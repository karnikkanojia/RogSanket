"""Durable job states with cancellation propagated into the inference worker."""
import asyncio
from datetime import datetime, timezone
import uuid
from .scheduler import QueueFull


class Jobs:
    def __init__(self, store, capacity=9):
        self.store = store
        self.capacity = capacity
        self.tasks = {}

    def submit(self, kind, operation):
        if len(self.tasks) >= self.capacity:
            raise QueueFull("Job queue full; retry later")
        job = {"id": str(uuid.uuid4()), "kind": kind, "status": "queued",
               "created": datetime.now(timezone.utc).isoformat()}
        self.store.save_job(job)

        async def execute():
            try:
                job["status"] = "running"
                self.store.save_job(job)
                job["result"] = await operation()
                job["status"] = "succeeded"
            except asyncio.CancelledError:
                job["status"] = "cancelled"
                raise
            except Exception as exc:
                job["status"] = "failed"
                job["error"] = str(exc)
            finally:
                self.store.save_job(job)
                self.tasks.pop(job["id"], None)

        self.tasks[job["id"]] = asyncio.create_task(execute())
        return job

    async def cancel(self, job_id):
        task = self.tasks.get(job_id)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            self.tasks.pop(job_id, None)
            job = self.store.get_job(job_id)
            if job and job["status"] in {"queued", "running"}:
                job["status"] = "cancelled"
                self.store.save_job(job)
        return self.store.get_job(job_id)

    async def close(self):
        for job_id in list(self.tasks):
            await self.cancel(job_id)
