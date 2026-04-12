# Bilibili Obsidian Clipper

[![GitHub all releases downloads](https://img.shields.io/github/downloads/haixiong1997/Bilibili-Obsidian-Clipper/total?style=flat-square)](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper/releases)

在 B 站视频页抓取字幕，预览后可复制 Markdown、下载字幕文件，并一键写入 Obsidian（Local REST API）。

## 功能

- B 站视频字幕抓取（自动识别当前分 P）
- 字幕预览、复制 Markdown
- 下载字幕文件（`srt/txt`）
- 保存到 Obsidian（Local REST API）

## 安装方式

1. 在 GitHub 的 `Releases` 页面下载最新 zip 包
2. 解压到任意本地目录
3. 打开扩展管理页：
   - Chrome：`chrome://extensions/`
   - Edge：`edge://extensions/`
4. 开启“开发者模式”
5. 点击“加载已解压的扩展程序”
6. 选择解压后的扩展目录

## 项目结构

- `README.md` / `LICENSE`：项目说明与许可证
- `extension/`：插件源码（manifest、js、css、icons）

## Obsidian 配置

1. 在 Obsidian 社区插件市场安装并启用 `Local REST API`
2. 在插件设置中勾选 `Enable Non-encrypted (HTTP) Server`
3. 复制插件页面里的 API Key
4. 在扩展设置页填写 `Local REST API 地址`、`API Key`、`笔记目录`

## 使用方式

1. 打开任意 B 站视频页并点击扩展图标
2. 面板会自动抓取并展示字幕
3. 按需点击 `刷新 / 复制 / 下载 / 保存到 Obsidian`

## 视频教程

- [B 站教程](https://www.bilibili.com/video/BV15qQwB4EZ9/?spm_id_from=333.1387.homepage.video_card.click&vd_source=040bc5ea7866b419558ec2682a2ccb59)
