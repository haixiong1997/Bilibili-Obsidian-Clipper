const el = {
  status: document.getElementById("status"),
  message: document.getElementById("message"),
  propTitle: document.getElementById("propTitle"),
  propUrl: document.getElementById("propUrl"),
  propCreated: document.getElementById("propCreated"),
  propTags: document.getElementById("propTags"),
  subtitleSelect: document.getElementById("subtitleSelect"),
  noteFolderSelect: document.getElementById("noteFolderSelect"),
  preview: document.getElementById("preview"),
  refreshBtn: document.getElementById("refreshBtn"),
  copyBtn: document.getElementById("copyBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  sendBtn: document.getElementById("sendBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  collectionSection: document.getElementById("collectionSection"),
  collectionTitle: document.getElementById("collectionTitle"),
  collectionList: document.getElementById("collectionList"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  selectCurrentBtn: document.getElementById("selectCurrentBtn"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  batchImportBtn: document.getElementById("batchImportBtn"),
  batchResultWrap: document.getElementById("batchResultWrap"),
  batchResult: document.getElementById("batchResult"),
  batchRetryBtn: document.getElementById("batchRetryBtn")
};

let latestPayload = null;
let selectedCollectionIds = new Set();
let currentCollectionKey = "";
let selectedNoteFolderId = "";
let batchPollTimer = 0;
let isPollingBatch = false;

const DEFAULT_SETTINGS = {
  downloadFormat: "srt"
};

init().catch((error) => {
  setStatus(`初始化失败：${error.message}`);
});

function init() {
  bindEvents();
  window.addEventListener("beforeunload", stopBatchPolling);
  return refreshFromTab();
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
    const resp = await sendToContent({
      type: "popup-send-obsidian",
      noteFolderId: getSelectedNoteFolderId()
    });
    if (!resp?.ok) {
      setMessage(`发送失败：${resp?.error || "未知错误"}`);
    }
    render(resp?.payload || latestPayload);
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
      setMessage(`切换失败：${resp?.error || "未知错误"}`);
    }
    render(resp?.payload || latestPayload);
  });

  el.settingsBtn.addEventListener("click", async () => {
    await sendToRuntime({ type: "open-options" });
  });

  el.noteFolderSelect.addEventListener("change", () => {
    selectedNoteFolderId = String(el.noteFolderSelect.value || "");
  });

  el.selectAllBtn.addEventListener("click", () => {
    const collection = latestPayload?.collection;
    if (!collection) {
      return;
    }
    selectedCollectionIds = new Set(collection.items.map((item) => String(item.episodeId)));
    renderCollectionSection(collection, latestPayload?.batchImport);
  });

  el.selectCurrentBtn.addEventListener("click", () => {
    const collection = latestPayload?.collection;
    if (!collection) {
      return;
    }
    selectedCollectionIds = new Set(
      collection.items.filter((item) => item.isCurrent).map((item) => String(item.episodeId))
    );
    renderCollectionSection(collection, latestPayload?.batchImport);
  });

  el.clearSelectionBtn.addEventListener("click", () => {
    selectedCollectionIds = new Set();
    renderCollectionSection(latestPayload?.collection, latestPayload?.batchImport);
  });

  el.collectionList.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
      return;
    }

    const episodeId = String(target.dataset.episodeId || "");
    if (!episodeId) {
      return;
    }

    if (target.checked) {
      selectedCollectionIds.add(episodeId);
    } else {
      selectedCollectionIds.delete(episodeId);
    }
    renderCollectionSection(latestPayload?.collection, latestPayload?.batchImport);
  });

  el.batchImportBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    const collection = payload?.collection;
    if (!collection?.items?.length) {
      setMessage("当前视频没有可导入的合集。");
      return;
    }

    const selectedEpisodeIds = collection.items
      .map((item) => String(item.episodeId || ""))
      .filter((episodeId) => selectedCollectionIds.has(episodeId));
    if (selectedEpisodeIds.length === 0) {
      setMessage("请先勾选要导入的合集视频。");
      return;
    }

    setMessage(`正在准备批量导入 ${selectedEpisodeIds.length} 集...`);
    const resp = await sendToContent({
      type: "popup-start-batch-import",
      selectedEpisodeIds,
      preferredSubtitleLang: getPreferredSubtitleLang(payload),
      noteFolderId: getSelectedNoteFolderId()
    });
    if (!resp?.ok) {
      setMessage(`批量导入失败：${resp?.error || "未知错误"}`);
      return;
    }
    render(resp?.payload || payload);
    startBatchPolling();
  });

  el.batchRetryBtn.addEventListener("click", async () => {
    const payload = await ensurePayload();
    const failedEpisodeIds = getFailedEpisodeIds(payload?.batchImport);
    if (failedEpisodeIds.length === 0) {
      setMessage("当前没有可重试的失败项。");
      return;
    }

    await startBatchImportWithIds(failedEpisodeIds, payload, `正在准备重试 ${failedEpisodeIds.length} 个失败项...`);
  });
}

async function refreshFromTab() {
  setStatus("正在抓取...");
  const resp = await sendToContent({ type: "popup-refresh" });
  if (!resp?.ok) {
    const errorText = resp?.error || "请在 B 站视频页使用。";
    setStatus(`抓取失败：${errorText}`);
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

function render(payload) {
  if (!payload) {
    return;
  }
  latestPayload = payload;

  setStatus(payload.status || "准备就绪");
  setMessage(payload.message || "");

  setText(el.propTitle, payload.title || "-");
  setText(el.propUrl, payload.url || "-");
  setText(el.propCreated, formatLocalDate());
  setText(el.propTags, payload.tags || "clippings");
  el.propTitle.title = payload.title || "";
  el.propUrl.title = payload.url || "";

  renderSubtitleOptions(payload.subtitleOptions || []);
  syncNoteFolderSelection(payload.noteFolderOptions || []);
  renderNoteFolderOptions(payload.noteFolderOptions || []);
  el.preview.value = payload.subtitlePreview || "";

  syncCollectionSelection(payload.collection);
  renderCollectionSection(payload.collection, payload.batchImport);
  renderBatchResult(payload.batchImport);
  syncBatchPolling(payload.batchImport);
  setBusyState(Boolean(payload.batchImport?.running));
}

function renderSubtitleOptions(options) {
  if (options.length === 0) {
    el.subtitleSelect.innerHTML = '<option value="">暂无字幕</option>';
    el.subtitleSelect.disabled = true;
    return;
  }

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

function syncNoteFolderSelection(options) {
  if (!Array.isArray(options) || options.length === 0) {
    selectedNoteFolderId = "";
    return;
  }

  if (selectedNoteFolderId && options.some((item) => String(item.id || "") === selectedNoteFolderId)) {
    return;
  }

  const selected = options.find((item) => item.selected) || options[0];
  selectedNoteFolderId = String(selected?.id || "");
}

function renderNoteFolderOptions(options) {
  if (!Array.isArray(options) || options.length === 0) {
    el.noteFolderSelect.innerHTML = '<option value="">请先去设置中配置保存目录</option>';
    el.noteFolderSelect.disabled = true;
    return;
  }

  el.noteFolderSelect.innerHTML = options
    .map((item) => {
      const id = String(item.id || "");
      const label = item.path ? `${item.label || "未命名目录"} · ${item.path}` : item.label || "未命名目录";
      const selected = id === selectedNoteFolderId ? "selected" : "";
      return `<option value="${escapeHtml(id)}" ${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
  el.noteFolderSelect.disabled = false;
}

function syncCollectionSelection(collection) {
  const key = getCollectionKey(collection);
  if (!collection?.items?.length) {
    selectedCollectionIds = new Set();
    currentCollectionKey = "";
    return;
  }

  if (key !== currentCollectionKey) {
    currentCollectionKey = key;
    selectedCollectionIds = new Set(collection.items.map((item) => String(item.episodeId || "")));
    return;
  }

  const availableIds = new Set(collection.items.map((item) => String(item.episodeId || "")));
  selectedCollectionIds = new Set(
    [...selectedCollectionIds].filter((episodeId) => availableIds.has(episodeId))
  );
}

function renderCollectionSection(collection, batchImport) {
  if (!collection?.items?.length) {
    el.collectionSection.classList.add("hidden");
    el.collectionTitle.textContent = "";
    el.collectionList.innerHTML = "";
    return;
  }

  const running = Boolean(batchImport?.running);
  const selectedCount = collection.items.filter((item) =>
    selectedCollectionIds.has(String(item.episodeId || ""))
  ).length;

  el.collectionSection.classList.remove("hidden");
  el.collectionTitle.textContent = `${collection.title || "未命名合集"} · 已选 ${selectedCount}/${collection.items.length}`;
  el.collectionList.innerHTML = collection.items
    .map((item) => {
      const checked = selectedCollectionIds.has(String(item.episodeId || "")) ? "checked" : "";
      const currentClass = item.isCurrent ? " current" : "";
      const currentTag = item.isCurrent ? '<span class="current-tag">当前视频</span>' : "";
      return `
        <label class="collection-item${currentClass}">
          <input type="checkbox" data-episode-id="${escapeHtml(String(item.episodeId || ""))}" ${checked} ${
            running ? "disabled" : ""
          } />
          <span class="collection-meta">
            <span class="collection-item-title">${escapeHtml(formatCollectionTitle(item))}</span>
            <span class="collection-item-sub">${escapeHtml(
              `${item.sectionTitle || "正片"} · ${formatDuration(item.duration)}`
            )} ${currentTag}</span>
          </span>
        </label>
      `;
    })
    .join("");

  el.selectAllBtn.disabled = running;
  el.selectCurrentBtn.disabled = running;
  el.clearSelectionBtn.disabled = running;
  el.batchImportBtn.disabled = running || selectedCount === 0;
}

function renderBatchResult(batchImport) {
  const results = Array.isArray(batchImport?.results) ? batchImport.results : [];
  const failures = results.filter((item) => item && item.ok === false);
  const failedEpisodeIds = getFailedEpisodeIds(batchImport);
  const running = Boolean(batchImport?.running);
  const hasFailures = Number(batchImport?.failed || 0) > 0 || failures.length > 0;

  if (!running && results.length === 0 && !hasFailures) {
    el.batchResultWrap.classList.add("hidden");
    el.batchResult.innerHTML = "";
    el.batchRetryBtn.classList.add("hidden");
    el.batchRetryBtn.disabled = true;
    return;
  }

  const summary = running
    ? `正在导入 ${batchImport.completed || 0}/${batchImport.total || 0}${
        batchImport.currentTitle ? `：${batchImport.currentTitle}` : ""
      }`
    : `批量导入完成：成功 ${batchImport.succeeded || 0}，失败 ${batchImport.failed || 0}`;

  const failureHtml =
    failures.length === 0
      ? running
        ? ""
        : hasFailures
          ? '<div class="batch-result-item">存在失败项，请使用下方按钮重试失败集数。</div>'
          : '<div class="batch-result-item">所有选中视频均已成功导入。</div>'
      : failures
          .map(
            (item) =>
              `<div class="batch-result-item">${escapeHtml(item.title || "未命名视频")}：${escapeHtml(
                item.error || "未知错误"
              )}</div>`
          )
          .join("");

  el.batchResultWrap.classList.remove("hidden");
  el.batchResult.innerHTML = `
    <div class="batch-result-summary">${escapeHtml(summary)}</div>
    ${failureHtml}
  `;

  if (running || failedEpisodeIds.length === 0) {
    el.batchRetryBtn.classList.add("hidden");
    el.batchRetryBtn.disabled = true;
    return;
  }

  el.batchRetryBtn.classList.remove("hidden");
  el.batchRetryBtn.disabled = false;
  el.batchRetryBtn.textContent = `仅重试失败项（${failedEpisodeIds.length}）`;
}

function syncBatchPolling(batchImport) {
  if (batchImport?.running) {
    startBatchPolling();
  } else {
    stopBatchPolling();
  }
}

function startBatchPolling() {
  if (batchPollTimer) {
    return;
  }

  batchPollTimer = window.setInterval(() => {
    void pollBatchState();
  }, 500);
}

function stopBatchPolling() {
  if (!batchPollTimer) {
    return;
  }
  window.clearInterval(batchPollTimer);
  batchPollTimer = 0;
}

async function pollBatchState() {
  if (isPollingBatch) {
    return;
  }
  isPollingBatch = true;

  try {
    const resp = await sendToContent({ type: "popup-get-state" });
    if (resp?.ok && resp.payload) {
      render(resp.payload);
    }
  } finally {
    isPollingBatch = false;
  }
}

function setBusyState(disabled) {
  const hasNoteFolderOptions = Boolean(latestPayload?.noteFolderOptions?.length);
  el.refreshBtn.disabled = disabled;
  el.copyBtn.disabled = disabled;
  el.downloadBtn.disabled = disabled;
  el.sendBtn.disabled = disabled || !hasNoteFolderOptions;
  el.subtitleSelect.disabled = disabled || !latestPayload?.subtitleOptions?.length;
  el.noteFolderSelect.disabled = disabled || !hasNoteFolderOptions;
  el.batchImportBtn.disabled =
    disabled ||
    !hasNoteFolderOptions ||
    !latestPayload?.collection?.items?.some((item) =>
      selectedCollectionIds.has(String(item.episodeId || ""))
    );
  if (disabled) {
    el.batchRetryBtn.disabled = true;
  }
}

function getSelectedNoteFolderId() {
  return String(selectedNoteFolderId || el.noteFolderSelect.value || "");
}

async function startBatchImportWithIds(selectedEpisodeIds, payload, pendingMessage) {
  if (!Array.isArray(selectedEpisodeIds) || selectedEpisodeIds.length === 0) {
    setMessage("请先选择要导入的合集视频。");
    return;
  }

  setMessage(pendingMessage);
  const resp = await sendToContent({
    type: "popup-start-batch-import",
    selectedEpisodeIds,
    preferredSubtitleLang: getPreferredSubtitleLang(payload),
    noteFolderId: getSelectedNoteFolderId()
  });
  if (!resp?.ok) {
    setMessage(`批量导入失败：${resp?.error || "未知错误"}`);
    return;
  }
  render(resp?.payload || payload);
  startBatchPolling();
}

function getFailedEpisodeIds(batchImport) {
  const results = Array.isArray(batchImport?.results) ? batchImport.results : [];
  return results
    .filter((item) => item && item.ok === false && item.episodeId)
    .map((item) => String(item.episodeId))
    .filter(Boolean);
}

function getPreferredSubtitleLang(payload) {
  const selected = (payload?.subtitleOptions || []).find((item) => item.selected);
  return String(selected?.lang || "");
}

function formatCollectionTitle(item) {
  const index = Number(item?.index || 0) || 0;
  const prefix = index > 0 ? `${index}. ` : "";
  return `${prefix}${String(item?.title || item?.bvid || "未命名视频")}`;
}

function formatDuration(seconds) {
  const safe = Math.max(0, Number(seconds || 0) || 0);
  const hour = Math.floor(safe / 3600);
  const minute = Math.floor((safe % 3600) / 60);
  const second = Math.floor(safe % 60);

  if (hour > 0) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(
      second
    ).padStart(2, "0")}`;
  }
  return `${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function getCollectionKey(collection) {
  if (!collection?.items?.length) {
    return "";
  }
  return `${collection.id || collection.title || "collection"}:${collection.items.length}`;
}

function formatLocalDate(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
    stopBatchPolling();
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
