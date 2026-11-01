#!/usr/bin/env python3
import json
import shutil
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT / "extension"
RELEASE_DIR = ROOT / "release"
MANIFEST_PATH = EXTENSION_DIR / "manifest.json"
PACKAGE_NAME = "bilibili-obsidian-clipper"


def load_manifest():
    with MANIFEST_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def dump_manifest(path: Path, data: dict):
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def prepare_release_dir(path: Path):
    if path.exists():
        shutil.rmtree(path)
    shutil.copytree(EXTENSION_DIR, path)


def disable_firefox_player_ai_quick_action(release_folder: Path):
    options_css = release_folder / "options.css"
    if options_css.exists():
        with options_css.open("a", encoding="utf-8") as fh:
            fh.write(
                "\n/* Firefox uses the built-in extension sidebar entry; hide the page-level AI quick button setting. */\n"
                ".player-ai-quick-action-settings { display: none !important; }\n"
            )

    background_js = release_folder / "background.js"
    if background_js.exists():
        source = background_js.read_text(encoding="utf-8")
        source = source.replace(
            "function normalizeEnablePlayerAiQuickAction(value) {\n  return value === true;\n}",
            "function normalizeEnablePlayerAiQuickAction(_value) {\n  return false;\n}",
        )
        background_js.write_text(source, encoding="utf-8")


EDGE_INSTALL_NOTE = """Edge 安装说明（开发者模式加载）

1. 解压本 zip 到任意目录
2. 打开 edge://extensions/
3. 打开左下角「开发人员模式」开关
4. 点击「加载解压缩的扩展」，选择解压后的文件夹
5. 打开任意 B 站视频页，点击工具栏中的扩展图标即可使用

打包提交到 Edge 商店（Microsoft Partner Center）时，可直接上传本 zip。
"""

def build_variant(manifest: dict, browser: str, version: str):
    release_folder = RELEASE_DIR / f"{PACKAGE_NAME}-v{version}-{browser}"
    zip_path = RELEASE_DIR / f"{PACKAGE_NAME}-v{version}-{browser}.zip"

    prepare_release_dir(release_folder)

    variant_manifest = json.loads(json.dumps(manifest))
    if browser in ("chrome", "edge"):
        variant_manifest.pop("browser_specific_settings", None)
        variant_manifest.pop("sidebar_action", None)
        background = variant_manifest.setdefault("background", {})
        background.pop("scripts", None)
        background["service_worker"] = "background.js"
        # 批量下载核心模块通过 importScripts 在 worker 内加载（见 background.js 顶部）
        if browser == "edge":
            note = release_folder / "EDGE-INSTALL.txt"
            note.write_text(EDGE_INSTALL_NOTE, encoding="utf-8")
    elif browser == "firefox":
        gecko = variant_manifest.setdefault("browser_specific_settings", {}).setdefault("gecko", {})
        gecko.setdefault("id", "bilibili-obsidian-clipper@github.com")
        gecko.setdefault("strict_min_version", "109.0")
        permissions = variant_manifest.get("permissions", [])
        if isinstance(permissions, list):
            variant_manifest["permissions"] = [item for item in permissions if item != "sidePanel"]
        variant_manifest.pop("side_panel", None)
        variant_manifest["sidebar_action"] = {
            "default_title": "Bilibili Obsidian Clipper",
            "default_icon": {
                "16": "icons/icon16.png",
                "32": "icons/icon32.png",
                "48": "icons/icon48.png"
            },
            "default_panel": "sidepanel.html",
            "open_at_install": False
        }
        background = variant_manifest.setdefault("background", {})
        background.pop("service_worker", None)
        background["scripts"] = ["background.js"]
        disable_firefox_player_ai_quick_action(release_folder)
    else:
        raise ValueError(f"Unsupported browser: {browser}")

    dump_manifest(release_folder / "manifest.json", variant_manifest)

    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(release_folder.rglob("*")):
            if file_path.is_dir():
                continue
            archive.write(file_path, file_path.relative_to(release_folder))

    return release_folder, zip_path


def main():
    manifest = load_manifest()
    version = str(manifest.get("version") or "").strip()
    if not version:
        raise SystemExit("manifest.json is missing a version")

    RELEASE_DIR.mkdir(parents=True, exist_ok=True)

    built = [
        build_variant(manifest, "chrome", version),
        build_variant(manifest, "edge", version),
        build_variant(manifest, "firefox", version),
    ]

    print(f"Built release packages for v{version}:")
    for folder, zip_path in built:
        print(f"- dir: {folder}")
        print(f"  zip: {zip_path}")


if __name__ == "__main__":
    main()
