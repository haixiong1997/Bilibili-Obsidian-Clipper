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


def build_variant(manifest: dict, browser: str, version: str):
    release_folder = RELEASE_DIR / f"{PACKAGE_NAME}-v{version}-{browser}"
    zip_path = RELEASE_DIR / f"{PACKAGE_NAME}-v{version}-{browser}.zip"

    prepare_release_dir(release_folder)

    variant_manifest = json.loads(json.dumps(manifest))
    if browser == "chrome":
      variant_manifest.pop("browser_specific_settings", None)
    elif browser == "firefox":
      gecko = variant_manifest.setdefault("browser_specific_settings", {}).setdefault("gecko", {})
      gecko.setdefault("id", "bilibili-obsidian-clipper@github.com")
      gecko.setdefault("strict_min_version", "109.0")
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
        build_variant(manifest, "firefox", version),
    ]

    print(f"Built release packages for v{version}:")
    for folder, zip_path in built:
        print(f"- dir: {folder}")
        print(f"  zip: {zip_path}")


if __name__ == "__main__":
    main()
