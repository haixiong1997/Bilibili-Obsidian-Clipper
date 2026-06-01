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
  ],
  fixedFrontmatterProperties: []
};

const SYSTEM_FRONTMATTER_FIELDS = new Set(DEFAULT_SETTINGS.frontmatterFields.map((field) => String(field).toLowerCase()));
const CUSTOM_PROPERTY_KEY_PATTERN = /^[\p{L}\p{N}_\-\s]+$/u;
const FIXED_PROPERTY_TYPES = new Set(["text", "number", "checkbox", "list"]);

const elements = {
  noteFolderList: document.getElementById("noteFolderList"),
  addNoteFolderBtn: document.getElementById("addNoteFolderBtn"),
  obsidianApiBaseUrl: document.getElementById("obsidianApiBaseUrl"),
  obsidianApiKey: document.getElementById("obsidianApiKey"),
  tags: document.getElementById("tags"),
  downloadFormat: document.getElementById("downloadFormat"),
  includeDateInFilename: document.getElementById("includeDateInFilename"),
  includeTimestampInBody: document.getElementById("includeTimestampInBody"),
  enableDebugLogs: document.getElementById("enableDebugLogs"),
  frontmatterFields: document.querySelectorAll('input[name="frontmatterField"]'),
  fixedPropertiesList: document.getElementById("fixedPropertiesList"),
  fixedPropertiesEmpty: document.getElementById("fixedPropertiesEmpty"),
  addFixedPropertyBtn: document.getElementById("addFixedPropertyBtn"),
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
  elements.includeDateInFilename.checked = settings.includeDateInFilename !== false;
  elements.includeTimestampInBody.checked = Boolean(settings.includeTimestampInBody);
  elements.enableDebugLogs.checked = Boolean(settings.enableDebugLogs);
  const selectedFields = new Set(settings.frontmatterFields || DEFAULT_SETTINGS.frontmatterFields);
  elements.frontmatterFields.forEach((checkbox) => {
    checkbox.checked = selectedFields.has(checkbox.value);
  });
  renderFixedPropertyRows(settings.fixedFrontmatterProperties);
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
    renderFixedPropertyRows(payload.fixedFrontmatterProperties);
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
  const normalizedApiKey = normalizeApiKey(elements.obsidianApiKey.value);
  elements.obsidianApiBaseUrl.value = normalizedBaseUrl;
  elements.obsidianApiKey.value = normalizedApiKey;

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
    obsidianApiKey: normalizedApiKey,
    tags: elements.tags.value.trim(),
    downloadFormat: normalizeDownloadFormat(elements.downloadFormat.value),
    includeDateInFilename: elements.includeDateInFilename.checked,
    includeTimestampInBody: elements.includeTimestampInBody.checked,
    enableDebugLogs: elements.enableDebugLogs.checked,
    frontmatterFields: selectedFields,
    fixedFrontmatterProperties: normalizeFixedFrontmatterProperties(collectFixedPropertyRows())
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

  const fixedPropertyValidation = validateFixedFrontmatterProperties(collectFixedPropertyRows({ includeRow: true }));
  if (!fixedPropertyValidation.ok) {
    return fixedPropertyValidation;
  }

  return { ok: true };
}

function applyValidationError(validation) {
  clearInputErrors();
  if (validation?.field instanceof HTMLElement) {
    validation.field.classList.add("input-error");
    validation.field.focus();
  }
  if (validation?.row) {
    const keyInput = validation.row.querySelector(".fixed-property-key");
    const valueInput = validation.row.querySelector(".fixed-property-value");
    if (keyInput && !String(keyInput.value || "").trim()) {
      keyInput.classList.add("input-error");
      keyInput.focus();
    } else if (valueInput && !String(valueInput.value || "").trim()) {
      valueInput.classList.add("input-error");
      valueInput.focus();
    } else if (keyInput) {
      keyInput.classList.add("input-error");
      keyInput.focus();
    }

    const errorNode = validation.row.querySelector(".fixed-property-error");
    if (errorNode) {
      errorNode.hidden = false;
      errorNode.textContent = validation.message || "固定属性校验失败";
    }
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
  clearFixedPropertyErrors();
}

function renderFixedPropertyRows(items) {
  elements.fixedPropertiesList.innerHTML = "";
  const rows = Array.isArray(items) ? items : [];
  rows.forEach((item) => addFixedPropertyRow(item));
  updateFixedPropertyEmptyState();
}

function addFixedPropertyRow(item = {}) {
  const type = normalizeFixedPropertyType(item.type);
  const row = document.createElement("div");
  row.className = "fixed-property-row";
  row.innerHTML = `
    <div class="fixed-property-fields">
      <div class="fixed-property-field fixed-property-field-type">${buildFixedPropertyTypePicker(type)}</div>
      <div class="fixed-property-field fixed-property-field-key">
        <input class="fixed-property-key" type="text" placeholder="属性名" value="${escapeAttribute(item.key)}" />
      </div>
      <div class="fixed-property-field fixed-property-field-value">
        <div class="fixed-property-value-slot">${buildFixedPropertyValueControl(type, item.value)}</div>
      </div>
      <div class="fixed-property-field fixed-property-field-remove">
        <button class="fixed-property-remove" type="button" aria-label="删除属性" title="删除属性">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 7h16"></path>
            <path d="M9 3h6"></path>
            <path d="M10 11v6"></path>
            <path d="M14 11v6"></path>
            <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
          </svg>
        </button>
      </div>
    </div>
    <p class="fixed-property-error" hidden></p>
  `;

  row.querySelector(".fixed-property-remove")?.addEventListener("click", () => {
    row.remove();
    updateFixedPropertyEmptyState();
  });

  const typeButton = row.querySelector(".fixed-property-type-button");
  const typePicker = row.querySelector(".fixed-property-type-picker");
  const typeMenu = row.querySelector(".fixed-property-type-menu");

  typeButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = typePicker?.dataset.open === "true";
    closeAllFixedPropertyMenus();
    if (typePicker && typeMenu && !isOpen) {
      typePicker.dataset.open = "true";
      typeButton.setAttribute("aria-expanded", "true");
      typeMenu.hidden = false;
    }
  });

  row.querySelectorAll(".fixed-property-type-option").forEach((option) => {
    option.addEventListener("click", () => {
      const nextType = normalizeFixedPropertyType(option.getAttribute("data-type"));
      const valueSlot = row.querySelector(".fixed-property-value-slot");
      if (typePicker) {
        typePicker.dataset.type = nextType;
        typePicker.dataset.open = "false";
      }
      if (typeButton) {
        typeButton.setAttribute("aria-expanded", "false");
        const labelNode = typeButton.querySelector(".fixed-property-type-label");
        if (labelNode) {
          labelNode.textContent = getFixedPropertyTypeLabel(nextType);
        }
      }
      if (typeMenu) {
        typeMenu.hidden = true;
      }
      const currentValue = readFixedPropertyValue(row);
      if (valueSlot) {
        valueSlot.innerHTML = buildFixedPropertyValueControl(nextType, currentValue);
        bindFixedPropertyValueEvents(row);
      }
      clearFixedPropertyErrorState(row);
    });
  });

  row.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      input.classList.remove("input-error");
      clearFixedPropertyErrorState(row);
    });
  });
  bindFixedPropertyValueEvents(row);

  elements.fixedPropertiesList.appendChild(row);
  updateFixedPropertyEmptyState();
}

function updateFixedPropertyEmptyState() {
  const hasRows = elements.fixedPropertiesList.children.length > 0;
  elements.fixedPropertiesEmpty.hidden = hasRows;
}

function collectFixedPropertyRows({ includeRow = false } = {}) {
  return Array.from(elements.fixedPropertiesList.querySelectorAll(".fixed-property-row")).map((row) => {
    const type = normalizeFixedPropertyType(row.querySelector(".fixed-property-type-picker")?.getAttribute("data-type"));
    const item = {
      key: String(row.querySelector(".fixed-property-key")?.value || "").trim(),
      type,
      value: readFixedPropertyValue(row, type)
    };
    if (includeRow) {
      item.row = row;
    }
    return item;
  });
}

function validateFixedFrontmatterProperties(items) {
  const seenKeys = new Set();
  const rows = Array.isArray(items) ? items : [];
  for (const item of rows) {
    const key = String(item?.key || "").trim();
    const type = normalizeFixedPropertyType(item?.type);
    const value = item?.value;
    const lowerKey = key.toLowerCase();
    const valueText = typeof value === "string" ? value.trim() : "";

    if (!key && isFixedPropertyRowEffectivelyEmpty(type, value)) {
      continue;
    }
    if (!key) {
      return { ok: false, row: item.row, message: "请填写固定属性的属性名" };
    }
    if (!CUSTOM_PROPERTY_KEY_PATTERN.test(key)) {
      return { ok: false, row: item.row, message: "属性名仅支持中文、英文、数字、空格、下划线和短横线" };
    }
    if (type === "number") {
      if (!valueText) {
        return { ok: false, row: item.row, message: "请填写数字类型的属性值" };
      }
      if (!Number.isFinite(Number(valueText))) {
        return { ok: false, row: item.row, message: "数字类型的属性值必须是有效数字" };
      }
    } else if (type === "checkbox") {
      if (!valueText) {
        return { ok: false, row: item.row, message: "请填写复选框类型的属性值" };
      }
      const normalizedCheckboxValue = valueText.toLowerCase();
      if (normalizedCheckboxValue !== "true" && normalizedCheckboxValue !== "false") {
        return { ok: false, row: item.row, message: "复选框类型的属性值只能填写 true 或 false" };
      }
    } else if (!valueText) {
      return { ok: false, row: item.row, message: "请填写固定属性的属性值" };
    }
    if (SYSTEM_FRONTMATTER_FIELDS.has(lowerKey)) {
      return { ok: false, row: item.row, message: "该属性名与系统字段重复，请换一个名称" };
    }
    if (seenKeys.has(lowerKey)) {
      return { ok: false, row: item.row, message: "固定属性名不能重复" };
    }
    seenKeys.add(lowerKey);
  }

  return { ok: true };
}

function clearFixedPropertyErrors() {
  elements.fixedPropertiesList.querySelectorAll(".fixed-property-key, .fixed-property-value").forEach((input) => {
    input.classList.remove("input-error");
  });
  elements.fixedPropertiesList.querySelectorAll(".fixed-property-type-button").forEach((input) => {
    input.classList.remove("input-error");
  });
  elements.fixedPropertiesList.querySelectorAll(".fixed-property-error").forEach((node) => {
    node.hidden = true;
    node.textContent = "";
  });
}

function normalizeFixedFrontmatterProperties(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      key: String(item?.key || "").trim(),
      type: normalizeFixedPropertyType(item?.type),
      value: normalizeFixedPropertyValue(item?.type, item?.value)
    }))
    .filter((item) => item.key && !isFixedPropertyRowEffectivelyEmpty(item.type, item.value));
}

function normalizeFixedPropertyType(value) {
  const type = String(value || "").trim().toLowerCase();
  return FIXED_PROPERTY_TYPES.has(type) ? type : "text";
}

function normalizeFixedPropertyValue(type, value) {
  const normalizedType = normalizeFixedPropertyType(type);
  if (normalizedType === "checkbox") {
    return String(value || "").trim().toLowerCase();
  }
  return String(value || "").trim();
}

function isFixedPropertyRowEffectivelyEmpty(type, value) {
  return !String(value || "").trim();
}

function readFixedPropertyValue(row, _type = normalizeFixedPropertyType(row.querySelector(".fixed-property-type")?.value)) {
  return String(row.querySelector(".fixed-property-value")?.value || "").trim();
}

function buildFixedPropertyValueControl(type, value) {
  const normalizedType = normalizeFixedPropertyType(type);
  const placeholder =
    normalizedType === "number"
      ? "数字值"
      : normalizedType === "checkbox"
        ? "true / false"
        : normalizedType === "list"
          ? "多个值，用逗号分隔"
          : "属性值";
  return `<input class="fixed-property-value" type="text" placeholder="${placeholder}" value="${escapeAttribute(value)}" />`;
}

function buildFixedPropertyTypePicker(type) {
  const normalizedType = normalizeFixedPropertyType(type);
  return `
    <div class="fixed-property-type-picker" data-type="${normalizedType}" data-open="false">
      <button class="fixed-property-type-button" type="button" aria-label="属性类型" aria-haspopup="true" aria-expanded="false">
        <span class="fixed-property-type-label">${getFixedPropertyTypeLabel(normalizedType)}</span>
        <svg viewBox="0 0 12 12" focusable="false" aria-hidden="true">
          <path d="M2.25 4.5 6 8.25 9.75 4.5"></path>
        </svg>
      </button>
      <div class="fixed-property-type-menu" hidden>
        <button class="fixed-property-type-option" type="button" data-type="text">文本</button>
        <button class="fixed-property-type-option" type="button" data-type="number">数字</button>
        <button class="fixed-property-type-option" type="button" data-type="checkbox">复选框</button>
        <button class="fixed-property-type-option" type="button" data-type="list">列表</button>
      </div>
    </div>
  `;
}

function getFixedPropertyTypeLabel(type) {
  const normalizedType = normalizeFixedPropertyType(type);
  if (normalizedType === "number") {
    return "数字";
  }
  if (normalizedType === "checkbox") {
    return "复选框";
  }
  if (normalizedType === "list") {
    return "列表";
  }
  return "文本";
}

function bindFixedPropertyValueEvents(row) {
  row.querySelectorAll(".fixed-property-value").forEach((input) => {
    input.addEventListener("input", () => clearFixedPropertyErrorState(row));
    input.addEventListener("change", () => clearFixedPropertyErrorState(row));
  });
}

function clearFixedPropertyErrorState(row) {
  row.querySelectorAll(".fixed-property-key, .fixed-property-value, .fixed-property-type-button").forEach((input) => {
    input.classList.remove("input-error");
  });
  const errorNode = row.querySelector(".fixed-property-error");
  if (errorNode) {
    errorNode.hidden = true;
    errorNode.textContent = "";
  }
}

function closeAllFixedPropertyMenus() {
  elements.fixedPropertiesList.querySelectorAll(".fixed-property-type-picker").forEach((picker) => {
    picker.setAttribute("data-open", "false");
    const button = picker.querySelector(".fixed-property-type-button");
    const menu = picker.querySelector(".fixed-property-type-menu");
    if (button) {
      button.setAttribute("aria-expanded", "false");
    }
    if (menu) {
      menu.hidden = true;
    }
  });
}

function escapeAttribute(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/g, "");
}

function normalizeApiKey(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
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
