# Bilibili Obsidian Clipper｜一键保存B站字幕

[![GitHub all releases downloads](https://img.shields.io/github/downloads/haixiong1997/Bilibili-Obsidian-Clipper/total?style=flat-square&logo=github&label=downloads)](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper/releases)
[![Chrome Web Store users](https://img.shields.io/chrome-web-store/users/jokophbofiphenlplmohabdcmalcbenl?style=flat-square&logo=google-chrome&logoColor=white&label=chrome)](https://chromewebstore.google.com/detail/jokophbofiphenlplmohabdcmalcbenl)
[![GitHub release](https://img.shields.io/github/v/release/haixiong1997/Bilibili-Obsidian-Clipper?style=flat-square&label=version)](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper/releases)

推荐官方插件市场下载：[Chrome](https://chromewebstore.google.com/detail/jokophbofiphenlplmohabdcmalcbenl?utm_source=item-share-cb) · [Edge](https://microsoftedge.microsoft.com/addons/detail/fbeeapnjdjgacilaobonekidbfjcmdjo) · [Firefox](https://addons.mozilla.org/addon/bilibili-obsidian-clipper/)

在 B 站视频页抓取字幕，预览后可复制 Markdown、下载字幕文件，并一键写入 Obsidian（Local REST API）。

> 注意：仅支持获取“有字幕轨”的 B 站视频字幕（播放器里有「字幕」选项，通常表示作者上传了外挂字幕或平台提供了 AI 字幕）；没有字幕轨的视频无法获取字幕。

## 功能

- B 站视频字幕抓取（自动识别当前分 P）
- **合集 / 多 P 字幕批量下载（v1.2.0+，见下文）**
- 字幕预览、复制 Markdown
- 下载字幕文件（`srt/txt`）
- 保存到 Obsidian（Local REST API）

## 合集 / 多 P 字幕批量下载（v1.2.0+）

新增独立的批量下载管理页，可一次性抓取整个合集、收藏夹或多 P 视频的字幕。

### 支持的输入

- 单视频 / 多 P 链接：`https://www.bilibili.com/video/BVxxxx/?p=2`
- UP 主合集：`https://space.bilibili.com/<mid>/channel/collectiondetail?sid=<合集id>`
- 番剧 / 课程：`ep` 链接或 `ss` 链接
- 收藏夹：`https://space.bilibili.com/<mid>/favlist?fid=<收藏夹id>`
- 支持一次粘贴多行，每行一个链接

### 使用步骤

1. 在任意 B 站视频页点击扩展图标，选择「批量下载合集字幕」（或直接打开扩展的 `batch.html` 页面）
2. 粘贴链接并点击「解析列表」，勾选需要下载的视频
3. 可选：导出格式（SRT / TXT / Markdown）、字幕语言、文件名规则、并发数与请求间隔
4. 点击「开始抓取字幕」，等待进度完成（无字幕 / 失败的条目可单独重试）
5. 点击「下载 ZIP」导出打包文件（附带 `00-索引.md` 索引），或「写入 Obsidian」批量落盘

### 说明

- 抓取完全复用当前浏览器的 B 站登录态，不经过任何第三方服务器；AI 字幕需要登录后才能获取
- 并发数 / 请求间隔可在页面里调整，遇到风控（-352 / -412）时请调低并发、拉长间隔后重试失败项
- 「写入 Obsidian」复用设置页中的 Local REST API 配置，默认跳过已存在的笔记

### 阅读视图（v1.0.18+）

沉浸式布局，支持排版调整、主题切换、字幕同步等。

> 稍后再看页面的阅读视图体验尚不完善，推荐在普通视频页使用。

### AI 侧边栏（v1.1.0+）

支持围绕当前视频字幕进行轻量对话，也可在普通网页中作为通用 AI 对话侧边栏使用。

内置历史对话、预设提示词、模型切换等能力，适合快速总结、整理与提炼视频内容。

## 功能图片演示

![Bilibili Obsidian Clipper 功能演示](docs/images/feature-demo-v2.png)

![Bilibili Obsidian Clipper AI 侧边栏演示](docs/images/33.png)

## 安装方式

### 升级说明

- Chrome / Edge：如果是从 GitHub 手动下载安装包升级，建议直接替换原扩展目录中的文件，并在扩展管理页点击“重新加载”；不要先移除旧扩展，否则本地设置、AI 历史对话和已保存的 Key 可能会丢失。
- Firefox：当前为“临时加载附加组件”方式，更适合开发调试使用；重新移除并加载新版本后，本地设置和 AI 历史对话可能不会保留。

### Chrome / Edge

1. 在 GitHub 的 `Releases` 页面下载最新的 `*-chrome.zip` 包（Edge 用户下载 `*-edge.zip`，内附 `EDGE-INSTALL.txt` 安装说明；Edge 亦可直接使用 `*-chrome.zip`）
2. 解压到任意本地目录
3. 打开扩展管理页：
   - Chrome：`chrome://extensions/`
   - Edge：`edge://extensions/`
4. 开启"开发者模式"
5. 点击"加载已解压的扩展程序"
6. 选择解压后的扩展目录

### Firefox

1. 在 GitHub 的 `Releases` 页面下载最新的 `*-firefox.zip` 包
2. 解压到任意本地目录
3. 打开 Firefox 附加组件管理页：`about:addons`
4. 点击右上角齿轮图标 → "调试附加组件"
5. 点击"临时加载附加组件..."
6. 选择解压后的文件夹中的 `manifest.json` 文件

## 项目结构

- `README.md` / `LICENSE`：项目说明与许可证
- `extension/`：插件源码（manifest、js、css、icons）
  - `batch-core.js`：批量下载核心（合集解析、并发队列、ZIP 打包）
  - `batch.html` / `batch.js` / `batch.css`：批量下载管理页
  - `background.js`：后台（含批量任务调度与消息路由）

## 用自己的 Agent 二次修改

这个项目是开源浏览器扩展，您可以下载源码，让自己的 AI 编程 Agent 按个人工作流修改功能。

推荐步骤：

1. 在 GitHub 页面点击 `Code` → `Download ZIP`，或使用 `git clone` 下载源码
2. 用 Cursor、Codex、Claude Code 等 AI 编程工具打开项目文件夹
3. 把想修改的功能描述清楚，例如：
   - “把默认保存目录改成我的 Obsidian 目录结构”
   - “新增一个 frontmatter 属性”
   - “调整 AI 初始问题和保存笔记格式”
4. 修改完成后，在浏览器扩展管理页选择 `extension/` 文件夹进行本地加载
5. 打开 B 站视频页测试字幕抓取、AI 对话和 Obsidian 写入是否正常

建议先在本地测试确认无误，再替换日常使用的扩展版本。修改源码前也建议保留一份原始版本，方便出现问题时回退。

## Obsidian 配置

1. 在 Obsidian 社区插件市场安装并启用 `Local REST API with MCP`
2. 在插件设置中勾选 `Enable Non-encrypted (HTTP) Server`
3. 复制插件页面里的 API Key
4. 在扩展设置页填写 `Local REST API 地址`、`API Key`、`笔记目录`

## 使用方式

1. 打开任意 B 站视频页并点击扩展图标
2. 面板会自动抓取并展示字幕
3. 按需点击 `刷新 / 复制 / 下载 / 保存到 Obsidian`

## 视频教程

- [B 站教程](https://www.bilibili.com/video/BV15qQwB4EZ9/?spm_id_from=333.1387.homepage.video_card.click&vd_source=040bc5ea7866b419558ec2682a2ccb59)

## 支持开发者

如果这个项目对您有帮助，欢迎微信打赏支持我的开发工作。您的支持是我持续改进和维护这个项目的动力。

<img src="docs/images/weixin.jpg" alt="微信扫码支持开发者" width="264" />

## 免责声明

> ▎ **用户自负责任条款**：本工具仅在用户已登录 B 站、且有访问权限的前提下获取数据。所有数据通过用户自己的浏览器和 cookie 获取，不经过任何第三方服务器。本工具不存储、不分发任何 B 站内容。使用本工具产生的所有后果由用户自行承担。请遵守 B 站用户协议与相关法律法规。
