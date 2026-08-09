from __future__ import annotations

import importlib.util
import pathlib
import unittest
import urllib.error
import urllib.request


MODULE_PATH = pathlib.Path(__file__).parents[1] / "animetvcut_skip" / "fetch_segments.py"
SPEC = importlib.util.spec_from_file_location("animetvcut_fetch_segments", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FetchSegmentsSecurityTests(unittest.TestCase):
    def test_accepts_only_bounded_animetvcut_segments_paths(self) -> None:
        parsed = MODULE.validate_url(
            "https://atc.example:8443/media/cut/cut_123/segments.json"
        )
        self.assertEqual(parsed.hostname, "atc.example")
        for value in (
            "file:///tmp/segments.json",
            "https://user:secret@atc.example/media/cut/a/segments.json",
            "https://atc.example/health",
            "https://atc.example/media/cut/a/segments.json?source=secret",
        ):
            with self.assertRaises(ValueError):
                MODULE.validate_url(value)

    def test_rejects_cross_origin_and_excessive_redirects(self) -> None:
        origin = ("https", "atc.example")
        handler = MODULE.SafeRedirectHandler(origin)
        request = urllib.request.Request(
            "https://atc.example/media/cut/a/segments.json"
        )
        with self.assertRaises(ValueError):
            handler.redirect_request(
                request,
                None,
                302,
                "redirect",
                {},
                "https://other.example/media/cut/a/segments.json",
            )
        handler.redirects = MODULE.MAX_REDIRECTS
        with self.assertRaises(urllib.error.HTTPError) as raised:
            handler.redirect_request(
                request,
                None,
                302,
                "redirect",
                {},
                "https://atc.example/media/cut/a/segments.json",
            )
        raised.exception.close()


if __name__ == "__main__":
    unittest.main()
