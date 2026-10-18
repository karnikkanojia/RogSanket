import Foundation
import Darwin
import CryptoKit
import MLXVLM
import MLXLMCommon
import MLXHuggingFace
import Tokenizers

struct Message: Decodable, Sendable { let role: String; let content: String }
struct Input: Decodable {
    let operation: String
    let messages: [Message]?
    let images: [String]?
    let max_tokens: Int?
    let deadline: Double
}
struct Manifest: Decodable {
    let base_model: String
    let revision: String
    let quantization_bits: Int
    let text_parity_passed: Bool
    let image_parity_passed: Bool
    let swift_parity_passed: Bool?
    let sha256: [String: String]
}

@main
struct NativeWorker {
    static func fail(_ message: String) -> NSError {
        NSError(domain: "EpiCastWorker", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    static func verify(_ root: URL) throws -> Manifest {
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: root.appendingPathComponent("epicast-artifact.json")))
        guard manifest.base_model == "google/medgemma-1.5-4b-it", !manifest.revision.isEmpty,
              manifest.quantization_bits == 4, manifest.text_parity_passed, manifest.image_parity_passed,
              manifest.swift_parity_passed == true, !manifest.sha256.isEmpty else {
            throw fail("Swift checkpoint parity has not passed; keep the Python MLX worker")
        }
        for (name, expected) in manifest.sha256 {
            let url = root.appendingPathComponent(name).resolvingSymlinksInPath()
            guard url.path.hasPrefix(root.resolvingSymlinksInPath().path + "/") else { throw fail("Invalid artifact path") }
            let file = try FileHandle(forReadingFrom: url)
            defer { try? file.close() }
            var digest = SHA256()
            while let chunk = try file.read(upToCount: 1_048_576), !chunk.isEmpty { digest.update(data: chunk) }
            let actual = digest.finalize().map { String(format: "%02x", $0) }.joined()
            guard actual == expected else { throw fail("Artifact checksum mismatch: \(name)") }
        }
        return manifest
    }

    static func main() async {
        if let text = ProcessInfo.processInfo.environment["EPICAST_PARENT_PID"], let parent = Int32(text) {
            Task.detached {
                while true {
                    if getppid() != parent { Darwin._exit(70) }
                    try? await Task.sleep(for: .milliseconds(500))
                }
            }
        }
        var model: ModelContainer?
        var manifest: Manifest?
        let output = FileHandle.standardOutput
        // Redirect library output to stderr while keeping protocol writes on original stdout.
        let protocolFD = dup(STDOUT_FILENO)
        dup2(STDERR_FILENO, STDOUT_FILENO)
        let protocolOutput = FileHandle(fileDescriptor: protocolFD, closeOnDealloc: true)
        _ = output
        while let line = readLine() {
            var temporary: [URL] = []
            defer { for url in temporary { try? FileManager.default.removeItem(at: url) } }
            do {
                let request = try JSONDecoder().decode(Input.self, from: Data(line.utf8))
                guard Date().timeIntervalSince1970 < request.deadline else { throw fail("Request expired") }
                guard request.operation == "generate" else { throw fail("Unsupported native operation") }
                guard let path = ProcessInfo.processInfo.environment["EPICAST_ARTIFACT"], !path.isEmpty else {
                    throw fail("EPICAST_ARTIFACT is required")
                }
                let root = URL(fileURLWithPath: path)
                if model == nil {
                    manifest = try verify(root)
                    model = try await VLMModelFactory.shared.loadContainer(from: root, using: #huggingFaceTokenizerLoader())
                }
                guard let model, let manifest else { throw fail("Model unavailable") }
                let maximum = request.max_tokens ?? 512
                guard (1...1024).contains(maximum) else { throw fail("Invalid output budget") }
                var parameters = GenerateParameters(maxTokens: maximum, temperature: 0)
                parameters.prefill.stepSize = 256
                var messages: [Chat.Message] = []
                for message in request.messages ?? [] {
                    guard let role = Chat.Message.Role(rawValue: message.role) else { throw fail("Invalid message role") }
                    messages.append(.init(role: role, content: message.content))
                }
                guard !messages.isEmpty else { throw fail("Messages are required") }
                let images = request.images ?? []
                guard images.count <= 1 else { throw fail("Only one image per request") }
                for encoded in images {
                    guard let data = Data(base64Encoded: encoded), data.count <= 12_000_000 else { throw fail("Invalid image") }
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
                    try data.write(to: url, options: .atomic)
                    temporary.append(url)
                    messages[messages.count - 1].images = [.url(url)]
                }
                // Use the model processor's tokenized input, including image tokens, for admission.
                let rawMessages = request.messages ?? []
                let imageURLs = temporary
                let promptTokens = try await model.perform { context in
                    var admissionMessages = rawMessages.map { Chat.Message(role: Chat.Message.Role(rawValue: $0.role)!, content: $0.content) }
                    admissionMessages[admissionMessages.count - 1].images = imageURLs.map { .url($0) }
                    let input = try await context.processor.prepare(input: UserInput(chat: admissionMessages))
                    return input.text.tokens.size
                }
                guard promptTokens + maximum <= 4096 else { throw fail("Input plus output exceeds 4096 tokens") }
                let start = Date()
                var first: Double?
                var text = ""
                // Fresh session per task: no encounter-specific KV cache is retained.
                let session = ChatSession(model, generateParameters: parameters)
                for try await chunk in session.streamResponse(to: messages) {
                    guard Date().timeIntervalSince1970 < request.deadline else { throw fail("Inference deadline exceeded") }
                    if first == nil { first = Date().timeIntervalSince(start) }
                    text += chunk
                }
                let response: [String: Any] = ["result": ["text": text, "provenance": [
                    "model": manifest.base_model, "revision": manifest.revision,
                    "backend": "mlx-swift-lm", "location": "local", "quantization": "4bit",
                    "prompt_tokens": promptTokens, "generation_seconds": Date().timeIntervalSince(start),
                    "first_token_seconds": first ?? 0,
                ]]]
                let data = try JSONSerialization.data(withJSONObject: response)
                protocolOutput.write(data + Data([10]))
            } catch {
                let result: [String: Any] = ["error": error.localizedDescription, "error_type": "RuntimeError"]
                if let data = try? JSONSerialization.data(withJSONObject: result) { protocolOutput.write(data + Data([10])) }
            }
        }
    }
}
