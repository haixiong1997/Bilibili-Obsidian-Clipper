# Chrome / Firefox 打包方案

结论：源码目录只维护一份 MV3 `manifest.json`，打包时再生成 `chrome` 和 `firefox` 两套发布产物，避免在源文件里混写兼容字段。

## 方案说明

- 源文件：`extension/manifest.json`
- Chrome 包：移除 `browser_specific_settings`
- Firefox 包：保留 `browser_specific_settings.gecko`
- 两边都使用 MV3 的 `background.service_worker`

## 为什么这样做

- Chrome 会对 MV3 下的旧字段更严格，源文件里不应该继续保留 `background.scripts`
- Firefox 发布又需要 `browser_specific_settings.gecko.id`
- 把差异放到打包阶段，源码更干净，后续维护更稳

## 打包命令

在仓库根目录执行：

```bash
python3 scripts/build_release.py
```

## 打包产物

脚本会自动生成：

- `release/bilibili-obsidian-clipper-v<version>-chrome/`
- `release/bilibili-obsidian-clipper-v<version>-chrome.zip`
- `release/bilibili-obsidian-clipper-v<version>-firefox/`
- `release/bilibili-obsidian-clipper-v<version>-firefox.zip`

版本号取自 `extension/manifest.json` 的 `version`

## 建议发布流程

1. 先在源码目录完成功能修改
2. Chrome 本地重新加载 `extension/`
3. Firefox 临时加载 `extension/manifest.json`
4. 两边各做一轮核心回归：抓字幕、下载、写入 Obsidian
5. 执行 `python3 scripts/build_release.py`
6. 上传对应浏览器的 zip 包到 release 或应用商店

## 最低验证清单

- Chrome 扩展页不再出现 `background.scripts` 的 MV3 警告
- 普通视频页可正常抓字幕
- `watchlater` 页面可正常抓字幕
- 多分P视频保存到 Obsidian 不再互相覆盖
