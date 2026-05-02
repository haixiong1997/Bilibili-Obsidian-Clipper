const DEFAULT_SETTINGS = {
  noteFolder: "Clippings/Bilibili",
  obsidianApiBaseUrl: "http://127.0.0.1:27123",
  obsidianApiKey: "",
  tags: "clippings,bilibili",
  downloadFormat: "srt",
  includeDateInFilename: true,
  includeTimestampInBody: true,
  enableDebugLogs: false,
  frontmatterFields: [
    "title",
    "url",
    "bvid",
    "cid",
    "author",
    "upload_date",
    "subtitle_lang",
    "created",
    "tags"
  ]
};

const BOC_VERSION = "1.0.14";
const CACHE_KEY_PREFIX = "boc_subtitle_cache_";

const state = {
  currentUrl: location.href,
  fetchRunId: 0,
  bvid: "",
  aid: "",
  cid: "",
  cidSource: "",
  pageIndex: 1,
  pageCount: 0,
  pageTitle: "",
  videoDuration: 0,
  description: "",
  title: "",
  author: "",
  uploadDate: "",
  subtitles: [],
  selectedSubtitleId: "",
  selectedSubtitleUrl: "",
  selectedSubtitleLang: "",
  subtitleBody: [],
  chapters: [],
  markdown: "",
  srt: "",
  txt: "",
  statusText: "准备就绪，点击“刷新抓取”开始。",
  messageText: "",
  settings: { ...DEFAULT_SETTINGS }
};

function shouldDebugLog() {
  return Boolean(state.settings?.enableDebugLogs);
}

function logInfo(...args) {
  if (shouldDebugLog()) {
    console.info(...args);
  }
}

function logWarn(...args) {
  if (shouldDebugLog()) {
    console.warn(...args);
  }
}

const ids = {
  root: "boc-root",
  panel: "boc-panel",
  status: "boc-status",
  meta: "boc-meta",
  subtitleSelect: "boc-subtitle-select",
  preview: "boc-preview",
  message: "boc-message",
  copyBtn: "boc-copy-btn",
  downloadBtn: "boc-download-btn",
  sendBtn: "boc-send-btn",
  refreshBtn: "boc-refresh-btn",
  closeBtn: "boc-close-btn",
  settingsBtn: "boc-settings-btn"
};

init();

function init() {
  const existingRoot = document.getElementById(ids.root);
  if (existingRoot) {
    existingRoot.remove();
  }

  logInfo(`[BOC] content script loaded, version=${BOC_VERSION}`);

  const root = document.createElement("div");
  root.id = ids.root;
  root.innerHTML = buildUiHtml();
  document.body.appendChild(root);

  bindUiEvents();
  bindRuntimeEvents();
  startUrlWatcher();
  getSettings().then((settings) => {
    state.settings = settings;
  });
}

function bindRuntimeEvents() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "popup-get-state") {
      sendResponse({ ok: true, payload: getPopupPayload() });
      return false;
    }

    if (message.type === "popup-refresh") {
      refreshClip()
        .then(() => sendResponse({ ok: true, payload: getPopupPayload() }))
        .catch((error) =>
          sendResponse({ ok: false, error: getErrorMessage(error), payload: getPopupPayload() })
        );
      return true;
    }

    if (message.type === "popup-select-subtitle") {
      const url = String(message.url || "").trim();
      const lang = String(message.lang || "unknown");
      const subtitleId = String(message.subtitleId || "");
      if (!url) {
        sendResponse({ ok: false, error: "Missing subtitle URL", payload: getPopupPayload() });
        return false;
      }
      loadSubtitle(url, lang, state.fetchRunId, subtitleId)
        .then(() => {
          setStatus("字幕切换完成。");
          renderSubtitleSelect();
          sendResponse({ ok: true, payload: getPopupPayload() });
        })
        .catch((error) =>
          sendResponse({ ok: false, error: getErrorMessage(error), payload: getPopupPayload() })
        );
      return true;
    }

    if (message.type === "popup-send-obsidian") {
      sendToObsidian()
        .then(() => sendResponse({ ok: true, payload: getPopupPayload() }))
        .catch((error) =>
          sendResponse({ ok: false, error: getErrorMessage(error), payload: getPopupPayload() })
        );
      return true;
    }

    return false;
  });
}

function buildUiHtml() {
  return `
    <aside id="${ids.panel}" aria-hidden="true">
      <header class="boc-header">
        <strong>Default</strong>
        <div class="boc-header-actions">
          <button id="${ids.settingsBtn}" type="button" title="插件设置">设置</button>
          <button id="${ids.closeBtn}" type="button" title="关闭">关闭</button>
        </div>
      </header>

      <p id="${ids.status}" class="boc-status">准备就绪，点击“刷新抓取”开始。</p>
      <div class="boc-props-head">属性</div>
      <div id="${ids.meta}" class="boc-meta"></div>

      <label class="boc-label" for="${ids.subtitleSelect}">字幕语言</label>
      <select id="${ids.subtitleSelect}" disabled>
        <option value="">暂无字幕</option>
      </select>

      <label class="boc-label" for="${ids.preview}">字幕预览</label>
      <textarea id="${ids.preview}" readonly></textarea>

      <div class="boc-actions">
        <button id="${ids.refreshBtn}" type="button">刷新抓取</button>
        <button id="${ids.copyBtn}" type="button">复制完整 Markdown</button>
        <button id="${ids.downloadBtn}" type="button">下载字幕</button>
        <button id="${ids.sendBtn}" type="button">发送到 Obsidian</button>
      </div>
      <p id="${ids.message}" class="boc-message"></p>
    </aside>
  `;
}

function bindUiEvents() {
  const panel = byId(ids.panel);
  const closeBtn = byId(ids.closeBtn);
  const refreshBtn = byId(ids.refreshBtn);
  const select = byId(ids.subtitleSelect);
  const copyBtn = byId(ids.copyBtn);
  const downloadBtn = byId(ids.downloadBtn);
  const sendBtn = byId(ids.sendBtn);
  const settingsBtn = byId(ids.settingsBtn);

  closeBtn.addEventListener("click", () => panel.classList.remove("open"));
  refreshBtn.addEventListener("click", refreshClip);
  select.addEventListener("change", onSubtitleChange);
  copyBtn.addEventListener("click", copyMarkdown);
  downloadBtn.addEventListener("click", downloadSubtitle);
  sendBtn.addEventListener("click", sendToObsidian);
  settingsBtn.addEventListener("click", requestOpenOptions);
}

function startUrlWatcher() {
  window.setInterval(() => {
    if (location.href === state.currentUrl) {
      return;
    }

    state.fetchRunId += 1;
    state.currentUrl = location.href;
    resetClipState();
    setStatus("检测到页面变化，请点击“刷新抓取”加载当前视频字幕。");
  }, 1200);
}

function resetClipState() {
  state.bvid = "";
  state.aid = "";
  state.cid = "";
  state.cidSource = "";
  state.pageIndex = 1;
  state.pageCount = 0;
  state.pageTitle = "";
  state.videoDuration = 0;
  state.description = "";
  state.title = "";
  state.author = "";
  state.uploadDate = "";
  state.subtitles = [];
  state.selectedSubtitleId = "";
  state.selectedSubtitleUrl = "";
  state.selectedSubtitleLang = "";
  state.subtitleBody = [];
  state.chapters = [];
  state.markdown = "";
  state.srt = "";
  state.txt = "";

  renderMeta();
  renderSubtitleSelect();
  byId(ids.preview).value = "";
  setMessage("");
}

async function refreshClip() {
  const runId = ++state.fetchRunId;
  try {
    setBusyState(true);
    setMessage("");
    setStatus("正在抓取视频信息...");
    state.settings = await getSettings();
    ensureRunActive(runId);

    state.bvid = extractBvid(location.href);
    if (!state.bvid) {
      throw new Error("当前页面不是标准 BV 视频地址，无法抓取字幕。");
    }

    const pageIndex = extractPageIndex(location.href);
    const oid = extractOid(location.href);
    const hasPageParam = hasExplicitPageParam(location.href);
    const meta = await retryAsync(() => fetchVideoMeta(state.bvid), 2, 250);
    ensureRunActive(runId);

    // 调试：打印 API 返回的原始数据
    logInfo("[BOC] raw meta data", {
      meta,
      defaultCid: meta.defaultCid,
      pagesCount: (meta.pages || []).length
    });

    state.aid = meta.aid || "";
    state.title = meta.title || readVideoTitle();
    state.author = meta.author || readVideoAuthor();
    state.uploadDate = meta.uploadDate || readUploadDate();
    state.description = meta.description || "";
    state.pageCount = Array.isArray(meta.pages) ? meta.pages.length : 0;
    let resolvedPageIndex = pageIndex;
    if ((meta.pages || []).length > 1 && !hasPageParam) {
      const pageIndexFromOid = pickPageIndexFromOid(meta.pages, oid);
      if (pageIndexFromOid > 0) {
        resolvedPageIndex = pageIndexFromOid;
        logInfo("[BOC] resolved page index from oid", {
          oid,
          resolvedPageIndex
        });
      } else {
        // B 站多分P中，P1 常见为无 ?p= 参数；watchlater 等页面可能改用 oid 标识当前分P。
        resolvedPageIndex = 1;
        logInfo("[BOC] multi-page video without p param or valid oid, fallback to P1", {
          oid
        });
      }
    }

    const currentPage = pickPageFromPages(meta.pages, resolvedPageIndex);
    state.pageIndex = resolvedPageIndex;
    state.pageTitle = currentPage?.part || "";
    state.cid = currentPage?.cid || pickCidFromPages(meta.pages, resolvedPageIndex, meta.defaultCid);
    state.cidSource = "meta-pages";
    state.videoDuration = pickDurationFromPages(meta.pages, resolvedPageIndex, meta.defaultDuration);
    if (!(state.videoDuration > 0)) {
      state.videoDuration = readRuntimeVideoDuration();
    }
    if (!(state.videoDuration > 0)) {
      throw new Error("无法获取当前视频时长，已停止抓取以避免串到错误字幕。");
    }

    logInfo("[BOC] resolved video ids", {
      url: location.href,
      aid: state.aid,
      bvid: state.bvid,
      cid: state.cid,
      cidSource: state.cidSource,
      pageIndex: resolvedPageIndex,
      videoDuration: state.videoDuration
    });

    setStatus("正在获取可用字幕...");
    let subtitleBundle = await retryAsync(
      () => fetchSubtitleBundle(state.bvid, state.cid, state.aid),
      3,
      500
    );
    ensureRunActive(runId);
    state.subtitles = normalizeSubtitleTracks(subtitleBundle.tracks);
    state.chapters = normalizeChapters(subtitleBundle.chapters);
    logInfo(
      "[BOC] chapters",
      state.chapters.map((item) => ({
        from: item.from,
        to: item.to,
        title: item.title
      }))
    );
    logInfo(
      "[BOC] subtitle tracks",
      state.subtitles.map((item) => ({
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        url: item.subtitleUrl
      }))
    );

    // 单源策略下，空字幕直接失败，避免空结果重试导致串轨。
    if (state.subtitles.length === 0) {
      throw new Error("这个视频暂时没有可用字幕。");
    }

    // 显式点击“刷新抓取”时默认走网络，避免命中历史缓存导致字幕错位。
    const forceRefresh = true;

    const preferred = pickPreferredSubtitle(state.subtitles, {
      previousId: state.selectedSubtitleId,
      previousUrl: state.selectedSubtitleUrl,
      previousLang: state.selectedSubtitleLang
    });

    if (!preferred) {
      throw new Error("这个视频暂时没有可用字幕。");
    }

    const candidates = buildSubtitleCandidates(state.subtitles, preferred);
    let selected = null;

    try {
      selected = await tryLoadSubtitleCandidates(candidates, runId, forceRefresh);
    } catch (error) {
      const message = getErrorMessage(error, "");
      if (!message.includes("HTTP") && error?.code !== "SUBTITLE_DURATION_MISMATCH") {
        throw error;
      }

      // Retry because subtitle signed URLs may expire quickly or hit rate limit.
      subtitleBundle = await retryAsync(
        () => fetchSubtitleBundle(state.bvid, state.cid, state.aid),
        2,
        500
      );
      ensureRunActive(runId);
      state.subtitles = normalizeSubtitleTracks(subtitleBundle.tracks);
      state.chapters = normalizeChapters(subtitleBundle.chapters);
      const retryPreferred = pickPreferredSubtitle(state.subtitles, {
        previousId: preferred.id,
        previousUrl: preferred.subtitleUrl,
        previousLang: preferred.lanDoc || preferred.lan || ""
      });
      if (!retryPreferred) {
        throw error;
      }
      const retryCandidates = buildSubtitleCandidates(state.subtitles, retryPreferred);
      selected = await tryLoadSubtitleCandidates(retryCandidates, runId, forceRefresh);
    }
    ensureRunActive(runId);
    if (selected) {
      logInfo("[BOC] selected subtitle track", {
        id: selected.id,
        lan: selected.lan,
        lanDoc: selected.lanDoc
      });
    }
    renderMeta();
    renderSubtitleSelect();
    setStatus("抓取完成，可以复制、下载或发送到 Obsidian。");
  } catch (error) {
    if (isStaleRunError(error)) {
      return;
    }
    resetClipState();
    if (error?.code === "SUBTITLE_DURATION_MISMATCH") {
      setStatus("抓取失败：未找到与当前视频时长匹配的字幕轨，可能该视频无可用字幕。");
      return;
    }
    setStatus(`抓取失败：${getErrorMessage(error)}`);
  } finally {
    if (runId === state.fetchRunId) {
      setBusyState(false);
    }
  }
}

async function onSubtitleChange(event) {
  const value = event.target.value;
  const option = event.target.options[event.target.selectedIndex];
  const lang = option?.dataset.lang || "unknown";
  const subtitleId = option?.dataset.id || "";
  if (!value) {
    return;
  }

  try {
    setBusyState(true);
    setStatus(`正在切换字幕：${lang}`);
    setMessage("");
    await loadSubtitle(value, lang, state.fetchRunId, subtitleId);
    setStatus("字幕切换完成。");
  } catch (error) {
    if (isStaleRunError(error)) {
      return;
    }
    setStatus(`切换字幕失败：${getErrorMessage(error)}`);
  } finally {
    setBusyState(false);
  }
}

async function loadSubtitle(url, lang, runId = state.fetchRunId, subtitleId = "", forceRefresh = false) {
  if (!url) {
    throw new Error("字幕 URL 为空。");
  }

  const cacheKey = getSubtitleCacheKey({
    bvid: state.bvid,
    cid: state.cid,
    subtitleId,
    subtitleUrl: url,
    lang
  });

  // 尝试从缓存读取
  if (!forceRefresh) {
    const cachedBody = await loadSubtitleFromCache(cacheKey);
    if (cachedBody && Array.isArray(cachedBody) && cachedBody.length > 0) {
      const cachedCheck = validateSubtitleByDuration(cachedBody, state.videoDuration);
      if (!cachedCheck.ok) {
        logWarn("[BOC] cached subtitle duration mismatch, clearing cache", {
          cacheKey,
          reason: cachedCheck.reason
        });
        await clearSubtitleCacheByKey(cacheKey);
      } else {
        logInfo("[BOC] using cached subtitle", { cacheKey, itemCount: cachedBody.length });
        ensureRunActive(runId);
        state.selectedSubtitleId = subtitleId ? String(subtitleId) : state.selectedSubtitleId;
        state.selectedSubtitleUrl = url;
        state.selectedSubtitleLang = lang;
        state.subtitleBody = cachedBody;
        state.markdown = buildMarkdown(state, cachedBody, state.settings);
        state.srt = buildSrt(cachedBody);
        state.txt = buildTxt(cachedBody, state.settings);
        byId(ids.preview).value = buildSubtitlePreview(cachedBody, state.settings);
        return;
      }
    }
  }

  // 从网络获取
  const subtitle = await fetchSubtitleBody(url);
  ensureRunActive(runId);
  const body = Array.isArray(subtitle.body) ? subtitle.body : [];
  if (body.length === 0) {
    throw new Error("字幕文件为空。");
  }
  const durationCheck = validateSubtitleByDuration(body, state.videoDuration);
  if (!durationCheck.ok) {
    const mismatchError = new Error("字幕时长与当前视频不匹配。");
    mismatchError.code = "SUBTITLE_DURATION_MISMATCH";
    mismatchError.details = durationCheck;
    throw mismatchError;
  }

  // 存入缓存
  await saveSubtitleToCache(cacheKey, body);

  state.selectedSubtitleId = subtitleId ? String(subtitleId) : state.selectedSubtitleId;
  state.selectedSubtitleUrl = url;
  state.selectedSubtitleLang = lang;
  state.subtitleBody = body;
  state.markdown = buildMarkdown(state, body, state.settings);
  state.srt = buildSrt(body);
  state.txt = buildTxt(body, state.settings);
  byId(ids.preview).value = buildSubtitlePreview(body, state.settings);
}

function getSubtitleCacheKey({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "" }) {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  return `${CACHE_KEY_PREFIX}${bvid}_${cid}_${sourceKey}`;
}

function buildSubtitleSourceKey(subtitleId, subtitleUrl, lang) {
  const id = String(subtitleId || "").trim();
  if (id) {
    return `id_${id}`;
  }

  const normalizedUrl = normalizeSubtitleUrlForCache(subtitleUrl);
  if (normalizedUrl) {
    return `url_${normalizedUrl}`;
  }

  return `lang_${String(lang || "").trim().toLowerCase() || "unknown"}`;
}

function normalizeSubtitleUrlForCache(url) {
  const text = String(url || "").trim();
  if (!text) {
    return "";
  }

  try {
    const parsed = new URL(text);
    const path = parsed.pathname.replace(/[^\w/.-]+/g, "_");
    return `${parsed.hostname}${path}`;
  } catch {
    return text.replace(/[^\w/.-]+/g, "_");
  }
}

async function loadSubtitleFromCache(cacheKey) {
  try {
    const result = await chrome.storage.local.get(cacheKey);
    return result[cacheKey]?.body || null;
  } catch {
    return null;
  }
}

async function saveSubtitleToCache(cacheKey, body) {
  try {
    await chrome.storage.local.set({
      [cacheKey]: {
        body,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    logWarn("[BOC] failed to save subtitle cache", error);
  }
}

async function clearSubtitleCacheByKey(cacheKey) {
  try {
    await chrome.storage.local.remove(cacheKey);
  } catch (error) {
    logWarn("[BOC] failed to clear subtitle cache by key", { cacheKey, error });
  }
}

async function clearSubtitleCache(bvid, cid, lang) {
  const cacheKey = getSubtitleCacheKey({ bvid, cid, lang });
  try {
    await chrome.storage.local.remove(cacheKey);
    logInfo("[BOC] cleared subtitle cache", { cacheKey });
  } catch (error) {
    logWarn("[BOC] failed to clear subtitle cache", error);
  }
}

function renderMeta() {
  const meta = byId(ids.meta);
  if (!state.bvid) {
    meta.innerHTML = '<div class="boc-meta-item">尚未抓取视频信息</div>';
    return;
  }

  const subtitleCount = state.subtitles.length;
  meta.innerHTML = `
    <div class="boc-meta-item"><strong>标题：</strong>${escapeHtml(state.title)}</div>
    <div class="boc-meta-item"><strong>URL：</strong>${escapeHtml(location.href)}</div>
    <div class="boc-meta-item"><strong>作者：</strong>${escapeHtml(state.author || "未知")}</div>
    <div class="boc-meta-item"><strong>日期：</strong>${escapeHtml(state.uploadDate || "未知")}</div>
    <div class="boc-meta-item"><strong>字幕轨：</strong>${subtitleCount}</div>
  `;
}

function renderSubtitleSelect() {
  const select = byId(ids.subtitleSelect);
  const subtitles = state.subtitles || [];

  if (subtitles.length === 0) {
    select.innerHTML = '<option value="">暂无字幕</option>';
    select.disabled = true;
    return;
  }

  select.innerHTML = subtitles
    .map((item) => {
      const selectedById =
        state.selectedSubtitleId && String(item.id) === String(state.selectedSubtitleId);
      const selectedByUrl = item.subtitleUrl === state.selectedSubtitleUrl;
      const selected = selectedById || selectedByUrl ? "selected" : "";
      const label = item.lanDoc || item.lan || "unknown";
      const isAi = isAiSubtitle(item);
      const aiTag = isAi ? " [AI自动]" : "";
      const optionLabel = `${label}${aiTag}`;
      return `<option value="${escapeHtml(item.subtitleUrl)}" data-lang="${escapeHtml(
        label
      )}" data-id="${escapeHtml(String(item.id || ""))}" data-isai="${isAi}" ${selected}>${escapeHtml(
        optionLabel
      )}</option>`;
    })
    .join("");
  select.disabled = false;
}

function getPopupPayload() {
  const subtitleOptions = (state.subtitles || []).map((item) => {
    const label = item.lanDoc || item.lan || "unknown";
    const isAi = isAiSubtitle(item);
    const selectedById =
      state.selectedSubtitleId && String(item.id) === String(state.selectedSubtitleId);
    const selectedByUrl = item.subtitleUrl === state.selectedSubtitleUrl;
    return {
      id: String(item.id || ""),
      url: item.subtitleUrl,
      lang: label,
      isAi,
      selected: selectedById || selectedByUrl
    };
  });

  return {
    url: location.href,
    title: state.title || "",
    author: state.author || "",
    uploadDate: state.uploadDate || "",
    tags: String(state.settings?.tags || ""),
    status: state.statusText || "",
    message: state.messageText || "",
    subtitlePreview: buildSubtitlePreview(state.subtitleBody || [], state.settings || DEFAULT_SETTINGS),
    markdown: state.markdown || "",
    srt: state.srt || "",
    txt: state.txt || "",
    downloadFormat: normalizeDownloadFormat(state.settings?.downloadFormat),
    subtitleOptions
  };
}

async function copyMarkdown() {
  if (!state.markdown) {
    setMessage("没有可复制的内容，请先刷新抓取。");
    return;
  }

  try {
    await navigator.clipboard.writeText(state.markdown);
    setMessage("Markdown 已复制到剪贴板。");
  } catch (error) {
    setMessage(`复制失败：${getErrorMessage(error)}`);
  }
}

async function downloadSubtitle() {
  state.settings = await getSettings();
  const format = normalizeDownloadFormat(state.settings?.downloadFormat);
  const content = format === "txt" ? state.txt : state.srt;
  if (!content) {
    setMessage("没有可下载的字幕，请先刷新抓取。");
    return;
  }

  const safeTitle = sanitizeFileName(state.title || state.bvid || "bilibili-subtitle");
  const langSuffix = sanitizeFileName(state.selectedSubtitleLang || "subtitle") || "subtitle";
  const filename = `${safeTitle}.${langSuffix}.${format}`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setMessage(`已下载：${filename}`);
}

async function sendToObsidian() {
  state.settings = await getSettings();
  if (!state.markdown) {
    setMessage("没有可发送内容，请先刷新抓取。");
    return;
  }

  const filename = buildNoteFilename(state);
  const folder = normalizeFolder(state.settings.noteFolder || "");
  const filepath = folder ? `${folder}/${filename}` : filename;
  const baseUrl = String(state.settings.obsidianApiBaseUrl || "").trim();
  const apiKey = String(state.settings.obsidianApiKey || "").trim();
  if (!baseUrl || !apiKey) {
    setMessage("请先在设置中填写 Obsidian Local REST API 地址和 API Key。");
    requestOpenOptions();
    return;
  }

  try {
    await writeNoteByLocalApi(baseUrl, apiKey, filepath, state.markdown);
    setMessage(`已写入 Obsidian：${filepath}`);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      setMessage("扩展刚刚更新，请刷新当前页面后重试。");
      return;
    }
    setMessage(`写入失败：${getErrorMessage(error)}`);
  }
}

async function writeNoteByLocalApi(baseUrl, apiKey, filepath, content) {
  const resp = await sendRuntimeMessage({
    type: "write-obsidian-note",
    baseUrl,
    apiKey,
    filepath,
    content
  });
  if (!resp?.ok) {
    throw new Error(toReadableText(resp?.error, "Local API 写入失败"));
  }
}

function setBusyState(disabled) {
  byId(ids.copyBtn).disabled = disabled;
  byId(ids.downloadBtn).disabled = disabled;
  byId(ids.sendBtn).disabled = disabled;
  byId(ids.refreshBtn).disabled = disabled;
  byId(ids.settingsBtn).disabled = disabled;
  byId(ids.subtitleSelect).disabled = disabled || state.subtitles.length === 0;
}

function setStatus(text) {
  state.statusText = String(text || "");
  byId(ids.status).textContent = state.statusText;
}

function setMessage(text) {
  state.messageText = String(text || "");
  byId(ids.message).textContent = state.messageText;
}

function toReadableText(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === "[object Object]") {
      return fallback;
    }
    return text;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (json && json !== "{}") {
      return json;
    }
  } catch {
    // ignore
  }
  const text = String(value);
  if (!text || text === "[object Object]") {
    return fallback;
  }
  return text;
}

function getErrorMessage(error, fallback = "未知错误") {
  const code = toReadableText(error?.code, "");
  const message = toReadableText(error?.message, "");
  if (message) {
    return code ? `${message} (code: ${code})` : message;
  }
  if (code) {
    return `code: ${code}`;
  }
  return toReadableText(error, fallback);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function isExtensionContextInvalidated(error) {
  const msg = String(error?.message || "");
  return msg.includes("Extension context invalidated");
}

function requestOpenOptions() {
  sendRuntimeMessage({ type: "open-options" })
    .then((resp) => {
      if (!resp?.ok) {
        setMessage(`打开设置失败：${toReadableText(resp?.error, "未知错误")}`);
      }
    })
    .catch((error) => {
      if (isExtensionContextInvalidated(error)) {
        setMessage("扩展刚刚更新，请刷新当前页面后重试。");
        return;
      }
      setMessage(`打开设置失败：${getErrorMessage(error)}`);
    });
}

async function getSettings() {
  try {
    const response = await sendRuntimeMessage({ type: "get-settings" });
    if (!response?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(response.settings || {}) };
  } catch (error) {
    return { ...DEFAULT_SETTINGS };
  }
}

function byId(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing node: ${id}`);
  }
  return node;
}

function extractBvid(url) {
  const match = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (match?.[1]) {
    return match[1];
  }

  try {
    const parsed = new URL(url);
    const fromQuery = String(parsed.searchParams.get("bvid") || "").trim();
    if (/^BV[0-9A-Za-z]+$/.test(fromQuery)) {
      return fromQuery;
    }
  } catch {
    // ignore invalid URL
  }

  return "";
}

function extractPageIndex(url) {
  try {
    const page = Number(new URL(url).searchParams.get("p") || "1");
    if (!Number.isFinite(page) || page <= 0) {
      return 1;
    }
    return page;
  } catch {
    return 1;
  }
}

function hasExplicitPageParam(url) {
  try {
    return new URL(url).searchParams.has("p");
  } catch {
    return false;
  }
}

function extractOid(url) {
  try {
    return String(new URL(url).searchParams.get("oid") || "").trim();
  } catch {
    return "";
  }
}

function ensureRunActive(runId) {
  if (runId !== state.fetchRunId) {
    const error = new Error("Stale refresh run");
    error.code = "STALE_RUN";
    throw error;
  }
}

function isStaleRunError(error) {
  return error?.code === "STALE_RUN";
}

async function retryAsync(task, retries = 1, delayMs = 180) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      // 如果不是网络错误也不是可重试的业务错误，立即抛出
      const isNetworkError = isRetryableNetworkError(error);
      const isRetryable = error?.retryable === true;
      if (!isNetworkError && !isRetryable) {
        throw error;
      }
      if (attempt >= retries) {
        throw error;
      }
      // 指数退避：delayMs * 2^(attempt-1)，最多等待 5 秒
      const backoffDelay = Math.min(delayMs * Math.pow(2, attempt - 1), 5000);
      logInfo(`[BOC] retrying after ${backoffDelay}ms, attempt ${attempt + 1}/${retries}`, {
        error: getErrorMessage(error),
        code: error.code
      });
      await sleep(backoffDelay);
    }
  }
  throw lastError || new Error("Unknown retry error");
}

function isRetryableNetworkError(error) {
  const message = getErrorMessage(error, "").toLowerCase();
  if (!message) {
    return false;
  }

  if (message.includes("http ")) {
    return true;
  }

  return (
    message.includes("请求失败") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("networkerror") ||
    message.includes("net::") ||
    message.includes("background fetch failed") ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

async function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchVideoMeta(bvid) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  logInfo("[BOC] fetch video meta", { url, bvid });
  const payload = await fetchJson(url);
  if (payload.code !== 0) {
    throw new Error(toReadableText(payload?.message, "无法获取视频信息"));
  }

  const data = payload.data || {};
  const pubdate = Number(data.pubdate || 0);
  const uploadDate = pubdate > 0 ? new Date(pubdate * 1000).toISOString().slice(0, 10) : "";
  const pages = Array.isArray(data.pages) ? data.pages : [];

  return {
    aid: data.aid ? String(data.aid) : "",
    title: String(data.title || ""),
    author: String(data.owner?.name || ""),
    description: String(data.desc || ""),
    uploadDate,
    defaultCid: data.cid ? String(data.cid) : "",
    defaultDuration: Number(data.duration || 0) || 0,
    pages: pages.map((item) => ({
      cid: String(item.cid || ""),
      page: Number(item.page || 0) || 0,
      part: String(item.part || "").trim(),
      duration: Number(item.duration || 0) || 0
    }))
  };
}

function pickPageFromPages(pages, pageIndex) {
  const safePageIndex = Number(pageIndex) > 0 ? Number(pageIndex) : 1;
  const safePages = Array.isArray(pages) ? pages : [];
  const pageByIndex = safePages[safePageIndex - 1];
  if (pageByIndex?.cid) {
    return pageByIndex;
  }

  const pageByNo = safePages.find((item) => Number(item.page) === safePageIndex);
  if (pageByNo?.cid) {
    return pageByNo;
  }

  return null;
}

function pickCidFromPages(pages, pageIndex, fallbackCid = "") {
  const matchedPage = pickPageFromPages(pages, pageIndex);
  if (matchedPage?.cid) {
    return String(matchedPage.cid);
  }

  const safePages = Array.isArray(pages) ? pages : [];
  if (safePages[0]?.cid) {
    return String(safePages[0].cid);
  }

  if (fallbackCid) {
    return String(fallbackCid);
  }

  throw new Error("没有找到当前分P的 CID。");
}

function pickPageIndexFromOid(pages, oid) {
  const safeOid = String(oid || "").trim();
  if (!safeOid) {
    return 0;
  }

  const safePages = Array.isArray(pages) ? pages : [];
  const pageByCid = safePages.find((item) => String(item?.cid || "") === safeOid);
  if (pageByCid?.page) {
    return Number(pageByCid.page) || 0;
  }

  return 0;
}

function pickDurationFromPages(pages, pageIndex, fallbackDuration = 0) {
  const matchedPage = pickPageFromPages(pages, pageIndex);
  if (Number(matchedPage?.duration) > 0) {
    return Number(matchedPage.duration);
  }

  const safePages = Array.isArray(pages) ? pages : [];
  if (Number(safePages[0]?.duration) > 0) {
    return Number(safePages[0].duration);
  }

  return Number(fallbackDuration || 0) || 0;
}

function readVideoTitle() {
  const h1 = document.querySelector("h1.video-title");
  if (h1?.textContent?.trim()) {
    return h1.textContent.trim();
  }

  const metaTitle = document.querySelector('meta[property="og:title"]');
  if (metaTitle?.getAttribute("content")) {
    return metaTitle.getAttribute("content").trim();
  }

  return document.title.replace(/_哔哩哔哩_bilibili/i, "").trim();
}

function readVideoAuthor() {
  const owner = document.querySelector(".up-name");
  if (owner?.textContent?.trim()) {
    return owner.textContent.trim();
  }

  const author = document.querySelector('meta[name="author"]');
  return author?.getAttribute("content")?.trim() || "";
}

function readUploadDate() {
  const publishNode = document.querySelector('meta[itemprop="uploadDate"]');
  if (publishNode?.getAttribute("content")) {
    return publishNode.getAttribute("content").trim();
  }

  const dateText = document.querySelector(".pubdate-ip-text")?.textContent?.trim();
  if (dateText) {
    return dateText;
  }

  return new Date().toISOString().slice(0, 10);
}

async function fetchSubtitleBundle(bvid, cid, aid = "") {
  const requests = buildSubtitleInfoRequests({ bvid, cid, aid });
  const fetchByRequest = async (request) => {
    logInfo("[BOC] fetch subtitles list", {
      source: request.source,
      url: request.url,
      bvid,
      cid,
      aid
    });

    const payload = await fetchJson(request.url);
    logInfo("[BOC] subtitles API raw response", { source: request.source, payload });
    if (payload.code !== 0) {
      throw buildBiliApiError(payload, "无法获取字幕列表");
    }

    const chapters = mapChaptersFromPlayerData(payload.data);
    const subtitles = mapSubtitleTracks(payload.data?.subtitle?.subtitles || [], request.source);
    const withUrl = subtitles.filter((item) => item.subtitleUrl);
    return { source: request.source, chapters, withUrl };
  };

  if (requests.length === 0) {
    return { tracks: [], chapters: [] };
  }

  const primaryRequest = requests[0];
  try {
    const primaryResult = await fetchByRequest(primaryRequest);
    if (primaryResult.withUrl.length > 0) {
      return { tracks: primaryResult.withUrl, chapters: primaryResult.chapters };
    }
    // 主来源成功但无字幕：直接判定无字幕，不再跨源兜底。
    return { tracks: [], chapters: primaryResult.chapters };
  } catch (primaryError) {
    logWarn("[BOC] subtitles API request failed", {
      source: primaryRequest.source,
      message: getErrorMessage(primaryError)
    });

    // 仅当主来源请求失败时才尝试次来源。
    if (requests.length > 1) {
      const secondaryRequest = requests[1];
      try {
        const secondaryResult = await fetchByRequest(secondaryRequest);
        if (secondaryResult.withUrl.length > 0) {
          logWarn("[BOC] primary subtitles source failed, using fallback source", {
            primary: primaryRequest.source,
            fallback: secondaryRequest.source
          });
          return { tracks: secondaryResult.withUrl, chapters: secondaryResult.chapters };
        }
        return { tracks: [], chapters: secondaryResult.chapters };
      } catch (secondaryError) {
        logWarn("[BOC] fallback subtitles source failed", {
          source: secondaryRequest.source,
          message: getErrorMessage(secondaryError)
        });
        throw secondaryError;
      }
    }

    throw primaryError;
  }
}

function buildSubtitleInfoRequests({ bvid, cid, aid }) {
  const safeBvid = encodeURIComponent(String(bvid || ""));
  const safeCid = encodeURIComponent(String(cid || ""));
  const safeAid = encodeURIComponent(String(aid || ""));
  const requests = [];

  // 参考 SubBatch：优先用 aid+cid 的 wbi 接口作为主来源。
  if (aid) {
    requests.push({
      source: "player-wbi-v2",
      url:
        "https://api.bilibili.com/x/player/wbi/v2" +
        `?aid=${safeAid}` +
        `&cid=${safeCid}` +
        (bvid ? `&bvid=${safeBvid}` : "")
    });
  }

  // 仅在主来源不可用时再回退到 player-v2。
  requests.push({
    source: "player-v2",
    url:
      "https://api.bilibili.com/x/player/v2" +
      (bvid ? `?bvid=${safeBvid}` : "?") +
      `${bvid ? "&" : ""}cid=${safeCid}` +
      (aid ? `&aid=${safeAid}` : "")
  });

  return requests;
}

function buildBiliApiError(payload, fallbackMessage) {
  const msg = toReadableText(payload?.message, fallbackMessage);
  const error = new Error(msg);
  error.code = payload?.code;
  error.retryable = isRetryableError(payload?.code);
  return error;
}

function mapSubtitleTracks(subtitles, source = "unknown") {
  return (subtitles || []).map((item) => ({
    id: item?.id === undefined || item?.id === null ? "" : String(item.id),
    lan: item?.lan || "",
    lanDoc: item?.lan_doc || "",
    subtitleUrl: normalizeSubtitleUrl(item?.subtitle_url || ""),
    source
  }));
}

function mapChaptersFromPlayerData(data) {
  const raw = Array.isArray(data?.view_points) ? data.view_points : [];
  return normalizeChapters(
    raw.map((item) => ({
      title: String(item?.content || item?.title || item?.label || "").trim(),
      from: normalizeChapterTime(item?.from ?? item?.start ?? item?.start_time),
      to: normalizeChapterTime(item?.to ?? item?.end ?? item?.end_time),
      source: "player-view-points"
    }))
  );
}

function normalizeChapterTime(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }

  // 某些接口会返回毫秒级时间戳，这里统一转换成秒。
  return num > 60 * 60 * 24 ? num / 1000 : num;
}

function normalizeChapters(chapters) {
  const normalized = (chapters || [])
    .map((item) => ({
      title: String(item?.title || "").trim(),
      from: Number(item?.from || 0) || 0,
      to: Number(item?.to || 0) || 0,
      source: String(item?.source || "")
    }))
    .filter((item) => item.title && item.from >= 0)
    .sort((a, b) => a.from - b.from);

  const unique = [];
  const seen = new Set();
  normalized.forEach((item) => {
    const key = `${Math.floor(item.from * 10)}|${item.title.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(item);
  });

  return unique;
}

function isRetryableError(code) {
  // -509: 请求过于频繁
  // -3: 参数错误（可能是临时性的）
  // 其他负数错误码也可能是临时性的
  return code === -509 || code === -3 || code < 0;
}

function normalizeSubtitleTracks(subtitles) {
  return [...(subtitles || [])].sort((a, b) => {
    const p = subtitlePriority(a) - subtitlePriority(b);
    if (p !== 0) {
      return p;
    }

    const lanA = String(a.lanDoc || a.lan || "").toLowerCase();
    const lanB = String(b.lanDoc || b.lan || "").toLowerCase();
    if (lanA < lanB) {
      return -1;
    }
    if (lanA > lanB) {
      return 1;
    }

    const idA = Number.parseInt(String(a.id || "0"), 10);
    const idB = Number.parseInt(String(b.id || "0"), 10);
    if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) {
      return idA - idB;
    }

    return String(a.subtitleUrl).localeCompare(String(b.subtitleUrl));
  });
}

function pickPreferredSubtitle(
  subtitles,
  { previousId = "", previousUrl = "", previousLang = "" } = {}
) {
  const tracks = subtitles || [];
  if (tracks.length === 0) {
    return null;
  }

  // 先按轨道 id 复用，最稳定
  if (previousId) {
    const byId = tracks.find((item) => String(item.id || "") === String(previousId));
    if (byId) {
      return byId;
    }
  }

  // 其次按 URL 路径复用（忽略 auth_key 等动态参数）
  const prevUrlKey = normalizeSubtitleUrlForCache(previousUrl);
  if (prevUrlKey) {
    const byUrl = tracks.find(
      (item) => normalizeSubtitleUrlForCache(item.subtitleUrl) === prevUrlKey
    );
    if (byUrl) {
      return byUrl;
    }
  }

  const normalizedPrevLang = String(previousLang || "").trim().toLowerCase();
  if (normalizedPrevLang) {
    const byLang = tracks.find((item) => {
      const label = String(item.lanDoc || item.lan || "").trim().toLowerCase();
      return label === normalizedPrevLang;
    });
    if (byLang) {
      return byLang;
    }
  }

  // 默认直接拿排序后的第一条：中文优先，其次英文。
  return tracks[0];
}

function buildSubtitleCandidates(subtitles, preferred) {
  const tracks = subtitles || [];
  const seen = new Set();
  const list = [];

  const pushUnique = (item) => {
    if (!item) {
      return;
    }
    const key =
      `${String(item.id || "").trim()}|` +
      `${normalizeSubtitleUrlForCache(item.subtitleUrl)}|` +
      `${String(item.lan || "").trim().toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    list.push(item);
  };

  pushUnique(preferred);
  for (const item of tracks) {
    pushUnique(item);
  }
  return list;
}

async function tryLoadSubtitleCandidates(candidates, runId, forceRefresh) {
  let lastError = null;
  for (const item of candidates || []) {
    try {
      logInfo("[BOC] try subtitle track", {
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        url: item.subtitleUrl
      });
      await loadSubtitle(
        item.subtitleUrl,
        item.lanDoc || item.lan || "unknown",
        runId,
        item.id,
        forceRefresh
      );
      return item;
    } catch (error) {
      lastError = error;
      const reasonCode = toReadableText(error?.code, "");
      const reasonMessage = getErrorMessage(error, "unknown");
      const meta = {
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        reason: reasonCode || reasonMessage
      };
      if (reasonCode === "SUBTITLE_DURATION_MISMATCH") {
        logInfo(`[BOC] subtitle track skipped ${JSON.stringify(meta)}`);
      } else {
        logWarn(`[BOC] subtitle track rejected ${JSON.stringify(meta)}`);
      }
      ensureRunActive(runId);
      continue;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("这个视频暂时没有可用字幕。");
}

function isAiSubtitle(item) {
  const lan = String(item?.lan || "").toLowerCase();
  // B站 AI 自动字幕的 lan 以 "ai-" 开头
  return lan.startsWith("ai-");
}

function subtitlePriority(item) {
  const lan = String(item?.lan || "").toLowerCase();
  const label = String(item?.lanDoc || "").toLowerCase();

  // 优先级：中文（包含 AI 中文）-> 英文 -> 其他
  if (lan === "zh-cn" || lan === "zh-hans") {
    return 0;
  }
  if (lan === "zh") {
    return 1;
  }
  if (lan.includes("zh")) {
    return 2;
  }
  if (label.includes("中文")) {
    return 3;
  }

  if (lan === "en" || lan === "en-us" || lan === "en-gb") {
    return 10;
  }
  if (lan.includes("en")) {
    return 11;
  }
  if (label.includes("英文") || label.includes("英语") || label.includes("english")) {
    return 12;
  }

  return 50;
}

function validateSubtitleByDuration(body, videoDuration) {
  const duration = Number(videoDuration || 0);
  if (!Array.isArray(body) || body.length === 0) {
    return { ok: false, reason: "empty", videoDuration: duration, maxTo: 0 };
  }

  let maxTo = 0;
  for (const item of body) {
    const to = Number(item?.to);
    const from = Number(item?.from);
    if (Number.isFinite(to) && to > maxTo) {
      maxTo = to;
    }
    if (Number.isFinite(from) && from > maxTo) {
      maxTo = from;
    }
  }

  if (!(duration > 0)) {
    return { ok: true, reason: "skip-no-video-duration", videoDuration: duration, maxTo };
  }

  const upperTolerance = Math.max(12, duration * 0.15);
  if (maxTo > duration + upperTolerance) {
    return { ok: false, reason: "too-long", videoDuration: duration, maxTo };
  }

  let minCoverageRatio = 0;
  if (duration >= 600) {
    minCoverageRatio = 0.18;
  } else if (duration >= 300) {
    minCoverageRatio = 0.22;
  } else if (duration >= 180) {
    minCoverageRatio = 0.25;
  }

  if (minCoverageRatio > 0 && maxTo < duration * minCoverageRatio) {
    return { ok: false, reason: "too-short", videoDuration: duration, maxTo };
  }

  return { ok: true, reason: "ok", videoDuration: duration, maxTo };
}

function readRuntimeVideoDuration() {
  const video = document.querySelector("video");
  const duration = Number(video?.duration);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  return 0;
}

async function fetchSubtitleBody(url) {
  logInfo("[BOC] fetch subtitle body", { url });
  return fetchJsonInBackground(url);
}

async function fetchJson(url) {
  if (typeof url === "string" && url.startsWith("https://api.bilibili.com/")) {
    return fetchJsonInBackground(url);
  }

  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`);
  }

  return response.json();
}

async function fetchJsonInBackground(url) {
  try {
    const resp = await sendRuntimeMessage({ type: "fetch-json", url });
    if (!resp?.ok) {
      throw new Error(toReadableText(resp?.error, "Background fetch failed"));
    }
    return resp.data;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      throw new Error("扩展刚刚更新，请刷新当前页面后重试。");
    }
    throw error;
  }
}

function normalizeSubtitleUrl(url) {
  if (!url) {
    return "";
  }

  if (url.startsWith("//")) {
    return `https:${url}`;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  return `https://${url.replace(/^\/+/, "")}`;
}

function buildSubtitlePreview(body, settings) {
  const compactWithHours = shouldShowHoursInSubtitle(body);
  return (body || [])
    .map((item) => {
      const text = String(item?.content || "").trim();
      if (!text) {
        return "";
      }
      if (settings.includeTimestampInBody) {
        return `\`${formatCompactTimestamp(item.from, compactWithHours)}\` ${text}`;
      }
      return text;
    })
    .filter(Boolean)
    .join("\n");
}

function buildMarkdown(meta, body, settings) {
  const created = new Date().toISOString().slice(0, 10);
  const tags = (settings.tags || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const tagsYaml =
    tags.length === 0 ? "[]" : `[${tags.map((tag) => `"${tag.replace(/"/g, '\\"')}"`).join(", ")}]`;

  const compactWithHours = shouldShowHoursInNote(meta, body);
  const chapterLines = buildChapterLines(meta.chapters || [], compactWithHours);
  const subtitleSectionLines = buildSubtitleSectionLines(
    body,
    meta.chapters || [],
    settings,
    compactWithHours
  );
  const frontMatter = buildFrontMatter(meta, settings, created, tagsYaml);

  const page = extractPageIndex(location.href);
  const embedIframe = buildBilibiliEmbedIframe(meta, page);
  const intro = String(meta.description || "").trim();

  const lines = [];
  if (frontMatter) {
    lines.push(frontMatter, "");
  }
  lines.push(embedIframe, "");

  if (intro) {
    lines.push("## 简介", "", intro, "");
  }

  if (chapterLines.length > 0) {
    lines.push("## 章节", "", ...chapterLines, "");
  }

  lines.push("## 字幕", "", ...subtitleSectionLines);

  return lines.join("\n");
}

function buildFrontMatter(meta, settings, created, tagsYaml) {
  const enabled = getEnabledFrontmatterFields(settings);
  if (enabled.length === 0) {
    return "";
  }

  const fieldLines = {
    title: `title: "${escapeYaml(meta.title)}"`,
    url: `url: "${escapeYaml(location.href)}"`,
    bvid: `bvid: "${escapeYaml(meta.bvid)}"`,
    cid: `cid: "${escapeYaml(meta.cid)}"`,
    author: `author: "${escapeYaml(meta.author || "unknown")}"`,
    upload_date: `upload_date: "${escapeYaml(meta.uploadDate || "unknown")}"`,
    subtitle_lang: `subtitle_lang: "${escapeYaml(meta.selectedSubtitleLang || "unknown")}"`,
    created: `created: "${created}"`,
    tags: `tags: ${tagsYaml}`
  };

  const lines = enabled.map((field) => fieldLines[field]).filter(Boolean);
  if (lines.length === 0) {
    return "";
  }

  return ["---", ...lines, "---"].join("\n");
}

function getEnabledFrontmatterFields(settings) {
  const defaultFields = Array.isArray(DEFAULT_SETTINGS.frontmatterFields)
    ? DEFAULT_SETTINGS.frontmatterFields
    : [];
  const raw = Array.isArray(settings?.frontmatterFields) ? settings.frontmatterFields : defaultFields;
  const allowed = new Set(defaultFields);
  const unique = [];
  raw.forEach((item) => {
    const key = String(item || "").trim();
    if (!key || !allowed.has(key) || unique.includes(key)) {
      return;
    }
    unique.push(key);
  });
  return unique;
}

function buildSubtitleSectionLines(body, chapters, settings, withHours) {
  const subtitleItems = (body || [])
    .map((item, index) => ({
      ...item,
      _index: index,
      text: String(item?.content || "").trim()
    }))
    .filter((item) => item.text);
  if (subtitleItems.length === 0) {
    return ["（暂无字幕）"];
  }

  const chapterItems = normalizeChapters(chapters);
  if (chapterItems.length === 0) {
    return subtitleItems.map((item) => formatSubtitleLine(item, settings, withHours));
  }

  const lines = [];
  const usedIndexes = new Set();

  chapterItems.forEach((chapter, idx) => {
    const start = Number(chapter.from || 0) || 0;
    const next = chapterItems[idx + 1];
    const chapterTo = Number(chapter.to || 0) || 0;
    let end = Infinity;
    if (next && Number(next.from) > start) {
      end = Number(next.from);
    } else if (chapterTo > start) {
      end = chapterTo;
    }

    const sectionItems = subtitleItems.filter((item) => {
      const from = Number(item.from || 0) || 0;
      const inStart = from + 0.001 >= start;
      const inEnd = end === Infinity ? true : from < end;
      return inStart && inEnd;
    });

    if (sectionItems.length === 0) {
      return;
    }

    const chapterStamp = settings.includeTimestampInBody
      ? ` \`${formatCompactTimestamp(start, withHours)}\``
      : "";
    lines.push(`### ${chapter.title}${chapterStamp}`, "");
    sectionItems.forEach((item) => {
      usedIndexes.add(item._index);
      lines.push(formatSubtitleLine(item, settings, withHours));
    });
    lines.push("");
  });

  const remaining = subtitleItems.filter((item) => !usedIndexes.has(item._index));
  if (remaining.length > 0) {
    lines.push("### 其他片段", "");
    remaining.forEach((item) => {
      lines.push(formatSubtitleLine(item, settings, withHours));
    });
    lines.push("");
  }

  if (lines.length === 0) {
    return subtitleItems.map((item) => formatSubtitleLine(item, settings, withHours));
  }

  while (lines.length > 0 && !lines[lines.length - 1]) {
    lines.pop();
  }
  return lines;
}

function formatSubtitleLine(item, settings, withHours) {
  const text = String(item?.content || "").trim();
  if (!text) {
    return "";
  }
  if (!settings.includeTimestampInBody) {
    return text;
  }
  return `\`${formatCompactTimestamp(item.from, withHours)}\` ${text}`;
}

function buildChapterLines(chapters, withHours = false) {
  const chapterItems = normalizeChapters(chapters);
  if (chapterItems.length === 0) {
    return [];
  }

  return chapterItems.map((item) => {
    const fromText = formatCompactTimestamp(item.from, withHours);
    return `- \`${fromText}\` ${item.title}`;
  });
}

function buildBilibiliEmbedIframe(meta, page = 1) {
  const safeAid = encodeURIComponent(String(meta?.aid || "").trim());
  const safeBvid = encodeURIComponent(String(meta?.bvid || "").trim());
  const safeCid = encodeURIComponent(String(meta?.cid || "").trim());
  const safePage = Number(page) > 0 ? Number(page) : 1;

  return `<iframe src="https://player.bilibili.com/player.html?aid=${safeAid}&bvid=${safeBvid}&cid=${safeCid}&page=${safePage}&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allow="fullscreen; picture-in-picture" allowfullscreen="true" style="height:100%;width:100%; aspect-ratio: 16 / 9;"> </iframe>`;
}

function buildSrt(body) {
  return body
    .map((item, index) => {
      const from = formatTimestamp(item.from, true);
      const to = formatTimestamp(item.to, true);
      const text = (item.content || "").trim();
      return `${index + 1}\n${from} --> ${to}\n${text}`;
    })
    .join("\n\n");
}

function buildTxt(body, settings) {
  const withHours = shouldShowHoursInSubtitle(body);
  return (body || [])
    .map((item) => {
      const text = String(item?.content || "").trim();
      if (!text) {
        return "";
      }
      if (!settings?.includeTimestampInBody) {
        return text;
      }
      return `${formatCompactTimestamp(item.from, withHours)} ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

function shouldShowHoursInSubtitle(body) {
  const maxTo = (body || []).reduce((max, item) => {
    const to = Number(item?.to || 0);
    return Number.isFinite(to) && to > max ? to : max;
  }, 0);
  return maxTo >= 3600;
}

function shouldShowHoursInNote(meta, body) {
  const subtitleMaxTo = (body || []).reduce((max, item) => {
    const to = Number(item?.to || 0);
    return Number.isFinite(to) && to > max ? to : max;
  }, 0);
  const chapterMaxTo = normalizeChapters(meta?.chapters || []).reduce((max, item) => {
    const from = Number(item?.from || 0) || 0;
    const to = Number(item?.to || 0) || 0;
    return Math.max(max, from, to);
  }, 0);
  const duration = Number(meta?.videoDuration || 0) || 0;
  return Math.max(subtitleMaxTo, chapterMaxTo, duration) >= 3600;
}

function formatCompactTimestamp(seconds, withHours) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hour = Math.floor(safe / 3600);
  const minute = Math.floor((safe % 3600) / 60);
  const second = safe % 60;

  if (withHours) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(
      second
    ).padStart(2, "0")}`;
  }

  const totalMinutes = Math.floor(safe / 60);
  return `${String(totalMinutes).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function formatTimestamp(seconds, forSrt = false) {
  const safe = Number(seconds) || 0;
  const msTotal = Math.max(0, Math.floor(safe * 1000));
  const hour = Math.floor(msTotal / 3600000);
  const minute = Math.floor((msTotal % 3600000) / 60000);
  const second = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  if (!forSrt) {
    return `${hh}:${mm}:${ss}.${String(ms).padStart(3, "0")}`;
  }

  return `${hh}:${mm}:${ss},${String(ms).padStart(3, "0")}`;
}

function sanitizeFileName(value) {
  return value.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}

function normalizeDownloadFormat(value) {
  return value === "txt" ? "txt" : "srt";
}

function buildNoteFilename(meta) {
  const includeDate = state.settings?.includeDateInFilename !== false;
  const baseParts = [];

  if (includeDate) {
    baseParts.push(new Date().toISOString().slice(0, 10));
  }

  baseParts.push(meta.title || meta.bvid || "bilibili-subtitle");

  if (Number(meta.pageCount) > 1) {
    baseParts.push(`P${Number(meta.pageIndex) > 0 ? Number(meta.pageIndex) : 1}`);
    const pageTitle = String(meta.pageTitle || "").trim();
    if (pageTitle) {
      baseParts.push(pageTitle);
    }
  }

  const baseName = sanitizeFileName(baseParts.filter(Boolean).join("-"));
  return `${baseName || "bilibili-subtitle"}.md`;
}

function normalizeFolder(input) {
  return String(input || "").trim().replace(/^\/+|\/+$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeYaml(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
