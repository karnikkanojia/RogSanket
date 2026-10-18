"""Bounded FIFO scheduler. Kill/restart the worker on timeout or cancellation."""
import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Any


class QueueFull(RuntimeError):
    pass


@dataclass
class Task:
    payload: dict
    future: Any


class Scheduler:
    def __init__(self, settings, command=None):
        self.settings = settings
        self.override_command = command
        self.command = command or [sys.executable, "-m", "src.runtime.worker"]
        self.current_command = None
        self.queue = asyncio.Queue(maxsize=settings.queue_size)
        self.process = None
        self.consumer = None
        self.active = False
        self.last_error = None
        self.completed = 0
        self.loaded = False
        self.successful_operations = set()

    async def start(self):
        self.consumer = asyncio.create_task(self._consume())

    async def _stop_worker(self, graceful=False):
        process, self.process = self.process, None
        self.loaded = False
        if process and process.returncode is None:
            if graceful and process.stdin:
                process.stdin.close()
                try:
                    await asyncio.wait_for(process.wait(), 2)
                    return
                except TimeoutError:
                    pass
            process.kill()
            await process.wait()

    async def close(self):
        if self.consumer:
            self.consumer.cancel()
            try:
                await self.consumer
            except asyncio.CancelledError:
                pass
        await self._stop_worker(graceful=True)
        while not self.queue.empty():
            task = self.queue.get_nowait()
            if not task.future.done():
                task.future.set_exception(RuntimeError("Runtime shutting down"))
            self.queue.task_done()

    async def run(self, payload):
        from .memory import admit
        try:
            admit()
        except MemoryError:
            if not self.active:
                await self._stop_worker()
            raise
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        payload = dict(payload, deadline=payload.get("deadline", time.time() + self.settings.timeout_seconds))
        try:
            self.queue.put_nowait(Task(payload, future))
        except asyncio.QueueFull:
            raise QueueFull("Inference queue full; retry later") from None
        try:
            return await asyncio.wait_for(future, max(0.01, payload["deadline"] - time.time()))
        except (asyncio.CancelledError, TimeoutError):
            future.cancel()
            raise

    async def _watch_memory(self):
        from .memory import admit
        while True:
            await asyncio.sleep(1)
            try:
                await asyncio.to_thread(admit)
            except MemoryError as exc:
                return str(exc)

    async def _consume(self):
        while True:
            task = await self.queue.get()
            read = pressure = None
            try:
                if task.future.cancelled():
                    continue
                self.active = True
                command = self.command
                if not self.override_command and self.settings.backend == "swift" and task.payload["operation"] == "generate":
                    executable = os.getenv("EPICAST_SWIFT_WORKER")
                    if not executable:
                        raise RuntimeError("EPICAST_SWIFT_WORKER must name the validated native executable")
                    command = [executable]
                if self.process and self.current_command != command:
                    await self._stop_worker()
                if not self.process or self.process.returncode is not None:
                    self.current_command = command
                    env = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                               EPICAST_ARTIFACT=self.settings.artifact, EPICAST_BACKEND=self.settings.backend)
                    self.process = await asyncio.create_subprocess_exec(
                        *command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        env=env, limit=4 * 1024 * 1024,
                    )
                self.process.stdin.write((json.dumps(task.payload) + "\n").encode())
                await self.process.stdin.drain()
                read = asyncio.create_task(self.process.stdout.readline())
                pressure = asyncio.create_task(self._watch_memory())
                done, _ = await asyncio.wait(
                    [read, task.future, pressure], timeout=max(0, task.payload["deadline"] - time.time()),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if pressure in done:
                    await self._stop_worker()
                    raise MemoryError(pressure.result())
                if read not in done or task.future.cancelled():
                    read.cancel()
                    await self._stop_worker()
                    if not task.future.done():
                        task.future.set_exception(TimeoutError("Inference deadline exceeded"))
                    continue
                line = read.result()
                if not line:
                    await self._stop_worker()
                    raise RuntimeError("Inference worker exited unexpectedly")
                response = json.loads(line)
                if "error" in response:
                    kind = response.get("error_type")
                    exception = {"ValueError": ValueError, "MemoryError": MemoryError,
                                 "TimeoutError": TimeoutError}.get(kind, RuntimeError)
                    raise exception(response["error"])
                self.loaded = task.payload["operation"] == "generate"
                self.completed += 1
                self.successful_operations.add(task.payload["operation"])
                if not task.future.done():
                    task.future.set_result(response["result"])
            except asyncio.CancelledError:
                if not task.future.done():
                    task.future.set_exception(RuntimeError("Runtime shutting down"))
                raise
            except Exception as exc:
                self.last_error = str(exc)
                if not task.future.done():
                    task.future.set_exception(exc)
            finally:
                if read is not None and not read.done():
                    read.cancel()
                self.active = False
                self.queue.task_done()
                if pressure is not None:
                    pressure.cancel()
                    try:
                        await pressure
                    except asyncio.CancelledError:
                        # Do not swallow shutdown arriving during watcher cleanup.
                        if asyncio.current_task().cancelling():
                            raise

    def status(self):
        return {"queue_depth": self.queue.qsize(), "queue_capacity": self.settings.queue_size,
                "active": self.active, "worker_loaded": self.loaded,
                "completed": self.completed, "last_error": self.last_error,
                "successful_operations": sorted(self.successful_operations)}
