"""Unified-memory admission telemetry, independent of ML libraries."""
import os
import platform
import subprocess


def snapshot():
    import psutil
    memory = psutil.virtual_memory()
    try:
        swap = psutil.swap_memory().used
    except (OSError, psutil.Error):
        swap = None
    state = {
        "total_bytes": memory.total, "available_bytes": memory.available,
        "rss_bytes": psutil.Process().memory_info().rss,
        "swap_used_bytes": swap,
        "pressure": "unknown",
    }
    if platform.system() == "Darwin":
        try:
            value = subprocess.run(
                ["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
                capture_output=True, text=True, timeout=1, check=True,
            ).stdout.strip()
            state["pressure"] = {"1": "normal", "2": "warning", "4": "critical"}.get(value, "unknown")
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        state["pressure"] = "critical" if memory.available < 512 * 1024**2 else "normal"
    return state


def admit():
    state = snapshot()
    if state["pressure"] == "critical" or state["available_bytes"] < 512 * 1024**2:
        raise MemoryError("Inference paused: insufficient unified-memory headroom")
    return state
