"""Create deterministic extension and source archives using Python's standard library."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
DIST = ROOT / "dist"
EXCLUDE = {"node_modules", ".git", ".tools", "dist", "__pycache__", "test-results"}

def archive(target, entries):
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for path, name in sorted(entries, key=lambda item: item[1]):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            output.writestr(info, path.read_bytes(), compresslevel=9)

manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
assert not manifest.get("host_permissions")
assert not manifest.get("content_scripts")
for entry in ("background.js", "index.html", "app.js", "model.js", "style.css",
              "privacy.html", "icons/16.png", "icons/32.png", "icons/48.png", "icons/128.png"):
    assert (EXT / entry).is_file(), f"Missing: {entry}"
DIST.mkdir(exist_ok=True)
version = manifest["version"]
package = DIST / f"Twinkle-{version}-chrome.zip"
source = DIST / f"Twinkle-{version}-source.zip"
archive(package, [(path, path.relative_to(EXT).as_posix()) for path in EXT.rglob("*") if path.is_file()])
archive(source, [(path, path.relative_to(ROOT).as_posix()) for path in ROOT.rglob("*")
                 if path.is_file() and not any(part in EXCLUDE for part in path.relative_to(ROOT).parts)
                 and not path.name.startswith(".env") and path.suffix not in (".pem", ".pyc")])
lines = []
for path in (package, source):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    lines.append(f"{digest}  {path.name}")
    print(f"{path.name}: {path.stat().st_size} bytes, SHA256 {digest}")
(DIST / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
