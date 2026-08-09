local core = {}

local allowed_types = { intro = true, outro = true, recap = true, preview = true }
local allowed_reasons = {
    policy_kept = true,
    alignment_retained = true,
    partially_retained = true,
}

local function finite(value)
    return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

function core.derive_segments_url(value)
    if type(value) ~= "string" or #value > 4096 then return nil end
    local scheme, authority, path = value:match("^(https?)://([^/]+)(/[^?#]*)")
    if not scheme or authority:find("@", 1, true) then return nil end
    local cut_id, suffix = path:match("^/media/cut/([A-Za-z0-9_-]+)/(.+)$")
    if not cut_id or #cut_id > 128 then return nil end
    if suffix ~= "master.m3u8" and
       not suffix:match("^segment/[A-Za-z0-9_.-]+$") then return nil end
    return scheme .. "://" .. authority .. "/media/cut/" .. cut_id .. "/segments.json"
end

function core.validate_payload(value)
    if type(value) ~= "table" or value.version ~= 1 or
       not finite(value.duration) or value.duration <= 0 or
       type(value.segments) ~= "table" or #value.segments > 1024 then
        return nil
    end
    local result, ids = {}, {}
    for index, item in ipairs(value.segments) do
        if type(item) ~= "table" or type(item.id) ~= "string" or
           not item.id:match("^[A-Za-z0-9_-]+$") or #item.id > 128 or ids[item.id] or
           not allowed_types[item.type] or type(item.title) ~= "string" or
           #item.title < 1 or #item.title > 128 or not allowed_reasons[item.reason] or
           not finite(item.start) or not finite(item["end"]) or item.start < 0 or
           item["end"] <= item.start or item["end"] > value.duration + 0.001 then
            return nil
        end
        ids[item.id] = true
        result[index] = {
            id = item.id,
            type = item.type,
            start = item.start,
            ["end"] = item["end"],
            title = item.title,
            reason = item.reason,
        }
    end
    table.sort(result, function(left, right)
        return left.start < right.start or
            (left.start == right.start and left["end"] < right["end"])
    end)
    for index = 2, #result do
        if result[index].start < result[index - 1]["end"] - 0.000001 then return nil end
    end
    return { version = 1, duration = value.duration, segments = result }
end

function core.active_segment(segments, position)
    if type(segments) ~= "table" or not finite(position) then return nil end
    for _, segment in ipairs(segments) do
        if segment.start <= position and position < segment["end"] then return segment end
    end
    return nil
end

function core.exact_skip_target(segment, position)
    if type(segment) ~= "table" or not finite(position) or position >= segment["end"] then
        return nil
    end
    return segment["end"]
end

function core.should_auto_skip(segment_type, options)
    if type(options) ~= "table" then return false end
    return (segment_type == "intro" and options.auto_skip_intro) or
        (segment_type == "outro" and options.auto_skip_outro) or
        (segment_type == "recap" and options.auto_skip_recap) or
        (segment_type == "preview" and options.auto_skip_preview) or false
end

function core.request_is_current(expected_generation, current_generation, expected_url, current_url)
    return expected_generation == current_generation and expected_url == current_url
end

function core.should_rearm(segment, position, previous_position)
    return type(segment) == "table" and finite(position) and finite(previous_position) and
        position < previous_position and position <= segment.start
end

return core
