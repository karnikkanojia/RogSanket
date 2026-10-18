import Foundation
import Vapor
import Darwin

private func response(_ body: Object, status: Int = 200) throws -> Response {
    Response(status: .init(statusCode: status), headers: ["Content-Type": "application/json"], body: .init(data: try JSON.object(body).data()))
}
private struct ContractErrors: AsyncMiddleware {
    func respond(to request: Request, chainingTo next: any AsyncResponder) async throws -> Response {
        do { return try await next.respond(to: request) }
        catch {
            let status: Int, message: String, retry: Int?
            if let error = error as? ServerError { status = error.status; message = error.message; retry = error.retryAfter }
            else if error is CancellationError { status = 499; message = "Cancelled"; retry = nil }
            else if let error = error as? AbortError { status = Int(error.status.code); message = error.reason; retry = nil }
            else { status = 500; message = "Server operation failed"; retry = nil }
            let result = try response(["detail": .string(message)], status: status)
            if let retry { result.headers.replaceOrAdd(name: "Retry-After", value: String(retry)) }
            return result
        }
    }
}
private struct ServerLifecycle: LifecycleHandler {
    let service: Service
    func shutdownAsync(_ application: Application) async { await service.close() }
}
private func payload(_ request: Request) throws -> Object {
    guard let type = request.headers.contentType, type.type.lowercased() == "application", type.subType.lowercased() == "json" else {
        throw ServerError.invalid("Expected application/json")
    }
    guard let buffer = request.body.data else { throw ServerError.invalid("Request body is required") }
    do {
        let body = try JSON.parse(Data(buffer.readableBytesView))
        guard case .object(let object) = body else { throw ServerError.invalid("Expected a JSON object") }
        return object
    } catch { throw ServerError.invalid("Invalid JSON request body") }
}
func validateEncounter(_ source: Object, multimodal: Bool = false) throws -> Object {
    let narrative = try source.text("narrative", maximum: 16000, minimum: 1)
    guard !narrative.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ServerError.invalid("Narrative is empty") }
    var value: Object = ["narrative": .string(narrative)]
    for key in ["district", "facility_name"] {
        if source[key] == nil || source[key] == .null { value[key] = .null }
        else { value[key] = .string(try source.text(key, maximum: 200)) }
    }
    for key in ["latitude", "longitude"] where source[key] != nil && source[key] != .null {
        guard source[key]?.number != nil else { throw ServerError.invalid("Invalid \(key)") }
    }
    if multimodal {
        for field in ["image_base64", "audio_base64"] {
            if let input = source[field], input != .null { try validateMedia(input, field: field); value[field] = input }
        }
    }
    return value
}
func validateMedia(_ value: JSON, field: String) throws {
    guard let text = value.text, text.utf8.count <= 16_000_000,
          let data = Data(base64Encoded: text), !data.isEmpty else { throw ServerError.invalid("Invalid or empty \(field)") }
}
private func district(_ request: Request) throws -> String {
    guard let value = try? request.query.get(String.self, at: "district") else { throw ServerError.invalid("district is required") }
    return value
}

public func runServer() async throws {
    signal(SIGPIPE, SIG_IGN)
    let settings = try Settings()
    let store = try Store(path: settings.database)
    let inference = LocalInference(settings: settings)
    let service = try Service(settings: settings, store: store, inference: inference)
    let app = try await Application.make(.detect())
    app.http.server.configuration.hostname = "127.0.0.1"
    app.http.server.configuration.port = settings.port
    app.http.server.configuration.shutdownTimeout = .seconds(5)
    app.routes.defaultMaxBodySize = "32mb"
    app.middleware = .init()
    app.middleware.use(ContractErrors())
    app.lifecycle.use(ServerLifecycle(service: service))
    app.get("health") { _ async throws -> Response in try response(await service.health()) }
    app.get("dashboard") { _ async throws -> Response in try response(await service.dashboard()) }
    app.get("alerts") { _ async throws -> Response in try response(await service.alertList()) }
    app.get("surveillance", "scan") { request async throws -> Response in
        let selected = try? request.query.get(String.self, at: "district")
        let found = try service.surveillance.scan(store.encounters(), districts: selected.map { [$0] })
        return try response(["scan_time": .string(Time.stamp()), "alerts_count": .int(found.count), "alerts": .array(found.map(JSON.object))])
    }
    app.post("encounter") { request async throws -> Response in
        try response(await service.encounter(validateEncounter(payload(request))))
    }
    app.get("surveillance", "report") { request async throws -> Response in
        let district = try district(request)
        return try await withThrowingTaskGroup(of: Response.self) { group in
            group.addTask { try response(await service.report(district)) }
            group.addTask { try await Task.sleep(for: .seconds(180)); throw ServerError(status: 504, message: "Report deadline exceeded") }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }
    app.post("jobs", "report") { request async throws -> Response in
        let input = try payload(request)
        let district = try input.text("district", maximum: 200, minimum: 1)
        let maximum = try input.integer("max_tokens", default: 1024, range: 1...1024)
        if let refresh = input["refresh"], refresh.flag == nil { throw ServerError.invalid("Invalid refresh") }
        let refresh = input["refresh"]?.flag ?? false
        let job = try await service.jobs.submit("report") { try await service.report(district, maxTokens: maximum, refresh: refresh) }
        return try response(job, status: 202)
    }
    app.post("jobs", "multimodal") { request async throws -> Response in
        let input = try validateEncounter(payload(request), multimodal: true)
        let job = try await service.jobs.submit("multimodal") { try await service.multimodal(input) }
        return try response(job, status: 202)
    }
    app.get("jobs", ":id") { request async throws -> Response in
        guard let id = request.parameters.get("id"), let job = try store.job(id) else { throw ServerError(status: 404, message: "Job not found") }
        return try response(job)
    }
    app.delete("jobs", ":id") { request async throws -> Response in
        guard let id = request.parameters.get("id"), let job = try await service.jobs.cancel(id) else { throw ServerError(status: 404, message: "Job not found") }
        return try response(job)
    }
    app.get("jobs", ":id", "events") { request async throws -> Response in
        guard let id = request.parameters.get("id"), try store.job(id) != nil else { throw ServerError(status: 404, message: "Job not found") }
        return Response(status: .ok, headers: ["Content-Type": "text/event-stream", "Cache-Control": "no-cache"], body: .init(managedAsyncStream: { writer in
            var previous = "", ticks = 0
            while !Task.isCancelled {
                guard let job = try store.job(id) else { return }
                let encoded = try JSON.object(job).serialized(sorted: true)
                if encoded != previous {
                    try await writer.write(.buffer(ByteBuffer(string: "event: status\ndata: \(encoded)\n\n")))
                    previous = encoded
                } else if ticks % 40 == 0 { try await writer.write(.buffer(ByteBuffer(string: ": keep-alive\n\n"))) }
                if ["succeeded", "failed", "cancelled"].contains(job["status"]?.text ?? "") { return }
                ticks += 1; try await Task.sleep(for: .milliseconds(250))
            }
        }))
    }
    app.post("transcribe") { request async throws -> Response in
        let input = try payload(request)
        try validateMedia(input["audio_base64"] ?? .null, field: "audio_base64")
        let format = try input.text("format", default: "wav")
        return try response(await inference.run(["operation": "transcribe", "audio_base64": input["audio_base64"]!, "format": .string(format)]))
    }
    for path: [PathComponent] in [["image-triage"], ["encounter", "image"]] {
        app.on(.POST, path) { request async throws -> Response in
            let input = try payload(request)
            try validateMedia(input["image_base64"] ?? .null, field: "image_base64")
            return try response(await service.image(["image_base64": input["image_base64"]!, "clinical_context": .string(try input.text("clinical_context", default: "", maximum: 16000))]))
        }
    }
    app.post("cough", "analyze") { request async throws -> Response in
        let input = try payload(request)
        try validateMedia(input["audio_base64"] ?? .null, field: "audio_base64")
        return try response(await inference.run(["operation": "cough", "audio_base64": input["audio_base64"]!, "format": .string(try input.text("format", default: "wav"))]))
    }
    app.get("hear", "spectrogram") { _ async throws -> Response in throw ServerError(status: 410, message: "Synthetic spectrogram removed. Submit recorded audio to /cough/analyze.") }
    app.post("alert", "advisory") { request async throws -> Response in
        let input = try payload(request)
        return try response(await service.advisory(["alert_id": .string(try input.text("alert_id")), "language": .string(try input.text("language", default: "english", maximum: 100)), "audience": .string(try input.text("audience", default: "community", maximum: 100))]))
    }
    app.get("fhir", "report") { request async throws -> Response in try response(await service.fhir(district(request))) }
    do { try await app.execute(); try await app.asyncShutdown() }
    catch { try? await app.asyncShutdown(); await service.close(); throw error }
}
