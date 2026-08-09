# Stremio Enhanced skip controls

`AnimeTVCutSkip.plugin.js` is a native Stremio Enhanced plugin tested against
Stremio Enhanced `v1.2.0`. Copy it into the Enhanced plugin directory or install it
through Enhanced's plugin manager, then enable it in Enhanced settings.

The plugin activates only for AnimeTVCut media URLs. It derives the owning cut's
`segments.json`, validates the bounded version-1 payload, and displays an accessible
fixed skip button while playback is inside a retained intro, outro, recap, or preview.
The button seeks to the exact server-provided output end. Per-type automatic skipping
is available but disabled by default.

Route changes, video replacement, playback end, fetch cancellation, and plugin removal
clear the active state and overlay. The plugin does not call skip providers and does
not infer source-episode coordinates.
