import Foundation
import Darwin

protocol Inference: Sendable {
    func run(_ payload: Object) async throws -> Object
    func status() async -> Object
    func close() async
}

private final class ChunkSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var sequence = 0
    func next() -> Int { lock.lock(); defer { lock.unlock() }; let value = sequence; sequence += 1; return value }
}

// The local process is a transport adapter. Application logic never owns ML libraries.
actor WireWorker {
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var command: [String] = []
    private var generation = UUID()
    private var buffer = Data()
    private var chunks: [Int: Data] = [:]
    private var nextChunk = 0
    private var reply: CheckedContinuation<Object, Error>?
    let settings: Settings
    private let overrideCommand: [String]?
    init(settings: Settings, command: [String]? = nil) { self.settings = settings; overrideCommand = command }

    func exchange(_ payload: Object) async throws -> Object {
        try Task.checkCancellation()
        let operation = payload["operation"]?.text ?? ""
        var wanted = overrideCommand ?? [settings.python, "-m", "src.runtime.worker"]
        if overrideCommand == nil, settings.backend == "swift", operation == "generate" {
            guard let executable = settings.swiftWorker else { throw ServerError.unavailable("EPICAST_SWIFT_WORKER must name the validated native executable") }
            wanted = [executable]
        }
        if process?.isRunning != true || command != wanted {
            await stop()
            try start(wanted)
        }
        let encoded = try JSON.object(payload).data() + Data([10])
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                reply = continuation
                let ticket = generation
                guard let input else { complete(.failure(ServerError.unavailable("Worker input closed"))); return }
                Task.detached {
                    do { try input.write(contentsOf: encoded) }
                    catch { await self.writeFailed(ticket) }
                }
            }
        } onCancel: { Task { await self.stop() } }
    }
    private func start(_ wanted: [String]) throws {
        let process = Process(), stdin = Pipe(), stdout = Pipe()
        process.executableURL = URL(fileURLWithPath: wanted[0])
        process.arguments = Array(wanted.dropFirst())
        process.currentDirectoryURL = settings.root
        var environment = settings.environment
        environment["EPICAST_PARENT_PID"] = String(getpid())
        environment["HF_HUB_OFFLINE"] = "1"; environment["TRANSFORMERS_OFFLINE"] = "1"
        environment["EPICAST_ARTIFACT"] = settings.artifact; environment["EPICAST_BACKEND"] = settings.backend
        process.environment = environment
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = FileHandle.standardError
        generation = UUID()
        let ticket = generation, sequence = ChunkSequence()
        stdout.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            let index = sequence.next()
            if data.isEmpty { handle.readabilityHandler = nil }
            Task { await self.receive(data, index: index, ticket: ticket) }
        }
        do { try process.run() }
        catch { stdout.fileHandleForReading.readabilityHandler = nil; throw ServerError.unavailable("Cannot start model worker. Check EPICAST_PYTHON and the runtime environment.") }
        try? stdin.fileHandleForReading.close(); try? stdout.fileHandleForWriting.close()
        self.process = process; input = stdin.fileHandleForWriting; output = stdout.fileHandleForReading
        command = wanted; buffer = Data(); chunks = [:]; nextChunk = 0
    }
    private func receive(_ data: Data, index: Int, ticket: UUID) {
        guard ticket == generation else { return }
        // FileHandle callbacks become independent Tasks; preserve byte order even
        // if the concurrency executor delivers those Tasks out of order.
        chunks[index] = data
        if buffer.count + chunks.values.reduce(0, { $0 + $1.count }) > 4 * 1024 * 1024 {
            complete(.failure(ServerError.unavailable("Worker response exceeded protocol limit")))
            Task { await self.stop() }; return
        }
        while let chunk = chunks.removeValue(forKey: nextChunk) {
            nextChunk += 1
            consume(chunk)
        }
    }
    private func consume(_ data: Data) {
        if data.isEmpty {
            output?.readabilityHandler = nil
            complete(.failure(ServerError.unavailable("Inference worker exited unexpectedly")))
            return
        }
        buffer.append(data)
        guard buffer.count <= 4 * 1024 * 1024 else {
            complete(.failure(ServerError.unavailable("Worker response exceeded protocol limit")))
            Task { await self.stop() }; return
        }
        guard let newline = buffer.firstIndex(of: 10) else { return }
        let line = buffer.prefix(upTo: newline)
        buffer.removeSubrange(...newline)
        do {
            let body = try JSON.parse(Data(line)).object
            if let error = body["error"]?.text {
                let kind = body["error_type"]?.text ?? "RuntimeError"
                complete(.failure(ServerError(status: kind == "ValueError" ? 422 : (kind == "TimeoutError" ? 504 : 503), message: error, retryAfter: kind == "MemoryError" ? 10 : nil)))
            } else if case .object(let result) = body["result"] { complete(.success(result)) }
            else { throw ServerError.unavailable("Invalid worker response envelope") }
        } catch { complete(.failure(ServerError.unavailable("Invalid worker JSON response"))); Task { await self.stop() } }
    }
    private func complete(_ result: Result<Object, Error>) {
        let continuation = reply; reply = nil; continuation?.resume(with: result)
    }
    private func writeFailed(_ ticket: UUID) {
        guard ticket == generation else { return }
        complete(.failure(ServerError.unavailable("Inference worker pipe closed")))
    }
    func running() -> Bool { process?.isRunning == true }
    func stop(graceful: Bool = false) async {
        generation = UUID()
        let process = process
        self.process = nil
        output?.readabilityHandler = nil
        try? input?.close(); input = nil
        try? output?.close(); output = nil
        buffer = Data(); chunks = [:]; nextChunk = 0
        complete(.failure(CancellationError()))
        if let process, process.isRunning {
            if graceful {
                Task.detached {
                    try? await Task.sleep(for: .seconds(2))
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                }
            } else { kill(process.processIdentifier, SIGKILL) }
            await Task.detached { process.waitUntilExit() }.value
        }
    }
}

actor LocalInference: Inference {
    private struct Pending {
        let id: UUID
        let payload: Object
        let reply: CheckedContinuation<Object, Error>
        let timer: Task<Void, Never>
    }
    private struct Active {
        let pending: Pending
        let task: Task<Void, Never>
        var failure: ServerError?
    }
    private var queue: [Pending] = []
    private var active: Active?
    private var closed = false
    private var loaded = false
    private var completed = 0
    private var lastError: String?
    private var operations: Set<String> = []
    private let settings: Settings
    private let worker: WireWorker
    private let admission: @Sendable () throws -> Void
    init(settings: Settings, command: [String]? = nil, admission: @escaping @Sendable () throws -> Void = Memory.admit) {
        self.settings = settings; worker = WireWorker(settings: settings, command: command); self.admission = admission
    }

    func run(_ payload: Object) async throws -> Object {
        guard !closed else { throw ServerError.unavailable("Runtime shutting down") }
        do { try admission() }
        catch { if active == nil { await worker.stop(); loaded = false }; throw error }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                guard queue.count < settings.queueCapacity else {
                    continuation.resume(throwing: ServerError(status: 429, message: "Inference queue full; retry later", retryAfter: 5)); return
                }
                let seconds = max(0.001, (payload["deadline"]?.number ?? Date().timeIntervalSince1970 + settings.timeout) - Date().timeIntervalSince1970)
                var request = payload; request["deadline"] = .number(Date().timeIntervalSince1970 + seconds)
                let timer = Task {
                    do { try await Task.sleep(for: .seconds(seconds)); self.expire(id) }
                    catch {}
                }
                queue.append(Pending(id: id, payload: request, reply: continuation, timer: timer))
                drain()
            }
        } onCancel: { Task { await self.cancel(id, failure: .cancelled) } }
    }
    private func drain() {
        guard active == nil, !queue.isEmpty, !closed else { return }
        let pending = queue.removeFirst()
        let task = Task { await self.execute(pending) }
        active = Active(pending: pending, task: task)
    }
    private func execute(_ pending: Pending) async {
        do {
            try Task.checkCancellation()
            try admission()
            let result = try await withThrowingTaskGroup(of: Object.self) { group in
                group.addTask { try await self.worker.exchange(pending.payload) }
                group.addTask {
                    while true { try await Task.sleep(for: .seconds(1)); try self.admission() }
                }
                defer { group.cancelAll() }
                return try await group.next()!
            }
            if let failure = active?.failure { throw failure }
            loaded = pending.payload["operation"]?.text == "generate"
            completed += 1; operations.insert(pending.payload["operation"]?.text ?? "")
            finish(pending, .success(result))
        } catch {
            if error is CancellationError || (error as? ServerError)?.retryAfter == 10 {
                await worker.stop(); loaded = false
            }
            let failure: Error = active?.failure ?? error
            lastError = failure.localizedDescription
            finish(pending, .failure(failure))
        }
    }
    private func finish(_ pending: Pending, _ result: Result<Object, Error>) {
        pending.timer.cancel(); active = nil; pending.reply.resume(with: result); drain()
    }
    private func expire(_ id: UUID) {
        cancel(id, failure: ServerError(status: 504, message: "Inference deadline exceeded"))
    }
    private func cancel(_ id: UUID, failure: ServerError) {
        if let index = queue.firstIndex(where: { $0.id == id }) {
            let pending = queue.remove(at: index); pending.timer.cancel(); pending.reply.resume(throwing: failure)
        } else if active?.pending.id == id {
            active?.failure = failure; active?.task.cancel()
        }
    }
    func status() async -> Object {
        let alive = await worker.running()
        return ["queue_depth": .int(queue.count), "queue_capacity": .int(settings.queueCapacity), "active": .bool(active != nil),
         "worker_loaded": .bool(loaded && alive), "completed": .int(completed), "last_error": lastError.map(JSON.string) ?? .null,
         "successful_operations": .array(operations.sorted().map(JSON.string))]
    }
    func close() async {
        closed = true
        for pending in queue { pending.timer.cancel(); pending.reply.resume(throwing: ServerError.unavailable("Runtime shutting down")) }
        queue = []
        let task = active?.task
        task?.cancel()
        await task?.value
        await worker.stop(graceful: true); loaded = false
    }
}
