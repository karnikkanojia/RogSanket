import Foundation
import Darwin

enum Memory {
    static func snapshot() -> Object {
        let host = mach_host_self()
        defer { mach_port_deallocate(mach_task_self_, host) }
        var vm = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
        let status = withUnsafeMutablePointer(to: &vm) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(host, HOST_VM_INFO64, $0, &count)
            }
        }
        let available: JSON = status == KERN_SUCCESS ? .number(Double(UInt64(vm.free_count) + UInt64(vm.inactive_count)) * Double(sysconf(_SC_PAGESIZE))) : .null
        var pressure: Int32 = 0, pressureSize = MemoryLayout<Int32>.size
        let pressureOK = sysctlbyname("kern.memorystatus_vm_pressure_level", &pressure, &pressureSize, nil, 0) == 0
        var swap = xsw_usage(), swapSize = MemoryLayout<xsw_usage>.size
        let swapOK = sysctlbyname("vm.swapusage", &swap, &swapSize, nil, 0) == 0
        var task = mach_task_basic_info()
        var taskCount = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let taskOK = withUnsafeMutablePointer(to: &task) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(taskCount)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &taskCount)
            }
        } == KERN_SUCCESS
        return ["total_bytes": .number(Double(ProcessInfo.processInfo.physicalMemory)), "available_bytes": available,
                "rss_bytes": taskOK ? .number(Double(task.resident_size)) : .null,
                "swap_used_bytes": swapOK ? .number(Double(swap.xsu_used)) : .null,
                "pressure": .string(pressureOK ? ([1: "normal", 2: "warning", 4: "critical"][Int(pressure)] ?? "unknown") : "unknown")]
    }
    static func admit() throws {
        let state = snapshot()
        guard let available = state["available_bytes"]?.number else { throw ServerError.unavailable("Memory telemetry unavailable; inference admission paused") }
        if state["pressure"]?.text == "critical" || available < 512 * 1024 * 1024 {
            throw ServerError(status: 503, message: "Inference paused: insufficient unified-memory headroom", retryAfter: 10)
        }
    }
}
