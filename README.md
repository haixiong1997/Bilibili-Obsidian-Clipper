# Bilibili Obsidian Clipper（FNS 增强版）

> 本仓库是 [haixiong1997/Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper) 的 fork 增强版，在原版基础上新增了 **Fast Note Sync（FNS）服务器直存** 与 **批量抓取（合集 / 多 P）** 功能。
> 原项目版权归原作者所有（MIT License）。

在 B 站视频页抓取字幕，预览后可复制 Markdown、下载字幕文件，并一键保存到 Obsidian（Local REST API）**或直接写入 Fast Note Sync 服务器同步项目**（无需本地 Obsidian）。

## 相比原版新增的功能

| 功能 | 说明 |
| --- | --- |
| **保存到 FNS** | 把字幕笔记直接写入 Fast Note Sync Service 服务器上的同步项目，本地不开 Obsidian 也能用 |
| **批量抓取（合集 / 多 P）** | 自动识别合集（ugc_season）/ 多 P / 单集，一次性批量抓取选中的分集字幕，合并保存到同一篇 Markdown 笔记 |
| **批量保存到 FNS** | 批量抓取的字幕可直接保存到 FNS 服务器 |
| **测试 FNS 连接** | 设置页新增独立按钮，验证 FNS 地址 / Token / Vault 是否可用 |

## 与原版的差异

- **设置页**：新增「Fast Note Sync（服务器直存）」配置区块（服务地址 / API Token / Vault 名 / 客户端类型），以及「测试 FNS 连接」按钮
- **视频面板 / popup**：新增「保存到 FNS」绿色按钮、「批量抓取（合集 / 多 P）」按钮
- **批量视图**：分集列表（勾选 / 全选 / 全不选）、逐集抓取进度条、「批量保存到 Obsidian / FNS」两个按钮

## FNS 配置

在扩展设置页填写：

| 字段 | 说明 |
| --- | --- |
| FNS 服务地址 | 例如 `http://你的服务器IP:9000` |
| FNS API Token | FNS 管理后台右上角「Copy API Config」复制的 Token |
| Vault 名 | 后台「Note Vaults」里目标库名，例如 `项目文章` |
| 客户端类型 | 默认 `ObsidianPlugin`，须与 Token 绑定的一致；填错返回 315/314 |

## 技术说明

- FNS 请求在 `background.js` 的 service worker 中发起（不受 CORS 限制）。
- FNS 对业务错误一律返回 HTTP 200，错误码在 body：`430`=笔记不存在、`315`=scope 受限、`314`=客户端受限、`414`=vault 不存在、`507`=未登录。
- 每个请求带 `x-client` 头，值取设置里的「客户端类型」（默认 ObsidianPlugin）。
- `fnsToken` 存 `chrome.storage.local`（敏感信息不同步），其余配置存 `chrome.storage.sync`。
- 批量抓取的合集识别、分集字幕抓取、合并 Markdown 生成，逻辑来自 [PR #22](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper/pull/22)（作者 zwang-zwang）。

## 安装（开发模式）

1. 下载本仓库 zip，解压后进入 `extension/` 目录
2. Edge 打开 `edge://extensions/`（Chrome 用 `chrome://extensions/`），开启「开发人员模式」
3. 点「加载解压缩的扩展」→ 选择 `extension/` 目录
4. 打开扩展设置页，填写 FNS 配置后「保存设置」→「测试 FNS 连接」

> 注意：不要用「拖拽 zip 到扩展页」的方式安装，Edge 解压 zip 会破坏目录结构导致图标加载失败。

## 免责声明

本工具仅在用户已登录 B 站、且有访问权限的前提下获取数据。所有数据通过用户自己的浏览器和 cookie 获取，不经过任何第三方服务器。本工具不存储、不分发任何 B 站内容。使用本工具产生的所有后果由用户自行承担。

## 开发说明

本分支的 **Fast Note Sync（FNS）直存** 与 **批量抓取适配** 部分，由 AI 编程助手 **Claude Code** 辅助编写（含 FNS API 对接、批量流程编排、UI 集成等）。

## 致谢

- [Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper) 原作者 haixiong1997
- [PR #22 批量抓取功能](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper/pull/22) 作者 zwang-zwang
