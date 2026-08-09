# Stremio-Kai AnimeTVCut companion

This is a standalone mpv Lua companion tested against Stremio-Kai `v4.8.0-Hotfix`.
It does not patch or overwrite Kai's native `notify_skip` implementation. Kai currently
has no stable public hook for injecting externally supplied, final-output skip ranges,
so isolation is safer and keeps upstream updates replaceable.

Install from PowerShell:

```powershell
.\install.ps1 -KaiDirectory "C:\path\to\Stremio-Kai"
```

Restart Stremio-Kai. During an AnimeTVCut stream, a bounded helper fetches that cut's
same-origin `segments.json`. Inside a retained segment, the companion shows an mpv OSD
message and temporarily binds **Tab** to an exact seek to the segment end. Per-type
automatic skipping is disabled by default and can be enabled in
`portable_config/script-opts/animetvcut_skip.conf`.

The companion is inactive for non-AnimeTVCut media. It does not infer IntroDB ranges,
rewrite chapters, or expose provider/source timestamps. The standalone interface is
keyboard/OSD based; Kai's native clickable overlay and gamepad bridge are not claimed
as stable integration points in this version.

Uninstall only AnimeTVCut-owned files:

```powershell
.\uninstall.ps1 -KaiDirectory "C:\path\to\Stremio-Kai"
```
