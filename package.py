import zipfile
from pathlib import Path

ROOT = Path(__file__).parent
DIST = ROOT / "dist"
OUTPUT = DIST / "extension.zip"

# Anything that should NOT end up in the shipped extension
EXCLUDE_DIRS = {".git", ".idea", ".vscode", "dist", "__pycache__", ".venv"}
EXCLUDE_FILES = {"package.py", ".gitignore", "README.md", "LICENSE"}


def should_include(path: Path) -> bool:
    if any(part in EXCLUDE_DIRS for part in path.parts):
        return False
    if path.name in EXCLUDE_FILES:
        return False
    return True


def main() -> None:
    DIST.mkdir(exist_ok=True)
    if OUTPUT.exists():
        OUTPUT.unlink()

    with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as zf:
        count = 0
        for path in ROOT.rglob("*"):
            if path.is_file() and should_include(path.relative_to(ROOT)):
                zf.write(path, path.relative_to(ROOT))
                count += 1

    print(f"Wrote {OUTPUT} ({count} files)")


if __name__ == "__main__":
    main()
