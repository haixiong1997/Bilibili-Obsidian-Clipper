const el = {
  status: document.getElementById("status"),
  message: document.getElementById("message"),
  propTitle: document.getElementById("propTitle"),
  propUrl: document.getElementById("propUrl"),
  propCreated: document.getElementById("propCreated"),
  propTags: document.getElementById("propTags"),
  subtitleSelect: document.getElementById("subtitleSelect"),
  preview: document.getElementById("preview"),
  refreshBtn: document.getElementById("refreshBtn"),
  copyBtn: document.getElementById("copyBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  sendBtn: document.getElementById("sendBtn"),
  settingsBtn: document.getElementById("settingsBtn")
};

let latestPayload = null;
let localBusy = false;

init().catch((error) => {
  setStatus(`初始化失败：${error.message}`);
});

async function init() {
  bindEvents();
  syncActionState();
  await refreshFromTab();
}

function bindEvents() {
  el.refreshBtn.addEventListener("click", async () => {
    await refreshFromTab();
  });

  el.copyBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    if (!payload?.markdown) {
      setMessage("没有可复制内容，请先刷新。");
      return;
    }
    await navigator.clipboard.writeText(payload.markdown);
    setMessage("已复制完整 Markdown。");
  });

  el.downloadBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    if (!payload?.srt) {
      setMessage("没有可下载字幕。");
      return;
    }
    const safeTitle = sanitizeFileName(payload.title || "bilibili-subtitle");
    const blob = new Blob([payload.srt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeTitle}.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setMessage("已下载 SRT。");
  });

  el.sendBtn.addEventListener("click", async () => {
    try {
      setLocalBusy(true);
      setStatus("正在发送到 Obsidian...");
      const resp = await sendToContent({ type: "popup-send-obsidian" });
      if (!resp?.ok) {
        setMessage(`发送失败：${resp?.error || "未知错误"}`);
      }
      render(resp?.payload || latestPayload);
    } finally {
      setLocalBusy(false);
    }
  });

  el.subtitleSelect.addEventListener("change", async (event) => {
    const option = event.target.options[event.target.selectedIndex];
    const url = String(option?.value || "");
    if (!url) {
      return;
    }
    try {
      setLocalBusy(true);
      setStatus("正在切换字幕...");
      const resp = await sendToContent({
        type: "popup-select-subtitle",
        url,
        lang: String(option.dataset.lang || "unknown"),
        subtitleId: String(option.dataset.id || "")
      });
      if (!resp?.ok) {
        setMessage(`切换失败：${resp?.error || "未知错误"}`);
      }
      render(resp?.payload || latestPayload);
    } finally {
      setLocalBusy(false);
    }
  });

  el.settingsBtn.addEventListener("click", async () => {
    await sendToRuntime({ type: "open-options" });
  });
}

async function refreshFromTab() {
  try {
    setLocalBusy(true);
    setStatus("正在抓取...");
    const resp = await sendToContent({ type: "popup-refresh" });
    if (!resp?.ok) {
      const errorText = resp?.error || "请在 B 站视频页使用。";
      setStatus(`抓取失败：${errorText}`);
    }
    render(resp?.payload || latestPayload);
  } finally {
    setLocalBusy(false);
  }
}

async function ensurePayload() {
  if (latestPayload) {
    return latestPayload;
  }
  const resp = await sendToContent({ type: "popup-get-state" });
  if (resp?.ok && resp.payload) {
    latestPayload = resp.payload;
  }
  return latestPayload;
}

function render(payload) {
  if (!payload) {
    return;
  }
  latestPayload = payload;

  setStatus(payload.status || "准备就绪");
  setMessage(payload.message || "");

  setText(el.propTitle, payload.title || "-");
  setText(el.propUrl, payload.url || "-");
  setText(el.propCreated, new Date().toISOString().slice(0, 10));
  setText(el.propTags, payload.tags || "clippings");
  el.propTitle.title = payload.title || "";
  el.propUrl.title = payload.url || "";

  const options = payload.subtitleOptions || [];
  if (options.length === 0) {
    el.subtitleSelect.innerHTML = '<option value="">暂无字幕</option>';
  } else {
    el.subtitleSelect.innerHTML = options
      .map((item) => {
        const selected = item.selected ? "selected" : "";
        const aiTag = item.isAi ? " [AI]" : "";
        return `<option value="${escapeHtml(item.url)}" data-id="${escapeHtml(
          item.id || ""
        )}" data-lang="${escapeHtml(item.lang || "")}" ${selected}>${escapeHtml(
          `${item.lang || "unknown"}${aiTag}`
        )}</option>`;
      })
      .join("");
  }

  el.preview.value = payload.subtitlePreview || "";
  syncActionState(payload);
}

function setText(node, text) {
  node.textContent = String(text || "");
}

function setStatus(text) {
  el.status.textContent = String(text || "");
}

function setMessage(text) {
  el.message.textContent = String(text || "");
}

function setLocalBusy(flag) {
  localBusy = Boolean(flag);
  syncActionState();
}

function syncActionState(payload = latestPayload) {
  const data = payload || {};
  const remoteBusy = Boolean(data.isBusy);
  const busy = localBusy || remoteBusy;
  const hasMarkdown = Boolean(data.markdown);
  const hasSrt = Boolean(data.srt);
  const options = Array.isArray(data.subtitleOptions) ? data.subtitleOptions : [];

  el.refreshBtn.disabled = busy;
  el.copyBtn.disabled = busy || !hasMarkdown;
  el.downloadBtn.disabled = busy || !hasSrt;
  el.sendBtn.disabled = busy || !hasMarkdown;
  el.subtitleSelect.disabled = busy || options.length === 0;
}

function sanitizeFileName(value) {
  return String(value || "subtitle")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id || null;
}

async function sendToContent(message) {
  const tabId = await getActiveTabId();
  if (!tabId) {
    throw new Error("找不到当前标签页");
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  }).catch((error) => {
    setStatus("请在 B 站视频页使用插件。");
    setMessage(error.message);
    return { ok: false, error: error.message, payload: latestPayload };
  });
}

async function sendToRuntime(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}
