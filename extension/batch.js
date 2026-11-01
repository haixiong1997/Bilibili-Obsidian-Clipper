/* B站字幕批量下载 —— 管理页面逻辑
 * 职责：解析链接 → 展示可勾选列表 → 抓取（后台端口）→ 打包 ZIP / 写入 Obsidian
 */

const $ = (id) => document.getElementById(id);

const el = {
  input: $("input"),
  parseBtn: $("parseBtn"),
  pasteBtn: $("pasteBtn"),
  parseHint: $("parseHint"),
  loginHint: $("loginHint"),
  format: $("format"),
  subtitleLang: $("subtitleLang"),
  naming: $("naming"),
  concurrency: $("concurrency"),
  delayMs: $("delayMs"),
  includeTimestamp: $("includeTimestamp"),
  listCard: $("listCard"),
  listTitle: $("listTitle"),
  listMeta: $("listMeta"),
  selectAllBtn: $("selectAllBtn"),
  selectNoneBtn: $("selectNoneBtn"),
  expandSeasonBtn: $("expandSeasonBtn"),
  summary: $("summary"),
  progressFill: $("progressFill"),
  progressText: $("progressText"),
  summaryStats: $("summaryStats"),
  rows: $("rows"),
  selectedInfo: $("selectedInfo"),
  downloadBtn: $("downloadBtn"),
  startBtn: $("startBtn"),
  obsidianBtn: $("obsidianBtn"),
  stopBtn: $("stopBtn"),
  retryFailedBtn: $("retryFailedBtn"),
  status: $("status")
};

const state = {
  groups: [],
  results: new Map(), // key -> { status, path, error, ... }
  running: false,
  port: null,
  settings: {},
  lastJob: null,
  aborted: false
};

// 调试辅助（不影响功能）
try {
  window.__bocBatchState = state;
} catch {}

const FORMAT_EXT = { srt: "srt", txt: "txt", markdown: "md" };

init().catch((error) => setStatus(`初始化失败：${error?.message || error}`, "error"));

async function init() {
  bindEvents();
  await loadSettings();
  await restoreLastJob();
  const preset = new URLSearchParams(location.search).get("input");
  if (preset) {
    el.input.value = preset;
    await parse();
  }
}

/* ------------------------------------------------------------------ *
 * 设置与状态
 * ------------------------------------------------------------------ */

async function loadSettings() {
  try {
    const resp = await sendMessage({ type: "get-settings" });
    state.settings = resp?.settings || {};
    const format = state.settings.downloadFormat === "txt" ? "txt" : "srt";
    el.format.value = format;
    el.parseHint.textContent = "提示：合集链接可直接在 UP 主页“合集”里复制地址栏。";
  } catch {
    state.settings = {};
  }
  el.loginHint.textContent = "使用当前浏览器登录态";
}

async function restoreLastJob() {
  try {
    const resp = await sendMessage({ type: "batch-load-job" });
    const job = resp?.job;
    if (!job?.input) return;
    state.lastJob = job;
    if (job.options) {
      if (job.options.format) el.format.value = job.options.format;
      if (job.options.naming) el.naming.value = job.options.naming;
      if (job.options.concurrency) el.concurrency.value = String(job.options.concurrency);
      if (job.options.delayMs) el.delayMs.value = String(job.options.delayMs);
      if (job.options.subtitleLang) el.subtitleLang.value = job.options.subtitleLang;
    }
    el.input.value = job.input;
    el.parseHint.textContent = `已恢复上次的链接（${new Date(job.resolvedAt).toLocaleString()}），点击“解析列表”重新加载。`;
  } catch {}
}

function collectOptions() {
  return {
    format: el.format.value,
    subtitleLang: el.subtitleLang.value,
    naming: el.naming.value,
    concurrency: Number(el.concurrency.value) || 3,
    delayMs: Number(el.delayMs.value) || 0,
    includeTimestamp: el.includeTimestamp.checked,
    skipExisting: true
  };
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

function bindEvents() {
  el.parseBtn.addEventListener("click", () => parse());
  el.pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        el.input.value = text.trim();
        setStatus("已从剪贴板读取链接。");
      }
    } catch {
      setStatus("无法读取剪贴板，请手动粘贴。", "error");
    }
  });

  el.input.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      parse();
    }
  });

  el.selectAllBtn.addEventListener("click", () => setAllSelected(true));
  el.selectNoneBtn.addEventListener("click", () => setAllSelected(false));

  el.expandSeasonBtn.addEventListener("click", () => expandAsSeason());

  el.startBtn.addEventListener("click", () => run("download"));
  el.downloadBtn.addEventListener("click", downloadZip);
  el.obsidianBtn.addEventListener("click", () => run("obsidian"));
  el.retryFailedBtn.addEventListener("click", () => retryFailed());
  el.stopBtn.addEventListener("click", () => {
    state.aborted = true;
    state.port?.disconnect();
    state.port = null;
    state.running = false;
    renderControls();
    setStatus("已停止。已完成的条目仍可导出。", "error");
  });

  el.format.addEventListener("change", () => {
    // 切换格式后旧的抓取结果仍是 SRT/TXT 原文，清理状态避免误导出
    for (const [key, result] of state.results) {
      if (result.status === "ok") {
        state.results.set(key, { status: "idle" });
      }
    }
    renderRows();
  });

  el.rows.addEventListener("change", (event) => {
    const checkbox = event.target.closest('input[type="checkbox"]');
    if (!checkbox) return;
    const key = checkbox.dataset.key;
    const item = findItem(key);
    if (item) item.selected = checkbox.checked;
    syncGroupSelection();
    updateSelectionInfo();
  });

  el.rows.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;
    const key = btn.dataset.key;
    if (btn.dataset.action === "retry") {
      retryOne(key);
    }
    if (btn.dataset.action === "copy-url") {
      const item = findItem(key);
      if (item) {
        navigator.clipboard.writeText(item.url).then(
          () => setStatus(`已复制：${item.url}`, "ok"),
          () => setStatus("复制失败", "error")
        );
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

async function parse() {
  const input = el.input.value.trim();
  if (!input) {
    setStatus("请先粘贴链接或 BV 号。", "error");
    return;
  }
  setBusy(true);
  setStatus("正在解析链接…");
  try {
    const resp = await sendMessage({ type: "batch-parse", input });
    if (!resp?.ok) {
      throw new Error(resp?.error || "解析失败");
    }
    state.groups = (resp.groups || []).map((group) => ({
      ...group,
      collapsedOriginally: true,
      items: (group.items || []).map((item) => ({ ...item, selected: true, expanded: false }))
    }));
    state.results.clear();
    renderRows();
    const total = countItems();
    const failed = state.groups.filter((group) => !group.ok).length;
    setStatus(
      failed
        ? `解析完成：${state.groups.length} 个链接，其中 ${failed} 个失败（见列表）。`
        : `解析完成：共 ${total} 个视频可下载。`,
      failed ? "error" : "ok"
    );
    await sendMessage({
      type: "batch-save-job",
      job: { input, options: collectOptions(), title: state.groups[0]?.title || "" }
    });
  } catch (error) {
    setStatus(`解析失败：${error?.message || error}`, "error");
  } finally {
    setBusy(false);
  }
}

/** 视频属于某合集时，允许一键展开整季 */
async function expandAsSeason() {
  const group = state.groups.find((item) => item.ok && item.season?.id && item.source === "video");
  if (!group) return;
  setStatus("正在展开合集…");
  try {
    const resp = await sendMessage({ type: "batch-parse", input: `/channel/collectiondetail?sid=${group.season.id}` });
    if (!resp?.ok) throw new Error(resp?.error || "展开失败");
    state.groups = (resp.groups || []).map((item) => ({
      ...item,
      items: (item.items || []).map((entry) => ({ ...entry, selected: true }))
    }));
    state.results.clear();
    renderRows();
    setStatus(`已展开合集：共 ${countItems()} 个视频。`, "ok");
  } catch (error) {
    setStatus(`展开合集失败：${error?.message || error}`, "error");
  }
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function renderRows() {
  el.listCard.hidden = state.groups.length === 0;
  if (state.groups.length === 0) return;

  const first = state.groups.find((group) => group.ok);
  el.listTitle.textContent = first?.title || state.groups[0]?.target?.raw || "解析结果";
  el.listMeta.textContent = `${state.groups.length} 个来源 · ${countItems()} 个视频`;
  el.expandSeasonBtn.hidden = !state.groups.some(
    (group) => group.ok && group.source === "video" && group.season?.id
  );

  const html = state.groups
    .map((group, groupIndex) => {
      if (!group.ok) {
        return `<div class="group-head"><b>解析失败</b><span class="tag">${escapeHtml(
          group.target?.raw || ""
        )}</span><span class="muted">${escapeHtml(group.error || "")}</span></div>`;
      }
      const sourceTag =
        group.source === "season"
          ? "合集"
          : group.source === "fav"
          ? "收藏夹"
          : group.items.length > 1
          ? `多 P (${group.items.length})`
          : "单视频";
      const selectedCount = group.items.filter((item) => item.selected).length;
      const head = `<div class="group-head"><b>${escapeHtml(
        group.title
      )}</b><span class="tag">${sourceTag}</span><span class="muted">${selectedCount}/${
        group.items.length
      } 已选</span></div>`;

      const rows = group.items
        .map((item) => {
          const result = state.results.get(item.key) || { status: "idle" };
          const index = item.pageCount > 1 ? `P${item.pageIndex}` : `#${item.index}`;
          const duration = item.duration ? ` · ${formatDuration(item.duration)}` : "";
          return `<div class="row" data-key="${escapeHtml(item.key)}">
            <input type="checkbox" data-key="${escapeHtml(item.key)}" ${
            item.selected ? "checked" : ""
          } />
            <div class="row-main">
              <div class="row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
              <div class="row-sub">${escapeHtml(item.bvid)} · ${index}${duration}${
            result.path ? ` · ${escapeHtml(result.path)}` : ""
          }${result.error ? ` · ${escapeHtml(result.error)}` : ""}</div>
            </div>
            <div class="row-state">${renderState(result)}</div>
          </div>`;
        })
        .join("");

      return `<div data-group="${groupIndex}">${head}${rows}</div>`;
    })
    .join("");

  el.rows.innerHTML = html || '<div class="empty">没有可下载的视频</div>';
  updateSelectionInfo();
  renderProgress();
}

function renderState(result) {
  switch (result.status) {
    case "running":
      return '<span class="spinner"></span><span class="muted">抓取中</span>';
    case "ok":
      return `<span class="badge ok">完成${result.lineCount ? ` ${result.lineCount} 行` : ""}</span>`;
    case "no-subtitle":
      return `<span class="badge warn">无字幕</span>`;
    case "skipped":
      return '<span class="badge skip">已存在</span>';
    case "error":
      return `<span class="badge err" title="${escapeHtml(result.error || "")}">失败</span>`;
    default:
      return '<span class="badge idle">待抓取</span>';
  }
}

function renderProgress() {
  const selected = selectedItems();
  const finished = selected.filter((item) => {
    const result = state.results.get(item.key);
    return result && ["ok", "no-subtitle", "error", "skipped"].includes(result.status);
  }).length;
  const total = selected.length;
  el.summary.hidden = total === 0;
  const percent = total ? Math.round((finished / total) * 100) : 0;
  el.progressFill.style.width = `${percent}%`;
  el.progressText.textContent = `${finished} / ${total}`;

  const all = [...state.results.values()];
  const ok = all.filter((item) => item.status === "ok").length;
  const none = all.filter((item) => item.status === "no-subtitle").length;
  const fail = all.filter((item) => item.status === "error").length;
  const skipped = all.filter((item) => item.status === "skipped").length;
  el.summaryStats.innerHTML = [
    `<span class="s-ok">成功 <b>${ok}</b></span>`,
    `<span class="s-warn">无字幕 <b>${none}</b></span>`,
    `<span class="s-err">失败 <b>${fail}</b></span>`,
    skipped ? `<span class="s-skip">跳过 <b>${skipped}</b></span>` : ""
  ]
    .filter(Boolean)
    .join("");

  el.retryFailedBtn.hidden = !(fail > 0 || none > 0);
  renderControls();
}

function renderControls() {
  const selected = selectedItems();
  const hasDone = selected.some((item) => state.results.get(item.key)?.status === "ok");
  const hasPending = selected.some((item) => state.results.get(item.key)?.status !== "ok");
  el.downloadBtn.disabled = state.running || !hasDone;
  el.obsidianBtn.disabled = state.running || !hasDone;
  el.startBtn.disabled = state.running || !hasPending || selected.length === 0;
  el.startBtn.textContent = state.running
    ? "抓取中…"
    : hasDone && hasPending
    ? "抓取剩余项"
    : "开始抓取字幕";
  el.stopBtn.hidden = !state.running;
  el.parseBtn.disabled = state.running;
  el.selectAllBtn.disabled = state.running;
  el.selectNoneBtn.disabled = state.running;
}

function updateSelectionInfo() {
  const selected = selectedItems();
  el.selectedInfo.textContent = `已选 ${selected.length} 项`;
  renderControls();
  // 更新分组标题里的已选计数
  for (const [index, group] of state.groups.entries()) {
    if (!group.ok) continue;
    const head = el.rows.querySelector(`[data-group="${index}"] .group-head .muted`);
    if (head) {
      head.textContent = `${group.items.filter((item) => item.selected).length}/${group.items.length} 已选`;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 选择
 * ------------------------------------------------------------------ */

function setAllSelected(value) {
  for (const group of state.groups) {
    if (!group.ok) continue;
    for (const item of group.items) item.selected = value;
  }
  for (const checkbox of el.rows.querySelectorAll('input[type="checkbox"]')) {
    checkbox.checked = value;
  }
  updateSelectionInfo();
}

function syncGroupSelection() {
  updateSelectionInfo();
}

function allItems() {
  return state.groups.flatMap((group) => (group.ok ? group.items : []));
}

function selectedItems() {
  return allItems().filter((item) => item.selected);
}

function findItem(key) {
  return allItems().find((item) => item.key === key);
}

function countItems() {
  return allItems().length;
}

/* ------------------------------------------------------------------ *
 * 抓取（通过长连接端口，逐条回传进度）
 * ------------------------------------------------------------------ */

function run(mode) {
  if (state.running) return;
  if (mode === "obsidian") {
    const { obsidianApiBaseUrl, obsidianApiKey } = state.settings || {};
    if (!obsidianApiBaseUrl || !obsidianApiKey) {
      setStatus("请先在设置中配置 Obsidian Local REST API 地址与 API Key。", "error");
      return;
    }
  }

  const options = collectOptions();
  let items;
  if (mode === "obsidian") {
    items = selectedItems().filter((item) => state.results.get(item.key)?.status === "ok");
    if (!items.length) {
      setStatus("没有抓取成功的条目可写入。", "error");
      return;
    }
  } else {
    items = selectedItems().filter((item) => {
      const result = state.results.get(item.key);
      // 已成功的跳过，除非格式变化（格式变化时上面已重置为 idle）
      return !result || result.status !== "ok";
    });
    if (!items.length) {
      setStatus("所选条目均已抓取完成，可直接下载 ZIP。");
      return;
    }
    for (const item of items) {
      state.results.set(item.key, { status: "idle" });
    }
  }

  state.running = true;
  state.aborted = false;
  renderRows();
  renderProgress();
  setStatus(mode === "obsidian" ? "正在写入 Obsidian…" : "正在抓取字幕…");

  const job = {
    mode,
    input: el.input.value.trim(),
    title: state.groups.find((group) => group.ok)?.title || "",
    author: state.groups.find((group) => group.ok)?.author || "",
    pubdate: state.groups.find((group) => group.ok)?.pubdate || 0,
    source: state.groups.find((group) => group.ok)?.source || "video",
    options,
    items: items.map(({ selected, ...rest }) => rest)
  };

  const port = chrome.runtime.connect({ name: "boc-batch" });
  state.port = port;

  port.onMessage.addListener((msg) => {
    if (msg.type === "progress") {
      const result = msg.result || {};
      state.results.set(result.key, result);
      if (msg.item?.key) updateRow(msg.item.key, result);
      renderProgress();
      setStatus(`进度 ${msg.done}/${msg.total}：${msg.item?.title || ""}`);
      return;
    }
    if (msg.type === "fatal") {
      finishRun();
      setStatus(msg.error || "任务失败", "error");
      return;
    }
    if (msg.type === "done") {
      const results = msg.results || [];
      const ok = results.filter((item) => item.ok).length;
      const none = results.filter((item) => item.status === "no-subtitle").length;
      const fail = results.filter((item) => item.status === "error").length;
      state.lastResults = results;
      finishRun();
      if (mode === "obsidian") {
        setStatus(`写入完成：成功 ${ok}，失败 ${fail}，跳过 ${results.length - ok - fail}。`, fail ? "error" : "ok");
      } else if (fail > 0) {
        const firstError = results.find((item) => item.status === "error")?.error || "";
        const rateLimited = /风控|code -352|code -412/.test(firstError);
        setStatus(
          `抓取完成：成功 ${ok}，无字幕 ${none}，失败 ${fail}。` +
            (firstError ? `示例错误：${firstError}` : "") +
            (rateLimited
              ? "｜疑似触发风控：请把并发数调到 1、请求间隔调到 1500ms，稍等几分钟后点「重试失败项」。"
              : "可点「重试失败项」重试。"),
          "error"
        );
      } else {
        setStatus(
          `抓取完成：成功 ${ok}，无字幕 ${none}，失败 0。点击“下载 ZIP”导出字幕。`,
          "ok"
        );
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (state.running) {
      finishRun();
      setStatus("后台连接已断开，任务可能被中断（可重试未完成项）。", "error");
    }
  });

  port.postMessage({ action: "start", job, settings: state.settings });
}

function finishRun() {
  state.running = false;
  state.port = null;
  renderRows();
  renderProgress();
}

function updateRow(key, result) {
  const row = el.rows.querySelector(`.row[data-key="${cssEscape(key)}"]`);
  if (!row) return;
  const stateCell = row.querySelector(".row-state");
  if (stateCell) stateCell.innerHTML = renderState(result || { status: "idle" });
  const sub = row.querySelector(".row-sub");
  if (sub) {
    const base = sub.dataset.base || sub.textContent;
    sub.dataset.base = base;
    sub.textContent = `${base}${result?.path ? ` · ${result.path}` : ""}${
      result?.error ? ` · ${result.error}` : ""
    }`;
  }
}

function retryOne(key) {
  const item = findItem(key);
  if (!item) return;
  state.results.delete(key);
  item.selected = true;
  const checkbox = el.rows.querySelector(`input[data-key="${cssEscape(key)}"]`);
  if (checkbox) checkbox.checked = true;
  renderRows();
  run("download");
}

function retryFailed() {
  let changed = 0;
  for (const item of allItems()) {
    const result = state.results.get(item.key);
    if (result && (result.status === "error" || result.status === "no-subtitle")) {
      state.results.delete(item.key);
      item.selected = true;
      changed += 1;
    }
  }
  if (!changed) {
    setStatus("没有需要重试的条目。");
    return;
  }
  renderRows();
  run("download");
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

async function downloadZip() {
  const options = collectOptions();
  const done = selectedItems().filter((item) => state.results.get(item.key)?.status === "ok");
  if (!done.length) {
    setStatus("没有已完成的字幕可导出，请先抓取。", "error");
    return;
  }

  const entries = done.map((item) => {
    const result = state.results.get(item.key);
    return { path: result.path, content: result.content };
  });

  // 附带一份索引，方便在 Obsidian / 笔记软件里检索
  const indexLines = [
    `# ${state.groups.find((group) => group.ok)?.title || "B站字幕批量导出"}`,
    "",
    `导出时间：${new Date().toLocaleString()}`,
    `条目数：${done.length}`,
    "",
    "| 序号 | 标题 | BV 号 | 字幕语言 | 文件 |",
    "| --- | --- | --- | --- | --- |"
  ];
  done.forEach((item, index) => {
    const result = state.results.get(item.key);
    indexLines.push(
      `| ${index + 1} | ${String(item.title).replace(/\|/g, "｜")} | ${item.bvid} | ${
        result.lan || ""
      } | ${result.path} |`
    );
  });
  entries.push({ path: "00-索引.md", content: `${indexLines.join("\n")}\n` });

  setStatus("正在打包 ZIP…");
  try {
    const resp = await sendMessage({ type: "batch-build-zip", entries });
    if (!resp?.ok) throw new Error(resp?.error || "打包失败");
    const bytes = base64ToBytes(resp.base64);
    const blob = new Blob([bytes], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const name = sanitizeFileName(
      `${state.groups.find((group) => group.ok)?.title || "bilibili-subtitles"}-字幕-${timestampTag()}`
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus(`已导出 ${done.length} 个字幕文件（.zip）。`, "ok");
  } catch (error) {
    setStatus(`打包失败：${error?.message || error}`, "error");
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timestampTag() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}`;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function setStatus(text, kind = "") {
  el.status.textContent = text || "";
  el.status.className = "status";
  if (kind === "error") el.status.classList.add("is-error");
  if (kind === "ok") el.status.classList.add("is-ok");
  el.status.classList.remove("spinner");
}

function setBusy(busy) {
  el.parseBtn.disabled = Boolean(busy);
  el.parseBtn.innerHTML = busy ? '<span class="spinner"></span>解析中' : "解析列表";
}

function sendMessage(message) {
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function sanitizeFileName(value) {
  return String(value || "bilibili")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hour = Math.floor(safe / 3600);
  const minute = Math.floor((safe % 3600) / 60);
  const second = safe % 60;
  return hour > 0
    ? `${hour}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`
    : `${minute}:${String(second).padStart(2, "0")}`;
}
