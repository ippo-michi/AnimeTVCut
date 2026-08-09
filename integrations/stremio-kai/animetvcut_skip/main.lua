local mp = require("mp")
local utils = require("mp.utils")
local options = require("mp.options")
local core = require("animetvcut_skip.core")

local config = {
    show_notifications = true,
    auto_skip_intro = false,
    auto_skip_outro = false,
    auto_skip_recap = false,
    auto_skip_preview = false,
    request_timeout_seconds = 8,
}
options.read_options(config, "animetvcut_skip")

local state = {
    generation = 0,
    payload = nil,
    active = nil,
    skipped = {},
    last_position = 0,
    key_bound = false,
}

local function unbind_key()
    if state.key_bound then
        mp.remove_key_binding("animetvcut-skip")
        state.key_bound = false
    end
end

local function cleanup()
    state.generation = state.generation + 1
    state.payload = nil
    state.active = nil
    state.skipped = {}
    state.last_position = 0
    unbind_key()
end

local function seek_segment(segment, position)
    local target = core.exact_skip_target(segment, position)
    if target then mp.commandv("seek", tostring(target), "absolute", "exact") end
end

local function manual_skip()
    if state.active then seek_segment(state.active, mp.get_property_number("time-pos", 0)) end
end

local function update_position(_, position)
    if not state.payload or type(position) ~= "number" then return end
    if position + 0.25 < state.last_position then
        for _, segment in ipairs(state.payload.segments) do
            if core.should_rearm(segment, position, state.last_position) then state.skipped[segment.id] = nil end
        end
    end
    state.last_position = position
    local segment = core.active_segment(state.payload.segments, position)
    if segment and core.should_auto_skip(segment.type, config) and not state.skipped[segment.id] then
        state.skipped[segment.id] = true
        seek_segment(segment, position)
        segment = nil
    end
    if segment == state.active then return end
    state.active = segment
    unbind_key()
    if segment then
        mp.add_forced_key_binding("TAB", "animetvcut-skip", manual_skip)
        state.key_bound = true
        if config.show_notifications then
            mp.osd_message(segment.title .. " — Press Tab", 1.25)
        end
    end
end

local function python_path()
    local script = mp.get_script_directory()
    local portable_root = utils.join_path(script, "../../..")
    local bundled = utils.join_path(portable_root, "python.exe")
    local info = utils.file_info(bundled)
    if info and info.is_file then return bundled end
    return "python"
end

local function load_segments()
    cleanup()
    local source = mp.get_property("stream-open-filename") or mp.get_property("path")
    local url = core.derive_segments_url(source)
    if not url then return end
    local generation = state.generation
    local expected_url = url
    local helper = utils.join_path(mp.get_script_directory(), "fetch_segments.py")
    mp.command_native_async({
        name = "subprocess",
        playback_only = false,
        capture_stdout = true,
        capture_stderr = true,
        args = { python_path(), helper, url, tostring(config.request_timeout_seconds) },
    }, function(success, result)
        local current_source = mp.get_property("stream-open-filename") or mp.get_property("path")
        local current_url = core.derive_segments_url(current_source)
        if not core.request_is_current(generation, state.generation, expected_url, current_url) or
           not success or not result or result.status ~= 0 or
           type(result.stdout) ~= "string" or #result.stdout > 262144 then return end
        local decoded = utils.parse_json(result.stdout)
        state.payload = core.validate_payload(decoded)
        if state.payload then update_position(nil, mp.get_property_number("time-pos", 0)) end
    end)
end

mp.observe_property("time-pos", "number", update_position)
mp.register_event("file-loaded", load_segments)
mp.register_event("end-file", cleanup)
mp.register_event("shutdown", cleanup)
