const DEFAULT_SYNC_SETTINGS = {
  noteFolder: "Clippings/Bilibili",
  obsidianApiBaseUrl: "http://127.0.0.1:27123",
  tags: "clippings,bilibili",
  downloadFormat: "srt",
  includeDateInFilename: true,
  includeTimestampInBody: true,
  enableDebugLogs: false,
  readerTheme: "light",
  readerFontScale: "m",
  readerLetterSpacing: "normal",
  readerLineHeight: "tight",
  readerContentWidth: "medium",
  readerChapterVisibility: "show",
  readerTranscriptVisible: true,
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
  ],
  fixedFrontmatterProperties: []
};

const DEFAULT_LOCAL_SETTINGS = {
  obsidianApiKey: ""
};
const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";

chrome.runtime.onInstalled.addListener(async () => {
  await initializeSettingsStorage();
});

async function ensureReaderContentReady(tabId) {
  if (!chrome.scripting || !tabId) {
    return;
  }

  const loadedVersion = await probeContentScriptVersion(tabId);
  if (loadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  await injectReaderContent(tabId);
  const reinjectedVersion = await probeContentScriptVersion(tabId);
  if (reinjectedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  if (loadedVersion && loadedVersion !== EXPECTED_CONTENT_SCRIPT_VERSION) {
    await chrome.tabs.reload(tabId);
    const ready = await waitForTabComplete(tabId);
    if (!ready) {
      throw new Error("扩展更新后页面未及时恢复，请刷新浏览器网页重试");
    }
    await sleep(120);
    await injectReaderContent(tabId);
    const reloadedVersion = await probeContentScriptVersion(tabId);
    if (reloadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
      return;
    }
  }

  throw new Error("扩展脚本未能和当前页面同步，请刷新浏览器网页重试");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function injectReaderContent(tabId) {
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
}

async function waitForTabComplete(tabId, retries = 40, delayMs = 250) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
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

async function triggerReaderModeInTab(tabId, readerUrl = "", retries = 12, delayMs = 300) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(delayMs);
    }

    try {
      const response = await sendMessageToTab(tabId, {
        type: "popup-trigger-reading-view",
        readerUrl
      });
      if (response?.ok) {
        return true;
      }
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("Could not establish connection. Receiving end does not exist.")) {
        try {
          await ensureReaderContentReady(tabId);
        } catch {
          // keep retrying
        }
        continue;
      }
    }
  }

  return false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "get-settings") {
    getMergedSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "save-settings") {
    saveSettings(message.settings || {})
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "open-options") {
    chrome.tabs
      .create({ url: chrome.runtime.getURL("options.html") })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "open-reading-view-tab") {
    const url = String(message.url || "").trim();
    const tabId = Number(message.tabId || 0) || 0;
    if (!url) {
      sendResponse({ ok: false, error: "缺少视频地址" });
      return false;
    }
    if (!tabId) {
      sendResponse({ ok: false, error: "缺少标签页信息" });
      return false;
    }

    let readerUrl = "";
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "www.bilibili.com") {
        throw new Error("当前网页不是 B 站视频页");
      }
      parsed.searchParams.set("boc_reader", "1");
      readerUrl = parsed.toString();
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "阅读视图地址无效" });
      return false;
    }

    ensureReaderContentReady(tabId)
      .then(() => triggerReaderModeInTab(tabId, readerUrl))
      .then((triggered) => {
        if (!triggered) {
          throw new Error("阅读视图触发失败，请刷新浏览器网页重试");
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "fetch-json") {
    const url = typeof message.url === "string" ? message.url : "";
    if (!url) {
      sendResponse({ ok: false, error: "Missing subtitle URL" });
      return false;
    }

    const isBiliRequest = /(?:api\.bilibili\.com|hdslb\.com)/.test(url);
    const headers = new Headers();
    if (isBiliRequest) {
      headers.set("Accept", "application/json, text/plain, */*");
      headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
      headers.set("Cache-Control", "no-cache");
      headers.set("Pragma", "no-cache");
    }

    const fetchOptions = {
      method: "GET",
      credentials: "include",
      cache: "no-store"
    };
    if (headers.size > 0) {
      fetchOptions.headers = headers;
    }
    if (isBiliRequest) {
      fetchOptions.referrer = "https://www.bilibili.com/";
      fetchOptions.referrerPolicy = "strict-origin-when-cross-origin";
    }

    fetch(url, fetchOptions)
      .then(async (response) => {
        if (!response.ok) {
          sendResponse({ ok: false, error: `HTTP ${response.status}` });
          return;
        }

        const text = await response.text();
        try {
          const data = JSON.parse(text);
          sendResponse({ ok: true, data });
        } catch {
          sendResponse({ ok: false, error: "Invalid JSON response" });
        }
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "write-obsidian-note") {
    const baseUrl = String(message.baseUrl || "").trim();
    const apiKey = String(message.apiKey || "").trim();
    const filepath = String(message.filepath || "").trim();
    const content = typeof message.content === "string" ? message.content : "";

    if (!baseUrl || !apiKey || !filepath) {
      sendResponse({ ok: false, error: "缺少 Local REST API 参数" });
      return false;
    }

    const encodedPath = filepath
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const endpoint = `${baseUrl.replace(/\/+$/g, "")}/vault/${encodedPath}`;

    fetch(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "text/markdown; charset=utf-8"
      },
      body: content
    })
      .then(async (response) => {
        if (!response.ok) {
          const bodyText = await response.text().catch(() => "");
          const detail = bodyText ? ` ${bodyText.slice(0, 200)}` : "";
          sendResponse({ ok: false, error: `HTTP ${response.status}.${detail}` });
          return;
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message.type === "test-obsidian-connection") {
    const baseUrl = String(message.baseUrl || "").trim();
    const apiKey = String(message.apiKey || "").trim();

    if (!baseUrl || !apiKey) {
      sendResponse({ ok: false, error: "缺少 Local REST API 参数" });
      return false;
    }

    const endpoint = `${baseUrl.replace(/\/+$/g, "")}/`;
    fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json, text/plain, */*"
      },
      cache: "no-store"
    })
      .then(async (response) => {
        const bodyText = await response.text().catch(() => "");
        let data = null;
        try {
          data = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          data = null;
        }

        if (!response.ok) {
          const detail = bodyText ? ` ${bodyText.slice(0, 200)}` : "";
          sendResponse({ ok: false, error: `HTTP ${response.status}.${detail}` });
          return;
        }

        if (data && data.authenticated === false) {
          sendResponse({ ok: false, error: "API Key 无效或未授权" });
          return;
        }

        sendResponse({
          ok: true,
          service: typeof data?.service === "string" ? data.service : "Obsidian Local REST API"
        });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: formatConnectionError(error) });
      });

    return true;
  }

  return false;
});

async function initializeSettingsStorage() {
  const syncCurrent = await chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS);
  const localCurrent = await chrome.storage.local.get(DEFAULT_LOCAL_SETTINGS);

  await chrome.storage.sync.set({ ...DEFAULT_SYNC_SETTINGS, ...syncCurrent });
  await chrome.storage.local.set({
    obsidianApiKey: normalizeApiKey(localCurrent.obsidianApiKey)
  });

  const legacySyncApiKey = normalizeApiKey(syncCurrent.obsidianApiKey);
  const localApiKey = normalizeApiKey(localCurrent.obsidianApiKey);
  if (!localApiKey && legacySyncApiKey) {
    await chrome.storage.local.set({ obsidianApiKey: legacySyncApiKey });
  }

  if ("obsidianApiKey" in syncCurrent) {
    await chrome.storage.sync.remove("obsidianApiKey");
  }
}

async function getMergedSettings() {
  const [syncSettings, localSettings] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS),
    chrome.storage.local.get(DEFAULT_LOCAL_SETTINGS)
  ]);

  const merged = { ...DEFAULT_SYNC_SETTINGS, ...syncSettings };
  merged.downloadFormat = normalizeDownloadFormat(merged.downloadFormat);
  merged.readerTheme = normalizeReaderTheme(merged.readerTheme);
  merged.readerFontScale = normalizeReaderFontScale(merged.readerFontScale);
  merged.readerLetterSpacing = normalizeReaderLetterSpacing(merged.readerLetterSpacing ?? merged.readerLineHeight);
  merged.readerLineHeight = normalizeReaderLineHeight(merged.readerLineHeight);
  merged.readerContentWidth = normalizeReaderContentWidth(merged.readerContentWidth);
  merged.readerChapterVisibility = normalizeReaderChapterVisibility(merged.readerChapterVisibility);
  merged.readerTranscriptVisible = normalizeReaderTranscriptVisible(merged.readerTranscriptVisible);
  merged.fixedFrontmatterProperties = normalizeFixedFrontmatterProperties(merged.fixedFrontmatterProperties);
  let apiKey = normalizeApiKey(localSettings.obsidianApiKey);
  const legacySyncApiKey = normalizeApiKey(syncSettings.obsidianApiKey);

  if (!apiKey && legacySyncApiKey) {
    apiKey = legacySyncApiKey;
    await chrome.storage.local.set({ obsidianApiKey: apiKey });
    await chrome.storage.sync.remove("obsidianApiKey");
  }

  return {
    ...merged,
    obsidianApiKey: apiKey
  };
}

async function saveSettings(settings) {
  const payload = settings && typeof settings === "object" ? settings : {};
  const syncPayload = { ...payload };
  delete syncPayload.obsidianApiKey;
  syncPayload.downloadFormat = normalizeDownloadFormat(syncPayload.downloadFormat);
  syncPayload.readerTheme = normalizeReaderTheme(syncPayload.readerTheme);
  syncPayload.readerFontScale = normalizeReaderFontScale(syncPayload.readerFontScale);
  syncPayload.readerLetterSpacing = normalizeReaderLetterSpacing(
    syncPayload.readerLetterSpacing ?? syncPayload.readerLineHeight
  );
  syncPayload.readerLineHeight = normalizeReaderLineHeight(syncPayload.readerLineHeight);
  syncPayload.readerContentWidth = normalizeReaderContentWidth(syncPayload.readerContentWidth);
  syncPayload.readerChapterVisibility = normalizeReaderChapterVisibility(syncPayload.readerChapterVisibility);
  syncPayload.readerTranscriptVisible = normalizeReaderTranscriptVisible(syncPayload.readerTranscriptVisible);
  syncPayload.fixedFrontmatterProperties = normalizeFixedFrontmatterProperties(syncPayload.fixedFrontmatterProperties);

  await Promise.all([
    chrome.storage.sync.set(syncPayload),
    chrome.storage.local.set({
      obsidianApiKey: normalizeApiKey(payload.obsidianApiKey)
    })
  ]);
}

function toString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeApiKey(value) {
  return toString(value).trim().replace(/^Bearer\s+/i, "").trim();
}

function normalizeDownloadFormat(value) {
  return value === "txt" ? "txt" : "srt";
}

function normalizeReaderTheme(value) {
  return value === "dark" || value === "paper" ? value : "light";
}

function normalizeReaderFontScale(value) {
  return ["xs", "s", "m", "l", "xl"].includes(value) ? value : "m";
}

function normalizeReaderLetterSpacing(value) {
  return ["tighter", "tight", "normal", "relaxed", "loose"].includes(value) ? value : "normal";
}

function normalizeReaderLineHeight(value) {
  return ["compact", "tight", "normal", "relaxed", "loose"].includes(value) ? value : "tight";
}

function normalizeReaderContentWidth(value) {
  return ["compact", "narrow", "medium", "wide", "full"].includes(value) ? value : "medium";
}

function normalizeReaderChapterVisibility(value) {
  return value === "hide" || value === "auto" ? value : "show";
}

function normalizeReaderTranscriptVisible(value) {
  return value !== false;
}

function normalizeFixedFrontmatterProperties(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => ({
      key: toString(item?.key).trim(),
      type: normalizeFixedPropertyType(item?.type),
      value: normalizeFixedPropertyValue(item?.type, item?.value)
    }))
    .filter((item) => item.key && !isFixedPropertyRowEffectivelyEmpty(item.type, item.value));
}

function normalizeFixedPropertyType(value) {
  const type = toString(value).trim().toLowerCase();
  return type === "number" || type === "checkbox" || type === "list" ? type : "text";
}

function normalizeFixedPropertyValue(type, value) {
  const normalizedType = normalizeFixedPropertyType(type);
  if (normalizedType === "checkbox") {
    return toString(value).trim().toLowerCase();
  }
  return toString(value).trim();
}

function isFixedPropertyRowEffectivelyEmpty(type, value) {
  return !toString(value).trim();
}

function formatConnectionError(error) {
  const message = String(error?.message || "").trim();
  if (!message) {
    return "连接失败：未知错误";
  }
  if (message.includes("Failed to fetch")) {
    return "无法连接 Local REST API。请检查地址、HTTP/HTTPS 模式和证书信任。";
  }
  return message;
}
