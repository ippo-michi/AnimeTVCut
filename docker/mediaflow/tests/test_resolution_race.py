import asyncio
from contextlib import asynccontextmanager
import unittest
from unittest.mock import patch

from aiohttp import ClientResponseError
from mediaflow_proxy.remuxer.media_source import HTTPMediaSource


class ConcurrentResolutionTest(unittest.IsolatedAsyncioTestCase):
    async def test_late_failure_refreshes_the_url_that_actually_failed(self):
        source = HTTPMediaSource("https://origin.test/resolution-race.mkv")
        primary = "https://primary.test/episode.mkv"
        secondary = "https://secondary.test/episode.mkv"
        source._url = primary
        ready = [asyncio.Event(), asyncio.Event()]
        release = [asyncio.Event(), asyncio.Event()]
        refreshed = asyncio.Event()
        stale_urls = []
        primary_requests = 0
        actual_refreshes = 0

        async def refresh(stale_url=None):
            nonlocal actual_refreshes
            stale_urls.append(stale_url)
            if source._url == stale_url:
                actual_refreshes += 1
                source._url = secondary
            refreshed.set()

        class Response:
            def __init__(self, index=None):
                self.index = index
                self.content = self

            async def __aenter__(self):
                if self.index is not None:
                    ready[self.index].set()
                    await release[self.index].wait()
                return self

            async def __aexit__(self, *_args):
                return False

            def raise_for_status(self):
                if self.index is not None:
                    raise ClientResponseError(None, (), status=503)

            async def iter_any(self):
                yield b"media"

        class Session:
            def get(self, url, **_kwargs):
                nonlocal primary_requests
                if url == primary:
                    index = primary_requests
                    primary_requests += 1
                    return Response(index)
                return Response()

        @asynccontextmanager
        async def session(*_args, **_kwargs):
            yield Session(), None

        async def consume():
            return b"".join([chunk async for chunk in source.stream()])

        with patch.object(source, "_resolve_destination", refresh), patch(
            "mediaflow_proxy.remuxer.media_source.create_aiohttp_session", session
        ):
            tasks = [asyncio.create_task(consume()) for _ in range(2)]
            try:
                await asyncio.wait_for(asyncio.gather(*(event.wait() for event in ready)), 2)
                release[0].set()
                await asyncio.wait_for(refreshed.wait(), 2)
                release[1].set()
                self.assertEqual(await asyncio.wait_for(asyncio.gather(*tasks), 2), [b"media", b"media"])
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        self.assertEqual(stale_urls, [primary, primary])
        self.assertEqual(actual_refreshes, 1)


if __name__ == "__main__":
    unittest.main()
