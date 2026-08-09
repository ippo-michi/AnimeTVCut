package.path = "integrations/stremio-kai/?.lua;" .. package.path

local core = require("animetvcut_skip.core")

local function equal(actual, expected, message)
    if actual ~= expected then
        error((message or "values differ") .. ": expected " .. tostring(expected) .. ", got " .. tostring(actual))
    end
end

equal(
    core.derive_segments_url("https://atc.example/media/cut/cut_123/master.m3u8"),
    "https://atc.example/media/cut/cut_123/segments.json",
    "master URL"
)
equal(
    core.derive_segments_url("https://atc.example/media/cut/cut_123/segment/r001.m4s"),
    "https://atc.example/media/cut/cut_123/segments.json",
    "segment URL"
)
equal(core.derive_segments_url("https://user:secret@atc.example/media/cut/a/master.m3u8"), nil)
equal(core.derive_segments_url("https://atc.example/health"), nil)

local payload = core.validate_payload({
    version = 1,
    duration = 180,
    segments = {
        { id = "s01", type = "intro", start = 0, ["end"] = 6, title = "Skip Intro", reason = "policy_kept" },
        { id = "s02", type = "recap", start = 60, ["end"] = 66, title = "Skip Recap", reason = "alignment_retained" },
        { id = "s03", type = "outro", start = 174, ["end"] = 180, title = "Skip Outro", reason = "partially_retained" },
    },
})
equal(#payload.segments, 3)
equal(core.active_segment(payload.segments, 0).id, "s01")
equal(core.active_segment(payload.segments, 5.999).id, "s01")
equal(core.active_segment(payload.segments, 6), nil)
equal(core.exact_skip_target(payload.segments[2], 62), 66)
equal(core.exact_skip_target(payload.segments[2], 66), nil)
equal(core.should_auto_skip("intro", { auto_skip_intro = false }), false)
equal(core.should_auto_skip("intro", { auto_skip_intro = true }), true)
equal(core.request_is_current(2, 2, "cut-a", "cut-a"), true)
equal(core.request_is_current(2, 3, "cut-a", "cut-a"), false)
equal(core.request_is_current(2, 2, "cut-a", "cut-b"), false)
equal(core.should_rearm({ start = 10 }, 9, 25), true)
equal(core.should_rearm({ start = 10 }, 15, 25), false)
equal(core.should_rearm({ start = 10 }, 9, 8), false)

equal(core.validate_payload({ version = 2, duration = 1, segments = {} }), nil)
equal(core.validate_payload({
    version = 1,
    duration = 10,
    segments = {
        { id = "a", type = "intro", start = 0, ["end"] = 6, title = "A", reason = "policy_kept" },
        { id = "b", type = "outro", start = 5, ["end"] = 8, title = "B", reason = "policy_kept" },
    },
}), nil)

print("Stremio-Kai AnimeTVCut core tests passed")
