"""Archives attached in chat are read in memory with size/ratio caps (no zip bombs, no disk writes)."""
import io
import os
import sys
import tarfile
import zipfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.routers.pdf import ARCHIVE_MAX_RATIO, _extract_archive  # noqa: E402


def zip_bytes(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def main():
    text, listing = _extract_archive("proj.zip", zip_bytes({
        "src/app.js": "console.log('hi')\n",
        "README.md": "# Demo\n",
        "logo.png": b"\x89PNG\r\n\x1a\n\x00\x00binary",
        "__MACOSX/._app.js": "junk",
        ".env": "SECRET=1",
    }))
    assert listing == ["src/app.js", "README.md"], listing
    assert "=== src/app.js ===" in text and "console.log" in text
    assert "SECRET" not in text, "dotfiles are skipped"
    assert "skipped" in text.splitlines()[0]

    bomb = zip_bytes({"big.txt": "a" * (ARCHIVE_MAX_RATIO * 20_000)})
    text, listing = _extract_archive("bomb.zip", bomb)
    assert listing == [], "high-ratio member must be refused"

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        data = b"print('tar ok')\n"
        info = tarfile.TarInfo("pkg/main.py")
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
    text, listing = _extract_archive("pkg.tar.gz", buf.getvalue())
    assert listing == ["pkg/main.py"] and "tar ok" in text
    print("PASS: archives read in memory; binaries/dotfiles skipped; zip bombs refused")


if __name__ == "__main__":
    main()
