# Chrome Web Store 上架文案（可直接复制）

## 插件名称

Bilibili Obsidian Clipper

## 简短描述（Short description）

在 B 站视频页一键抓取字幕，支持预览、复制、下载，并可直写到 Obsidian。

## 详细描述（Detailed description）

Bilibili Obsidian Clipper 是一个面向知识管理与内容整理的浏览器扩展。  
它会在 Bilibili 视频页面自动识别当前视频与分 P，抓取可用字幕并提供结构化导出。

主要功能：

- 自动识别当前视频（BVID/CID/分 P）并抓取字幕
- 多字幕轨切换，默认优先中文
- 字幕预览、复制 Markdown、下载字幕文件（SRT/TXT）
- 可将整理后的内容写入 Obsidian（通过 Local REST API）
- 可在设置中控制 Frontmatter 字段与导出行为

适合场景：

- 课程与讲座笔记整理
- 视频内容摘录与复盘
- 构建个人知识库（PKM）

## 分类建议（Category）

Productivity

## 隐私与权限说明（用于 Privacy Tab）

Single purpose（单一用途）：

本扩展的唯一用途是在 Bilibili 视频页提取字幕并导出到本地笔记工作流（复制、下载或写入 Obsidian）。

权限用途说明：

- `storage`：保存用户设置（如 API 地址、导出格式、字段勾选）
- `tabs`：读取当前标签页视频 URL，用于识别当前视频与分 P
- `https://www.bilibili.com/*`：仅在视频页运行内容脚本
- `https://api.bilibili.com/*` 与 `https://*.hdslb.com/*`：获取视频与字幕数据
- `http://127.0.0.1/*` / `https://127.0.0.1/*` / `http://localhost/*` / `https://localhost/*`：仅用于连接用户本机 Obsidian Local REST API

数据处理声明（建议按实际在后台勾选）：

- 不出售用户数据
- 不将用户数据用于广告
- 不将用户数据用于与扩展核心功能无关的目的
- 不将数据传输到开发者自有远端服务器
- API Key 仅保存在浏览器本地存储中

## 审核测试说明（Test instructions）

1. 打开任意 Bilibili 视频页（`https://www.bilibili.com/video/*`）。
2. 点击扩展图标，等待自动抓取字幕。
3. 验证可执行：字幕切换、复制、下载。
4. 如需测试 Obsidian 写入：
   - 在 Obsidian 安装并启用 Local REST API
   - 开启 HTTP Server，并将地址与 API Key 填入扩展设置
   - 点击“保存到 Obsidian”验证写入成功

