import Foundation
import XCTest
@testable import ServerCore

actor FixtureInference: Inference {
    var requests: [Object] = []
    var failures = 0
    var invalidExtractions = 0
    var failImage = false
    let signal: Object = ["symptoms": ["fever"], "syndrome_category": "acute_febrile_illness", "severity": "moderate", "age_group": "adult", "icd10_codes": ["R50"], "confidence_score": 0.8]
    func invalidate(_ times: Int) { invalidExtractions = times }
    func failImages() { failImage = true }
    func run(_ payload: Object) async throws -> Object {
        requests.append(payload)
        if payload["operation"]?.text == "image" {
            if failImage { throw ServerError.unavailable("Image artifact missing") }
            return ["flagged": true, "top_pattern": "test-only", "score_type": "cosine_similarity"]
        }
        if payload["operation"]?.text == "cough" { return ["classification": "test-only"] }
        if payload["operation"]?.text == "transcribe" { return ["transcription": "Synthetic dictation.", "requires_review": true] }
        var text = "Synthetic report draft."
        if payload["task"]?.text == "extraction" {
            text = try JSON.object(signal).serialized()
            if invalidExtractions > 0 { invalidExtractions -= 1; text = "invalid schema" }
        }
        return ["text": .string(text), "provenance": ["model": "test-only", "revision": "fixture", "backend": "test", "location": "local"]]
    }
    func status() -> Object { ["worker_loaded": false, "queue_depth": 0, "queue_capacity": 8, "active": false, "completed": .int(requests.count), "last_error": .null, "successful_operations": []] }
    func close() {}
}

final class CoreTests: XCTestCase, @unchecked Sendable {
    private var root: String { String(#filePath.prefix(upTo: #filePath.range(of: "/native/Server/Tests/")!.lowerBound)) }
    private func settings() throws -> Settings { try Settings(environment: ["EPICAST_ROOT": root, "EPICAST_DATABASE": ":memory:"]) }
    private func fixture(_ name: String, ext: String = "json") -> URL { Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures")! }
    private func makeService(_ inference: FixtureInference = FixtureInference()) throws -> Service {
        try Service(settings: settings(), store: Store(path: ":memory:"), inference: inference)
    }
    private func assertJSON(_ actual: JSON, _ expected: JSON, file: StaticString = #filePath, line: UInt = #line) {
        if case .number(let a) = actual, case .number(let b) = expected {
            XCTAssertEqual(a, b, accuracy: max(1e-12, abs(b) * 1e-10), file: file, line: line)
        } else if case .object(let a) = actual, case .object(let b) = expected {
            XCTAssertEqual(Set(a.keys), Set(b.keys), file: file, line: line)
            for key in b.keys { assertJSON(a[key] ?? .null, b[key]!, file: file, line: line) }
        } else if case .array(let a) = actual, case .array(let b) = expected {
            XCTAssertEqual(a.count, b.count, file: file, line: line)
            for (left, right) in zip(a, b) { assertJSON(left, right, file: file, line: line) }
        } else { XCTAssertEqual(actual, expected, file: file, line: line) }
    }
    func testPythonSurveillanceParity() throws {
        let cases = try JSON.parse(Data(contentsOf: fixture("surveillance"))).array
        let surveillance = Surveillance(thresholds: try settings().thresholds())
        for item in cases {
            let records = item["records"].array.map(\.object)
            let now = try Time.date(item["now"].text!)
            let actual = try surveillance.scan(records, now: now).sorted { $0["alert_id"]!.text! < $1["alert_id"]!.text! }
            assertJSON(.array(actual.map(JSON.object)), item["alerts"])
        }
    }
    func testPythonStatisticsParity() throws {
        for item in try JSON.parse(Data(contentsOf: fixture("statistics"))).array {
            let counts = item["counts"].array.map { $0.number! }, mean = item["mean"].number!
            assertJSON(.object(Statistics.cusum(counts, mean: mean)), item["cusum"])
            assertJSON(.object(Statistics.ears(counts)), item["ears"])
            assertJSON(.object(Statistics.poisson(Int(counts.last ?? 0), expected: mean)), item["poisson"])
        }
    }
    func testStoreLeasePrivacyAndRestart() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("test.sqlite3").path
        let store = try Store(path: path)
        XCTAssertThrowsError(try Store(path: path))
        try store.add(["encounter_id": "test", "timestamp": .string(Time.stamp()), "narrative_text": "never persist this", "location_lat": 1, "image_path": "/private/test"], provenance: [:])
        XCTAssertThrowsError(try store.add(["encounter_id": "test"], provenance: [:]))
        try store.saveJob(["id": "j", "kind": "report", "status": "running", "created": .string(Time.stamp())])
        store.close()
        let reopened = try Store(path: path)
        defer { reopened.close() }
        XCTAssertEqual(try reopened.count(), 1)
        let record = try reopened.encounters().first!
        XCTAssertEqual(record["narrative_text"], "")
        XCTAssertEqual(record["location_lat"], .null)
        XCTAssertEqual(record["image_path"], .null)
        XCTAssertEqual(try reopened.job("j")?["status"], "failed")
    }
    func testValidation() throws {
        XCTAssertThrowsError(try validateEncounter(["narrative": "   "]))
        XCTAssertThrowsError(try validateEncounter(["narrative": .string(String(repeating: "a", count: 16001))]))
        XCTAssertThrowsError(try validateMedia("invalid", field: "audio_base64"))
        XCTAssertThrowsError(try validateMedia("", field: "image_base64"))
        XCTAssertNoThrow(try validateMedia("dGVzdA==", field: "image_base64"))
        XCTAssertThrowsError(try Settings(environment: ["EPICAST_REMOTE_27B_URL": "http://example.com"]))
        XCTAssertThrowsError(try Settings(environment: ["EPICAST_REMOTE_27B_URL": "https://user:secret@example.com"]))
    }
    func testExtractionRetryAndDurability() async throws {
        let inference = FixtureInference(); await inference.invalidate(1)
        let service = try makeService(inference)
        let result = try await service.encounter(["narrative": "Synthetic fever.", "district": "TEST", "facility_name": "TEST Clinic"])
        XCTAssertNotNil(result["encounter_id"]?.text)
        let calls = await inference.requests
        XCTAssertEqual(calls.count, 2)
        let stored = try await service.store.encounters()
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored.first?["narrative_text"], "")
        await service.close()
    }
    func testFailedExtractionNeverPersists() async throws {
        let inference = FixtureInference(); await inference.invalidate(2)
        let service = try makeService(inference)
        do { _ = try await service.encounter(["narrative": "Synthetic test"]); XCTFail("Expected validation failure") } catch {}
        let count = try await service.store.count(); XCTAssertEqual(count, 0)
        let calls = await inference.requests; XCTAssertEqual(calls.count, 2)
        await service.close()
    }
    func testMultimodalExtractsOnceAndStoresAfterSuccess() async throws {
        let inference = FixtureInference(), service = try makeService(inference)
        let result = try await service.multimodal(["narrative": "Synthetic test", "district": "TEST", "image_base64": "dGVzdA==", "audio_base64": "dGVzdA=="])
        XCTAssertNotNil(result["encounter"])
        let calls = await inference.requests
        XCTAssertEqual(calls.filter { $0["task"]?.text == "extraction" }.count, 1)
        XCTAssertEqual(calls.filter { $0["task"]?.text == "image_analysis" }.count, 1)
        let count = try await service.store.count(); XCTAssertEqual(count, 1)
        await service.close()
    }
    func testFailedModalityNeverPersistsEncounter() async throws {
        let inference = FixtureInference(); await inference.failImages()
        let service = try makeService(inference)
        do { _ = try await service.multimodal(["narrative": "Synthetic test", "image_base64": "dGVzdA=="]); XCTFail("Expected modality failure") } catch {}
        let count = try await service.store.count(); XCTAssertEqual(count, 0)
        await service.close()
    }
    func testReportCacheAndAggregatePrivacy() async throws {
        let inference = FixtureInference(), service = try makeService(inference)
        _ = try await service.encounter(["narrative": "PRIVATE SYNTHETIC RAW", "district": "TEST", "facility_name": "PRIVATE FACILITY"])
        _ = try await service.report("TEST", maxTokens: 512)
        _ = try await service.report("TEST", maxTokens: 512)
        let calls = await inference.requests.filter { $0["task"]?.text == "report" }
        XCTAssertEqual(calls.count, 1)
        let prompt = try JSON.object(calls[0]).serialized()
        XCTAssertFalse(prompt.contains("PRIVATE"))
        await service.close()
    }
    func testJobCancellationAndCapacity() async throws {
        let store = try Store(path: ":memory:"), jobs = Jobs(store: store, capacity: 1)
        let job = try await jobs.submit("report") { try await Task.sleep(for: .seconds(30)); return [:] }
        do { _ = try await jobs.submit("report") { [:] }; XCTFail("Expected queue overflow") }
        catch let error as ServerError { XCTAssertEqual(error.status, 429) }
        let cancelled = try await jobs.cancel(job["id"]!.text!)
        XCTAssertEqual(cancelled?["status"], "cancelled")
        await jobs.close(); store.close()
    }
    func testCommittedSuccessIsNotRelabeledCancelled() async throws {
        actor Operation {
            var reply: CheckedContinuation<Object, Never>?
            var cancelled = false
            func work() async -> Object {
                await withTaskCancellationHandler {
                    await withCheckedContinuation { reply = $0 }
                } onCancel: { Task { await self.markCancelled() } }
            }
            func markCancelled() { cancelled = true }
            func finish() { reply?.resume(returning: ["saved": true]); reply = nil }
        }
        let operation = Operation(), store = try Store(path: ":memory:"), jobs = Jobs(store: store)
        let job = try await jobs.submit("encounter") { await operation.work() }
        for _ in 0..<100 {
            if await operation.reply != nil { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let cancellation = Task { try await jobs.cancel(job["id"]!.text!) }
        for _ in 0..<100 {
            if await operation.cancelled { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        await operation.finish()
        let result = try await cancellation.value
        XCTAssertEqual(result?["status"], "succeeded")
        XCTAssertEqual(result?["result"]?["saved"], true)
        await jobs.close(); store.close()
    }
    func testFHIRPreservesFirstSyndromeWhenCountsTie() async throws {
        let service = try makeService()
        let now = Date()
        for syndrome in ["acute_watery_diarrhea", "acute_bloody_diarrhea"] {
            try await service.store.add(["encounter_id": .string(syndrome), "timestamp": .string(Time.stamp(now)),
                "district": "TEST", "syndromic_signal": ["syndrome_category": .string(syndrome)]], provenance: [:])
        }
        let result = try await service.fhir("TEST", now: now)
        let narrative = result["entry"]!.array[0]["resource"]["section"].array[1]["text"]["div"].text!
        XCTAssertTrue(narrative.contains("Most common syndrome: acute watery diarrhea"))
        await service.close()
    }
    func testEmptyDistrictUsesPythonUnknownBucket() throws {
        let now = Date()
        let record: Object = ["encounter_id": "test", "timestamp": .string(Time.stamp(now)),
            "district": "", "syndromic_signal": ["syndrome_category": "acute_neurological_syndrome"]]
        let surveillance = Surveillance(thresholds: try settings().thresholds())
        let alerts = try surveillance.scan([record], now: now)
        XCTAssertEqual(alerts.first?["district"], "unknown")
        XCTAssertEqual(try surveillance.scan([record], districts: [""], now: now).count, 0)
    }

}
