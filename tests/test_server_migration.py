"""Prompt and subprocess guards shared by workers and the native server."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_shared_prompt_contract():
    from src.agents.intake_agent import SYSTEM_PROMPT
    from src.agents.surveillance_agent import SITUATION_REPORT_PROMPT
    prompts = json.loads((ROOT/'native/Server/Sources/ServerCore/Resources/prompts.json').read_text())
    assert prompts == {'extraction': SYSTEM_PROMPT, 'report': SITUATION_REPORT_PROMPT}


def test_worker_exits_after_parent_death(tmp_path):
    pid_file = tmp_path/'worker.pid'
    # The short-lived supervisor launches the real worker without loading models.
    code = '''
import os, subprocess, sys, time
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c',
                         'from src.runtime.worker import watch_parent; import time; watch_parent(); time.sleep(30)'], stdin=subprocess.PIPE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env=dict(os.environ, EPICAST_PARENT_PID=str(os.getpid())))
Path(sys.argv[1]).write_text(str(child.pid))
time.sleep(.5)
'''
    subprocess.run([sys.executable, '-c', code, str(pid_file)], cwd=ROOT, check=True, timeout=5)
    import psutil
    pid = int(pid_file.read_text())
    for _ in range(50):
        try:
            process = psutil.Process(pid)
            if process.status() == psutil.STATUS_ZOMBIE:
                return
        except psutil.NoSuchProcess:
            return
        time.sleep(.1)
    process.kill()
    pytest.fail('Worker outlived its supervising server')
