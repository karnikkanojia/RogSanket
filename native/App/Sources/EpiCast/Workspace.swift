import Foundation
import Combine
import ImageIO

struct Attachment: Identifiable {
    let url: URL
    let name: String
    let bytes: Int
    var id: URL { url }
    var size: String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) }
}

enum MediaFiles {
    static let root = FileManager.default.temporaryDirectory.appendingPathComponent("epicast-client-\(UUID().uuidString)", isDirectory: true)
    static func newURL(extension suffix: String) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root.appendingPathComponent(UUID().uuidString).appendingPathExtension(suffix)
    }
    static func importFile(_ source: URL) throws -> Attachment {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        // Read at most the limit plus one byte. URL resource values can cache
        // stale sizes, and a selected file may change after its metadata is read.
        let handle = try FileHandle(forReadingFrom: source)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: 10_000_001) ?? Data()
        guard !data.isEmpty, data.count <= 10_000_000 else {
            throw APIError(message: "Choose a nonempty file no larger than 10 MB.")
        }
        let destination = try newURL(extension: source.pathExtension)
        try data.write(to: destination, options: .atomic)
        return Attachment(url: destination, name: source.lastPathComponent, bytes: data.count)
    }
    static func validateImage(_ attachment: Attachment) throws {
        guard let source = CGImageSourceCreateWithURL(attachment.url as CFURL, nil),
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0,
              width.doubleValue * height.doubleValue <= 16_000_000 else {
            throw APIError(message: "Choose a single-frame image no larger than 16 megapixels. Resize it before attaching; the app will not discard detail automatically.")
        }
    }
    static func remove(_ attachment: Attachment?) {
        if let attachment { try? FileManager.default.removeItem(at: attachment.url) }
    }
    static func cleanUp() {
        guard FileManager.default.fileExists(atPath: root.path) else { return }
        try? FileManager.default.removeItem(at: root)
    }
}

enum Destination: String, CaseIterable, Identifiable {
    case overview, alerts, intake, reports
    var id: Self { self }
    var title: String {
        switch self {
        case .overview: "Overview"
        case .alerts: "Active alerts"
        case .intake: "Record encounter"
        case .reports: "Situation reports"
        }
    }
    var symbol: String {
        switch self {
        case .overview: "chart.bar.xaxis"
        case .alerts: "bell"
        case .intake: "plus.circle"
        case .reports: "doc.text"
        }
    }
}

@MainActor
final class Workspace: ObservableObject {
    @Published var selection: Destination? = .overview
    @Published private(set) var serverAddress: String
    @Published private(set) var dashboard: DashboardData?
    @Published private(set) var alerts: [SurveillanceAlert] = []
    @Published private(set) var health: Health?
    @Published private(set) var refreshing = false
    @Published private(set) var dashboardError = ""
    @Published private(set) var alertsError = ""
    @Published private(set) var connectionError = ""
    @Published private(set) var busy: Destination?
    @Published private(set) var jobStatus = ""
    @Published private(set) var operationError = ""
    @Published private(set) var operationDestination: Destination?
    @Published private(set) var notice = ""
    @Published private(set) var cancelling = false
    @Published var district = ""
    @Published var facility = ""
    @Published var narrative = ""
    @Published var reportDistrict = ""
    @Published private(set) var report: SituationReport?
    @Published private(set) var lastEncounter: MultimodalResult?
    @Published private(set) var image: Attachment?
    @Published private(set) var cough: Attachment?
    @Published var pendingTranscript: String?
    private var client: APIClient
    private var task: Task<Void, Never>?
    private var jobID: String?

    init(client suppliedClient: APIClient? = nil) {
        let stored = UserDefaults.standard.string(forKey: "localServerAddress") ?? "http://127.0.0.1:8000"
        let url = (try? APIClient.localURL(stored)) ?? URL(string: "http://127.0.0.1:8000")!
        serverAddress = url.absoluteString
        client = suppliedClient ?? APIClient(base: url)
    }

    var validEncounter: Bool {
        !district.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && district.count <= 200 &&
        !facility.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && facility.count <= 200 &&
        narrative.trimmingCharacters(in: .whitespacesAndNewlines).count >= 10 && narrative.count <= 16000
    }
    var validReport: Bool {
        !reportDistrict.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && reportDistrict.count <= 200
    }

    func configure(_ address: String) async throws {
        guard busy == nil, !refreshing else { throw APIError(message: "Wait for the current request before changing servers.") }
        let url = try APIClient.localURL(address)
        client = APIClient(base: url)
        serverAddress = url.absoluteString
        UserDefaults.standard.set(serverAddress, forKey: "localServerAddress")
        dashboard = nil; alerts = []; report = nil; lastEncounter = nil
        await refresh()
    }

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        // These calls remain independent of the inference job and of each other.
        async let overview: Void = loadDashboard()
        async let signals: Void = loadAlerts()
        async let connection: Void = loadHealth()
        _ = await (overview, signals, connection)
    }
    private func loadDashboard() async {
        do { dashboard = try await client.dashboard(); dashboardError = "" }
        catch { dashboardError = error.localizedDescription }
    }
    private func loadAlerts() async {
        do { alerts = try await client.alerts().alerts; alertsError = "" }
        catch { alertsError = error.localizedDescription }
    }
    private func loadHealth() async {
        do { health = try await client.health(); connectionError = "" }
        catch { health = nil; connectionError = error.localizedDescription }
    }

    func attach(_ url: URL, image isImage: Bool, captured: Bool = false) {
        do {
            let attachment = try MediaFiles.importFile(url)
            if isImage {
                do { try MediaFiles.validateImage(attachment) }
                catch { MediaFiles.remove(attachment); throw error }
                MediaFiles.remove(image); image = attachment
            }
            else { MediaFiles.remove(cough); cough = attachment }
            operationError = ""
        } catch { operationDestination = .intake; operationError = error.localizedDescription }
        if captured { try? FileManager.default.removeItem(at: url) }
    }
    func removeImage() { MediaFiles.remove(image); image = nil }
    func removeCough() { MediaFiles.remove(cough); cough = nil }
    func importFailed(_ error: Error) { operationDestination = .intake; operationError = error.localizedDescription }

    private func begin(_ destination: Destination, status: String = "Submitting", operation: @escaping @MainActor () async throws -> Void) {
        guard busy == nil else { return }
        busy = destination; operationDestination = destination; operationError = ""; notice = ""; cancelling = false
        jobStatus = status; jobID = nil
        task = Task {
            defer { busy = nil; jobID = nil; task = nil; cancelling = false }
            do { try await operation() }
            catch is CancellationError { notice = "Cancelled. No further work was requested." }
            catch { operationError = error.localizedDescription }
            await loadHealth()
        }
    }

    private func wait<T>(_ initial: Job<T>) async throws -> T {
        jobID = initial.id
        var current = initial
        // A cancellation while POST is in flight is held until its job ID arrives.
        // This avoids abandoning an accepted server job with no cancellation request.
        if cancelling {
            _ = try await client.cancel(current.id)
            current = try await client.job(current.id)
        }
        while !current.isTerminal {
            jobStatus = readable(current.status)
            try await Task.sleep(for: .milliseconds(500))
            current = try await client.job(current.id)
        }
        if current.status == "succeeded", let result = current.result { return result }
        if current.status == "cancelled" { throw CancellationError() }
        throw APIError(message: current.error ?? "The job failed. Your input has been kept; correct the problem before retrying.")
    }

    func submit() {
        guard validEncounter else { return }
        begin(.intake) {
            var payload = EncounterPayload(narrative: self.narrative,
                district: self.district.trimmingCharacters(in: .whitespacesAndNewlines),
                facility_name: self.facility.trimmingCharacters(in: .whitespacesAndNewlines))
            if let image = self.image { payload.image_base64 = try Data(contentsOf: image.url).base64EncodedString() }
            if let cough = self.cough { payload.audio_base64 = try Data(contentsOf: cough.url).base64EncodedString() }
            let result = try await self.wait(self.client.submit(payload))
            self.lastEncounter = result
            self.narrative = ""; self.removeImage(); self.removeCough()
            self.notice = "Encounter saved. Review the extracted signal below."
            await self.refresh()
        }
    }

    func generateReport() {
        guard validReport else { return }
        let district = reportDistrict.trimmingCharacters(in: .whitespacesAndNewlines)
        begin(.reports) {
            self.report = nil
            self.report = try await self.wait(self.client.report(district))
            self.notice = "Draft ready. Review all recommendations before use."
        }
    }

    func transcribe(_ source: URL, temporary: Bool = false) {
        guard busy == nil else { return }
        begin(.intake, status: "Transcribing") {
            defer { if temporary { try? FileManager.default.removeItem(at: source) } }
            let attachment = try MediaFiles.importFile(source)
            defer { MediaFiles.remove(attachment) }
            self.jobStatus = "Transcribing"
            let payload = AudioPayload(audio_base64: try Data(contentsOf: attachment.url).base64EncodedString(), format: source.pathExtension)
            let result = try await self.client.transcribe(payload)
            self.pendingTranscript = result.transcription
            self.notice = "Review and correct the transcript before using it."
        }
    }

    func cancel() {
        guard busy != nil, !cancelling else { return }
        cancelling = true
        guard let id = jobID else {
            // Transcription has no background-job API; its request is not falsely
            // presented as server-cancellable. The UI offers cancellation for jobs only.
            return
        }
        Task {
            do { _ = try await client.cancel(id) }
            catch {
                cancelling = false
                operationError = "Could not confirm cancellation. \(error.localizedDescription)"
            }
        }
    }
    var canCancelJob: Bool { busy != nil && jobStatus != "Transcribing" }
}
