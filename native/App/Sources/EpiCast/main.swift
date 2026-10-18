import Foundation
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class Workspace: ObservableObject {
    @Published var district = ""
    @Published var facility = ""
    @Published var narrative = ""
    @Published var report = ""
    @Published var dashboard = ""
    @Published var alerts = ""
    @Published var status = ""
    @Published var busy = false
    @Published var image: URL?
    @Published var cough: URL?
    private var task: Task<Void, Never>?
    private var jobID: String?
    private var capturedFiles: [URL] = []
    private let base = URL(string: "http://127.0.0.1:8000")!

    func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 190
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw NSError(domain: "EpiCast", code: 1, userInfo: [NSLocalizedDescriptionKey: result["detail"] as? String ?? "API unavailable"])
        }
        return result
    }

    func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        busy = true
        status = "Working…"
        task = Task {
            defer { busy = false; jobID = nil }
            do { try await operation() }
            catch is CancellationError { status = "Cancelled" }
            catch { status = error.localizedDescription }
        }
    }

    func refresh() {
        perform {
            let overview = try await self.request("dashboard")
            self.dashboard = self.pretty(overview)
            self.alerts = self.pretty(try await self.request("alerts"))
            self.status = "Updated"
        }
    }

    func pretty(_ value: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    func wait(_ job: [String: Any]) async throws -> [String: Any] {
        guard let id = job["id"] as? String else { throw URLError(.cannotParseResponse) }
        jobID = id
        while true {
            try Task.checkCancellation()
            let current = try await request("jobs/\(id)")
            let state = current["status"] as? String ?? "unknown"
            status = state.capitalized
            if state == "succeeded" { return current["result"] as? [String: Any] ?? [:] }
            if state == "failed" || state == "cancelled" {
                throw NSError(domain: "EpiCast", code: 2, userInfo: [NSLocalizedDescriptionKey: current["error"] as? String ?? state])
            }
            try await Task.sleep(for: .milliseconds(500))
        }
    }

    func submit() {
        perform {
            var payload: [String: Any] = ["narrative": self.narrative, "district": self.district, "facility_name": self.facility]
            if let image = self.image { payload["image_base64"] = try self.media(image) }
            if let cough = self.cough { payload["audio_base64"] = try self.media(cough) }
            let result = try await self.wait(self.request("jobs/multimodal", method: "POST", body: payload))
            for url in self.capturedFiles { try? FileManager.default.removeItem(at: url) }
            self.capturedFiles = []
            self.image = nil
            self.cough = nil
            self.status = "Encounter saved: \((result["encounter"] as? [String: Any])?["encounter_id"] ?? "")"
        }
    }

    func generateReport() {
        perform {
            let result = try await self.wait(self.request("jobs/report", method: "POST", body: ["district": self.district]))
            self.report = result["report"] as? String ?? ""
            self.status = "Draft report. Review before use."
        }
    }

    func media(_ url: URL) throws -> String {
        let allowed = url.startAccessingSecurityScopedResource()
        defer { if allowed { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        guard data.count <= 10_000_000 else { throw NSError(domain: "EpiCast", code: 3, userInfo: [NSLocalizedDescriptionKey: "File exceeds 10 MB"] ) }
        return data.base64EncodedString()
    }

    func attachCapturedPhoto(_ url: URL) {
        capturedFiles.append(url)
        image = url
    }

    func transcribe(_ url: URL, temporary: Bool = false) {
        perform {
            defer { if temporary { try? FileManager.default.removeItem(at: url) } }
            let result = try await self.request("transcribe", method: "POST", body: ["audio_base64": try self.media(url)])
            self.narrative = result["transcription"] as? String ?? ""
            self.status = "Review and correct transcript before submitting."
        }
    }

    func cancel() {
        let id = jobID
        task?.cancel()
        if let id { Task { _ = try? await request("jobs/\(id)", method: "DELETE") } }
    }
}

@main
struct EpiCastApp: App {
    @StateObject private var workspace = Workspace()
    @StateObject private var audioCapture = AudioCapture()
    @StateObject private var photoCapture = PhotoCapture()
    @State private var selecting: String?
    @State private var importing = false
    var body: some Scene {
        WindowGroup {
            VStack(alignment: .leading, spacing: 16) {
                Text("EpiCast").font(.largeTitle.bold())
                HStack {
                    TextField("District", text: $workspace.district)
                    TextField("Facility", text: $workspace.facility)
                    Button("Refresh", action: workspace.refresh).disabled(workspace.busy)
                }
                TabView {
                    VStack(alignment: .leading) {
                        Text("Clinical narrative · Review transcription before submitting")
                        TextEditor(text: $workspace.narrative).frame(minHeight: 180)
                        HStack {
                            Button(audioCapture.recording ? "Stop dictation" : "Record dictation") {
                                if audioCapture.recording {
                                    if let url = audioCapture.stop() { workspace.transcribe(url, temporary: true) }
                                } else { Task { await audioCapture.start() } }
                            }
                            Button("Camera") { Task { await photoCapture.start() } }
                            Button("Import dictation") { selecting = "dictation"; importing = true }
                            Button("Attach image") { selecting = "image"; importing = true }
                            Button("Attach cough") { selecting = "cough"; importing = true }
                        }.disabled(workspace.busy)
                        if photoCapture.running {
                            CameraPreview(session: photoCapture.session).frame(height: 180)
                            HStack {
                                Button("Take photo") { photoCapture.capture { workspace.attachCapturedPhoto($0) } }
                                Button("Close camera", action: photoCapture.stop)
                            }
                        }
                        if !audioCapture.error.isEmpty { Text(audioCapture.error).foregroundStyle(.red) }
                        if !photoCapture.error.isEmpty { Text(photoCapture.error).foregroundStyle(.red) }
                        Text([workspace.image?.lastPathComponent, workspace.cough?.lastPathComponent].compactMap { $0 }.joined(separator: " · "))
                        Button("Submit encounter", action: workspace.submit)
                            .disabled(workspace.busy || audioCapture.recording || workspace.narrative.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }.padding().tabItem { Text("Intake") }
                    ScrollView { Text(workspace.dashboard).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.padding().tabItem { Text("Dashboard") }
                    ScrollView { Text(workspace.alerts).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.padding().tabItem { Text("Alerts") }
                    VStack(alignment: .leading) {
                        Button("Generate draft", action: workspace.generateReport).disabled(workspace.busy || workspace.district.isEmpty)
                        ScrollView { Text(workspace.report).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    }.padding().tabItem { Text("Reports") }
                }
                HStack { Text(workspace.status); Spacer(); if workspace.busy { Button("Cancel", action: workspace.cancel) } }
            }.padding(24).frame(minWidth: 760, minHeight: 600)
            .fileImporter(isPresented: $importing, allowedContentTypes: selecting == "image" ? [.image] : [.audio]) { result in
                if case .success(let url) = result {
                    if selecting == "dictation" { workspace.transcribe(url) }
                    else if selecting == "image" { workspace.image = url }
                    else { workspace.cough = url }
                }
            }
        }
    }
}
