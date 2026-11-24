"""Compare PDF extraction between the base commit (PyMuPDF) and the current checkout (pypdfium2).

Usage (from worker/):
    uv run python scripts/compare_pdf_extractors.py ../.claude/skills/verify-fama/fixtures/harbour-notes.pdf paper.pdf

By default the old extractor is loaded from git commit `34522b1` and run in an ephemeral
`uv run --with pymupdf` environment, so the current project needs no PyMuPDF dependency.
"""

from __future__ import annotations

import argparse
import difflib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

BASE_COMMIT = "34522b1"
OLD_PDF_PATH = "worker/src/fama_worker/extract/pdf.py"

_OLD_RUNNER = """
import importlib.util, json, sys
from pathlib import Path

old_source = Path(sys.argv[1])
paths = [Path(p) for p in sys.argv[2:]]

spec = importlib.util.spec_from_file_location("_old_fama_pdf", old_source)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

out = {}
for path in paths:
    try:
        doc = mod.extract_pdf(path)
        out[str(path)] = {
            "error": None,
            "title": doc.title,
            "author": doc.author,
            "chapters": [{"title": c.title, "text": c.text} for c in doc.chapters],
        }
    except Exception as exc:
        out[str(path)] = {"error": f"{type(exc).__name__}: {exc}"}
print(json.dumps(out, ensure_ascii=False))
"""


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _run_old(base_ref: str, paths: list[Path]) -> dict[str, dict]:
    root = _repo_root()
    source = subprocess.check_output(
        ["git", "-C", str(root), "show", f"{base_ref}:{OLD_PDF_PATH}"],
        text=True,
    )
    with tempfile.TemporaryDirectory() as tmp:
        old_file = Path(tmp) / "old_pdf.py"
        old_file.write_text(source, encoding="utf-8")
        cmd = [
            "uv",
            "run",
            "--no-project",
            "--python",
            "3.12",
            "--with",
            "pymupdf>=1.25",
            "python",
            "-c",
            _OLD_RUNNER,
            str(old_file),
            *(str(p.resolve()) for p in paths),
        ]
        env_prefix = str(root / "worker" / "src")
        import os

        env = os.environ.copy()
        env["PYTHONPATH"] = env_prefix + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True, env=env)
    return json.loads(proc.stdout)


def _run_new(paths: list[Path]) -> dict[str, dict]:
    from fama_worker.extract.pdf import extract_pdf

    out: dict[str, dict] = {}
    for path in paths:
        resolved = path.resolve()
        try:
            doc = extract_pdf(resolved)
            out[str(resolved)] = {
                "error": None,
                "title": doc.title,
                "author": doc.author,
                "chapters": [{"title": c.title, "text": c.text} for c in doc.chapters],
            }
        except Exception as exc:
            out[str(resolved)] = {"error": f"{type(exc).__name__}: {exc}"}
    return out


def _diff_snippet(old_text: str, new_text: str, max_lines: int) -> list[str]:
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    diff = list(difflib.unified_diff(old_lines, new_lines, fromfile="old", tofile="new", lineterm="", n=1))
    if max_lines > 0 and len(diff) > max_lines:
        return diff[:max_lines] + [f"... ({len(diff) - max_lines} more diff lines)"]
    return diff


def _compare_one(path: Path, old: dict, new: dict, max_diff_lines: int) -> None:
    print(f"\n{'=' * 72}")
    print(f"PDF: {path.name} ({path})")
    print(f"{'=' * 72}")
    if old.get("error") or new.get("error"):
        print(f"  ERROR old={old.get('error')!r} | new={new.get('error')!r}")
        return

    for field in ("title", "author"):
        o, n = old[field], new[field]
        if o == n:
            print(f"  {field:8}: SAME  {n!r}")
        else:
            print(f"  {field:8}: DIFF")
            print(f"    old: {o!r}")
            print(f"    new: {n!r}")

    old_chapters = old["chapters"]
    new_chapters = new["chapters"]
    old_titles = [c["title"] for c in old_chapters]
    new_titles = [c["title"] for c in new_chapters]
    if old_titles == new_titles:
        print(f"  chapters: SAME ({len(new_chapters)}) {new_titles}")
    else:
        print(f"  chapters: DIFF (old={len(old_chapters)}, new={len(new_chapters)})")
        print(f"    old: {old_titles}")
        print(f"    new: {new_titles}")

    # Pair chapters by index when counts match, else by title.
    pairs: list[tuple[str, str, str]] = []
    if len(old_chapters) == len(new_chapters):
        for oc, nc in zip(old_chapters, new_chapters):
            label = nc["title"] if oc["title"] == nc["title"] else f"{oc['title']} -> {nc['title']}"
            pairs.append((label, oc["text"], nc["text"]))
    else:
        new_by_title = {c["title"]: c["text"] for c in new_chapters}
        for oc in old_chapters:
            if oc["title"] in new_by_title:
                pairs.append((oc["title"], oc["text"], new_by_title[oc["title"]]))

    for label, otext, ntext in pairs:
        ow = len(otext.split())
        nw = len(ntext.split())
        if otext == ntext:
            print(f"  [SAME] {label} ({nw} words)")
            continue
        ratio = difflib.SequenceMatcher(None, otext.split(), ntext.split()).ratio()
        print(f"  [DIFF] {label}: words old={ow} new={nw} (delta={nw - ow:+d}), word_similarity={ratio:.4f}")
        for line in _diff_snippet(otext, ntext, max_diff_lines):
            print(f"    {line}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdfs", nargs="+", type=Path, help="PDF files to compare")
    parser.add_argument("--base", default=BASE_COMMIT, help=f"Git ref for old PyMuPDF extractor (default: {BASE_COMMIT})")
    parser.add_argument("--max-diff-lines", type=int, default=30, help="Max unified diff lines per chapter (0 = unlimited)")
    args = parser.parse_args(argv)

    missing = [p for p in args.pdfs if not p.exists()]
    if missing:
        for p in missing:
            print(f"Missing PDF: {p}", file=sys.stderr)
        return 1

    old_results = _run_old(args.base, args.pdfs)
    new_results = _run_new(args.pdfs)
    for path in args.pdfs:
        key = str(path.resolve())
        _compare_one(path, old_results[key], new_results[key], args.max_diff_lines)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
