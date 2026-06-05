const STORAGE_KEY = "monitorState";
const OFFSCREEN_URL = "offscreen.html";
const NOTIFICATION_TITLE = "UOOC 视频提醒";
const NOTIFICATION_ICON_URL = chrome.runtime.getURL("icon-128.png");
const ALERT_POPUP_URL = "alert.html";
const PAUSE_THRESHOLD_SECONDS = 10;

const state = {
  globalEnabled: true,
  tabs: {}
};

let stateLoaded = false;
let offscreenReadyPromise = null;
const alertWindowsByTabId = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("Message handling failed", error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

chrome.notifications.onClicked.addListener((notificationId) => {
  void handleNotificationClick(notificationId);
});

initialize().catch((error) => {
  console.error("Failed to initialize background worker", error);
});

async function initialize() {
  await loadState();
  await reconcileTrackedTabs();

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (!state.tabs[tabId]) {
      return;
    }

    delete state.tabs[tabId];
    alertWindowsByTabId.delete(tabId);
    void persistState();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const tabState = state.tabs[tabId];
    if (!tabState) {
      return;
    }

    if (changeInfo.status === "loading") {
      resetRuntimeState(tabId, { keepSnooze: false });
    }

    if (typeof changeInfo.title === "string" && changeInfo.title) {
      tabState.title = changeInfo.title;
    } else if (tab?.title) {
      tabState.title = tab.title;
    }

    if (typeof changeInfo.url === "string" && changeInfo.url) {
      tabState.url = changeInfo.url;
    } else if (tab?.url) {
      tabState.url = tab.url;
    }

    void persistState();
  });
}

async function reconcileTrackedTabs() {
  const openTabs = await chrome.tabs.query({
    url: ["https://www.uooc.net.cn/*"]
  });

  const openTabsById = new Map(openTabs.map((tab) => [tab.id, tab]));
  let changed = false;

  for (const tabId of Object.keys(state.tabs)) {
    const numericTabId = Number(tabId);
    const liveTab = openTabsById.get(numericTabId);

    if (!liveTab) {
      delete state.tabs[tabId];
      changed = true;
      continue;
    }

    const tabState = state.tabs[tabId];
    if (liveTab.title && liveTab.title !== tabState.title) {
      tabState.title = liveTab.title;
      changed = true;
    }

    if (liveTab.url && liveTab.url !== tabState.url) {
      tabState.url = liveTab.url;
      changed = true;
    }
  }

  if (changed) {
    await persistState();
  }
}

async function handleMessage(message, sender) {
  await ensureStateLoaded();

  switch (message?.type) {
    case "STATUS_UPDATE":
      return handleStatusUpdate(message.payload, sender);
    case "ALERT_EVENT":
      return handleAlertEvent(message.payload, sender);
    case "GET_MONITOR_STATE":
      return buildPopupState(message.activeTabId ?? null);
    case "SET_GLOBAL_MONITORING":
      state.globalEnabled = Boolean(message.enabled);
      await persistState();
      return { ok: true, globalEnabled: state.globalEnabled };
    case "SET_TAB_MONITORING":
      return setTabMonitoring(message.tabId, message.enabled);
    case "SNOOZE_TAB":
      return setTabSnooze(message.tabId, true);
    case "UNSNOOZE_TAB":
      return setTabSnooze(message.tabId, false);
    case "RUN_MANUAL_ANTI_PAUSE":
      return runManualAntiPause(message.tabId);
    case "TEST_SOUND":
      await playAlertSound();
      return { ok: true };
    case "GET_ALERT_CONTEXT":
      return getAlertContext(message.tabId, message.reason);
    case "DISMISS_ALERT_WINDOW":
      dismissAlertWindow(message.tabId);
      return { ok: true };
    case "FOCUS_MONITORED_TAB":
      await focusMonitoredTab(message.tabId);
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message type: ${message?.type ?? "undefined"}` };
  }
}

async function handleStatusUpdate(payload, sender) {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    return { ok: false, error: "Missing tab id" };
  }

  const tabState = ensureTabState(tabId, {
    title: payload?.title || sender.tab?.title || `标签页 ${tabId}`,
    url: payload?.url || sender.tab?.url || ""
  });

  tabState.title = payload?.title || sender.tab?.title || tabState.title;
  tabState.url = payload?.url || sender.tab?.url || tabState.url;
  tabState.lastSeenAt = Date.now();
  tabState.videoPresent = payload?.kind !== "video-missing";

  if (isFiniteNumber(payload?.currentTime)) {
    tabState.currentTime = payload.currentTime;
  }

  if (isFiniteNumber(payload?.duration)) {
    tabState.duration = payload.duration;
  }

  if (payload?.kind === "progress") {
    tabState.lastProgressAt = Date.now();
  }

  switch (payload?.kind) {
    case "play":
      tabState.status = "playing";
      tabState.pausedSince = null;
      tabState.blockedSince = null;
      tabState.pendingPauseAlert = false;
      tabState.pauseAlerted = false;
      tabState.blockedAlerted = false;
      tabState.endedAlerted = false;
      tabState.lastProgressAt = Date.now();
      if (tabState.snoozed) {
        tabState.snoozed = false;
        tabState.snoozeReason = null;
      }
      break;
    case "pause":
      tabState.pausedSince = payload.pausedSince || Date.now();
      tabState.pendingPauseAlert = !tabState.pauseAlerted;
      if (!tabState.snoozed) {
        tabState.status = tabState.pauseAlerted ? "paused_alerted" : "paused_pending";
      }
      break;
    case "ended":
      tabState.status = "ended";
      tabState.pausedSince = null;
      tabState.pendingPauseAlert = false;
      await maybeAlert(tabId, tabState, "ended");
      break;
    case "waiting":
    case "stalled":
      if (!tabState.snoozed && tabState.status === "playing") {
        tabState.status = "paused_pending";
      }
      break;
    case "video-missing":
      tabState.status = "idle";
      tabState.pausedSince = null;
      tabState.pendingPauseAlert = false;
      break;
    default:
      break;
  }

  await persistState();
  return { ok: true };
}

async function handleAlertEvent(payload, sender) {
  const tabId = sender.tab?.id ?? payload?.tabId;
  if (typeof tabId !== "number") {
    return { ok: false, error: "Missing tab id" };
  }

  const tabState = ensureTabState(tabId, {
    title: payload?.title || sender.tab?.title || `标签页 ${tabId}`,
    url: payload?.url || sender.tab?.url || ""
  });

  tabState.title = payload?.title || sender.tab?.title || tabState.title;
  tabState.url = payload?.url || sender.tab?.url || tabState.url;

  if (payload?.kind === "pause-timeout") {
    await maybeAlert(tabId, tabState, "pause-timeout");
  } else if (payload?.kind === "blocked-suspected") {
    tabState.blockedSince = payload.blockedSince || Date.now();
    await maybeAlert(tabId, tabState, "blocked-suspected");
  }

  await persistState();
  return { ok: true };
}

function ensureTabState(tabId, initial = {}) {
  if (!state.tabs[tabId]) {
    state.tabs[tabId] = {
      tabId,
      title: initial.title || `标签页 ${tabId}`,
      url: initial.url || "",
      status: "idle",
      monitoringEnabled: true,
      snoozed: false,
      snoozeReason: null,
      pausedSince: null,
      blockedSince: null,
      lastSeenAt: null,
      lastProgressAt: null,
      lastAlertAt: null,
      lastAlertType: null,
      currentTime: 0,
      duration: 0,
      pendingPauseAlert: false,
      pauseAlerted: false,
      blockedAlerted: false,
      endedAlerted: false,
      videoPresent: false
    };
  }

  return state.tabs[tabId];
}

async function maybeAlert(tabId, tabState, reason) {
  if (!state.globalEnabled || !tabState.monitoringEnabled) {
    return;
  }

  if (tabState.snoozed && reason === "pause-timeout") {
    tabState.status = "snoozed";
    return;
  }

  if (reason === "pause-timeout") {
    if (tabState.pauseAlerted) {
      return;
    }
    tabState.pauseAlerted = true;
    tabState.pendingPauseAlert = false;
    tabState.status = "paused_alerted";
  } else if (reason === "ended") {
    if (tabState.endedAlerted) {
      return;
    }
    tabState.endedAlerted = true;
    tabState.status = "ended";
  } else if (reason === "blocked-suspected") {
    if (tabState.blockedAlerted) {
      return;
    }
    tabState.blockedAlerted = true;
    tabState.status = "blocked_suspected";
  }

  tabState.lastAlertAt = Date.now();
  tabState.lastAlertType = reason;

  await showNotification(tabId, tabState, reason);
  await playAlertSound();
  await showAlertWindow(tabId, reason);
}

async function showNotification(tabId, tabState, reason) {
  const notificationId = `uooc-${tabId}-${reason}`;
  const message = buildNotificationMessage(tabState, reason);

  await chrome.notifications.create(notificationId, {
    type: "basic",
    title: NOTIFICATION_TITLE,
    message,
    iconUrl: NOTIFICATION_ICON_URL
  });
}

async function handleNotificationClick(notificationId) {
  const parts = notificationId.split("-");
  const tabId = Number(parts[1]);
  if (!Number.isFinite(tabId)) {
    return;
  }

  await focusMonitoredTab(tabId);
}

async function focusMonitoredTab(tabId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (error) {
    console.warn("Failed to focus tab for notification", error);
  }
}

function buildNotificationMessage(tabState, reason) {
  const title = tabState.title || "UOOC 视频";

  if (reason === "pause-timeout") {
    return `${title} 已暂停超过 ${PAUSE_THRESHOLD_SECONDS} 秒。`;
  }

  if (reason === "ended") {
    return `${title} 已播放结束，请手动切换下一个视频。`;
  }

  if (reason === "blocked-suspected") {
    return `${title} 疑似被题目或弹窗卡住，请回到页面确认。`;
  }

  return `${title} 状态异常，请检查页面。`;
}

async function showAlertWindow(tabId, reason) {
  const existingWindowId = alertWindowsByTabId.get(tabId);
  const url = `${ALERT_POPUP_URL}?tabId=${encodeURIComponent(tabId)}&reason=${encodeURIComponent(reason)}`;

  if (existingWindowId) {
    try {
      await chrome.windows.update(existingWindowId, {
        focused: true,
        drawAttention: true
      });
      return;
    } catch {
      alertWindowsByTabId.delete(tabId);
    }
  }

  const createdWindow = await chrome.windows.create({
    url,
    type: "popup",
    width: 420,
    height: 320,
    focused: true
  });

  if (typeof createdWindow.id === "number") {
    alertWindowsByTabId.set(tabId, createdWindow.id);
  }
}

function dismissAlertWindow(tabId) {
  const windowId = alertWindowsByTabId.get(tabId);
  if (!windowId) {
    return;
  }

  alertWindowsByTabId.delete(tabId);
  chrome.windows.remove(windowId).catch(() => {});
}

function getAlertContext(tabId, reason) {
  const tabState = state.tabs[tabId];
  if (!tabState) {
    return { ok: false, error: "Tab state not found" };
  }

  return {
    ok: true,
    tabId,
    reason,
    title: tabState.title || `标签页 ${tabId}`,
    message: buildNotificationMessage(tabState, reason),
    currentTime: tabState.currentTime,
    duration: tabState.duration
  };
}

async function setTabMonitoring(tabId, enabled) {
  const tabState = ensureTabState(tabId);
  tabState.monitoringEnabled = Boolean(enabled);

  if (!tabState.monitoringEnabled) {
    tabState.status = "idle";
  } else if (tabState.snoozed) {
    tabState.status = "snoozed";
  } else if (tabState.videoPresent) {
    tabState.status = tabState.pausedSince
      ? tabState.pauseAlerted
        ? "paused_alerted"
        : "paused_pending"
      : "playing";
  }

  await persistState();
  return { ok: true };
}

async function setTabSnooze(tabId, snoozed) {
  const tabState = ensureTabState(tabId);
  tabState.snoozed = Boolean(snoozed);
  tabState.snoozeReason = snoozed ? "manual" : null;

  if (tabState.snoozed) {
    tabState.status = "snoozed";
  } else if (tabState.videoPresent) {
    tabState.status = tabState.pausedSince
      ? tabState.pauseAlerted
        ? "paused_alerted"
        : "paused_pending"
      : "playing";
  } else {
    tabState.status = "idle";
  }

  await persistState();
  return { ok: true };
}

async function runManualAntiPause(tabId) {
  if (typeof tabId !== "number") {
    return { ok: false, error: "Missing tab id" };
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    return { ok: false, error: "Tab not found" };
  }

  if (!tab.url || !tab.url.startsWith("https://www.uooc.net.cn/")) {
    return { ok: false, error: "Current tab is not a UOOC page" };
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const jq = window.jQuery || window.$;
      if (typeof jq !== "function") {
        return {
          ok: false,
          error: "Current page does not expose jQuery/$"
        };
      }

      jq("html").off("mouseleave blur visibilitychange");

      return {
        ok: true
      };
    }
  });

  return result?.result || { ok: false, error: "Manual anti-pause injection returned no result" };
}

function resetRuntimeState(tabId, { keepSnooze }) {
  const tabState = ensureTabState(tabId);
  tabState.status = keepSnooze && tabState.snoozed ? "snoozed" : "idle";
  tabState.pausedSince = null;
  tabState.blockedSince = null;
  tabState.currentTime = 0;
  tabState.duration = 0;
  tabState.lastSeenAt = null;
  tabState.lastProgressAt = null;
  tabState.lastAlertAt = null;
  tabState.lastAlertType = null;
  tabState.pendingPauseAlert = false;
  tabState.pauseAlerted = false;
  tabState.blockedAlerted = false;
  tabState.endedAlerted = false;
  tabState.videoPresent = false;

  if (!keepSnooze) {
    tabState.snoozed = false;
    tabState.snoozeReason = null;
  }
}

async function loadState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  if (result[STORAGE_KEY]) {
    Object.assign(state, result[STORAGE_KEY]);
  }
  stateLoaded = true;
}

async function ensureStateLoaded() {
  if (!stateLoaded) {
    await loadState();
  }
}

async function persistState() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: state
  });
}

async function buildPopupState(activeTabId) {
  const tabs = Object.values(state.tabs)
    .sort((left, right) => (right.lastSeenAt || 0) - (left.lastSeenAt || 0))
    .map((tabState) => ({
      ...tabState,
      isActive: tabState.tabId === activeTabId
    }));

  return {
    ok: true,
    globalEnabled: state.globalEnabled,
    tabs
  };
}

async function playAlertSound() {
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    type: "PLAY_OFFSCREEN_SOUND"
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Failed to play offscreen sound");
  }
}

async function ensureOffscreenDocument() {
  if (offscreenReadyPromise) {
    return offscreenReadyPromise;
  }

  offscreenReadyPromise = (async () => {
    const offscreenDocumentUrl = chrome.runtime.getURL(OFFSCREEN_URL);
    const contexts = chrome.runtime.getContexts
      ? await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [offscreenDocumentUrl]
        })
      : [];

    if (contexts.length > 0) {
      return;
    }

    if (!chrome.offscreen?.createDocument) {
      throw new Error("Offscreen API is unavailable");
    }

    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play a short alert sound when monitored videos pause or end."
    });
  })();

  try {
    await offscreenReadyPromise;
  } finally {
    offscreenReadyPromise = null;
  }
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
