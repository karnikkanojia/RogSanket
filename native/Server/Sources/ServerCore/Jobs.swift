import Foundation

actor Jobs {
    let store: Store
    let capacity: Int
    private var tasks: [String: Task<Void, Never>] = [:]
    init(store: Store, capacity: Int = 9) { self.store = store; self.capacity = capacity }
    func submit(_ kind: String, operation: @escaping @Sendable () async throws -> Object) throws -> Object {
        guard tasks.count < capacity else { throw ServerError(status: 429, message: "Job queue full; retry later", retryAfter: 5) }
        let id = UUID().uuidString.lowercased()
        let job: Object = ["id": .string(id), "kind": .string(kind), "status": "queued", "created": .string(Time.stamp() + Time.zoneOffset())]
        try store.saveJob(job)
        tasks[id] = Task {
            var current = job
            do {
                try Task.checkCancellation()
                current["status"] = "running"; try self.store.saveJob(current)
                let result = try await operation()
                // A returned operation may already have committed an encounter.
                // Publish that success instead of relabeling saved work cancelled.
                current["result"] = .object(result); current["status"] = "succeeded"
            } catch is CancellationError { current["status"] = "cancelled" }
            catch let error as ServerError where error.status == 499 { current["status"] = "cancelled" }
            catch { current["status"] = "failed"; current["error"] = .string(error.localizedDescription) }
            do { try self.store.saveJob(current) }
            catch { FileHandle.standardError.write(Data("Failed to persist job state; check database storage.\n".utf8)) }
            self.tasks.removeValue(forKey: id)
        }
        return job
    }
    func cancel(_ id: String) async throws -> Object? {
        if let task = tasks[id] {
            task.cancel(); await task.value
            if var job = try store.job(id), ["queued", "running"].contains(job["status"]?.text ?? "") {
                job["status"] = "cancelled"; try store.saveJob(job)
            }
            tasks.removeValue(forKey: id)
        }
        return try store.job(id)
    }
    func close() async {
        for id in Array(tasks.keys) { _ = try? await cancel(id) }
    }
}
extension Time {
    static func zoneOffset() -> String {
        let seconds = TimeZone.current.secondsFromGMT()
        return String(format: "%@%02d:%02d", seconds >= 0 ? "+" : "-", abs(seconds) / 3600, abs(seconds) % 3600 / 60)
    }
}
