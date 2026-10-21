import asyncio
import fcntl
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from mediaflow_proxy.remuxer import media_source


class ResolutionLockTest(unittest.IsolatedAsyncioTestCase):
    async def test_cancelling_a_lock_waiter_does_not_leave_the_source_locked(self):
        loop = asyncio.get_running_loop()
        started = asyncio.Event()
        finished = asyncio.Event()
        real_flock = fcntl.flock

        def tracked_flock(fd, operation):
            if operation & fcntl.LOCK_EX:
                loop.call_soon_threadsafe(started.set)
                try:
                    return real_flock(fd, operation)
                finally:
                    loop.call_soon_threadsafe(finished.set)
            return real_flock(fd, operation)

        with TemporaryDirectory() as directory, patch.object(
            media_source, "_HTTP_RESOLUTION_CACHE_DIR", Path(directory)
        ):
            source = media_source.HTTPMediaSource("https://origin.test/cancel-lock.mkv")
            lock_path = Path(directory) / f"{source._resolution_key}.lock"
            owner = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            probe = os.open(lock_path, os.O_RDWR)
            real_flock(owner, fcntl.LOCK_EX)
            task = None
            try:
                with patch.object(media_source.fcntl, "flock", tracked_flock):
                    task = asyncio.create_task(source._resolve_destination())
                    await asyncio.wait_for(started.wait(), 2)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                    real_flock(owner, fcntl.LOCK_UN)
                    await asyncio.wait_for(finished.wait(), 2)
                    # A cancelled blocking executor call can still acquire this
                    # lock later and leak its fd. Another process must get it now.
                    real_flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                real_flock(owner, fcntl.LOCK_UN)
                os.close(owner)
                os.close(probe)
                if task is not None:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)


if __name__ == "__main__":
    unittest.main()
