from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from mediaflow_proxy.remuxer import media_source


class ResolutionCacheTest(unittest.IsolatedAsyncioTestCase):
    async def test_another_workers_refresh_wins_over_the_local_cache(self):
        primary = "https://primary.test/episode.mkv"
        secondary = "https://secondary.test/episode.mkv"
        with TemporaryDirectory() as directory, patch.object(
            media_source, "_HTTP_RESOLUTION_CACHE_DIR", Path(directory)
        ), patch.object(media_source, "_http_resolution_cache", {}):
            source = media_source.HTTPMediaSource("https://origin.test/cache-race.mkv")
            source._apply_resolution(primary, 123)
            old_worker_cache = dict(media_source._http_resolution_cache)
            # Another process has its own memory but publishes to the same disk.
            source._apply_resolution(secondary, 123)
            media_source._http_resolution_cache.clear()
            media_source._http_resolution_cache.update(old_worker_cache)

            await source.resolve_file_size()
            self.assertEqual(source.resolved_url, secondary)
            # An ordinary request must not publish the old CDN over the refresh.
            payload = next(Path(directory).glob("*.json")).read_text()
            self.assertIn(secondary, payload)


if __name__ == "__main__":
    unittest.main()
