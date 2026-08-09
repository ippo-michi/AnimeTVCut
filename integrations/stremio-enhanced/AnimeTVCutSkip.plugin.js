/**
 * @name AnimeTVCutSkip
 * @description Output-timeline skip buttons for AnimeTVCut streams.
 * @version 1.0.0
 * @author AnimeTVCut
 */

(() => {
  "use strict";

  const TYPES = new Set(["intro", "outro", "recap", "preview"]);
  const REASONS = new Set([
    "policy_kept",
    "alignment_retained",
    "partially_retained",
  ]);
  const MEDIA_PATH =
    /^\/media\/cut\/([A-Za-z0-9_-]{1,128})\/(?:master\.m3u8|segment\/[A-Za-z0-9_.-]{1,160})$/;
  const SETTINGS = [
    {
      key: "showButtons",
      label: "Show AnimeTVCut skip buttons",
      type: "toggle",
      defaultValue: true,
    },
    {
      key: "autoSkipIntro",
      label: "Automatically skip intros",
      type: "toggle",
      defaultValue: false,
    },
    {
      key: "autoSkipOutro",
      label: "Automatically skip outros",
      type: "toggle",
      defaultValue: false,
    },
    {
      key: "autoSkipRecap",
      label: "Automatically skip recaps",
      type: "toggle",
      defaultValue: false,
    },
    {
      key: "autoSkipPreview",
      label: "Automatically skip previews",
      type: "toggle",
      defaultValue: false,
    },
  ];

  function deriveSegmentsUrl(value) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return undefined;
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== ""
    )
      return undefined;
    const match = MEDIA_PATH.exec(parsed.pathname);
    if (!match || !match[1]) return undefined;
    return `${parsed.origin}/media/cut/${match[1]}/segments.json`;
  }

  function validatePayload(value) {
    if (
      !value ||
      typeof value !== "object" ||
      value.version !== 1 ||
      !Number.isFinite(value.duration) ||
      value.duration <= 0 ||
      !Array.isArray(value.segments) ||
      value.segments.length > 1024
    )
      return undefined;
    const segments = [];
    const ids = new Set();
    for (const item of value.segments) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) ||
        ids.has(item.id) ||
        !TYPES.has(item.type) ||
        typeof item.title !== "string" ||
        item.title.length < 1 ||
        item.title.length > 128 ||
        !REASONS.has(item.reason) ||
        !Number.isFinite(item.start) ||
        !Number.isFinite(item.end) ||
        item.start < 0 ||
        item.end <= item.start ||
        item.end > value.duration + 0.001
      )
        return undefined;
      ids.add(item.id);
      segments.push(
        Object.freeze({
          id: item.id,
          type: item.type,
          start: item.start,
          end: item.end,
          title: item.title,
          reason: item.reason,
        }),
      );
    }
    segments.sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
    for (let index = 1; index < segments.length; index += 1) {
      if (segments[index].start < segments[index - 1].end - 0.000001)
        return undefined;
    }
    return Object.freeze({
      version: 1,
      duration: value.duration,
      segments: Object.freeze(segments),
    });
  }

  function activeSegment(segments, currentTime) {
    if (!Number.isFinite(currentTime)) return undefined;
    return segments.find(
      (segment) => segment.start <= currentTime && currentTime < segment.end,
    );
  }

  function shouldAutoSkip(type, settings) {
    return Boolean(
      (type === "intro" && settings.autoSkipIntro) ||
      (type === "outro" && settings.autoSkipOutro) ||
      (type === "recap" && settings.autoSkipRecap) ||
      (type === "preview" && settings.autoSkipPreview),
    );
  }

  function exactSkipTarget(segment, currentTime) {
    return segment && Number.isFinite(currentTime) && currentTime < segment.end
      ? segment.end
      : undefined;
  }

  function requestIsCurrent(
    expectedGeneration,
    currentGeneration,
    expectedUrl,
    currentUrl,
  ) {
    return (
      expectedGeneration === currentGeneration && expectedUrl === currentUrl
    );
  }

  function shouldRearm(segment, currentTime, previousTime) {
    return Boolean(
      segment &&
      Number.isFinite(currentTime) &&
      Number.isFinite(previousTime) &&
      currentTime < previousTime &&
      currentTime <= segment.start,
    );
  }

  const core = Object.freeze({
    SETTINGS,
    activeSegment,
    deriveSegmentsUrl,
    exactSkipTarget,
    requestIsCurrent,
    shouldAutoSkip,
    shouldRearm,
    validatePayload,
  });
  globalThis.AnimeTVCutSkipCore = core;

  if (typeof document === "undefined" || typeof window === "undefined") return;

  const api =
    typeof StremioEnhancedAPI === "undefined" ? undefined : StremioEnhancedAPI;
  const pluginId = "AnimeTVCutSkip.plugin.js";
  const defaultSettings = Object.fromEntries(
    SETTINGS.map((setting) => [setting.key, setting.defaultValue]),
  );
  let settings = { ...defaultSettings };
  let generation = 0;
  let video;
  let payload;
  let button;
  let abortController;
  let activeSegmentsUrl;
  let lastTime = 0;
  let resourceEpoch = 0;
  const skipped = new Set();
  let destroyed = false;

  function log(message) {
    if (api?.logger) api.logger.error(message);
  }

  function removeButton() {
    button?.remove();
    button = undefined;
  }

  function cleanupPlayback() {
    generation += 1;
    abortController?.abort();
    abortController = undefined;
    if (video) {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("ended", cleanupPlayback);
    }
    video = undefined;
    payload = undefined;
    activeSegmentsUrl = undefined;
    lastTime = 0;
    skipped.clear();
    removeButton();
    resourceEpoch = performance.now();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cleanupPlayback();
    observer.disconnect();
    clearInterval(timer);
    window.removeEventListener("hashchange", onRouteChange);
  }

  function manualSkip(segment) {
    const target = exactSkipTarget(segment, video?.currentTime);
    if (target === undefined || !video) return;
    video.currentTime = target;
  }

  function renderButton(segment) {
    if (!settings.showButtons || !segment) {
      removeButton();
      return;
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-live", "polite");
      button.style.cssText =
        "position:fixed;right:4vw;bottom:12vh;z-index:2147483647;padding:12px 18px;border:1px solid rgba(255,255,255,.65);border-radius:6px;background:rgba(15,15,18,.86);color:#fff;font:600 15px system-ui;cursor:pointer";
      document.body.append(button);
    }
    button.textContent = segment.title;
    button.onclick = () => manualSkip(segment);
  }

  function onSeeking() {
    if (!video || !payload) return;
    const current = video.currentTime;
    if (current < lastTime) {
      for (const segment of payload.segments) {
        if (shouldRearm(segment, current, lastTime)) skipped.delete(segment.id);
      }
    }
    lastTime = current;
  }

  function onTimeUpdate() {
    if (!video || !payload) return;
    const current = video.currentTime;
    if (current + 0.25 < lastTime) onSeeking();
    lastTime = current;
    const segment = activeSegment(payload.segments, current);
    if (
      segment &&
      shouldAutoSkip(segment.type, settings) &&
      !skipped.has(segment.id)
    ) {
      skipped.add(segment.id);
      manualSkip(segment);
      renderButton(undefined);
      return;
    }
    renderButton(segment);
  }

  async function loadForVideo(candidateVideo) {
    let sameVideo = video === candidateVideo;
    const candidates = [candidateVideo.currentSrc, candidateVideo.src]
      .filter(Boolean)
      .concat(
        performance
          .getEntriesByType("resource")
          .filter((entry) => entry.startTime >= resourceEpoch)
          .map((entry) => entry.name),
      )
      .reverse();
    const segmentsUrl = candidates
      .map(deriveSegmentsUrl)
      .find((value) => value !== undefined);
    if (
      sameVideo &&
      segmentsUrl !== undefined &&
      activeSegmentsUrl !== undefined &&
      segmentsUrl !== activeSegmentsUrl
    ) {
      sameVideo = false;
    }
    if (sameVideo && (payload || abortController)) return;
    if (!sameVideo) {
      cleanupPlayback();
      video = candidateVideo;
      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("seeking", onSeeking);
      video.addEventListener("ended", cleanupPlayback, { once: true });
    }
    const token = generation;
    if (!segmentsUrl) return;
    activeSegmentsUrl = segmentsUrl;
    const controller = new AbortController();
    abortController = controller;
    try {
      const response = await fetch(segmentsUrl, {
        signal: controller.signal,
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > 262144) return;
      const text = await response.text();
      if (
        text.length > 262144 ||
        !requestIsCurrent(token, generation, segmentsUrl, activeSegmentsUrl) ||
        video !== candidateVideo
      )
        return;
      payload = validatePayload(JSON.parse(text));
      onTimeUpdate();
    } catch {
      if (!controller.signal.aborted) log("AnimeTVCut skip metadata failed");
    } finally {
      if (abortController === controller) abortController = undefined;
    }
  }

  function scan() {
    if (destroyed) return;
    const candidate = document.querySelector("video");
    if (candidate && !candidate.ended) void loadForVideo(candidate);
    else if (video) cleanupPlayback();
  }

  async function reloadSettings(saved) {
    if (destroyed) return;
    if (saved && typeof saved === "object") {
      settings = { ...settings, ...saved };
      onTimeUpdate();
      return;
    }
    if (!api?.getSetting) return;
    const entries = await Promise.all(
      SETTINGS.map(async (setting) => {
        const value = await api.getSetting(setting.key);
        return [setting.key, value ?? setting.defaultValue];
      }),
    );
    settings = { ...defaultSettings, ...Object.fromEntries(entries) };
    onTimeUpdate();
  }

  if (api?.registerSettings)
    api
      .registerSettings(SETTINGS)
      .catch(() => log("AnimeTVCut settings registration failed"));
  if (api?.onSettingsSaved)
    api.onSettingsSaved((saved) => void reloadSettings(saved));
  void reloadSettings();
  function onRouteChange() {
    cleanupPlayback();
    queueMicrotask(scan);
  }
  const observer = new MutationObserver(() => {
    if (!document.getElementById(pluginId)) {
      destroy();
      return;
    }
    scan();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("hashchange", onRouteChange);
  const timer = setInterval(scan, 500);
  scan();
})();
