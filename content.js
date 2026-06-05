const PAUSE_THRESHOLD_MS = 10 * 1000;
const BLOCKED_THRESHOLD_MS = 15 * 1000;
const PROGRESS_THROTTLE_MS = 15 * 1000;
const HEARTBEAT_INTERVAL_MS = 5000;

const BLOCKING_SELECTORS = [
  ".el-dialog__wrapper",
  ".el-message-box__wrapper",
  ".ant-modal-wrap",
  ".ant-modal-mask",
  ".layui-layer",
  ".layui-layer-page",
  ".video-question",
  ".question-dialog",
  ".question-modal",
  ".exam-dialog",
  ".mask-layer",
  "[role='dialog']",
  "[class*='question']",
  "[class*='exam']",
  "[class*='topic']",
  "[class*='modal']",
  "[class*='dialog']",
  "[class*='mask']"
];

const state = {
  video: null,
  domObserverAttached: false,
  inspectTimerId: null,
  pauseTimerId: null,
  overlaySeenSince: null,
  lastProgressSentAt: 0,
  lastBlockedReportAt: 0,
  heartbeatStarted: false
};

bootstrap();

function bootstrap() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startMonitoring, { once: true });
    return;
  }

  startMonitoring();
}

function startMonitoring() {
  attachToBestVideo();
  observeDomChanges();
  window.addEventListener("focus", attachToBestVideo, { passive: true });

  if (state.heartbeatStarted) {
    return;
  }

  state.heartbeatStarted = true;
  window.setInterval(() => {
    attachToBestVideo();
    inspectPossibleBlocker();
    sendProgress("heartbeat");
  }, HEARTBEAT_INTERVAL_MS);
}

function observeDomChanges() {
  if (state.domObserverAttached) {
    return;
  }

  state.domObserverAttached = true;
  const observer = new MutationObserver(scheduleInspection);

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden"]
  });
}

function scheduleInspection() {
  if (state.inspectTimerId) {
    return;
  }

  state.inspectTimerId = window.setTimeout(() => {
    state.inspectTimerId = null;
    attachToBestVideo();
    inspectPossibleBlocker();
  }, 150);
}

function attachToBestVideo() {
  const nextVideo = pickBestVideo();
  if (!nextVideo) {
    if (state.video) {
      detachVideoListeners(state.video);
      state.video = null;
    }

    clearPauseTimer();
    void sendMessage({
      type: "STATUS_UPDATE",
      payload: buildPayload("video-missing")
    });
    return;
  }

  if (state.video === nextVideo) {
    return;
  }

  if (state.video) {
    detachVideoListeners(state.video);
  }

  state.video = nextVideo;
  attachVideoListeners(nextVideo);

  if (nextVideo.ended) {
    handleEnded();
  } else if (!nextVideo.paused) {
    handlePlay();
  } else {
    handlePause();
  }
}

function pickBestVideo() {
  const videos = [...document.querySelectorAll("video")].filter((video) => {
    const rect = video.getBoundingClientRect();
    return rect.width > 32 && rect.height > 32;
  });

  if (videos.length === 0) {
    return null;
  }

  videos.sort((left, right) => area(right) - area(left));
  return videos[0];
}

function area(video) {
  const rect = video.getBoundingClientRect();
  return rect.width * rect.height;
}

function attachVideoListeners(video) {
  video.addEventListener("play", handlePlay);
  video.addEventListener("pause", handlePause);
  video.addEventListener("ended", handleEnded);
  video.addEventListener("waiting", handleWaiting);
  video.addEventListener("stalled", handleStalled);
  video.addEventListener("error", handleError);
  video.addEventListener("timeupdate", handleTimeupdate);
  video.addEventListener("loadedmetadata", handleLoadedMetadata);
}

function detachVideoListeners(video) {
  video.removeEventListener("play", handlePlay);
  video.removeEventListener("pause", handlePause);
  video.removeEventListener("ended", handleEnded);
  video.removeEventListener("waiting", handleWaiting);
  video.removeEventListener("stalled", handleStalled);
  video.removeEventListener("error", handleError);
  video.removeEventListener("timeupdate", handleTimeupdate);
  video.removeEventListener("loadedmetadata", handleLoadedMetadata);
}

function handlePlay() {
  clearPauseTimer();
  state.overlaySeenSince = null;
  state.lastBlockedReportAt = 0;

  void sendMessage({
    type: "STATUS_UPDATE",
    payload: buildPayload("play")
  });
}

function handlePause() {
  clearPauseTimer();
  const pausedSince = Date.now();

  void sendMessage({
    type: "STATUS_UPDATE",
    payload: buildPayload("pause", { pausedSince })
  });

  state.pauseTimerId = window.setTimeout(() => {
    if (!state.video || !state.video.paused || state.video.ended) {
      return;
    }

    void sendMessage({
      type: "ALERT_EVENT",
      payload: buildPayload("pause-timeout", { pausedSince })
    });
  }, PAUSE_THRESHOLD_MS);
}

function handleEnded() {
  clearPauseTimer();
  state.overlaySeenSince = null;

  void sendMessage({
    type: "STATUS_UPDATE",
    payload: buildPayload("ended")
  });
}

function handleWaiting() {
  void sendMessage({
    type: "STATUS_UPDATE",
    payload: buildPayload("waiting")
  });
}

function handleStalled() {
  void sendMessage({
    type: "STATUS_UPDATE",
    payload: buildPayload("stalled")
  });
}

function handleError() {
  void sendMessage({
    type: "STATUS_UPDATE",
    payload: buildPayload("error")
  });
}

function handleTimeupdate() {
  sendProgress("progress");
}

function handleLoadedMetadata() {
  sendProgress("metadata");
}

function sendProgress(kind) {
  if (!state.video) {
    return;
  }

  const now = Date.now();
  if (kind === "progress" && now - state.lastProgressSentAt < PROGRESS_THROTTLE_MS) {
    return;
  }

  state.lastProgressSentAt = now;
  void sendMessage({
    type: "STATUS_UPDATE",
    payload: buildPayload("progress", { kind })
  });
}

function inspectPossibleBlocker() {
  if (!state.video || state.video.ended) {
    state.overlaySeenSince = null;
    return;
  }

  const blockingElement = findBlockingElement();
  if (!blockingElement || !state.video.paused) {
    state.overlaySeenSince = null;
    return;
  }

  if (!state.overlaySeenSince) {
    state.overlaySeenSince = Date.now();
    return;
  }

  const now = Date.now();
  if (now - state.overlaySeenSince < BLOCKED_THRESHOLD_MS) {
    return;
  }

  if (now - state.lastBlockedReportAt < BLOCKED_THRESHOLD_MS) {
    return;
  }

  state.lastBlockedReportAt = now;
  void sendMessage({
    type: "ALERT_EVENT",
    payload: buildPayload("blocked-suspected", {
      blockedSince: state.overlaySeenSince
    })
  });
}

function findBlockingElement() {
  for (const selector of BLOCKING_SELECTORS) {
    const matches = document.querySelectorAll(selector);
    for (const node of matches) {
      if (isBlocking(node)) {
        return node;
      }
    }
  }

  return null;
}

function isBlocking(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  const rect = node.getBoundingClientRect();
  if (rect.width < window.innerWidth * 0.25 || rect.height < window.innerHeight * 0.15) {
    return false;
  }

  if (rect.bottom < 0 || rect.right < 0) {
    return false;
  }

  if (!["fixed", "absolute", "sticky"].includes(style.position)) {
    return false;
  }

  const zIndex = Number.parseInt(style.zIndex || "0", 10);
  return Number.isFinite(zIndex) ? zIndex >= 10 : true;
}

function buildPayload(kind, extra = {}) {
  const video = state.video;

  return {
    kind,
    title: document.title,
    url: location.href,
    currentTime: video ? Number(video.currentTime || 0) : 0,
    duration: video ? Number(video.duration || 0) : 0,
    paused: video ? video.paused : false,
    ended: video ? video.ended : false,
    ...extra
  };
}

async function sendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.debug("Extension message failed", error);
    return null;
  }
}

function clearPauseTimer() {
  if (!state.pauseTimerId) {
    return;
  }

  window.clearTimeout(state.pauseTimerId);
  state.pauseTimerId = null;
}
