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

const elements = {
  noteFolder: document.getElementById("noteFolder"),
  obsidianApiBaseUrl: document.getElementById("obsidianApiBaseUrl"),
  obsidianApiKey: document.getElementById("obsidianApiKey"),
  tags: document.getElementById("tags"),
  includeTimestampInBody: document.getElementById("includeTimestampInBody"),
  frontmatterFields: document.querySelectorAll('input[name="frontmatterField"]'),
  saveBtn: document.getElementById("saveBtn"),
  status: document.getElementById("status")
};

init();

function init() {
  loadSettings();
  elements.saveBtn.addEventListener("click", saveSettings);
}

async function loadSettings() {
  const settings = await getSettings();
  elements.noteFolder.value = settings.noteFolder || "";
  elements.obsidianApiBaseUrl.value = settings.obsidianApiBaseUrl || "";
  elements.obsidianApiKey.value = settings.obsidianApiKey || "";
  elements.tags.value = settings.tags || "";
  elements.includeTimestampInBody.checked = Boolean(settings.includeTimestampInBody);
  const selectedFields = new Set(settings.frontmatterFields || DEFAULT_SETTINGS.frontmatterFields);
  elements.frontmatterFields.forEach((checkbox) => {
    checkbox.checked = selectedFields.has(checkbox.value);
  });
}

async function saveSettings() {
  const selectedFields = Array.from(elements.frontmatterFields)
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);

  const payload = {
    noteFolder: elements.noteFolder.value.trim(),
    obsidianApiBaseUrl: elements.obsidianApiBaseUrl.value.trim(),
    obsidianApiKey: elements.obsidianApiKey.value.trim(),
    tags: elements.tags.value.trim(),
    includeTimestampInBody: elements.includeTimestampInBody.checked,
    frontmatterFields: selectedFields
  };

  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "save-settings", settings: payload }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        const msg = chrome.runtime.lastError?.message || resp?.error || "保存失败";
        setStatus(msg, true);
        resolve();
        return;
      }

      setStatus("保存成功");
      resolve();
    });
  });
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "get-settings" }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        resolve({ ...DEFAULT_SETTINGS });
        return;
      }
      resolve({ ...DEFAULT_SETTINGS, ...(resp.settings || {}) });
    });
  });
}

function setStatus(text, isError = false) {
  elements.status.textContent = text;
  elements.status.dataset.error = isError ? "true" : "false";
}
