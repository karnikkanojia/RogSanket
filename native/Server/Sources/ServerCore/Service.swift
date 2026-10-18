import Foundation
import CryptoKit

final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

actor Service {
    let settings: Settings
    let store: Store
    let inference: any Inference
    let jobs: Jobs
    let surveillance: Surveillance
    private let prompts: Object
    init(settings: Settings, store: Store, inference: any Inference) throws {
        self.settings = settings; self.store = store; self.inference = inference; jobs = Jobs(store: store)
        surveillance = Surveillance(thresholds: try settings.thresholds())
        guard let source = Bundle.module.url(forResource: "prompts", withExtension: "json") else {
            throw ServerError.unavailable("Server prompt resource missing; rebuild the Swift server package")
        }
        prompts = try JSON.parse(Data(contentsOf: source)).object
    }
    func generate(_ task: String, messages: [JSON], maxTokens: Int = 512, images: [JSON] = []) async throws -> Object {
        try await inference.run(["operation": "generate", "task": .string(task), "messages": .array(messages),
                                 "max_tokens": .int(maxTokens), "temperature": 0, "images": .array(images)])
    }
    func extract(_ narrative: String) async throws -> (Object, JSON) {
        var messages: [JSON] = [["role": "system", "content": prompts["extraction"]!], ["role": "user", "content": .string(narrative)]]
        for attempt in 0...1 {
            let result = try await generate("extraction", messages: messages)
            let start = Date()
            do {
                var text = try result.text("text").trimmingCharacters(in: .whitespacesAndNewlines)
                if text.hasPrefix("```"), let first = text.firstIndex(of: "\n"), let end = text.range(of: "```", options: .backwards), end.lowerBound > first {
                    text = String(text[text.index(after: first)..<end.lowerBound])
                }
                let signal = try Signal.validate(JSON.parse(Data(text.utf8)).object)
                var provenance = result["provenance"]?.object ?? [:]
                provenance["validation_seconds"] = .number(Date().timeIntervalSince(start))
                return (signal, .object(provenance))
            } catch {
                if attempt == 1 { throw ServerError.unavailable("Extraction failed schema validation after one retry") }
                messages.append(["role": "assistant", "content": result["text"] ?? ""])
                messages.append(["role": "user", "content": "Return only valid JSON matching the required schema."])
            }
        }
        throw ServerError.unavailable("Extraction failed")
    }
    func encounter(_ payload: Object, extracted: (Object, JSON)? = nil) async throws -> Object {
        let extraction: (Object, JSON)
        if let extracted { extraction = extracted } else { extraction = try await extract(payload.text("narrative")) }
        try Task.checkCancellation()
        let id = UUID().uuidString.lowercased(), stamp = Time.stamp()
        let record: Object = ["encounter_id": .string(id), "timestamp": .string(stamp), "district": payload["district"] ?? .null,
            "facility_name": payload["facility_name"] ?? .null, "narrative_text": "", "location_lat": .null, "location_lon": .null,
            "has_image": false, "image_path": .null, "syndromic_signal": .object(extraction.0)]
        try store.add(record, provenance: extraction.1)
        return ["encounter_id": .string(id), "timestamp": .string(stamp), "syndromic_signal": .object(extraction.0),
                "total_encounters": .int(try store.count()), "provenance": extraction.1]
    }
    func multimodal(_ payload: Object) async throws -> Object {
        let extracted = try await extract(payload.text("narrative"))
        var result: Object = ["text": .object(extracted.0)]
        if let audio = payload["audio_base64"], audio != .null {
            result["cough"] = .object(try await inference.run(["operation": "cough", "audio_base64": audio]))
        }
        if let media = payload["image_base64"], media != .null {
            result["image"] = .object(try await image(["image_base64": media, "clinical_context": payload["narrative"]!]))
        }
        result["encounter"] = .object(try await encounter(payload, extracted: extracted))
        return result
    }
    func image(_ payload: Object) async throws -> Object {
        var request = payload; request["operation"] = "image"
        var result = try await inference.run(request)
        if result["flagged"]?.flag == true {
            let generated = try await generate("image_analysis", messages: [["role": "user", "content": .string("Describe clinical image findings relevant to syndromic surveillance. " + (payload["clinical_context"]?.text ?? ""))]], images: [payload["image_base64"]!])
            result["medgemma_analysis"] = generated["text"]
            result["analysis_provenance"] = generated["provenance"]
        }
        return result
    }
    func report(_ district: String, maxTokens: Int = 1024, refresh: Bool = false) async throws -> Object {
        let (summary, alerts) = try surveillance.summary(store.encounters(), district: district)
        var identity: Object = ["summary": .object(summary), "artifact": .string(settings.artifact), "remote": .string(settings.remoteURL?.absoluteString ?? ""), "prompt_version": 1, "max_tokens": .int(maxTokens), "cache_format": "swift-v1"]
        if !settings.artifact.isEmpty {
            let manifest = URL(fileURLWithPath: settings.artifact).appendingPathComponent("epicast-artifact.json")
            if let text = try? String(contentsOf: manifest, encoding: .utf8) { identity["manifest"] = .string(text) }
        }
        let key = SHA256.hash(data: try JSON.object(identity).data(sorted: true)).map { String(format: "%02x", $0) }.joined()
        if !refresh, let cached = try store.report(key) { return cached }
        let prompt = prompts["report"]!.text!.replacingOccurrences(of: "{surveillance_data}", with: try JSON.object(summary).serialized()) + "\nInclude alert summaries and actions in this single report. Recommendations are drafts. Do not invent forecasts or missing evidence."
        var generated: Object?
        var fallback: JSON = .null
        if let url = settings.remoteURL {
            do {
                var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 60
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                if let token = settings.remoteToken { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
                request.httpBody = try JSON.object(["model": .string(settings.remoteModel), "messages": [["role": "user", "content": .string(prompt)]], "max_tokens": .int(maxTokens), "temperature": 0]).data()
                let config = URLSessionConfiguration.ephemeral; config.urlCache = nil
                let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
                defer { session.finishTasksAndInvalidate() }
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw ServerError.unavailable("Remote unavailable") }
                let body = try JSON.parse(data)
                guard let choice = body["choices"].array.first, let text = choice["message"]["content"].text, !text.isEmpty else { throw ServerError.unavailable("Remote response invalid") }
                generated = ["text": .string(text), "provenance": ["model": body["model"] == .null ? .string(settings.remoteModel) : body["model"], "location": "remote", "backend": "openai-compatible", "revision": body["system_fingerprint"]]]
            } catch {
                try Task.checkCancellation()
                fallback = "Remote 27B unavailable; local 4B fallback used"
            }
        }
        if generated == nil { generated = try await generate("report", messages: [["role": "user", "content": .string(prompt)]], maxTokens: maxTokens) }
        try Task.checkCancellation()
        let response: Object = ["district": .string(district), "report_time": .string(Time.stamp()), "report": generated!["text"] ?? "",
            "alerts": .array(alerts.map(JSON.object)), "provenance": generated!["provenance"] ?? [:], "draft": true, "fallback_reason": fallback]
        try store.saveReport(key, response)
        return response
    }
    func dashboard(now: Date = Date()) throws -> Object {
        let records = try store.encounters(), alerts = try surveillance.scan(records, now: now)
        let counts: Object = ["total": .int(alerts.count), "emergency": .int(alerts.filter { $0["alert_level"]?.text == "emergency" }.count), "warning": .int(alerts.filter { $0["alert_level"]?.text == "warning" }.count), "watch": .int(alerts.filter { $0["alert_level"]?.text == "watch" }.count)]
        return ["timestamp": .string(Time.stamp(now)), "total_encounters": .int(records.count), "syndrome_distribution": .object(surveillance.distribution(records)),
            "districts": .array(Set(records.filter { $0["syndromic_signal"] != .null && $0["syndromic_signal"] != nil }.map { signalDistrict($0) }).sorted().map(JSON.string)),
            "active_alerts": .object(counts), "recent_encounters": .array(records.suffix(20).map { ["id": $0["encounter_id"]!, "time": $0["timestamp"]!, "district": $0["district"] ?? .null, "syndrome": $0["syndromic_signal"]?["syndrome_category"] ?? .null] })]
    }
    func alertList() throws -> Object {
        let found = try surveillance.scan(store.encounters())
        return ["timestamp": .string(Time.stamp()), "total_alerts": .int(found.count), "alerts": .array(found.map(JSON.object)),
            "by_level": .object(Dictionary(uniqueKeysWithValues: ["emergency", "warning", "watch"].map { level in (level, JSON.int(found.filter { $0["alert_level"]?.text == level }.count)) }))]
    }
    func health() async throws -> Object {
        let runtime = await inference.status()
        return ["status": "ok", "server_backend": "swift", "initialized": runtime["worker_loaded"] ?? false, "total_encounters": .int(try store.count()),
            "runtime": .object(runtime), "memory": .object(Memory.snapshot()),
            "artifacts_present": ["text": .bool(settings.artifactPresent("EPICAST_ARTIFACT")), "image": .bool(settings.artifactPresent("EPICAST_MEDSIGLIP_ARTIFACT")), "transcription": .bool(settings.artifactPresent("EPICAST_MEDASR_ARTIFACT")), "cough": .bool(settings.artifactPresent("EPICAST_HEAR_ARTIFACT"))],
            "release_validated": false, "readiness_note": "Artifact presence is not validation. Execution verifies checksums and parity gates."]
    }
    func advisory(_ payload: Object) async throws -> Object {
        guard let alert = try surveillance.scan(store.encounters()).first(where: { $0["alert_id"] == payload["alert_id"] }) else { throw ServerError(status: 404, message: "Alert not found") }
        let evidence: Object = ["district": alert["district"]!, "syndrome": alert["syndrome_category"]!, "cases": alert["case_count_current_week"]!, "level": alert["alert_level"]!]
        let prompt = "Draft advisory in \(payload["language"]!.text!) for \(payload["audience"]!.text!). Use only this evidence: " + (try JSON.object(evidence).serialized())
        let result = try await generate("advisory", messages: [["role": "user", "content": .string(prompt)]])
        var response = payload; response["advisory"] = result["text"]; response["provenance"] = result["provenance"]; response["draft"] = true
        return response
    }
    func close() async { await jobs.close(); await inference.close(); store.close() }
}
