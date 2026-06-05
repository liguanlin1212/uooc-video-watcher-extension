const REFRESH_INTERVAL_MS = 3000;

const statusLabels = {
  idle: "未检测到视频",
  playing: "正在播放",
  paused_pending: "已暂停，等待 10 秒阈值",
  paused_alerted: "已暂停，且已提醒",
  ended: "已播放结束",
  blocked_suspected: "疑似被弹窗或题目卡住",
  snoozed: "你已标记“我确实要暂停”"
};

const globalToggle = document.getElementById("globalToggle");
const manualAntiPauseButton = document.getElementById("manualAntiPauseButton");
const manualAntiPauseStatus = document.getElementById("manualAntiPauseStatus");
const testSoundButton = document.getElementById("testSoundButton");
const tabList = document.getElementById("tabList");
const tabCount = document.getElementById("tabCount");
const tabTemplate = document.getElementById("tabTemplate");

let activeTabId = null;
let refreshTimerId = null;

initialize().catch((error) => {
  console.error("Popup initialization failed", error);
  renderEmptyState("扩展初始化失败。");
});

async function initialize() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  activeTabId = activeTab?.id ?? null;
  globalToggle.addEventListener("change", handleGlobalToggleChange);
  manualAntiPauseButton.addEventListener("click", handleManualAntiPauseClick);
  testSoundButton.addEventListener("click", handleTestSoundClick);

  await refreshState();

  refreshTimerId = window.setInterval(() => {
    void refreshState();
  }, REFRESH_INTERVAL_MS);

  window.addEventListener("unload", () => {
    if (refreshTimerId) {
      window.clearInterval(refreshTimerId);
    }
  });
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({
    type: "GET_MONITOR_STATE",
    activeTabId
  });

  if (!response?.ok) {
    renderEmptyState("未能读取扩展状态。");
    return;
  }

  globalToggle.checked = Boolean(response.globalEnabled);
  renderTabList(response.tabs || []);
}

async function handleGlobalToggleChange(event) {
  await chrome.runtime.sendMessage({
    type: "SET_GLOBAL_MONITORING",
    enabled: event.target.checked
  });
  await refreshState();
}

async function handleManualAntiPauseClick() {
  manualAntiPauseStatus.textContent = "";

  if (!Number.isFinite(activeTabId)) {
    manualAntiPauseStatus.textContent = "当前没有可执行的活动标签页。";
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "RUN_MANUAL_ANTI_PAUSE",
    tabId: activeTabId
  });

  manualAntiPauseStatus.textContent = response?.ok
    ? "已对当前页面执行一次书签同款逻辑。"
    : `执行失败：${response?.error || "未知错误"}`;
}

async function handleTestSoundClick() {
  try {
    await chrome.runtime.sendMessage({ type: "TEST_SOUND" });
  } catch (error) {
    console.error("Test sound failed", error);
  }
}

function renderTabList(tabs) {
  tabList.textContent = "";
  tabCount.textContent = String(tabs.length);

  if (tabs.length === 0) {
    renderEmptyState("打开 UOOC 视频页后，这里会显示正在监控的标签页。");
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const tabState of tabs) {
    fragment.appendChild(renderTabCard(tabState));
  }
  tabList.appendChild(fragment);
}

function renderEmptyState(message) {
  tabList.textContent = "";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  tabList.appendChild(empty);
  tabCount.textContent = "0";
}

function renderTabCard(tabState) {
  const node = tabTemplate.content.firstElementChild.cloneNode(true);
  const title = node.querySelector(".tab-title");
  const status = node.querySelector(".tab-status");
  const monitorToggle = node.querySelector(".monitor-toggle");
  const snoozeButton = node.querySelector(".snooze-button");
  const alertTime = node.querySelector(".tab-alert-time");

  title.textContent = tabState.title || `标签页 ${tabState.tabId}`;
  status.textContent = buildStatusText(tabState);
  monitorToggle.checked = Boolean(tabState.monitoringEnabled);
  alertTime.textContent = tabState.lastAlertAt
    ? `最近提醒：${formatTime(tabState.lastAlertAt)}`
    : "最近提醒：无";

  monitorToggle.addEventListener("change", async (event) => {
    await chrome.runtime.sendMessage({
      type: "SET_TAB_MONITORING",
      tabId: tabState.tabId,
      enabled: event.target.checked
    });
    await refreshState();
  });

  const snoozed = Boolean(tabState.snoozed);
  snoozeButton.textContent = snoozed ? "恢复提醒" : "我确实要暂停";
  snoozeButton.disabled = !tabState.monitoringEnabled;
  snoozeButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: snoozed ? "UNSNOOZE_TAB" : "SNOOZE_TAB",
      tabId: tabState.tabId
    });
    await refreshState();
  });

  if (tabState.isActive) {
    node.style.borderColor = "rgba(194, 126, 20, 0.42)";
  }

  return node;
}

function buildStatusText(tabState) {
  const label = statusLabels[tabState.status] || "状态未知";
  const pieces = [label];

  if (Number.isFinite(tabState.currentTime) && Number.isFinite(tabState.duration) && tabState.duration > 0) {
    pieces.push(`进度 ${formatClock(tabState.currentTime)} / ${formatClock(tabState.duration)}`);
  }

  return pieces.join(" · ");
}

function formatClock(seconds) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(remainSeconds)}`;
  }

  return `${minutes}:${pad(remainSeconds)}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
