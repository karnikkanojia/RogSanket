import Foundation
import XCTest
@testable import ServerCore

final class InferenceTests: XCTestCase, @unchecked Sendable {
    private func runtime(timeout: Double = 5, capacity: Int = 8, admission: @escaping @Sendable () throws -> Void = {}) throws -> LocalInference {
        var settings = try Settings(environment: ["EPICAST_ROOT": FileManager.default.currentDirectoryPath])
        settings.timeout = timeout; settings.queueCapacity = capacity
        let worker = Bundle.module.url(forResource: "worker", withExtension: "py", subdirectory: "Fixtures")!
        return LocalInference(settings: settings, command: ["/usr/bin/python3", worker.path], admission: admission)
    }
    private func active(_ runtime: LocalInference) async throws {
        for _ in 0..<200 {
            if await runtime.status()["active"]?.flag == true { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("No active worker")
    }
    func testProcessProtocolOfflineAndFragmentedOutput() async throws {
        let runtime = try runtime()
        let result = try await runtime.run(["operation": "generate", "task": "chunks", "data": .string(String(repeating: "x", count: 200_000))])
        XCTAssertEqual(result["task"], "chunks")
        XCTAssertEqual(result["offline"], "1")
        XCTAssertEqual(result["size"], 200_000)
        await runtime.close()
    }
    func testCancellationKillsWorkerAndRecovers() async throws {
        let runtime = try runtime()
        let task = Task { try await runtime.run(["operation": "generate", "task": "hang"]) }
        try await active(runtime)
        task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") } catch {}
        let result = try await runtime.run(["operation": "generate", "task": "recovered"])
        XCTAssertEqual(result["task"], "recovered")
        await runtime.close()
    }
    func testTimeoutAndCrashRecovery() async throws {
        let runtime = try runtime(timeout: 0.4)
        do { _ = try await runtime.run(["operation": "generate", "task": "hang"]); XCTFail("Expected timeout") }
        catch let error as ServerError { XCTAssertEqual(error.status, 504) }
        do { _ = try await runtime.run(["operation": "generate", "task": "crash"]); XCTFail("Expected crash") }
        catch { XCTAssertTrue(error.localizedDescription.contains("exited")) }
        let result = try await runtime.run(["operation": "generate", "task": "recovered"])
        XCTAssertEqual(result["task"], "recovered")
        await runtime.close()
    }
    func testQueueOverflowAndQueuedCancellation() async throws {
        let runtime = try runtime(capacity: 1)
        let first = Task { try await runtime.run(["operation": "generate", "task": "hang"]) }
        try await active(runtime)
        let queued = Task { try await runtime.run(["operation": "generate", "task": "queued"]) }
        for _ in 0..<100 {
            if await runtime.status()["queue_depth"]?.number == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        do { _ = try await runtime.run(["operation": "generate", "task": "overflow"]); XCTFail("Expected overflow") }
        catch let error as ServerError { XCTAssertEqual(error.status, 429) }
        queued.cancel(); first.cancel()
        _ = try? await queued.value; _ = try? await first.value
        let status = await runtime.status()
        XCTAssertEqual(status["queue_depth"], 0)
        await runtime.close()
    }
    func testMemoryPressureStopsActiveWorker() async throws {
        final class Pressure: @unchecked Sendable {
            let lock = NSLock(); private var critical = false
            func trigger() { lock.lock(); critical = true; lock.unlock() }
            func admit() throws {
                lock.lock(); let failure = critical; lock.unlock()
                if failure { throw ServerError(status: 503, message: "Test pressure", retryAfter: 10) }
            }
        }
        let pressure = Pressure(), runtime = try runtime(admission: { try pressure.admit() })
        let task = Task { try await runtime.run(["operation": "generate", "task": "hang"]) }
        try await active(runtime); pressure.trigger()
        do { _ = try await task.value; XCTFail("Expected pressure rejection") }
        catch let error as ServerError { XCTAssertEqual(error.status, 503) }
        let status = await runtime.status()
        XCTAssertEqual(status["worker_loaded"], false)
        await runtime.close()
    }
}
