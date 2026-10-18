import Foundation
import AppKit
import XCTest
@testable import EpiCast

final class StubProtocol: URLProtocol, @unchecked Sendable {
    final class Storage: @unchecked Sendable {
        let lock = NSLock()
        private var deleteCount = 0
        var deletes: Int { lock.lock(); defer { lock.unlock() }; return deleteCount }
        private var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
        func set(_ handler: @escaping @Sendable (URLRequest) throws -> (Int, Data)) {
            lock.lock(); defer { lock.unlock() }; self.handler = handler; deleteCount = 0
        }
        func respond(_ request: URLRequest) throws -> (Int, Data) {
            lock.lock(); let callback = handler
            if request.httpMethod == "DELETE" { deleteCount += 1 }
            lock.unlock()
            guard let callback else { throw URLError(.badServerResponse) }
            return try callback(request)
        }
    }
    static let storage = Storage()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.storage.respond(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@MainActor
final class ContractTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")!)
    }
    private func client(handler: @escaping @Sendable (URLRequest) throws -> (Int, Data)) -> APIClient {
        StubProtocol.storage.set(handler)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return APIClient(base: URL(string: "http://127.0.0.1:8000")!, session: URLSession(configuration: configuration))
    }
    func testActualFastAPIContracts() throws {
        let decoder = JSONDecoder()
        let dashboard = try decoder.decode(DashboardData.self, from: fixture("dashboard"))
        XCTAssertEqual(dashboard.total_encounters, 24)
        XCTAssertEqual(dashboard.syndrome_distribution["acute_respiratory_infection"], 24)
        let alerts = try decoder.decode(AlertsResponse.self, from: fixture("alerts"))
        XCTAssertFalse(alerts.alerts.isEmpty)
        XCTAssertEqual(alerts.alerts.first?.syndrome_category, "acute_respiratory_infection")
        XCTAssertNotNil(alerts.alerts.first?.case_count_current_week)
        let health = try decoder.decode(Health.self, from: fixture("health"))
        XCTAssertFalse(health.release_validated)
        XCTAssertEqual(health.runtime.queue_capacity, 8)
    }
    func testLocalAddressValidation() throws {
        XCTAssertEqual(try APIClient.localURL("http://127.0.0.1:8099").port, 8099)
        XCTAssertNoThrow(try APIClient.localURL("http://[::1]:8000"))
        for address in ["https://example.com", "file:///tmp/test", "http://user:secret@localhost", "http://localhost?token=x", "http://localhost/api"] {
            XCTAssertThrowsError(try APIClient.localURL(address))
        }
    }
    func testResponseErrorsAndUnavailableModels() async throws {
        let api = client { _ in (503, Data(#"{"detail":"Artifact parity has not passed"}"#.utf8)) }
        do { let _: Health = try await api.health(); XCTFail("Expected failure") }
        catch { XCTAssertEqual(error.localizedDescription, "Artifact parity has not passed") }
    }
    func testRejectsMalformedSuccessResponse() async throws {
        let api = client { _ in (200, Data(#"{"unexpected":true}"#.utf8)) }
        do { let _: DashboardData = try await api.dashboard(); XCTFail("Expected failure") }
        catch { XCTAssertTrue(error.localizedDescription.contains("unexpected response")) }
    }
    func testReportJobDecodingAndCancellation() async throws {
        let report = try fixture("report")
        let api = client { request in
            if request.httpMethod == "DELETE" {
                XCTAssertEqual(request.url?.path, "/jobs/test-report")
                return (200, Data(#"{"id":"test-report","status":"cancelled"}"#.utf8))
            }
            XCTAssertEqual(request.url?.path, "/jobs/test-report")
            return (200, report)
        }
        let job: Job<SituationReport> = try await api.job("test-report")
        XCTAssertTrue(job.isTerminal)
        XCTAssertEqual(job.result?.district, "TEST · North")
        XCTAssertEqual(job.result?.provenance.revision, "test-revision")
        _ = try await api.cancel(job.id)
    }
    func testMediaIsBoundedCopiedAndRemoved() throws {
        let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        defer { try? FileManager.default.removeItem(at: source); MediaFiles.cleanUp() }
        try Data().write(to: source)
        XCTAssertThrowsError(try MediaFiles.importFile(source))
        try Data([1, 2, 3]).write(to: source)
        let attachment = try MediaFiles.importFile(source)
        XCTAssertNotEqual(attachment.url, source)
        XCTAssertEqual(try Data(contentsOf: attachment.url), Data([1, 2, 3]))
        MediaFiles.remove(attachment)
        XCTAssertFalse(FileManager.default.fileExists(atPath: attachment.url.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
        try Data(repeating: 0, count: 10_000_001).write(to: source)
        XCTAssertThrowsError(try MediaFiles.importFile(source))
    }
    func testValidationDoesNotTruncateNarrative() {
        let workspace = Workspace()
        workspace.district = "TEST"
        workspace.facility = "TEST Clinic"
        workspace.narrative = "too short"
        XCTAssertFalse(workspace.validEncounter)
        workspace.narrative = String(repeating: "x", count: 16001)
        XCTAssertFalse(workspace.validEncounter)
        XCTAssertEqual(workspace.narrative.count, 16001)
        workspace.narrative = "Synthetic test narrative."
        XCTAssertTrue(workspace.validEncounter)
    }
    private func waitUntilIdle(_ workspace: Workspace) async throws {
        for _ in 0..<300 {
            if workspace.busy == nil { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Workspace did not complete its request")
    }
    func testReportWorkflowRetainsProvenance() async throws {
        let report = try fixture("report")
        let health = try fixture("health")
        let api = client { request in
            if request.url?.path == "/health" { return (200, health) }
            XCTAssertEqual(request.url?.path, "/jobs/report")
            XCTAssertEqual(request.httpMethod, "POST")
            return (202, report)
        }
        let workspace = Workspace(client: api)
        workspace.reportDistrict = "TEST · North"
        workspace.generateReport()
        try await waitUntilIdle(workspace)
        XCTAssertEqual(workspace.report?.provenance.revision, "test-revision")
        XCTAssertTrue(workspace.operationError.isEmpty)
        XCTAssertNil(workspace.busy)
    }
    func testCancellationBeforeJobIDStillDeletesJob() async throws {
        let health = try fixture("health")
        let api = client { request in
            if request.url?.path == "/health" { return (200, health) }
            if request.httpMethod == "POST" {
                return (202, Data(#"{"id":"test-cancel","status":"queued"}"#.utf8))
            }
            XCTAssertEqual(request.url?.path, "/jobs/test-cancel")
            return (200, Data(#"{"id":"test-cancel","status":"cancelled"}"#.utf8))
        }
        let workspace = Workspace(client: api)
        workspace.reportDistrict = "TEST"
        workspace.generateReport()
        workspace.cancel()
        try await waitUntilIdle(workspace)
        XCTAssertEqual(StubProtocol.storage.deletes, 1)
        XCTAssertTrue(workspace.notice.contains("Cancelled"))
        XCTAssertNil(workspace.report)
        XCTAssertTrue(workspace.operationError.isEmpty)
    }
    func testFailedEncounterKeepsInput() async throws {
        let health = try fixture("health")
        let api = client { request in
            if request.url?.path == "/health" { return (200, health) }
            return (503, Data(#"{"detail":"Model not verified"}"#.utf8))
        }
        let workspace = Workspace(client: api)
        workspace.district = "TEST"
        workspace.facility = "TEST Clinic"
        workspace.narrative = "Synthetic narrative retained after failure."
        workspace.submit()
        try await waitUntilIdle(workspace)
        XCTAssertEqual(workspace.narrative, "Synthetic narrative retained after failure.")
        XCTAssertEqual(workspace.operationError, "Model not verified")
        XCTAssertNil(workspace.lastEncounter)
    }

    func testSavedEncounterClearsInputAndRefreshes() async throws {
        let result = try fixture("encounter-job")
        let overview = try fixture("dashboard")
        let alerts = try fixture("alerts")
        let health = try fixture("health")
        let api = client { request in
            switch request.url?.path {
            case "/dashboard": return (200, overview)
            case "/alerts": return (200, alerts)
            case "/health": return (200, health)
            default:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/jobs/multimodal")
                return (202, result)
            }
        }
        let workspace = Workspace(client: api)
        workspace.district = "TEST"
        workspace.facility = "TEST Clinic"
        workspace.narrative = "Synthetic encounter submitted successfully."
        workspace.submit()
        try await waitUntilIdle(workspace)
        XCTAssertEqual(workspace.lastEncounter?.encounter.syndromic_signal.symptoms, ["fever", "cough"])
        XCTAssertEqual(workspace.lastEncounter?.encounter.provenance?.revision, "test-only")
        XCTAssertTrue(workspace.narrative.isEmpty)
        XCTAssertEqual(workspace.district, "TEST")
        XCTAssertEqual(workspace.facility, "TEST Clinic")
        XCTAssertNotNil(workspace.dashboard)
        XCTAssertTrue(workspace.operationError.isEmpty)
    }

    func testImagesAreValidatedBeforePreview() throws {
        let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        defer { try? FileManager.default.removeItem(at: source); MediaFiles.cleanUp() }
        try Data([1, 2, 3]).write(to: source)
        let invalid = try MediaFiles.importFile(source)
        XCTAssertThrowsError(try MediaFiles.validateImage(invalid))
        MediaFiles.remove(invalid)
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 8, pixelsHigh: 8,
            bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        try bitmap.representation(using: .png, properties: [:])!.write(to: source)
        let valid = try MediaFiles.importFile(source)
        XCTAssertNoThrow(try MediaFiles.validateImage(valid))
        MediaFiles.remove(valid)
    }

}
