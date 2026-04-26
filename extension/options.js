const DEFAULT_SETTINGS = {
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
  obsidianApiKey: "",
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

const elements = {
  noteFolderList: document.getElementById("noteFolderList"),
  addNoteFolderBtn: document.getElementById("addNoteFolderBtn"),
  obsidianApiBaseUrl: document.getElementById("obsidianApiBaseUrl"),
  obsidianApiKey: document.getElementById("obsidianApiKey"),
  tags: document.getElementById("tags"),
  downloadFormat: document.getElementById("downloadFormat"),
  includeTimestampInBody: document.getElementById("includeTimestampInBody"),
  enableDebugLogs: document.getElementById("enableDebugLogs"),
  frontmatterFields: document.querySelectorAll('input[name="frontmatterField"]'),
  saveBtn: document.getElementById("saveBtn"),
  testConnectionBtn: document.getElementById("testConnectionBtn"),
  status: document.getElementById("status")
};

init();

function init() {
  loadSettings();
  elements.saveBtn.addEventListener("click", saveSettings);
  elements.testConnectionBtn.addEventListener("click", testConnection);
  elements.addNoteFolderBtn.addEventListener("click", () => {
    appendNoteFolderRow({
      id: createNoteFolderId(),
      label: "",
      path: "",
      isDefault: getNoteFolderRows().length === 0
    });
  });

  [elements.obsidianApiBaseUrl, elements.obsidianApiKey, elements.tags].forEach((input) => {
    input?.addEventListener("input", () => input.classList.remove("input-error"));
  });

  elements.noteFolderList.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    target.classList.remove("input-error");
  });

  elements.noteFolderList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const removeBtn = target.closest("[data-action='remove-folder']");
    if (!removeBtn) {
      return;
    }

    const row = removeBtn.closest(".folder-item");
    row?.remove();
    ensureSomeNoteFolderRow();
    ensureValidDefaultNoteFolder();
  });
}

async function loadSettings() {
  const settings = normalizeSettings(await getSettings());
  renderNoteFolders(settings.noteFolders, settings.defaultNoteFolderId);
  elements.obsidianApiBaseUrl.value = settings.obsidianApiBaseUrl || "";
  elements.obsidianApiKey.value = settings.obsidianApiKey || "";
  elements.tags.value = settings.tags || "";
  elements.downloadFormat.value = normalizeDownloadFormat(settings.downloadFormat);
  elements.includeTimestampInBody.checked = Boolean(settings.includeTimestampInBody);
  elements.enableDebugLogs.checked = Boolean(settings.enableDebugLogs);
  const selectedFields = new Set(settings.frontmatterFields || DEFAULT_SETTINGS.frontmatterFields);
  elements.frontmatterFields.forEach((checkbox) => {
    checkbox.checked = selectedFields.has(checkbox.value);
  });
}

async function saveSettings() {
  clearInputErrors();
  const payload = collectFormPayload();
  const validation = validateSettings(payload, { requireApiKey: false });
  if (!validation.ok) {
    applyValidationError(validation);
    return;
  }

  setBusy(true);
  try {
    const resp = await sendRuntimeMessage({ type: "save-settings", settings: payload });
    if (!resp?.ok) {
      setStatus(resp?.error || "保存失败", true);
      return;
    }
    setStatus(payload.obsidianApiKey ? "保存成功" : "保存成功（未填写 API Key，暂不可写入 Obsidian）");
  } catch (error) {
    setStatus(error.message || "保存失败", true);
  } finally {
    setBusy(false);
  }
}

async function getSettings() {
  try {
    const resp = await sendRuntimeMessage({ type: "get-settings" });
    if (!resp?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(resp.settings || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function setStatus(text, isError = false) {
  elements.status.textContent = text;
  elements.status.dataset.error = isError ? "true" : "false";
}

function normalizeDownloadFormat(value) {
  return value === "txt" ? "txt" : "srt";
}

function collectFormPayload() {
  const selectedFields = Array.from(elements.frontmatterFields)
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);

  const normalizedBaseUrl = normalizeBaseUrl(elements.obsidianApiBaseUrl.value);
  elements.obsidianApiBaseUrl.value = normalizedBaseUrl;

  const noteFolders = getNoteFolderRows().map((row) => ({
    id: String(row.dataset.folderId || createNoteFolderId()),
    label: row.querySelector("[data-role='folder-label']")?.value.trim() || "",
    path: row.querySelector("[data-role='folder-path']")?.value.trim() || ""
  }));
  const selectedDefault = elements.noteFolderList.querySelector("input[name='defaultNoteFolder']:checked");
  const defaultNoteFolderId = String(selectedDefault?.value || noteFolders[0]?.id || "");
  const defaultFolder = noteFolders.find((item) => item.id === defaultNoteFolderId);

  return {
    noteFolders,
    defaultNoteFolderId,
    noteFolder: defaultFolder?.path || "",
    obsidianApiBaseUrl: normalizedBaseUrl,
    obsidianApiKey: elements.obsidianApiKey.value.trim(),
    tags: elements.tags.value.trim(),
    downloadFormat: normalizeDownloadFormat(elements.downloadFormat.value),
    includeTimestampInBody: elements.includeTimestampInBody.checked,
    enableDebugLogs: elements.enableDebugLogs.checked,
    frontmatterFields: selectedFields
  };
}

function validateSettings(payload, { requireApiKey }) {
  const noteFolders = Array.isArray(payload.noteFolders) ? payload.noteFolders : [];
  if (noteFolders.length === 0) {
    return { ok: false, field: elements.addNoteFolderBtn, message: "请至少配置一个保存目录" };
  }

  for (const row of getNoteFolderRows()) {
    const labelInput = row.querySelector("[data-role='folder-label']");
    const pathInput = row.querySelector("[data-role='folder-path']");
    const path = String(pathInput?.value || "").trim();
    const label = String(labelInput?.value || "").trim();

    if (!label) {
      return { ok: false, field: labelInput, message: "请填写目录名称" };
    }
    if (!path) {
      return { ok: false, field: pathInput, message: "请填写笔记目录（例如：Clippings/Bilibili）" };
    }
    if (/^[\/\\]|[\/\\]$/.test(path)) {
      return { ok: false, field: pathInput, message: "笔记目录无需以 / 开头或结尾" };
    }
    if (/[\\:*?"<>|\u0000-\u001f]/.test(path)) {
      return { ok: false, field: pathInput, message: "笔记目录包含非法字符，请修改后再试" };
    }
  }

  if (!payload.defaultNoteFolderId || !noteFolders.some((item) => item.id === payload.defaultNoteFolderId)) {
    return { ok: false, field: elements.addNoteFolderBtn, message: "请选择默认保存目录" };
  }

  if (!payload.obsidianApiBaseUrl) {
    return { ok: false, field: elements.obsidianApiBaseUrl, message: "请填写 Local REST API 地址" };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(payload.obsidianApiBaseUrl);
  } catch {
    return { ok: false, field: elements.obsidianApiBaseUrl, message: "Local REST API 地址格式不正确" };
  }

  const protocol = parsedUrl.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return { ok: false, field: elements.obsidianApiBaseUrl, message: "Local REST API 地址仅支持 http 或 https" };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const isLocal = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  if (!isLocal) {
    return {
      ok: false,
      field: elements.obsidianApiBaseUrl,
      message: "请使用本机地址（127.0.0.1 或 localhost），不要填写公网/局域网地址"
    };
  }

  if ((parsedUrl.pathname && parsedUrl.pathname !== "/") || parsedUrl.search || parsedUrl.hash) {
    return { ok: false, field: elements.obsidianApiBaseUrl, message: "地址请只填写到端口，例如 http://127.0.0.1:27123" };
  }

  if (requireApiKey && !payload.obsidianApiKey) {
    return { ok: false, field: elements.obsidianApiKey, message: "测试连接前请填写 Local REST API Key" };
  }

  if (/[\r\n]/.test(payload.tags)) {
    return { ok: false, field: elements.tags, message: "默认标签请使用逗号分隔，不要换行" };
  }

  return { ok: true };
}

function applyValidationError(validation) {
  clearInputErrors();
  if (validation?.field instanceof HTMLElement) {
    validation.field.classList.add("input-error");
    validation.field.focus();
  }
  setStatus(validation?.message || "设置校验失败", true);
}

function clearInputErrors() {
  [
    elements.obsidianApiBaseUrl,
    elements.obsidianApiKey,
    elements.tags,
    ...elements.noteFolderList.querySelectorAll("input")
  ].forEach((input) => {
    input?.classList.remove("input-error");
  });
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/g, "");
}

async function testConnection() {
  clearInputErrors();
  const payload = collectFormPayload();
  const validation = validateSettings(payload, { requireApiKey: true });
  if (!validation.ok) {
    applyValidationError(validation);
    return;
  }

  setBusy(true);
  setStatus("正在测试连接...");
  try {
    const resp = await sendRuntimeMessage({
      type: "test-obsidian-connection",
      baseUrl: payload.obsidianApiBaseUrl,
      apiKey: payload.obsidianApiKey
    });

    if (!resp?.ok) {
      setStatus(`连接失败：${resp?.error || "未知错误"}`, true);
      return;
    }

    const service = resp?.service ? `（${resp.service}）` : "";
    setStatus(`连接成功 ${service}`);
  } catch (error) {
    setStatus(`连接失败：${error.message || "未知错误"}`, true);
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy) {
  elements.saveBtn.disabled = isBusy;
  elements.testConnectionBtn.disabled = isBusy;
  elements.addNoteFolderBtn.disabled = isBusy;
  elements.saveBtn.textContent = isBusy ? "处理中..." : "保存设置";
  elements.testConnectionBtn.textContent = isBusy ? "处理中..." : "测试连接";
  elements.noteFolderList.querySelectorAll("input, button").forEach((node) => {
    node.disabled = isBusy;
  });
}

function sendRuntimeMessage(message) {
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

function renderNoteFolders(noteFolders, defaultNoteFolderId) {
  elements.noteFolderList.innerHTML = "";
  const normalized = normalizeSettings({
    noteFolders,
    defaultNoteFolderId
  });

  normalized.noteFolders.forEach((item) => {
    appendNoteFolderRow({
      ...item,
      isDefault: item.id === normalized.defaultNoteFolderId
    });
  });
  ensureValidDefaultNoteFolder();
}

function appendNoteFolderRow(folder) {
  const row = document.createElement("div");
  row.className = "folder-item";
  row.dataset.folderId = folder.id || createNoteFolderId();
  row.innerHTML = `
    <label class="folder-default">
      <input type="radio" name="defaultNoteFolder" value="${escapeHtml(row.dataset.folderId)}" ${
        folder.isDefault ? "checked" : ""
      } />
      默认
    </label>
    <div class="folder-fields">
      <input
        type="text"
        data-role="folder-label"
        placeholder="目录名称，例如：B站/学习"
        value="${escapeHtml(folder.label || "")}"
      />
      <input
        type="text"
        data-role="folder-path"
        placeholder="Obsidian 路径，例如：Clippings/Bilibili"
        value="${escapeHtml(folder.path || "")}"
      />
    </div>
    <button type="button" class="folder-remove" data-action="remove-folder">删除</button>
  `;
  elements.noteFolderList.appendChild(row);
}

function ensureSomeNoteFolderRow() {
  if (getNoteFolderRows().length > 0) {
    return;
  }

  appendNoteFolderRow({
    id: createNoteFolderId(),
    label: "默认目录",
    path: DEFAULT_SETTINGS.noteFolder,
    isDefault: true
  });
}

function ensureValidDefaultNoteFolder() {
  const rows = getNoteFolderRows();
  const checked = elements.noteFolderList.querySelector("input[name='defaultNoteFolder']:checked");
  if (checked || rows.length === 0) {
    return;
  }
  const firstRadio = rows[0].querySelector("input[name='defaultNoteFolder']");
  if (firstRadio) {
    firstRadio.checked = true;
  }
}

function getNoteFolderRows() {
  return Array.from(elements.noteFolderList.querySelectorAll(".folder-item"));
}

function createNoteFolderId() {
  if (globalThis.crypto?.randomUUID) {
    return `note-folder-${globalThis.crypto.randomUUID()}`;
  }
  return `note-folder-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeSettings(raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const sourceFolders = Array.isArray(payload.noteFolders) ? payload.noteFolders : [];
  const folders =
    sourceFolders.length > 0
      ? sourceFolders
          .map((item, index) => ({
            id: String(item?.id || `note-folder-${index + 1}`),
            label: String(item?.label || `目录 ${index + 1}`).trim(),
            path: String(item?.path || "").trim()
          }))
          .filter((item) => item.path)
      : [
          {
            id: DEFAULT_SETTINGS.defaultNoteFolderId,
            label: "默认目录",
            path: String(payload.noteFolder || DEFAULT_SETTINGS.noteFolder).trim()
          }
        ];

  const defaultNoteFolderId =
    String(payload.defaultNoteFolderId || "").trim() &&
    folders.some((item) => item.id === String(payload.defaultNoteFolderId).trim())
      ? String(payload.defaultNoteFolderId).trim()
      : folders[0].id;

  return {
    ...DEFAULT_SETTINGS,
    ...payload,
    noteFolders: folders,
    defaultNoteFolderId,
    noteFolder: folders.find((item) => item.id === defaultNoteFolderId)?.path || DEFAULT_SETTINGS.noteFolder
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
