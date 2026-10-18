import Foundation

struct APIError: LocalizedError, Sendable {
    let message: String
    var errorDescription: String? { message }
}

actor APIClient {
    let base: URL
    private let session: URLSession

    init(base: URL, session: URLSession? = nil) {
        self.base = base
        if let session { self.session = session }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.timeoutIntervalForRequest = 190
            self.session = URLSession(configuration: configuration)
        }
    }

    static func localURL(_ text: String) throws -> URL {
        guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
              ["localhost", "127.0.0.1", "::1", "[::1]"].contains(parts.host?.lowercased() ?? ""),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", let url = parts.url else {
            throw APIError(message: "Enter a local API address, such as http://127.0.0.1:8000.")
        }
        return url
    }

    func request<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
        request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        // Health and dashboard requests never wait behind a model request.
        if method == "GET" { request.timeoutInterval = 10 }
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch let error as URLError where error.code == .cancelled { throw CancellationError() }
        catch {
            let message = method == "POST"
                ? "The server response was lost. Check surveillance records before retrying; the server may have accepted the request."
                : "Cannot reach the local server. Check its address and that EpiCast Server is running."
            throw APIError(message: message)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError(message: "Invalid server response.") }
        guard (200..<300).contains(http.statusCode) else {
            let detail = (try? JSONDecoder().decode(JSONValue.self, from: data)).flatMap { value -> String? in
                guard case .object(let fields) = value, let detail = fields["detail"] else { return nil }
                if case .string(let message) = detail { return message }
                return nil
            }
            throw APIError(message: detail ?? "Server rejected the request (HTTP \(http.statusCode)). Check the fields and retry.")
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError(message: "The server returned an unexpected response. Check that client and server versions match.") }
    }

    func dashboard() async throws -> DashboardData { try await request("dashboard") }
    func alerts() async throws -> AlertsResponse { try await request("alerts") }
    func health() async throws -> Health { try await request("health") }
    func submit(_ payload: EncounterPayload) async throws -> Job<MultimodalResult> {
        try await request("jobs/multimodal", method: "POST", body: JSONEncoder().encode(payload))
    }
    func report(_ district: String) async throws -> Job<SituationReport> {
        try await request("jobs/report", method: "POST", body: JSONEncoder().encode(ReportPayload(district: district)))
    }
    func job<T>(_ id: String) async throws -> Job<T> { try await request("jobs/\(id)") }
    func cancel(_ id: String) async throws -> JSONValue { try await request("jobs/\(id)", method: "DELETE") }
    func transcribe(_ payload: AudioPayload) async throws -> Transcription {
        try await request("transcribe", method: "POST", body: JSONEncoder().encode(payload))
    }
}
