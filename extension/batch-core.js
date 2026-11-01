/* Bilibili Obsidian Clipper - 批量字幕下载核心模块
 * 由 background.js 通过 importScripts("batch-core.js") 加载（MV3 service worker）。
 * 设计要点：
 *  1. 所有请求都复用用户自己的登录 Cookie（credentials: "include"），不经过任何第三方服务器；
 *  2. 合集 / 多 P 的内容发现采用「先接口、后页面内联数据」的降级策略，最大化成功率；
 *  3. 抓取使用限流并发队列，单条失败不影响整体，失败项可单独重试；
 *  4. 字幕内容在本地生成 SRT / TXT / Markdown，按 ZIP 打包下载或批量写入 Obsidian。
 */

const BOC_BATCH_STORAGE_KEY = "bocBatchLastJob";
const BOC_BATCH_DEFAULT_OPTIONS = {
  format: "srt", // 打包格式：srt | txt | markdown
  subtitleLang: "auto", // auto（优先中文）或具体 lan
  concurrency: 3,
  delayMs: 350,
  naming: "index-title", // index-title | title | index
  writeObsidian: false,
  skipExisting: true,
  maxRetries: 1
};

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

function bocSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * 安全转字符串。
 * 注意：不要依赖 background.js 的 toString（它对非字符串返回空串），
 * 而 B 站 API 返回的 cid / aid 是数字，必须原样转成字符串。
 */
function bocSafeString(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return String(value);
  } catch {
    return "";
  }
}

/** 文件名 / 目录名净化：去掉非法字符，限制长度 */
function bocSanitizeName(value, fallback = "untitled", maxLength = 80) {
  const text = bocSafeString(value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  return (text || fallback).slice(0, maxLength);
}

/** 时间戳格式化：SRT 用逗号毫秒，普通预览用点号 */
function bocFormatTimestamp(seconds, forSrt = true) {
  const msTotal = Math.max(0, Math.floor((Number(seconds) || 0) * 1000));
  const hour = Math.floor(msTotal / 3600000);
  const minute = Math.floor((msTotal % 3600000) / 60000);
  const second = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  return forSrt
    ? `${hh}:${mm}:${ss},${String(ms).padStart(3, "0")}`
    : `${hh}:${mm}:${ss}.${String(ms).padStart(3, "0")}`;
}

function bocFormatDuration(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hour = Math.floor(safe / 3600);
  const minute = Math.floor((safe % 3600) / 60);
  const second = safe % 60;
  if (hour > 0) {
    return `${hour}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  }
  return `${minute}:${String(second).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ *
 * 输入解析：支持 BV / av / ss / ep / 合集页 / 多 P 链接
 * ------------------------------------------------------------------ */

function bocExtractBvid(text) {
  const match = String(text || "").match(/BV[0-9A-Za-z]{10}/);
  return match ? match[0] : "";
}

function bocExtractAid(text) {
  const match = String(text || "").match(/(?:\/video\/)?av(\d+)/i);
  return match ? match[1] : "";
}

/**
 * 把用户粘贴的任意文本（可能是多行、带标题的分享文案）拆成若干个「目标」。
 * 返回 [{ kind: "bvid"|"aid"|"season"|"media"|"fav", id, page, raw, source }]
 */
function bocParseTargets(input) {
  const text = bocSafeString(input);
  const tokens = text
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const targets = [];
  const seen = new Set();

  const push = (target) => {
    const key = `${target.kind}:${target.id}:${target.page || 1}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  for (const token of tokens) {
    const bvid = bocExtractBvid(token);
    if (bvid) {
      let page = 1;
      const pMatch = token.match(/[?&]p=(\d+)/);
      if (pMatch) page = Math.max(1, Number(pMatch[1]) || 1);
      push({ kind: "bvid", id: bvid, page, raw: token });
      continue;
    }

    const season = token.match(/space\.bilibili\.com\/(\d+)\/[^?]*channel\/collectiondetail\?.*?\bsid=(\d+)/) ||
      token.match(/space\.bilibili\.com\/(\d+)\/.*\bseason_id=(\d+)/) ||
      token.match(/\bseason_id=(\d+)/);
    if (season) {
      // space 链接里第一个数字组是 UP 主 mid，用于后续合集列表接口
      if (season.length >= 3) {
        push({ kind: "season", id: String(season[2]), mid: String(season[1]), page: 1, raw: token });
      } else {
        push({ kind: "season", id: String(season[1]), mid: "", page: 1, raw: token });
      }
      continue;
    }

    const media = token.match(/\bep(\d+)/) || token.match(/\/bangumi\/play\/ep(\d+)/);
    if (media) {
      push({ kind: "media", id: String(media[1]), page: 1, raw: token });
      continue;
    }

    const aid = bocExtractAid(token);
    if (aid) {
      push({ kind: "aid", id: String(aid), page: 1, raw: token });
      continue;
    }

    const fav = token.match(/space\.bilibili\.com\/[^/?#]*\/favlist\?.*?\bfid=(\d+)/) ||
      token.match(/\bfid=(\d+)/);
    if (fav) {
      push({ kind: "fav", id: String(fav[1]), page: 1, raw: token });
      continue;
    }

    if (/^\d{6,}$/.test(token)) {
      push({ kind: "season-or-aid", id: token, page: 1, raw: token });
    }
  }

  return targets;
}

/* ------------------------------------------------------------------ *
 * B 站数据获取
 * ------------------------------------------------------------------ */

async function bocFetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    referrer: "https://www.bilibili.com/",
    referrerPolicy: "strict-origin-when-cross-origin",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/** 带退避重试的 JSON 请求：B 站偶发 -352 / -412（风控）时自动退避重试 */
async function bocFetchJsonRetry(url, retries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      // 线性退避 + 抖动：1.2s、2.4s…，给风控冷却时间
      await bocSleep(1200 * attempt + Math.floor(Math.random() * 400));
    }
    try {
      const payload = await bocFetchJson(url);
      if (payload && payload.code === 0) {
        return payload;
      }
      const code = payload?.code;
      lastError = new Error(bocDescribeApiError(code, payload?.message));
      // 明确的「无权限 / 无此内容 / 未登录」不值得重试
      if (code === -404 || code === -403 || code === -800 || code === -101) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("请求失败");
}

function bocDescribeApiError(code, message) {
  const map = {
    "-101": "账号未登录（请先在浏览器登录 B 站）",
    "-352": "被风控拦截，请稍后重试或降低并发",
    "-412": "请求被限制，请稍后重试",
    "-404": "内容不存在或已被删除",
    "-403": "无权访问该内容"
  };
  const hint = map[String(code)] || "";
  return [hint, message, code !== undefined ? `(code ${code})` : ""].filter(Boolean).join(" ");
}

/** 视频基本信息 + 分 P 列表；view 接口被风控时降级到 pagelist */
async function bocGetVideoInfo(bvid, options = {}) {
  const safeBvid = bocSafeString(bvid);
  let title = "";
  let author = "";
  let aid = "";
  let pages = [];
  let pubdate = 0;
  let cover = "";
  let season = null;

  if (safeBvid) {
    try {
      const payload = await bocFetchJsonRetry(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(safeBvid)}`,
        options.retries ?? 1
      );
      const data = payload.data || {};
      title = bocSafeString(data.title);
      author = bocSafeString(data.owner?.name);
      aid = bocSafeString(data.aid);
      pubdate = Number(data.pubdate) || 0;
      cover = bocSafeString(data.pic);
      pages = (Array.isArray(data.pages) ? data.pages : []).map((item) => ({
        cid: bocSafeString(item?.cid),
        page: Number(item?.page) || 0,
        part: bocSafeString(item?.part),
        duration: Number(item?.duration) || 0
      }));
      const ugc = data.ugc_season;
      if (ugc && Array.isArray(ugc.sections)) {
        const episodes = ugc.sections.flatMap((section) => section?.episodes || []);
        season = {
          id: bocSafeString(ugc.id),
          title: bocSafeString(ugc.title),
          mid: bocSafeString(ugc.mid),
          episodes: episodes.map((ep) => ({
            bvid: bocSafeString(ep?.bvid),
            aid: bocSafeString(ep?.aid),
            cid: bocSafeString(ep?.cid),
            title: bocSafeString(ep?.title),
            duration: Number(ep?.arc?.duration) || 0,
            cover: bocSafeString(ep?.arc?.pic)
          }))
        };
      }
    } catch (error) {
      // 继续尝试 pagelist
    }
  }

  if (!pages.length) {
    let cid = "";
    if (safeBvid) {
      try {
        const list = await bocFetchJsonRetry(
          `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(safeBvid)}&jsonp=jsonp`,
          options.retries ?? 1
        );
        pages = (Array.isArray(list.data) ? list.data : []).map((item) => ({
          cid: bocSafeString(item?.cid),
          page: Number(item?.page) || 0,
          part: bocSafeString(item?.part),
          duration: Number(item?.duration) || 0
        }));
      } catch (error) {
        if (!title) {
          throw new Error(`无法获取视频信息：${error.message}`);
        }
      }
    }
    if (!pages.length && !title) {
      throw new Error("无法获取视频信息，请确认链接有效且已在浏览器登录 B 站");
    }
  }

  return {
    bvid: safeBvid,
    aid,
    title: title || safeBvid,
    author,
    pubdate,
    cover,
    pages,
    season
  };
}

/** 合集（UGC 季）内全部视频：多接口 + 多入口降级 */
async function bocGetSeasonEpisodes(seasonId, mid = "") {
  const errors = [];
  const buildList = (items) =>
    (items || [])
      .map((item, index) => ({
        bvid: bocSafeString(item?.bvid),
        aid: bocSafeString(item?.aid),
        cid: bocSafeString(item?.cid),
        title: bocSafeString(item?.title),
        duration: Number(item?.duration) || 0,
        cover: bocSafeString(item?.pic),
        index: index + 1
      }))
      .filter((item) => item.bvid);

  if (mid) {
    for (const pageSize of [30, 20, 10]) {
      try {
        const collected = [];
        let pageNum = 1;
        for (;;) {
          const payload = await bocFetchJsonRetry(
            "https://api.bilibili.com/x/polymer/web-space/seasons_archives_list" +
              `?mid=${encodeURIComponent(mid)}&season_id=${encodeURIComponent(seasonId)}` +
              `&sort_reverse=false&page_num=${pageNum}&page_size=${pageSize}`,
            1
          );
          const archives = payload.data?.archives || [];
          const meta = payload.data?.meta || {};
          collected.push(...archives);
          const total = Number(meta.total) || 0;
          if (!archives.length || collected.length >= total || pageNum >= 50) {
            break;
          }
          pageNum += 1;
          await bocSleep(260);
        }
        const list = buildList(collected);
        if (list.length) {
          return { seasonTitle: "", episodes: list };
        }
      } catch (error) {
        errors.push(error.message);
        break;
      }
    }
  }

  // 番剧 / 课程类型的 season
  try {
    const payload = await bocFetchJsonRetry(
      `https://api.bilibili.com/pgc/view/web/season?season_id=${encodeURIComponent(seasonId)}`,
      1
    );
    const episodes = buildList(payload.data?.episodes || payload.result?.episodes || []);
    if (episodes.length) {
      return { seasonTitle: bocSafeString(payload.data?.title || payload.result?.season_title), episodes };
    }
  } catch (error) {
    errors.push(error.message);
  }

  const detail = errors.filter(Boolean).slice(0, 2).join("；");
  throw new Error(`无法获取合集列表${detail ? `：${detail}` : ""}`);
}

/**
 * 从视频页内联数据（window.__INITIAL_STATE__）读取合集信息。
 * 部分接口被风控时，这条「借用户已打开的页面」的路径最稳。
 */
async function bocReadInitialStateFromTabs() {
  if (!chrome.tabs?.query) {
    return null;
  }
  const tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" }).catch(() => []);
  for (const tab of tabs || []) {
    if (!tab.id || tab.discarded) continue;
    const results = await chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          try {
            const state = window.__INITIAL_STATE__;
            const data = state?.videoData;
            if (!data) return null;
            return {
              bvid: data.bvid || "",
              aid: data.aid || "",
              title: data.title || "",
              author: data.owner?.name || "",
              pubdate: data.pubdate || 0,
              season: data.ugc_season
                ? {
                    id: data.ugc_season.id,
                    title: data.ugc_season.title,
                    mid: data.ugc_season.mid,
                    episodes: (data.ugc_season.sections || []).flatMap((section) =>
                      (section?.episodes || []).map((ep) => ({
                        bvid: ep?.bvid || "",
                        aid: ep?.aid || "",
                        cid: ep?.cid || "",
                        title: ep?.title || "",
                        duration: ep?.arc?.duration || 0,
                        cover: ep?.arc?.pic || ""
                      }))
                    )
                  }
                : null,
              pages: (data.pages || []).map((item) => ({
                cid: item?.cid || "",
                page: item?.page || 0,
                part: item?.part || "",
                duration: item?.duration || 0
              }))
            };
          } catch {
            return null;
          }
        }
      })
      .catch(() => null);
    const value = results?.[0]?.result;
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * 解析用户输入 → 待下载列表。
 * 返回 { title, source, multiPage, seasonId, items: [...] }
 */
async function bocResolveTarget(target) {
  const kind = target?.kind;
  const id = bocSafeString(target?.id);

  if (kind === "season" || kind === "season-or-aid" || kind === "fav") {
    if (kind === "fav") {
      const fav = await bocGetFavlist(id);
      return fav;
    }
    const local = kind === "season-or-aid" ? await bocReadInitialStateFromTabs() : null;
    const matchedLocal =
      local?.season && String(local.season.id) === String(id) ? local.season : null;
    const mid = bocSafeString(target?.mid) || matchedLocal?.mid || "";
    const season = await bocGetSeasonEpisodes(id, mid);
    const episodes = season.episodes.length
      ? season.episodes
      : (matchedLocal?.episodes || []).map((item, index) => ({ ...item, index: index + 1 }));
    if (!episodes.length) {
      throw new Error("合集内没有可下载的视频");
    }
    return {
      title: season.seasonTitle || matchedLocal?.title || `合集-${id}`,
      source: "season",
      seasonId: id,
      items: episodes.map((item, index) => ({
        key: `${item.bvid}-p1`,
        bvid: item.bvid,
        aid: item.aid,
        cid: item.cid,
        title: item.title,
        parentTitle: season.seasonTitle || matchedLocal?.title || `合集-${id}`,
        pageIndex: 1,
        pageCount: 1,
        index: index + 1,
        duration: item.duration,
        url: `https://www.bilibili.com/video/${item.bvid}/`
      }))
    };
  }

  if (kind === "bvid" || kind === "aid") {
    const bvid = kind === "bvid" ? id : "";
    let info = null;
    if (bvid) {
      info = await bocGetVideoInfo(bvid);
    } else {
      const payload = await bocFetchJsonRetry(
        `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(id)}`,
        1
      );
      info = await bocGetVideoInfo(bocSafeString(payload.data?.bvid));
    }

    // 若该视频属于某个合集，自动识别合集并提示（是否展开由上层决定）
    const pages = info.pages.length
      ? info.pages
      : [{ cid: "", page: 1, part: info.title, duration: 0 }];
    const requestedPage = Math.max(1, Number(target?.page) || 1);
    const selectedPages =
      pages.length > 1 && target?.explicitPage
        ? pages.filter((item) => Number(item.page) === requestedPage)
        : pages;

    return {
      title: info.title,
      source: "video",
      bvid: info.bvid,
      author: info.author,
      pubdate: info.pubdate,
      seasonId: info.season?.id || "",
      season: info.season || null,
      pageCount: pages.length,
      items: (selectedPages.length ? selectedPages : pages).map((page, index) => ({
        key: `${info.bvid}-p${page.page || index + 1}`,
        bvid: info.bvid,
        aid: info.aid,
        cid: page.cid,
        title: pages.length > 1 ? page.part || `P${page.page}` : info.title,
        parentTitle: info.title,
        pageIndex: Number(page.page) || index + 1,
        pageCount: pages.length,
        index: index + 1,
        duration: page.duration,
        url:
          pages.length > 1
            ? `https://www.bilibili.com/video/${info.bvid}/?p=${Number(page.page) || index + 1}`
            : `https://www.bilibili.com/video/${info.bvid}/`
      }))
    };
  }

  if (kind === "media") {
    const payload = await bocFetchJsonRetry(
      `https://api.bilibili.com/pgc/view/web/season?ep_id=${encodeURIComponent(id)}`,
      1
    );
    const episodes = (payload.data?.episodes || payload.result?.episodes || [])
      .map((item, index) => ({
        bvid: bocSafeString(item?.bvid),
        aid: bocSafeString(item?.aid),
        cid: bocSafeString(item?.cid),
        title: bocSafeString(item?.share_copy || item?.long_title || item?.title),
        duration: Number(item?.duration) || 0,
        index: index + 1
      }))
      .filter((item) => item.bvid);
    if (!episodes.length) {
      throw new Error("番剧/课程中没有可下载的视频");
    }
    return {
      title: bocSafeString(payload.data?.title || payload.result?.season_title || `EP${id}`),
      source: "season",
      seasonId: String(payload.data?.season_id || ""),
      items: episodes.map((item) => ({
        key: `${item.bvid}-p1`,
        bvid: item.bvid,
        aid: item.aid,
        cid: item.cid,
        title: item.title,
        parentTitle: bocSafeString(payload.data?.title || ""),
        pageIndex: 1,
        pageCount: episodes.length,
        index: item.index,
        duration: item.duration,
        url: `https://www.bilibili.com/video/${item.bvid}/`
      }))
    };
  }

  throw new Error("无法识别的链接，请粘贴 BV 号、视频地址、合集地址或收藏夹地址");
}

async function bocGetFavlist(mediaId) {
  const collected = [];
  let pageNum = 1;
  for (;;) {
    const payload = await bocFetchJsonRetry(
      "https://api.bilibili.com/x/v3/fav/resource/list" +
        `?media_id=${encodeURIComponent(mediaId)}&platform=web&pn=${pageNum}` +
        "&ps=20&keyword=&order=mtime&type=0&tid=0&jsonp=jsonp",
      1
    );
    const medias = payload.data?.medias || [];
    collected.push(...medias);
    const hasMore = Boolean(payload.data?.has_more);
    if (!hasMore || !medias.length || pageNum >= 100) break;
    pageNum += 1;
    await bocSleep(300);
  }
  const items = collected
    .filter((item) => item && item.bvid && Number(item.attr) !== 9)
    .filter((item) => Number(item.page) <= 1 || !item.page)
    .map((item, index) => ({
      key: `${item.bvid}-p1`,
      bvid: bocSafeString(item.bvid),
      aid: bocSafeString(item.id),
      cid: "",
      title: bocSafeString(item.title),
      parentTitle: `收藏夹-${mediaId}`,
      pageIndex: 1,
      pageCount: 1,
      index: index + 1,
      duration: Number(item.duration) || 0,
      url: `https://www.bilibili.com/video/${item.bvid}/`
    }));
  if (!items.length) {
    throw new Error("收藏夹为空或无法读取（可能需要登录）");
  }
  return { title: `收藏夹-${mediaId}`, source: "fav", seasonId: "", items };
}

/* ------------------------------------------------------------------ *
 * 单个视频的字幕抓取
 * ------------------------------------------------------------------ */

/** 优先挑选中文轨道（含 AI 字幕），否则取第一条 */
function bocPickTrack(tracks, preferredLang = "auto") {
  const list = (tracks || []).filter((item) => item.subtitleUrl);
  if (!list.length) return null;
  if (preferredLang && preferredLang !== "auto") {
    const exact = list.find((item) => String(item.lan || "").toLowerCase() === preferredLang.toLowerCase());
    if (exact) return exact;
  }
  const score = (item) => {
    const lan = String(item.lan || "").toLowerCase();
    let value = 0;
    if (lan.startsWith("zh")) value += 100;
    if (lan.includes("ai")) value += 20; // AI 中文字幕兜底能力更强
    if (lan === "zh-cn") value += 5;
    return value;
  };
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

function bocMapTracks(subtitles) {
  return (subtitles || []).map((item) => ({
    id: item?.id === undefined || item?.id === null ? "" : String(item.id),
    lan: bocSafeString(item?.lan),
    lanDoc: bocSafeString(item?.lan_doc),
    subtitleUrl: (() => {
      const url = bocSafeString(item?.subtitle_url).trim();
      if (!url) return "";
      return url.startsWith("//") ? `https:${url}` : url;
    })()
  }));
}

/** 获取某个 cid 的字幕轨道列表（player/wbi/v2 → player/v2 降级） */
async function bocFetchSubtitleTracks({ bvid, cid, aid }) {
  const safeBvid = encodeURIComponent(bvid || "");
  const safeCid = encodeURIComponent(cid || "");
  const safeAid = encodeURIComponent(aid || "");
  const urls = [];
  if (aid) {
    urls.push(
      "https://api.bilibili.com/x/player/wbi/v2" +
        `?aid=${safeAid}&cid=${safeCid}${bvid ? `&bvid=${safeBvid}` : ""}`
    );
  }
  urls.push(
    "https://api.bilibili.com/x/player/v2" +
      (bvid ? `?bvid=${safeBvid}` : "?") +
      `${bvid ? "&" : ""}cid=${safeCid}` +
      (aid ? `&aid=${safeAid}` : "")
  );

  let lastError = null;
  for (const url of urls) {
    try {
      const payload = await bocFetchJsonRetry(url, 1);
      const tracks = bocMapTracks(payload.data?.subtitle?.subtitles || []);
      return { tracks, chapters: payload.data?.view_points || [] };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("无法获取字幕列表");
}

async function bocFetchSubtitleBody(url) {
  // 字幕正文 JSON（aisubtitle.hdslb.com）没有 code 字段，不能用带 code 校验的重试包装；
  // 网络抖动时额外重试一次
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await bocSleep(900);
    }
    try {
      const payload = await bocFetchJson(url);
      const body = Array.isArray(payload.body)
        ? payload.body
        : Array.isArray(payload?.data?.body)
        ? payload.data.body
        : [];
      return body
        .map((item) => ({
          from: Number(item?.from) || 0,
          to: Number(item?.to) || 0,
          content: bocSafeString(item?.content).replace(/\r/g, "").trim()
        }))
        .filter((item) => item.content);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("字幕内容下载失败");
}

/** 补全 cid：正常情况下解析阶段就有；缺失时用 pagelist 兜底（轻量、不易风控） */
async function bocEnsureCid(item) {
  if (item.cid) return item.cid;
  try {
    const list = await bocFetchJsonRetry(
      `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(item.bvid)}&jsonp=jsonp`,
      1
    );
    const entries = Array.isArray(list.data) ? list.data : [];
    const page = Math.max(1, Number(item.pageIndex) || 1);
    const matched = entries.find((entry) => Number(entry?.page) === page) || entries[0];
    if (matched?.cid) {
      return bocSafeString(matched.cid);
    }
  } catch (error) {
    // 落入下方统一报错
  }
  return "";
}

/**
 * 抓取单个条目的字幕。
 * 返回 { ok, status: "ok"|"no-subtitle", tracks, track, body, cid, error }
 */
async function bocFetchItemSubtitle(item, options = {}) {
  const cid = await bocEnsureCid(item);
  if (!cid) {
    return { ok: false, status: "error", error: "缺少 cid，无法定位视频分 P" };
  }
  const { tracks } = await bocFetchSubtitleTracks({ bvid: item.bvid, cid, aid: item.aid });
  if (!tracks.length) {
    return { ok: false, status: "no-subtitle", cid, tracks: [], error: "该视频没有字幕轨" };
  }
  const track = bocPickTrack(tracks, options.subtitleLang || "auto");
  if (!track) {
    return { ok: false, status: "no-subtitle", cid, tracks, error: "该视频没有字幕轨" };
  }
  const body = await bocFetchSubtitleBody(track.subtitleUrl);
  if (!body.length) {
    return { ok: false, status: "no-subtitle", cid, tracks, error: "字幕内容为空" };
  }
  return { ok: true, status: "ok", cid, tracks, track, body };
}

/* ------------------------------------------------------------------ *
 * 内容格式化
 * ------------------------------------------------------------------ */

function bocBuildSrt(body) {
  return (body || [])
    .map((item, index) => {
      const text = bocSafeString(item.content).trim();
      const from = bocFormatTimestamp(item.from, true);
      const to = bocFormatTimestamp(item.to || item.from, true);
      return `${index + 1}\n${from} --> ${to}\n${text}`;
    })
    .join("\n\n");
}

function bocBuildTxt(body, { withTimestamp = true } = {}) {
  const maxTo = (body || []).reduce((max, item) => Math.max(max, Number(item?.to) || 0), 0);
  const withHours = maxTo >= 3600;
  return (body || [])
    .map((item) => {
      const text = bocSafeString(item.content).trim();
      if (!text) return "";
      if (!withTimestamp) return text;
      const safe = Math.max(0, Math.floor(Number(item.from) || 0));
      const hh = Math.floor(safe / 3600);
      const mm = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
      const ss = String(safe % 60).padStart(2, "0");
      return `[${withHours ? `${String(hh).padStart(2, "0")}:${mm}:${ss}` : `${String(
        Math.floor(safe / 60)
      ).padStart(2, "0")}:${ss}`}] ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

/** 生成与单视频保存一致的 Markdown 结构（frontmatter + 字幕正文） */
function bocBuildMarkdown(job, item, body, extra = {}) {
  const now = new Date();
  const created = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
  const uploadDate = Number(job.pubdate) > 0
    ? new Date(Number(job.pubdate) * 1000).toISOString().slice(0, 10)
    : "";
  const title = item.title || item.bvid;
  const lines = [
    "---",
    `title: "${String(title).replace(/"/g, '\\"')}"`,
    `bvid: "${item.bvid}"`,
    item.aid ? `aid: "${item.aid}"` : "",
    item.cid ? `cid: "${item.cid}"` : "",
    item.pageCount > 1 ? `p: ${item.pageIndex}` : "",
    job.author ? `author: "${String(job.author).replace(/"/g, '\\"')}"` : "",
    uploadDate ? `upload_date: "${uploadDate}"` : "",
    `source: "${item.url || ""}"`,
    `subtitle_lang: "${extra.lan || ""}"`,
    `created: "${created}"`,
    "tags:",
    "  - bilibili",
    "  - subtitle",
    job.source === "season" ? "  - collection" : "",
    "---",
    "",
    `# ${title}`,
    "",
    `> [!info] 视频信息`,
    `> - UP 主：${job.author || "未知"}`,
    `> - 链接：${item.url || ""}`,
    `> - 字幕语言：${extra.lanDoc || extra.lan || "未知"}`,
    item.pageCount > 1 ? `> - 分 P：${item.pageIndex} / ${item.pageCount}` : "",
    "",
    "## 字幕",
    ""
  ].filter((line) => line !== "");

  const withHours = (body || []).some((entry) => Number(entry?.to) >= 3600);
  for (const entry of body || []) {
    const safe = Math.max(0, Math.floor(Number(entry.from) || 0));
    const hh = Math.floor(safe / 3600);
    const mm = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
    const ss = String(safe % 60).padStart(2, "0");
    const stamp = withHours ? `${String(hh).padStart(2, "0")}:${mm}:${ss}` : `${String(Math.floor(safe / 60)).padStart(2, "0")}:${ss}`;
    lines.push(`\`${stamp}\` ${bocSafeString(entry.content).trim()}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 条目的导出文件名（不含扩展名）
 * naming: index-title（001-标题）/ title（标题）/ index（001）
 * 合集场景下同一父视频的多个分 P 会带 P 编号，避免重名覆盖。
 */
function bocBuildItemBaseName(item, naming = "index-title") {
  const order = Number(item.index) || 1;
  const pad = String(order).padStart(3, "0");
  const multiPage = Number(item.pageCount) > 1;
  const title = bocSanitizeName(item.title || item.bvid, item.bvid || "untitled", 60);
  const pageTag = multiPage ? `P${Number(item.pageIndex) || 1}-` : "";

  if (naming === "index") {
    return pad;
  }
  if (naming === "title") {
    return bocSanitizeName(`${pageTag}${title}`, title, 100);
  }
  return `${pad}-${pageTag}${title}`.slice(0, 110);
}

/* ------------------------------------------------------------------ *
 * 并发队列
 * ------------------------------------------------------------------ */

async function bocRunQueue(items, worker, { concurrency = 3, delayMs = 300, onProgress, signal } = {}) {
  const list = items || [];
  const size = Math.max(1, Math.min(8, Number(concurrency) || 3));
  let cursor = 0;
  let done = 0;
  const results = new Array(list.length);
  // 风控自适应：遇到 -352/-412 时自动放大间隔，成功后逐步恢复
  let currentDelay = delayMs;
  const RATE_LIMIT_RE = /风控|code -352|code -412|HTTP 412|HTTP 429/;

  const runOne = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      const item = list[index];
      try {
        results[index] = await worker(item, index);
      } catch (error) {
        try {
          console.error("[BOC批量] 条目处理失败", item?.key, error?.stack || error?.message || error);
        } catch {}
        results[index] = {
          key: item?.key,
          ok: false,
          status: "error",
          error: error?.message || String(error)
        };
      }
      done += 1;
      if (typeof onProgress === "function") {
        onProgress({ done, total: list.length, item, result: results[index] });
      }
      const result = results[index];
      if (result && result.status === "error" && RATE_LIMIT_RE.test(String(result.error || ""))) {
        currentDelay = Math.min(currentDelay * 2 + 500, 6000);
      } else if (result && result.ok) {
        currentDelay = Math.max(delayMs, Math.floor(currentDelay / 2));
      }
      if (done < list.length && (currentDelay > 0 || result?.status === "error")) {
        await bocSleep(currentDelay + Math.floor(Math.random() * 120));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(size, list.length || 1) }, runOne));
  return results;
}

/* ------------------------------------------------------------------ *
 * ZIP 打包（store 模式，无需第三方库；UTF-8 文件名标志位 0x0800）
 * ------------------------------------------------------------------ */

const BOC_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function bocCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = BOC_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function bocDosDateTime(date = new Date()) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dateValue =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, date: dateValue };
}

/**
 * 生成 ZIP 文件。
 * @param {Array<{path: string, content: string}>} entries
 * @returns {Uint8Array}
 */
function bocBuildZip(entries, now = new Date()) {
  const encoder = new TextEncoder();
  const { time, date } = bocDosDateTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries || []) {
    const nameBytes = encoder.encode(entry.path);
    const dataBytes =
      entry.content instanceof Uint8Array ? entry.content : encoder.encode(String(entry.content ?? ""));
    const crc = bocCrc32(dataBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 文件名
    lv.setUint16(8, 0, true); // store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    chunks.push(localHeader, dataBytes);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += localHeader.length + dataBytes.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const cd of central) {
    chunks.push(cd);
    cdSize += cd.length;
  }

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);
  chunks.push(end);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
}

/* ------------------------------------------------------------------ *
 * Obsidian 批量写入（沿用 Local REST API）
 * ------------------------------------------------------------------ */

async function bocWriteNote({ baseUrl, apiKey, filepath, content }) {
  const encodedPath = String(filepath)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const endpoint = `${String(baseUrl).replace(/\/+$/g, "")}/vault/${encodedPath}`;
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "text/markdown; charset=utf-8"
    },
    body: content
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${text ? ` ${text.slice(0, 120)}` : ""}`);
  }
}

async function bocNoteExists({ baseUrl, apiKey, filepath }) {
  const encodedPath = String(filepath)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await fetch(`${String(baseUrl).replace(/\/+$/g, "")}/vault/${encodedPath}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "text/markdown, */*" },
    cache: "no-store"
  });
  if (response.status === 404) return false;
  return response.ok;
}

/* ------------------------------------------------------------------ *
 * 任务存档（关闭批量页后仍可恢复）
 * ------------------------------------------------------------------ */

async function bocSaveJob(job) {
  try {
    await chrome.storage.local.set({
      [BOC_BATCH_STORAGE_KEY]: {
        input: job.input || "",
        options: job.options || {},
        title: job.title || "",
        resolvedAt: Date.now()
      }
    });
  } catch {}
}

async function bocLoadJob() {
  try {
    const data = await chrome.storage.local.get(BOC_BATCH_STORAGE_KEY);
    return data?.[BOC_BATCH_STORAGE_KEY] || null;
  } catch {
    return null;
  }
}

/* 暴露给 background 的消息处理器使用（同时便于在 SW 调试台手动调用） */
globalThis.BOCBatch = {
  parseTargets: bocParseTargets,
  resolveTarget: bocResolveTarget,
  getVideoInfo: bocGetVideoInfo,
  getSeasonEpisodes: bocGetSeasonEpisodes,
  fetchItemSubtitle: bocFetchItemSubtitle,
  fetchSubtitleTracks: bocFetchSubtitleTracks,
  fetchSubtitleBody: bocFetchSubtitleBody,
  pickTrack: bocPickTrack,
  buildSrt: bocBuildSrt,
  buildTxt: bocBuildTxt,
  buildMarkdown: bocBuildMarkdown,
  buildItemBaseName: bocBuildItemBaseName,
  buildZip: bocBuildZip,
  runQueue: bocRunQueue,
  writeNote: bocWriteNote,
  noteExists: bocNoteExists,
  saveJob: bocSaveJob,
  loadJob: bocLoadJob,
  sanitizeName: bocSanitizeName,
  formatDuration: bocFormatDuration,
  readInitialStateFromTabs: bocReadInitialStateFromTabs,
  defaults: BOC_BATCH_DEFAULT_OPTIONS
};
