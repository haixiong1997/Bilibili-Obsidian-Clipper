# Bilibili Obsidian Clipper

在 B 站视频页抓取字幕，预览后可复制 Markdown、下载字幕文件，并一键写入 Obsidian（Local REST API）。

## 功能

- B 站视频字幕抓取（自动识别当前分 P）
- 字幕预览、复制 Markdown
- 下载字幕文件（`srt/txt`）
- 保存到 Obsidian（Local REST API）

## 安装方式

### 方式 A：从 Release 安装（推荐）

1. 下载发布包：`release/bilibili-obsidian-clipper-v1.0.10.zip`
2. 解压到任意本地目录
3. 打开 `chrome://extensions/`
4. 开启“开发者模式”
5. 点击“加载已解压的扩展程序”
6. 选择刚刚解压后的目录

### 方式 B：从源码安装

1. 打开 `chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本目录 `bilibili-obsidian-clipper`

## Obsidian 配置

1. 在 Obsidian 社区插件市场安装并启用 `Local REST API`
2. 在插件设置中勾选 `Enable Non-encrypted (HTTP) Server`
3. 复制插件页面里的 API Key
4. 在扩展设置页填写 `Local REST API 地址`、`API Key`、`笔记目录`

## 使用方式

1. 打开任意 B 站视频页并点击扩展图标
2. 面板会自动抓取并展示字幕
3. 按需点击 `刷新 / 复制 / 下载 / 保存到 Obsidian`
