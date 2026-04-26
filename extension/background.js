const DEFAULT_SYNC_SETTINGS = {
  noteFolder: "Clippings/Bilibili",
  noteFolders: [
    {
      id: "default-note-folder",
      label: "默认目录",
      path: "Clippings/Bilibili"
    }
  ],
  defaultNoteFolderId: "default-note-folder",
  obsidianApiBaseUrl: "http://127.0.0.1:27123",
  tags: "clippings,bilibili",
  downloadFormat: "srt",
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

const DEFAULT_LOCAL_SETTINGS = {
  obsidianApiKey: ""
};

chrome.runtime.onInstalled.addListener(async () => {
  await initializeSettingsStorage();
});

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
  const normalizedSync = normalizeSettingsPayload({ ...DEFAULT_SYNC_SETTINGS, ...syncCurrent });

  await chrome.storage.sync.set(normalizedSync);
  await chrome.storage.local.set({
    obsidianApiKey: toString(localCurrent.obsidianApiKey)
  });

  const legacySyncApiKey = toString(syncCurrent.obsidianApiKey).trim();
  const localApiKey = toString(localCurrent.obsidianApiKey).trim();
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

  const merged = normalizeSettingsPayload({ ...DEFAULT_SYNC_SETTINGS, ...syncSettings });
  merged.downloadFormat = normalizeDownloadFormat(merged.downloadFormat);
  let apiKey = toString(localSettings.obsidianApiKey).trim();
  const legacySyncApiKey = toString(syncSettings.obsidianApiKey).trim();

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
  const payload = normalizeSettingsPayload(settings && typeof settings === "object" ? settings : {});
  const syncPayload = { ...payload };
  delete syncPayload.obsidianApiKey;
  syncPayload.downloadFormat = normalizeDownloadFormat(syncPayload.downloadFormat);

  await Promise.all([
    chrome.storage.sync.set(syncPayload),
    chrome.storage.local.set({
      obsidianApiKey: toString(payload.obsidianApiKey).trim()
    })
  ]);
}

function toString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeDownloadFormat(value) {
  return value === "txt" ? "txt" : "srt";
}

function normalizeSettingsPayload(raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const normalizedFolders = normalizeNoteFolders(payload.noteFolders, payload.noteFolder);
  const defaultNoteFolderId = resolveDefaultNoteFolderId(
    payload.defaultNoteFolderId,
    normalizedFolders
  );
  const defaultNoteFolder = normalizedFolders.find((item) => item.id === defaultNoteFolderId);

  return {
    ...DEFAULT_SYNC_SETTINGS,
    ...payload,
    noteFolders: normalizedFolders,
    defaultNoteFolderId,
    noteFolder: defaultNoteFolder?.path || DEFAULT_SYNC_SETTINGS.noteFolder
  };
}

function normalizeNoteFolders(noteFolders, legacyNoteFolder = "") {
  const source = Array.isArray(noteFolders) ? noteFolders : [];
  const normalized = source
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const path = toString(item.path).trim();
      if (!path) {
        return null;
      }

      const id = toString(item.id).trim() || `note-folder-${index + 1}`;
      const label = toString(item.label).trim() || `目录 ${index + 1}`;
      return { id, label, path };
    })
    .filter(Boolean);

  if (normalized.length > 0) {
    return dedupeNoteFolders(normalized);
  }

  const fallbackPath = toString(legacyNoteFolder).trim() || DEFAULT_SYNC_SETTINGS.noteFolder;
  return [
    {
      id: DEFAULT_SYNC_SETTINGS.defaultNoteFolderId,
      label: "默认目录",
      path: fallbackPath
    }
  ];
}

function dedupeNoteFolders(noteFolders) {
  const seen = new Set();
  const result = [];

  noteFolders.forEach((item, index) => {
    let id = toString(item.id).trim() || `note-folder-${index + 1}`;
    while (seen.has(id)) {
      id = `${id}-${index + 1}`;
    }
    seen.add(id);
    result.push({
      id,
      label: toString(item.label).trim() || `目录 ${index + 1}`,
      path: toString(item.path).trim()
    });
  });

  return result;
}

function resolveDefaultNoteFolderId(defaultNoteFolderId, noteFolders) {
  const preferredId = toString(defaultNoteFolderId).trim();
  if (preferredId && noteFolders.some((item) => item.id === preferredId)) {
    return preferredId;
  }
  return noteFolders[0]?.id || DEFAULT_SYNC_SETTINGS.defaultNoteFolderId;
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
