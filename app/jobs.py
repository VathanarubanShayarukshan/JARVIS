"""Background agent jobs.

Each chat prompt runs as a detached asyncio task, independent of the HTTP
connection that started it. Events are kept in memory and persisted to SQLite
so a client can disconnect ("push to background"), close the browser window,
and later replay + follow the same job from any device.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, AsyncIterator

from . import database as db
from .agent import run_agent
from .database import append_message


class Job:
    def __init__(self, job_id: str, session_id: str):
        self.id = job_id
        self.session_id = session_id
        self.status = "running"
        self.events: list[dict[str, Any]] = []
        self.cond = asyncio.Condition()
        self.task: asyncio.Task | None = None
        self.followers = 0
        self.created_at = time.time()


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}

    def init(self) -> None:
        db.interrupt_stale_jobs()

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def running_for_session(self, session_id: str) -> Job | None:
        for j in self._jobs.values():
            if j.session_id == session_id and j.status == "running":
                return j
        return None

    def start(
        self,
        session_id: str,
        provider: Any,
        model: str,
        message: str,
        extra_system: str | None = None,
    ) -> Job:
        job = Job(uuid.uuid4().hex, session_id)
        self._jobs[job.id] = job
        db.create_job(job.id, session_id)
        self._publish(job, {"type": "job", "id": job.id, "session_id": session_id})
        job.task = asyncio.create_task(self._run(job, provider, model, message, extra_system))
        self._prune()
        return job

    def _publish(self, job: Job, ev: dict[str, Any]) -> None:
        idx = len(job.events)
        job.events.append(ev)
        db.add_job_event(job.id, idx, ev)

    async def _notify(self, job: Job) -> None:
        async with job.cond:
            job.cond.notify_all()

    async def _run(self, job: Job, provider: Any, model: str, message: str, extra_system: str | None) -> None:
        accrued = ""
        try:
            async for ev in run_agent(provider, model, job.session_id, message, extra_system):
                if ev.get("type") == "text":
                    accrued += ev.get("text") or ""
                self._publish(job, ev)
                await self._notify(job)
                if ev.get("type") == "done":
                    job.status = "done"
                elif ev.get("type") == "error":
                    job.status = "error"
                    if accrued.strip():
                        append_message(job.session_id, "assistant", accrued)
        except asyncio.CancelledError:
            job.status = "stopped"
            partial = accrued.strip()
            content = (partial + "\n\n⏹ (stopped by user)") if partial else "⏹ Stopped by user."
            if partial:
                append_message(job.session_id, "assistant", content)
            self._publish(job, {"type": "done", "content": content, "stopped": True})
        except Exception as e:  # noqa: BLE001
            job.status = "error"
            self._publish(job, {"type": "error", "message": f"{type(e).__name__}: {e}"})
        finally:
            if job.status == "running":
                job.status = "done"
            db.set_job_status(job.id, job.status)
            await self._notify(job)

    async def stop(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or job.status != "running" or not job.task:
            return False
        job.task.cancel()
        try:
            await job.task
        except (asyncio.CancelledError, Exception):
            pass
        return True

    async def follow(self, job: Job, after: int = 0) -> AsyncIterator[dict[str, Any]]:
        i = after
        job.followers += 1
        try:
            while True:
                async with job.cond:
                    while i >= len(job.events) and job.status == "running":
                        await job.cond.wait()
                    batch = job.events[i:]
                    i = len(job.events)
                    finished = job.status != "running"
                for ev in batch:
                    yield ev
                if finished:
                    return
        finally:
            job.followers -= 1

    async def replay(self, job_id: str, after: int = 0) -> AsyncIterator[dict[str, Any]]:
        """Follow a live job, or replay a finished one straight from the DB."""
        job = self._jobs.get(job_id)
        if job:
            async for ev in self.follow(job, after):
                yield ev
            return
        row = db.get_job(job_id)
        if not row:
            yield {"type": "error", "message": "job not found"}
            return
        for ev in db.get_job_events(job_id, after):
            yield ev

    def _prune(self) -> None:
        if len(self._jobs) <= 200:
            return
        finished = sorted(
            (j for j in self._jobs.values() if j.status != "running" and j.followers == 0),
            key=lambda j: j.created_at,
        )
        for j in finished[: len(self._jobs) - 200]:
            self._jobs.pop(j.id, None)

    async def shutdown(self) -> None:
        for j in list(self._jobs.values()):
            if j.status == "running" and j.task:
                j.task.cancel()
        for j in list(self._jobs.values()):
            if j.task:
                try:
                    await j.task
                except (asyncio.CancelledError, Exception):
                    pass


manager = JobManager()