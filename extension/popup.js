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
  fnsSendBtn: document.getElementById("fnsSendBtn"),
  readingViewBtn: document.getElementById("readingViewBtn"),
  aiBtn: document.getElementById("aiBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  // 批量抓取
  batchBtn: document.getElementById("batchBtn"),
  batchView: document.getElementById("batchView"),
  batchBackBtn: document.getElementById("batchBackBtn"),
  batchTitle: document.getElementById("batchTitle"),
  batchCount: document.getElementById("batchCount"),
  batchSelectAllBtn: document.getElementById("batchSelectAllBtn"),
  batchSelectNoneBtn: document.getElementById("batchSelectNoneBtn"),
  batchSelectedCount: document.getElementById("batchSelectedCount"),
  batchTotalCount: document.getElementById("batchTotalCount"),
  batchStatus: document.getElementById("batchStatus"),
  batchList: document.getElementById("batchList"),
  batchProgress: document.getElementById("batchProgress"),
  batchProgressBar: document.getElementById("batchProgressBar"),
  batchProgressText: document.getElementById("batchProgressText"),
  batchSendBtn: document.getElementById("batchSendBtn"),
  batchFnsSendBtn: document.getElementById("batchFnsSendBtn"),
  batchMessage: document.getElementById("batchMessage")
};

let latestPayload = null;
const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";
const DEFAULT_SETTINGS = {
  downloadFormat: "srt"
};

// 批量抓取会话（popup 端）
const batchSession = {
  list: null,
  items: [],
  selectedIds: new Set(),
  fetching: false,
  fetchedResults: []
};

function formatLocalDate(value = Date.now()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

init().catch((error) => {
  setStatus(`初始化失败：${error.message}`, true);
});

async function init() {
  bindEvents();
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
    try {
      await navigator.clipboard.writeText(payload.markdown);
      setMessage("已复制完整 Markdown。");
    } catch (error) {
      setMessage(`复制失败：${error?.message || "无法访问剪贴板"}`);
    }
  });

  el.downloadBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    const settings = await getSettingsFromRuntime();
    const format = normalizeDownloadFormat(settings?.downloadFormat || payload?.downloadFormat);
    const content =
      format === "txt" ? payload?.txt || payload?.subtitlePreview || "" : payload?.srt || "";
    if (!content) {
      setMessage("没有可下载字幕。");
      return;
    }
    const safeTitle = sanitizeFileName(payload.title || "bilibili-subtitle");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeTitle}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setMessage(`已下载 ${format.toUpperCase()}。`);
  });

  el.sendBtn.addEventListener("click", async () => {
    setStatus("正在发送到 Obsidian...");
    const resp = await sendToContent({ type: "popup-send-obsidian" });
    if (!resp?.ok) {
      setStatus(`发送失败：${resp?.error || "未知错误"}`, true);
      setMessage(`发送失败：${resp?.error || "未知错误"}`);
    }
    render(resp?.payload || latestPayload);
  });

  el.fnsSendBtn.addEventListener("click", async () => {
    setStatus("正在保存到 FNS...");
    const resp = await sendToContent({ type: "popup-send-fns" });
    if (!resp?.ok) {
      setStatus(`保存失败：${resp?.error || "未知错误"}`, true);
      setMessage(`保存失败：${resp?.error || "未知错误"}`);
    }
    render(resp?.payload || latestPayload);
  });

  el.batchBtn?.addEventListener("click", async () => {
    await openBatchView();
  });

  el.batchBackBtn?.addEventListener("click", () => {
    closeBatchView();
  });

  el.batchSelectAllBtn?.addEventListener("click", () => {
    selectAllBatchItems(true);
  });

  el.batchSelectNoneBtn?.addEventListener("click", () => {
    selectAllBatchItems(false);
  });

  el.batchSendBtn?.addEventListener("click", async () => {
    await runBatchFetchAndSave("obsidian");
  });

  el.batchFnsSendBtn?.addEventListener("click", async () => {
    await runBatchFetchAndSave("fns");
  });

  el.readingViewBtn?.addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!isSupportedSubtitlePage(tab?.url || "")) {
      setMessage("请先打开一个 B 站视频页。");
      return;
    }

    const prepResp = await sendToContent({ type: "popup-get-state" });
    if (!prepResp?.ok) {
      setStatus(prepResp?.error || "请刷新浏览器网页重试，或当前网页不支持", true);
      setMessage(prepResp?.error || "请刷新浏览器网页重试，或当前网页不支持");
      return;
    }

    setStatus("正在打开阅读视图...");
    const resp = await sendToRuntime({
      type: "open-reading-view-tab",
      url: tab.url,
      tabId: tab.id
    });
    if (!resp?.ok) {
      setStatus(`打开失败：${resp?.error || "未知错误"}`, true);
      setMessage(`打开失败：${resp?.error || "未知错误"}`);
      return;
    }
    setMessage("已在当前页面打开阅读视图。");
    setStatus("阅读视图已打开。");
    window.setTimeout(() => window.close(), 80);
  });

  el.subtitleSelect.addEventListener("change", async (event) => {
    const option = event.target.options[event.target.selectedIndex];
    const url = String(option?.value || "");
    if (!url) {
      return;
    }
    setStatus("正在切换字幕...");
    const resp = await sendToContent({
      type: "popup-select-subtitle",
      url,
      lang: String(option.dataset.lang || "unknown"),
      subtitleId: String(option.dataset.id || "")
    });
    if (!resp?.ok) {
      setStatus(`切换失败：${resp?.error || "未知错误"}`, true);
      setMessage(`切换失败：${resp?.error || "未知错误"}`);
    }
    render(resp?.payload || latestPayload);
  });

  el.settingsBtn.addEventListener("click", async () => {
    await sendToRuntime({ type: "open-options" });
  });

  el.aiBtn?.addEventListener("click", async () => {
    try {
      if (globalThis.browser?.sidebarAction?.open) {
        globalThis.browser.sidebarAction.open();
        window.setTimeout(() => window.close(), 80);
        return;
      }

      const tab = await getActiveTab();
      if (!tab?.id) {
        setStatus("找不到当前标签页。", true);
        setMessage("找不到当前标签页。");
        return;
      }

      if (chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ tabId: tab.id });
      } else {
        throw new Error("当前浏览器不支持扩展侧边栏");
      }
      window.setTimeout(() => window.close(), 80);
    } catch (error) {
      setStatus(`打开侧边栏失败：${error?.message || error}`, true);
      setMessage(`打开侧边栏失败：${error?.message || error}`);
    }
  });
}

async function refreshFromTab() {
  setStatus("正在抓取...");
  const resp = await sendToContent({ type: "popup-refresh" });
  if (!resp?.ok) {
    const errorText = (resp?.error || "请在 B 站视频页使用。").replace(
      "请刷新浏览器网页重试，或当前网页不支持",
      "请刷新网页重试，或当前网页不支持"
    );
    setStatus(`抓取失败：${errorText}`, true);
    render(resp?.payload || latestPayload, { preserveStatus: true });
    return;
  }
  render(resp?.payload || latestPayload);
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

function render(payload, { preserveStatus = false } = {}) {
  if (!payload) {
    return;
  }
  latestPayload = payload;

  if (!preserveStatus) {
    const statusText = String(payload.status || "准备就绪");
    const isErrorStatus = /失败|错误|不可用|不支持/.test(statusText);
    setStatus(statusText, isErrorStatus);
  }
  setMessage(payload.message || "");

  setText(el.propTitle, payload.title || "-");
  setText(el.propUrl, payload.url || "-");
  setText(el.propCreated, formatLocalDate());
  setText(el.propTags, payload.tags || "clippings");
  el.propTitle.title = payload.title || "";
  el.propUrl.title = payload.url || "";

  const options = payload.subtitleOptions || [];
  if (options.length === 0) {
    el.subtitleSelect.innerHTML = '<option value="">暂无字幕</option>';
    el.subtitleSelect.disabled = true;
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
    el.subtitleSelect.disabled = false;
  }

  el.preview.value = payload.subtitlePreview || "";
}

function setText(node, text) {
  node.textContent = String(text || "");
}

function setStatus(text, isError = false) {
  el.status.textContent = String(text || "");
  el.status.classList.toggle("is-error", Boolean(isError));
}

function setMessage(text) {
  el.message.textContent = String(text || "");
}

function sanitizeFileName(value) {
  return String(value || "subtitle")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizeDownloadFormat(value) {
  return value === "txt" ? "txt" : "srt";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

async function getActiveTabId() {
  const tab = await getActiveTab();
  return tab?.id || null;
}

async function sendToContent(message) {
  const tab = await getActiveTab();
  const tabId = tab?.id || null;
  if (!tabId) {
    throw new Error("找不到当前标签页");
  }

  try {
    return await sendMessageToTab(tabId, message);
  } catch (error) {
    if (shouldRetryAfterInjection(error) && isSupportedSubtitlePage(tab?.url || "")) {
      try {
        await ensureContentScriptReady(tabId);
        await sleep(80);
        return await sendMessageToTab(tabId, message);
      } catch (retryError) {
        error = retryError;
      }
    }

    const normalizedError = normalizeContentErrorMessage(error);
    setStatus("请在 B 站视频页使用插件。");
    setMessage(normalizedError);
    return { ok: false, error: normalizedError, payload: latestPayload };
  }
}

function normalizeContentErrorMessage(error) {
  const message = String(error?.message || "").trim();
  if (message.includes("Could not establish connection. Receiving end does not exist.")) {
    return "请刷新浏览器网页重试，或当前网页不支持";
  }
  return message || "未知错误";
}

function shouldRetryAfterInjection(error) {
  const message = String(error?.message || "");
  return message.includes("Could not establish connection. Receiving end does not exist.");
}

function isSupportedSubtitlePage(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.hostname !== "www.bilibili.com") {
      return false;
    }
    return parsed.pathname === "/list/watchlater" ||
      parsed.pathname === "/list/watchlater/" ||
      parsed.pathname.startsWith("/video/");
  } catch {
    return false;
  }
}

async function ensureContentScriptReady(tabId) {
  if (!chrome.scripting) {
    throw new Error("请刷新浏览器网页重试，或当前网页不支持");
  }

  const loadedVersion = await probeContentScriptVersion(tabId);
  if (loadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"]
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (!message.includes("Identifier 'DEFAULT_SETTINGS' has already been declared")) {
      throw error;
    }
  }

  const reinjectedVersion = await probeContentScriptVersion(tabId);
  if (reinjectedVersion !== EXPECTED_CONTENT_SCRIPT_VERSION) {
    throw new Error("扩展刚更新，请刷新当前页面后重试。");
  }
}

async function probeContentScriptVersion(tabId) {
  try {
    const probe = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__BOC_CONTENT_SCRIPT_LOADED__ || ""
    });
    return String(probe?.[0]?.result || "");
  } catch {
    return "";
  }
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

async function getSettingsFromRuntime() {
  try {
    const resp = await sendToRuntime({ type: "get-settings" });
    if (!resp?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(resp.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ===== 批量抓取（合集 / 多 P）=====
async function openBatchView() {
  if (!el.batchView) {
    return;
  }
  el.batchView.hidden = false;
  resetBatchSession();
  setBatchStatus("正在获取分集列表...");
  setBatchMessage("");
  el.batchList.innerHTML = "";
  updateBatchSendButton();
  el.batchProgress.hidden = true;

  const resp = await sendToContent({ type: "popup-get-batch-list" });
  if (!resp?.ok) {
    setBatchStatus(`获取分集列表失败：${resp?.error || "未知错误"}`, true);
    return;
  }
  const payload = resp.payload || {};
  batchSession.list = payload;
  batchSession.items = Array.isArray(payload.items) ? payload.items : [];

  const typeLabel =
    payload.type === "ugc_season"
      ? "合集"
      : payload.type === "multi_p"
      ? `多 P（共 ${payload.pageCount || payload.total || 0} 集）`
      : "单集";
  el.batchTitle.textContent = `${typeLabel}：${payload.title || payload.mainBvid || "未知"}`;
  el.batchTitle.title = el.batchTitle.textContent;
  el.batchCount.textContent = String(payload.total || 0);
  el.batchTotalCount.textContent = String(payload.total || 0);
  setBatchStatus(
    payload.total > 0
      ? `共 ${payload.total} 个分集，勾选需要批量抓取的项后点击“批量保存”。`
      : "未发现可批量抓取的分集。"
  );

  renderBatchList(batchSession.items);
  // 默认全选，方便用户直接使用
  selectAllBatchItems(true);
}

function closeBatchView() {
  if (!el.batchView) {
    return;
  }
  el.batchView.hidden = true;
  if (batchSession.fetching) {
    // 通知 content 取消会话
    sendToContent({ type: "popup-batch-cancel" }).catch(() => {});
  }
  resetBatchSession();
}

function resetBatchSession() {
  batchSession.list = null;
  batchSession.items = [];
  batchSession.selectedIds = new Set();
  batchSession.fetching = false;
  batchSession.fetchedResults = [];
}

function renderBatchList(items) {
  if (!el.batchList) {
    return;
  }
  const safeItems = Array.isArray(items) ? items : [];
  el.batchList.innerHTML = safeItems
    .map((item, index) => {
      const checked = batchSession.selectedIds.has(item.id) ? "checked" : "";
      const prefix =
        item.type === "multi_p"
          ? `P${item.pageIndex || index + 1}`
          : item.type === "ugc_season"
          ? `EP${index + 1}`
          : "";
      const durationText = item.duration > 0 ? ` · ${formatDurationLabel(item.duration)}` : "";
      const metaParts = [];
      if (prefix) {
        metaParts.push(`<span class="batch-item-prefix">${escapeHtml(prefix)}</span>`);
      }
      if (item.section) {
        metaParts.push(`<span class="batch-item-section">${escapeHtml(item.section)}</span>`);
      }
      metaParts.push(`<span class="batch-item-duration">${escapeHtml(durationText)}</span>`);
      return `
        <li class="batch-item" data-id="${escapeHtml(item.id)}" data-index="${index}">
          <input type="checkbox" ${checked} aria-label="选择该分集" />
          <div class="batch-item-main">
            <div class="batch-item-title">${escapeHtml(item.pageTitle || item.bvid || "未知分集")}</div>
            <div class="batch-item-meta">${metaParts.join("")}</div>
            <div class="batch-item-status is-pending" data-status>等待抓取</div>
          </div>
        </li>
      `;
    })
    .join("");

  el.batchList.querySelectorAll(".batch-item").forEach((node) => {
    const id = node.getAttribute("data-id");
    const checkbox = node.querySelector('input[type="checkbox"]');
    node.addEventListener("click", (event) => {
      if (event.target === checkbox) {
        return;
      }
      checkbox.checked = !checkbox.checked;
      toggleBatchItemSelection(id, checkbox.checked);
    });
    checkbox.addEventListener("change", () => {
      toggleBatchItemSelection(id, checkbox.checked);
    });
  });

  updateBatchSelectedCount();
  updateBatchSendButton();
}

function toggleBatchItemSelection(id, selected) {
  if (!id) {
    return;
  }
  if (selected) {
    batchSession.selectedIds.add(id);
  } else {
    batchSession.selectedIds.delete(id);
  }
  updateBatchSelectedCount();
  updateBatchSendButton();
}

function selectAllBatchItems(selectAll) {
  if (selectAll) {
    batchSession.items.forEach((item) => batchSession.selectedIds.add(item.id));
  } else {
    batchSession.selectedIds.clear();
  }
  el.batchList.querySelectorAll('.batch-item input[type="checkbox"]').forEach((cb) => {
    cb.checked = selectAll;
  });
  updateBatchSelectedCount();
  updateBatchSendButton();
}

function updateBatchSelectedCount() {
  const total = batchSession.items.length;
  const selected = batchSession.selectedIds.size;
  if (el.batchSelectedCount) {
    el.batchSelectedCount.textContent = String(selected);
  }
  if (el.batchTotalCount) {
    el.batchTotalCount.textContent = String(total);
  }
}

function updateBatchSendButton() {
  const disabled = batchSession.fetching || batchSession.selectedIds.size === 0;
  if (el.batchSendBtn) {
    el.batchSendBtn.disabled = disabled;
  }
  if (el.batchFnsSendBtn) {
    el.batchFnsSendBtn.disabled = disabled;
  }
}

function setBatchStatus(text, isError = false) {
  if (!el.batchStatus) {
    return;
  }
  el.batchStatus.textContent = String(text || "");
  el.batchStatus.classList.toggle("is-error", Boolean(isError));
}

function setBatchMessage(text) {
  if (!el.batchMessage) {
    return;
  }
  el.batchMessage.textContent = String(text || "");
}

function setBatchItemStatus(index, text, kind = "pending") {
  const node = el.batchList?.querySelector(`.batch-item[data-index="${index}"] [data-status]`);
  if (!node) {
    return;
  }
  node.textContent = String(text || "");
  node.classList.remove("is-ok", "is-err", "is-pending");
  if (kind === "ok") {
    node.classList.add("is-ok");
  } else if (kind === "err") {
    node.classList.add("is-err");
  } else {
    node.classList.add("is-pending");
  }
}

function setBatchProgress(current, total, text) {
  if (!el.batchProgress) {
    return;
  }
  el.batchProgress.hidden = false;
  const ratio = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  if (el.batchProgressBar) {
    el.batchProgressBar.style.width = `${ratio}%`;
  }
  if (el.batchProgressText) {
    el.batchProgressText.textContent =
      text || `正在抓取 ${current}/${total}（${ratio}%）`;
  }
}

function formatDurationLabel(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  if (safe <= 0) {
    return "";
  }
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) {
    return `${h}时${m}分`;
  }
  if (m > 0) {
    return `${m}分${s > 0 ? `${s}秒` : ""}`;
  }
  return `${s}秒`;
}

async function runBatchFetchAndSave(target = "obsidian") {
  if (batchSession.fetching) {
    return;
  }
  const selectedItems = batchSession.items.filter((item) => batchSession.selectedIds.has(item.id));
  if (selectedItems.length === 0) {
    setBatchMessage("请先勾选要批量抓取的分集。");
    return;
  }

  // 直接启动新会话；startBatchSession 内部会重置 items/results，无需先 cancel
  //（cancel 会清空 content 端的 list，导致 start 找不到列表）
  const startResp = await sendToContent({
    type: "popup-batch-start",
    selectedIds: selectedItems.map((item) => item.id)
  });
  if (!startResp?.ok) {
    setBatchStatus(`启动批量抓取失败：${startResp?.error || "未知错误"}`, true);
    return;
  }

  batchSession.fetching = true;
  batchSession.fetchedResults = [];
  updateBatchSendButton();
  setBatchMessage("");
  setBatchStatus(`开始批量抓取 ${selectedItems.length} 个分集...`);

  const total = selectedItems.length;
  let successCount = 0;
  let failedCount = 0;

  for (let i = 0; i < selectedItems.length; i++) {
    const item = selectedItems[i];
    const originalIndex = batchSession.items.indexOf(item);
    setBatchItemStatus(originalIndex, "正在抓取...", "pending");
    setBatchProgress(i, total, `正在抓取 ${i + 1}/${total}：${item.pageTitle || item.id}`);

    try {
      const resp = await sendToContent({ type: "popup-batch-fetch-item", index: i });
      if (resp?.ok && resp.payload) {
        batchSession.fetchedResults.push(resp.payload);
        if (resp.payload.hasSubtitle) {
          successCount += 1;
          setBatchItemStatus(
            originalIndex,
            `已抓取${resp.payload.subtitleLang ? `（${resp.payload.subtitleLang}）` : ""}`,
            "ok"
          );
        } else {
          failedCount += 1;
          setBatchItemStatus(
            originalIndex,
            `无字幕${resp.payload.error ? `：${resp.payload.error}` : ""}`,
            "err"
          );
        }
      } else {
        failedCount += 1;
        batchSession.fetchedResults.push(resp?.payload || { index: i, hasSubtitle: false });
        setBatchItemStatus(
          originalIndex,
          `失败：${resp?.error || "未知错误"}`,
          "err"
        );
      }
    } catch (error) {
      failedCount += 1;
      setBatchItemStatus(originalIndex, `失败：${error?.message || "未知错误"}`, "err");
    }

    // 简单的节流，避免触发 B 站风控
    if (i < selectedItems.length - 1) {
      await sleep(300);
    }
  }

  setBatchProgress(total, total, `抓取完成：成功 ${successCount}，失败 ${failedCount}`);

  if (successCount === 0) {
    setBatchStatus("抓取完成但未获取到任何字幕，已停止保存。", true);
    batchSession.fetching = false;
    updateBatchSendButton();
    return;
  }

  const destLabel = target === "fns" ? "FNS" : "Obsidian";
  const saveType = target === "fns" ? "popup-batch-save-fns" : "popup-batch-save";
  setBatchStatus(`抓取完成，正在保存到 ${destLabel}（${successCount}/${total} 条字幕）...`);
  const saveResp = await sendToContent({ type: saveType });
  batchSession.fetching = false;
  updateBatchSendButton();

  if (!saveResp?.ok) {
    setBatchStatus(`保存失败：${saveResp?.error || "未知错误"}`, true);
    return;
  }
  const filepath = saveResp.payload?.filepath || "";
  setBatchStatus(`已保存到 ${destLabel}：${filepath}`);
  setBatchMessage(`批量保存完成：成功 ${successCount} / 失败 ${failedCount}。`);
}
