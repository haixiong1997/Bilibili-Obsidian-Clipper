const DEFAULT_SETTINGS = {
  noteFolder: "Clippings/Bilibili",
  obsidianApiBaseUrl: "http://127.0.0.1:27123",
  obsidianApiKey: "",
  tags: "clippings,bilibili",
  includeTimestampInBody: true,
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

const BOC_VERSION = "1.0.11";
const CACHE_KEY_PREFIX = "boc_subtitle_cache_";

const state = {
  currentUrl: location.href,
  fetchRunId: 0,
  bvid: "",
  aid: "",
  cid: "",
  cidSource: "",
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
  isBusy: false,
  statusText: "准备就绪，点击“刷新抓取”开始。",
  messageText: "",
  settings: { ...DEFAULT_SETTINGS }
};

init();

function init() {
  console.info(`[BOC] content script loaded, version=${BOC_VERSION}`);
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
        .catch((error) => sendResponse({ ok: false, error: error.message, payload: getPopupPayload() }));
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
          sendResponse({ ok: true, payload: getPopupPayload() });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message, payload: getPopupPayload() }));
      return true;
    }

    if (message.type === "popup-send-obsidian") {
      sendToObsidian()
        .then(() => sendResponse({ ok: true, payload: getPopupPayload() }))
        .catch((error) => sendResponse({ ok: false, error: error.message, payload: getPopupPayload() }));
      return true;
    }

    return false;
  });
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
    const hasPageParam = hasExplicitPageParam(location.href);
    const meta = await retryAsync(() => fetchVideoMeta(state.bvid), 2, 250);
    ensureRunActive(runId);

    // 调试：打印 API 返回的原始数据
    console.info("[BOC] raw meta data", {
      meta,
      defaultCid: meta.defaultCid,
      pagesCount: (meta.pages || []).length
    });

    state.aid = meta.aid || "";
    state.title = meta.title || readVideoTitle();
    state.author = meta.author || readVideoAuthor();
    state.uploadDate = meta.uploadDate || readUploadDate();
    state.description = meta.description || "";
    if ((meta.pages || []).length > 1 && !hasPageParam) {
      throw new Error("多分P视频请先切到目标分P（URL含?p=）后再抓取。");
    }
    state.cid = pickCidFromPages(meta.pages, pageIndex, meta.defaultCid);
    state.cidSource = "meta-pages";
    state.videoDuration = pickDurationFromPages(meta.pages, pageIndex, meta.defaultDuration);

    console.info("[BOC] resolved video ids", {
      url: location.href,
      aid: state.aid,
      bvid: state.bvid,
      cid: state.cid,
      cidSource: state.cidSource,
      pageIndex,
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
    console.info(
      "[BOC] chapters",
      state.chapters.map((item) => ({
        from: item.from,
        to: item.to,
        title: item.title
      }))
    );
    console.info(
      "[BOC] subtitle tracks",
      state.subtitles.map((item) => ({
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        url: item.subtitleUrl
      }))
    );

    // B站 API 有时不返回字幕列表，需要等待并重试
    if (state.subtitles.length === 0) {
      console.info("[BOC] subtitle tracks empty, waiting and retrying...");
      // 等待 1 秒后重试
      await sleep(1000);
      subtitleBundle = await retryAsync(
        () => fetchSubtitleBundle(state.bvid, state.cid, state.aid),
        3,
        800
      );
      state.subtitles = normalizeSubtitleTracks(subtitleBundle.tracks);
      state.chapters = normalizeChapters(subtitleBundle.chapters);
      if (state.subtitles.length === 0) {
        throw new Error("这个视频暂时没有可用字幕。");
      }
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
      const message = String(error?.message || "");
      if (!message.includes("HTTP") && error?.code !== "SUBTITLE_DURATION_MISMATCH") {
        throw error;
      }

      // Retry because subtitle signed URLs may expire quickly or hit rate limit.
      const preferPlayerV2 = error?.code === "SUBTITLE_DURATION_MISMATCH";
      subtitleBundle = await retryAsync(
        () => fetchSubtitleBundle(state.bvid, state.cid, state.aid, { preferPlayerV2 }),
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
      console.info("[BOC] selected subtitle track", {
        id: selected.id,
        lan: selected.lan,
        lanDoc: selected.lanDoc
      });
    }
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
    setStatus(`抓取失败：${error.message}`);
  } finally {
    if (runId === state.fetchRunId) {
      setBusyState(false);
    }
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
        console.warn("[BOC] cached subtitle duration mismatch, clearing cache", {
          cacheKey,
          reason: cachedCheck.reason
        });
        await clearSubtitleCacheByKey(cacheKey);
      } else {
        console.info("[BOC] using cached subtitle", { cacheKey, itemCount: cachedBody.length });
        ensureRunActive(runId);
        state.selectedSubtitleId = subtitleId ? String(subtitleId) : state.selectedSubtitleId;
        state.selectedSubtitleUrl = url;
        state.selectedSubtitleLang = lang;
        state.subtitleBody = cachedBody;
        state.markdown = buildMarkdown(state, cachedBody, state.settings);
        state.srt = buildSrt(cachedBody);
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
    console.warn("[BOC] failed to save subtitle cache", error);
  }
}

async function clearSubtitleCacheByKey(cacheKey) {
  try {
    await chrome.storage.local.remove(cacheKey);
  } catch (error) {
    console.warn("[BOC] failed to clear subtitle cache by key", { cacheKey, error });
  }
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
    subtitleOptions
  };
}

async function sendToObsidian() {
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
    setMessage(`写入失败：${error.message}`);
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
    throw new Error(resp?.error || "Local API 写入失败");
  }
}

function setBusyState(disabled) {
  state.isBusy = Boolean(disabled);
}

function setStatus(text) {
  state.statusText = String(text || "");
}

function setMessage(text) {
  state.messageText = String(text || "");
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
        setMessage(`打开设置失败：${resp?.error || "未知错误"}`);
      }
    })
    .catch((error) => {
      if (isExtensionContextInvalidated(error)) {
        setMessage("扩展刚刚更新，请刷新当前页面后重试。");
        return;
      }
      setMessage(`打开设置失败：${error.message}`);
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

function extractBvid(url) {
  const match = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
  return match?.[1] || "";
}

function extractPageIndex(url) {
  const page = Number(new URL(url).searchParams.get("p") || "1");
  if (!Number.isFinite(page) || page <= 0) {
    return 1;
  }
  return page;
}

function hasExplicitPageParam(url) {
  return new URL(url).searchParams.has("p");
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
      const isNetworkError = error?.message?.includes("请求失败");
      const isRetryable = error?.retryable === true;
      if (!isNetworkError && !isRetryable) {
        throw error;
      }
      if (attempt >= retries) {
        throw error;
      }
      // 指数退避：delayMs * 2^(attempt-1)，最多等待 5 秒
      const backoffDelay = Math.min(delayMs * Math.pow(2, attempt - 1), 5000);
      console.info(`[BOC] retrying after ${backoffDelay}ms, attempt ${attempt + 1}/${retries}`, {
        error: error.message,
        code: error.code
      });
      await sleep(backoffDelay);
    }
  }
  throw lastError || new Error("Unknown retry error");
}

async function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchVideoMeta(bvid) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  console.info("[BOC] fetch video meta", { url, bvid });
  const payload = await fetchJson(url);
  if (payload.code !== 0) {
    throw new Error(payload.message || "无法获取视频信息");
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
      duration: Number(item.duration || 0) || 0
    }))
  };
}

function pickCidFromPages(pages, pageIndex, fallbackCid = "") {
  const safePageIndex = Number(pageIndex) > 0 ? Number(pageIndex) : 1;
  const safePages = Array.isArray(pages) ? pages : [];
  const pageByIndex = safePages[safePageIndex - 1];
  if (pageByIndex?.cid) {
    return String(pageByIndex.cid);
  }

  const pageByNo = safePages.find((item) => Number(item.page) === safePageIndex);
  if (pageByNo?.cid) {
    return String(pageByNo.cid);
  }

  if (safePages[0]?.cid) {
    return String(safePages[0].cid);
  }

  if (fallbackCid) {
    return String(fallbackCid);
  }

  throw new Error("没有找到当前分P的 CID。");
}

function pickDurationFromPages(pages, pageIndex, fallbackDuration = 0) {
  const safePageIndex = Number(pageIndex) > 0 ? Number(pageIndex) : 1;
  const safePages = Array.isArray(pages) ? pages : [];
  const pageByIndex = safePages[safePageIndex - 1];
  if (Number(pageByIndex?.duration) > 0) {
    return Number(pageByIndex.duration);
  }

  const pageByNo = safePages.find((item) => Number(item.page) === safePageIndex);
  if (Number(pageByNo?.duration) > 0) {
    return Number(pageByNo.duration);
  }

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

async function fetchSubtitleBundle(bvid, cid, aid = "", options = {}) {
  const requests = buildSubtitleInfoRequests({ bvid, cid, aid, ...options });
  let fallbackAiTrack = null;
  let fallbackChapters = [];
  let lastError = null;

  for (const request of requests) {
    console.info("[BOC] fetch subtitles list", {
      source: request.source,
      url: request.url,
      bvid,
      cid,
      aid
    });

    try {
      const payload = await fetchJson(request.url);
      console.info("[BOC] subtitles API raw response", { source: request.source, payload });

      if (payload.code !== 0) {
        throw buildBiliApiError(payload, "无法获取字幕列表");
      }

      const chapters = mapChaptersFromPlayerData(payload.data);
      if (fallbackChapters.length === 0 && chapters.length > 0) {
        fallbackChapters = chapters;
      }

      const subtitles = mapSubtitleTracks(payload.data?.subtitle?.subtitles || [], request.source);
      const withUrl = subtitles.filter((item) => item.subtitleUrl);
      const aiNoUrl = subtitles.find((item) => isAiSubtitle(item) && !item.subtitleUrl);

      // 参考稳定插件策略：单源优先，不混合多接口结果，避免出现“同语言双轨一对一错”。
      if (withUrl.length > 0) {
        return { tracks: withUrl, chapters };
      }

      if (!fallbackAiTrack && aiNoUrl) {
        fallbackAiTrack = aiNoUrl;
      }
    } catch (error) {
      lastError = error;
      console.warn("[BOC] subtitles API request failed", {
        source: request.source,
        message: error.message
      });
    }
  }

  // 只有“检测到 AI 轨但没有 URL”时，才尝试 AI URL 兜底。
  // 如果接口里本来就没有任何字幕轨，不再构造 AI 轨，避免串到别的视频字幕。
  if (aid && cid && fallbackAiTrack) {
    const aiUrl = await fetchAiSubtitleUrl(aid, cid);
    if (aiUrl) {
      return {
        tracks: [{ ...fallbackAiTrack, subtitleUrl: aiUrl, source: "ai-search-stat" }],
        chapters: fallbackChapters
      };
    }
  }

  if (lastError) {
    throw lastError;
  }
  return { tracks: [], chapters: fallbackChapters };
}

function buildSubtitleInfoRequests({ bvid, cid, aid, preferPlayerV2 = false }) {
  const safeBvid = encodeURIComponent(String(bvid || ""));
  const safeCid = encodeURIComponent(String(cid || ""));
  const safeAid = encodeURIComponent(String(aid || ""));
  const requests = [];

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

  requests.push({
    source: "player-v2",
    url:
      "https://api.bilibili.com/x/player/v2" +
      (bvid ? `?bvid=${safeBvid}` : "?") +
      `${bvid ? "&" : ""}cid=${safeCid}` +
      (aid ? `&aid=${safeAid}` : "")
  });

  if (preferPlayerV2) {
    requests.sort((a, b) => {
      if (a.source === "player-v2" && b.source !== "player-v2") {
        return -1;
      }
      if (a.source !== "player-v2" && b.source === "player-v2") {
        return 1;
      }
      return 0;
    });
  }

  return requests;
}

function buildBiliApiError(payload, fallbackMessage) {
  const msg = payload?.message || fallbackMessage;
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

async function fetchAiSubtitleUrl(aid, cid) {
  if (!aid || !cid) {
    return "";
  }

  const url =
    "https://api.bilibili.com/x/player/v2/ai/subtitle/search/stat" +
    `?aid=${encodeURIComponent(String(aid))}` +
    `&cid=${encodeURIComponent(String(cid))}`;

  console.info("[BOC] fetch ai subtitle stat", { url, aid, cid });
  try {
    const payload = await fetchJson(url);
    console.info("[BOC] ai subtitle stat raw response", { payload });
    if (payload.code !== 0) {
      throw buildBiliApiError(payload, "无法获取 AI 字幕地址");
    }
    return normalizeSubtitleUrl(payload.data?.subtitle_url || "");
  } catch (error) {
    console.warn("[BOC] ai subtitle stat request failed", { message: error.message });
    return "";
  }
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
      console.info("[BOC] try subtitle track", {
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
      console.warn("[BOC] subtitle track rejected", {
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        reason: error?.code || error?.message || "unknown"
      });
      ensureRunActive(runId);
      continue;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("这个视频暂时没有可用字幕。");
}

function pickPreferredAiSubtitle(
  aiTracks,
  { previousId = "", previousUrl = "", previousLang = "" } = {}
) {
  const tracks = aiTracks || [];
  if (tracks.length === 0) {
    return null;
  }

  if (previousId) {
    const byId = tracks.find((item) => String(item.id || "") === String(previousId));
    if (byId) {
      return byId;
    }
  }

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

  return tracks[0];
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

  const upperTolerance = Math.max(20, duration * 0.25);
  if (maxTo > duration + upperTolerance) {
    return { ok: false, reason: "too-long", videoDuration: duration, maxTo };
  }

  let minCoverageRatio = 0;
  if (duration >= 600) {
    minCoverageRatio = 0.12;
  } else if (duration >= 300) {
    minCoverageRatio = 0.15;
  } else if (duration >= 180) {
    minCoverageRatio = 0.18;
  }

  if (minCoverageRatio > 0 && maxTo < duration * minCoverageRatio) {
    return { ok: false, reason: "too-short", videoDuration: duration, maxTo };
  }

  return { ok: true, reason: "ok", videoDuration: duration, maxTo };
}

async function fetchSubtitleBody(url) {
  console.info("[BOC] fetch subtitle body", { url });
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
      throw new Error(resp?.error || "Background fetch failed");
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

function buildNoteFilename(meta) {
  const date = new Date().toISOString().slice(0, 10);
  const baseName = sanitizeFileName(`${date}-${meta.title || meta.bvid || "bilibili-subtitle"}`);
  return `${baseName}.md`;
}

function normalizeFolder(input) {
  return String(input || "").trim().replace(/^\/+|\/+$/g, "");
}

function escapeYaml(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
