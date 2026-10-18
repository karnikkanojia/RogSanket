#!/usr/bin/env python3
"""Compatibility entrypoint for the native Swift application server."""
if __name__ == "__main__":
    import os
    from pathlib import Path
    import sys
    launcher = str(Path(__file__).resolve().parent / "run_local.sh")
    os.execv(launcher, [launcher, *sys.argv[1:]])
