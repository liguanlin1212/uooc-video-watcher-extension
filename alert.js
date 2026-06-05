const params = new URLSearchParams(window.location.search);
const tabId = Number(params.get("tabId"));
const reason = params.get("reason") || "";

const alertTitle = document.getElementById("alertTitle");
const alertMessage = document.getElementById("alertMessage");
const alertProgress = document.getElementById("alertProgress");
const openTabButton = document.getElementById("openTabButton");
const closeButton = document.getElementById("closeButton");

initialize().catch((error) => {
  console.error("Alert window initialization failed", error);
  alertTitle.textContent = "提醒加载失败";
  alertMessage.textContent = error.message || "无法读取提醒内容。";
});

async function initialize() {
  if (!Number.isFinite(tabId)) {
    throw new Error("无效的标签页参数。");
  }

  const response = await chrome.runtime.sendMessage({
    type: "GET_ALERT_CONTEXT",
    tabId,
    reason
  });

  if (!response?.ok) {
    throw new Error(response?.error || "无法读取提醒上下文。");
  }

  alertTitle.textContent = response.title;
  alertMessage.textContent = response.message;
  alertProgress.textContent =
    Number.isFinite(response.currentTime) && Number.isFinite(response.duration) && response.duration > 0
      ? `当前进度：${formatClock(response.currentTime)} / ${formatClock(response.duration)}`
      : "";

  openTabButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: "FOCUS_MONITORED_TAB",
      tabId
    });
    await closeWindow();
  });

  closeButton.addEventListener("click", async () => {
    await closeWindow();
  });
}

async function closeWindow() {
  await chrome.runtime.sendMessage({
    type: "DISMISS_ALERT_WINDOW",
    tabId
  });
  window.close();
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
