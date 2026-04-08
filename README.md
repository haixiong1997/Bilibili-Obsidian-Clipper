# Bilibili Obsidian Clipper

在 B 站视频页抓取字幕，预览后复制 Markdown / 下载 SRT / 直写到 Obsidian（Local REST API）。

## 功能概览

- 适用页面：`https://www.bilibili.com/video/*`
- 自动解析并抓取：`title / url / bvid / cid / author / upload_date / description`
- 自动发现多语言字幕轨，默认优先中文、其次英文
- 支持章节抓取（若视频返回 `view_points`）
- 导出 Markdown 结构：
  - Frontmatter（可在设置页勾选字段）
  - B 站 iframe 嵌入
  - `## 简介`
  - `## 章节`
  - `## 字幕`（按章节拆分成 `### 章节名`）
- 时间戳格式（Markdown）：
  - 用反引号包裹：如 `` `00:07` ``
  - 视频时长 < 1h：`mm:ss`
  - 视频时长 >= 1h：`hh:mm:ss`

## 本地加载

1. 打开 `chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本目录 `bilibili-obsidian-clipper`

## Obsidian 配置

1. 安装并启用 Obsidian 的 Local REST API 插件
2. 打开本扩展设置页，填写：
   - `Local REST API 地址`（默认 `http://127.0.0.1:27123`）
   - `Local REST API Key`
   - `笔记目录`（如 `Clippings/Bilibili`）
   - `默认 tags`
   - `下载格式`（`srt` 或 `txt`，默认 `srt`）
   - `Frontmatter 字段勾选`
3. `Local REST API Key` 仅保存到当前浏览器本地（`chrome.storage.local`），不会走 Chrome 同步

## 使用流程

1. 打开 B 站视频页
2. 点击扩展图标，弹出面板会自动抓取
3. 可切换字幕语言并预览
4. 选择操作：
   - `刷新`
   - `复制`
   - `下载`
   - `保存到 Obsidian`

## 字幕抓取机制（实现要点）

1. 从 URL 提取 `bvid` 和分 P 参数 `p`
2. 调 `x/web-interface/view` 获取 `aid / cid / pages / description`
3. 根据 `p` 精准定位当前 `cid`
4. 依次请求：
   - `x/player/wbi/v2`
   - `x/player/v2`
5. 读取字幕轨 `subtitle.subtitles`，并提取章节 `view_points`
6. 选轨后拉取字幕 JSON（带重试 + 缓存）
7. 用视频时长和字幕时长做校验，避免串轨

## 写入 Obsidian 机制

1. 在内容脚本中构建 Markdown
2. 发送到 background
3. background 使用 `PUT {baseUrl}/vault/{filepath}` 写入
4. Header 使用 `Authorization: Bearer <API_KEY>`

## 调试建议

1. 每次改代码后先在 `chrome://extensions/` 点“重新加载”
2. 再刷新 B 站视频页
3. 设置页可手动开启“调试日志（仅在排查问题时开启）”，默认关闭
4. 打开视频页 DevTools，查看前缀为 `[BOC]` 的日志
5. 常见失败点：
   - 视频本身无字幕
   - 字幕接口临时限流
   - Local REST API 地址或 Key 错误

## 已知限制

- 不是所有视频都有字幕
- 不是所有视频都有章节
- 部分字幕需要登录态
