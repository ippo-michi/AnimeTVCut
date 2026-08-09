"""Bounded same-origin fetch helper for the AnimeTVCut mpv companion."""

from __future__ import annotations

import re
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 262_144
MAX_REDIRECTS = 3
PATH_RE = re.compile(r"^/media/cut/[A-Za-z0-9_-]{1,128}/segments\.json$")


def validate_url(value: str, expected_origin: tuple[str, str] | None = None) -> urllib.parse.SplitResult:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("unsupported URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL credentials are forbidden")
    origin = (parsed.scheme.lower(), parsed.netloc.lower())
    if expected_origin is not None and origin != expected_origin:
        raise ValueError("cross-origin redirect is forbidden")
    if not PATH_RE.fullmatch(parsed.path) or parsed.query or parsed.fragment:
        raise ValueError("unsupported AnimeTVCut path")
    return parsed


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, origin: tuple[str, str]) -> None:
        self.origin = origin
        self.redirects = 0

    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        self.redirects += 1
        if self.redirects > MAX_REDIRECTS:
            raise urllib.error.HTTPError(new_url, code, "too many redirects", headers, file_pointer)
        validate_url(new_url, self.origin)
        return super().redirect_request(request, file_pointer, code, message, headers, new_url)


def main() -> int:
    if len(sys.argv) != 3:
        return 2
    url = sys.argv[1]
    try:
        timeout = max(1.0, min(float(sys.argv[2]), 30.0))
        parsed = validate_url(url)
        origin = (parsed.scheme.lower(), parsed.netloc.lower())
        opener = urllib.request.build_opener(SafeRedirectHandler(origin))
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        with opener.open(request, timeout=timeout) as response:
            content_length = response.headers.get("Content-Length")
            if content_length is not None and int(content_length) > MAX_BYTES:
                return 3
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                return 3
            sys.stdout.buffer.write(body)
        return 0
    except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError):
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
