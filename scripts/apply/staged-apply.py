#!/usr/bin/env python3
"""Staged apply helper.

Walks the most recently generated tailored CVs (one batch produced by the
COWORK/TAILOR Cowork prompts, up to 15 by default) and, one job at a time:

  1. opens the job's apply URL in the default browser, and
  2. opens that CV's folder in the file manager,

then waits for you to confirm before moving to the next job. Pressing Enter
marks the job as applied by writing an `.applied` marker file (JSON with a
timestamp, the company, and the apply URL) into the CV folder; already-marked
folders are skipped on later runs unless --include-applied is given. You are
asked once, up front, which OS you are on so the right "open" command is used.

The apply URL is looked up in the scraper's CSV by job_id (the tailored CV
folder name), falling back to the row's job_url, then to a resume.json field.

Usage:
    python3.11 scripts/apply/staged-apply.py                 # last 15 tailored CVs
    python3.11 scripts/apply/staged-apply.py --count 5       # last 5
    python3.11 scripts/apply/staged-apply.py --list-applied  # list applied companies
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

BASE_DIR = Path.home() / "Documents" / "job-application-automation"
CSV_PATH = BASE_DIR / "job_tracker.csv"
TAILORED_DIR = BASE_DIR / "CVs" / "tailored"

DEFAULT_COUNT = 15  # matches the per-batch limit in COWORK_PROMPT.txt / TAILOR_PROMPT.txt

# Marker file written into a CV folder once you confirm you applied. A file
# inside the directory (rather than xattrs) survives WSL/Windows/OneDrive moves.
APPLIED_MARKER = ".applied"

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def clean_for_terminal(text: str) -> str:
    """Strip control characters so scraped CSV/JSON values cannot inject
    terminal escape sequences when printed."""
    return _CONTROL_CHARS.sub("", text)


def as_web_url(value: str) -> str:
    """Return value only if it is a plain http(s) URL, else ''.

    Apply URLs come from scraped data (CSV / resume.json); anything else
    (stray text, 'nan', file paths) must not reach the OS opener, which
    would otherwise treat it as a local path to open."""
    value = (value or "").strip()
    return value if value.startswith(("http://", "https://")) else ""


def ask_os() -> str:
    """Prompt once for the OS. Returns 'WINDOWS', 'LINUX', or 'MAC'."""
    aliases = {
        "1": "WINDOWS", "WINDOWS": "WINDOWS", "W": "WINDOWS", "WIN": "WINDOWS",
        "2": "LINUX", "LINUX": "LINUX", "L": "LINUX",
        "3": "MAC", "MAC": "MAC", "M": "MAC", "MACOS": "MAC", "OSX": "MAC",
    }
    while True:
        ans = input("Which OS are you on?  [1] WINDOWS   [2] LINUX   [3] MAC : ").strip().upper()
        if ans in aliases:
            return aliases[ans]
        print("  Please enter WINDOWS, LINUX, or MAC (or 1/2/3).")


def _running_under_wsl() -> bool:
    """True when this Linux Python is running inside WSL (so we must hand paths
    to Windows via wslpath/explorer.exe rather than cmd.exe start)."""
    if os.environ.get("WSL_DISTRO_NAME"):
        return True
    try:
        with open("/proc/version", encoding="utf-8") as f:
            return "microsoft" in f.read().lower()
    except OSError:
        return False


def open_target(os_type: str, target: str) -> None:
    """Open a URL or a directory with the native opener for the chosen OS."""
    is_url = target.startswith(("http://", "https://"))
    try:
        if os_type == "WINDOWS":
            if _running_under_wsl():
                # Under WSL, cmd.exe `start` can't open a Linux path (it reads the
                # leading "/home" as a switch) and warns on UNC cwd. Translate the
                # path with wslpath and let explorer.exe open it; URLs pass through.
                arg = target
                if not is_url:
                    arg = subprocess.run(
                        ["wslpath", "-w", target],
                        capture_output=True, text=True, check=True, timeout=10,
                    ).stdout.strip()
                subprocess.run(["explorer.exe", arg], check=False)
            # os.startfile handles both URLs and folders via shell associations.
            elif hasattr(os, "startfile"):
                os.startfile(target)  # type: ignore[attr-defined]
            else:
                subprocess.run(["cmd.exe", "/c", "start", "", target], check=False)
        elif os_type == "MAC":
            subprocess.run(["open", target], check=False)
        else:  # LINUX
            subprocess.run(["xdg-open", target], check=False)
    except Exception as e:
        print(f"  ! could not open {target}: {e}")


def load_csv_index(csv_path: Path) -> dict[str, dict[str, str]]:
    """Map job_id -> CSV row. Empty dict if the CSV is missing."""
    index: dict[str, dict[str, str]] = {}
    if not csv_path.exists():
        return index
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            job_id = (row.get("job_id") or "").strip()
            if job_id:
                index[job_id] = row
    return index


def find_recent_cv_dirs(tailored_dir: Path, count: int, include_applied: bool = False) -> list[Path]:
    """The `count` most recently generated tailored CV folders (newest first).

    Folders already carrying the APPLIED_MARKER are skipped unless
    include_applied is True."""
    if not tailored_dir.exists():
        return []
    dirs = [d for d in tailored_dir.iterdir() if d.is_dir() and (d / "resume.json").exists()]
    if not include_applied:
        dirs = [d for d in dirs if not (d / APPLIED_MARKER).exists()]
    dirs.sort(key=lambda d: (d / "resume.json").stat().st_mtime, reverse=True)
    return dirs[:count]


def mark_applied(cv_dir: Path, url: str, company: str) -> None:
    """Write the APPLIED_MARKER file into the CV folder."""
    marker = cv_dir / APPLIED_MARKER
    payload = {
        "applied_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "company": company,
        "apply_url": url,
    }
    try:
        marker.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"        marked applied: {marker}")
    except OSError as e:
        print(f"  ! could not write {marker}: {e}")


def list_applied(tailored_dir: Path, csv_index: dict[str, dict[str, str]]) -> None:
    """Print the companies marked applied as one comma-separated line, oldest first."""
    entries = []
    for d in tailored_dir.iterdir() if tailored_dir.exists() else []:
        marker = d / APPLIED_MARKER
        if not d.is_dir() or not marker.exists():
            continue
        applied_at = company = ""
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                applied_at = str(data.get("applied_at") or "")
                company = str(data.get("company") or "")
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            pass  # unreadable marker: still listed, via CSV/folder-name fallback
        if not company:
            row = csv_index.get(d.name)
            company = (row.get("company") or "").strip() if row else ""
        entries.append((applied_at, clean_for_terminal(company) or d.name))
    if not entries:
        print(f"No applied CVs found under {tailored_dir}")
        return
    entries.sort()
    seen: set[str] = set()
    distinct = [c for _, c in entries if not (c in seen or seen.add(c))]
    print(", ".join(f'"{company}"' for company in distinct))


def resolve_apply_url(row: dict[str, str] | None, cv_dir: Path) -> str:
    """CSV apply_url, then CSV job_url, then a resume.json fallback.

    Only plain http(s) URLs are returned (see as_web_url) — this also drops
    pandas' literal 'nan' strings without a special case."""
    if row:
        for key in ("apply_url", "job_url"):
            url = as_web_url(row.get(key) or "")
            if url:
                return url
    resume_json = cv_dir / "resume.json"
    if resume_json.exists():
        try:
            data = json.loads(resume_json.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return ""  # unreadable/corrupt resume.json: no URL fallback available
        job = data.get("job") or {}
        for src in (job, data):
            if not isinstance(src, dict):
                continue
            for key in ("apply_url", "job_url"):
                url = as_web_url(str(src.get(key) or ""))
                if url:
                    return url
    return ""


def describe(row: dict[str, str] | None, cv_dir: Path) -> str:
    """Human-readable label for a job: 'Company — Title', else the folder name."""
    if row:
        company = clean_for_terminal((row.get("company") or "").strip())
        title = clean_for_terminal((row.get("title") or "").strip())
        label = " — ".join(p for p in (company, title) if p)
        if label:
            return label
    return cv_dir.name


def main() -> None:
    parser = argparse.ArgumentParser(description="Staged apply over the latest tailored CVs")
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT,
                        help=f"How many of the most recent CVs to process (default {DEFAULT_COUNT})")
    parser.add_argument("--tailored-dir", type=Path, default=TAILORED_DIR,
                        help="Override the tailored CVs directory")
    parser.add_argument("--csv", type=Path, default=CSV_PATH,
                        help="Override the job tracker CSV path")
    parser.add_argument("--include-applied", action="store_true",
                        help=f"Also process CVs already marked applied ({APPLIED_MARKER} present)")
    parser.add_argument("--list-applied", action="store_true",
                        help="List all companies already marked applied, then exit")
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be >= 1")

    if args.list_applied:
        list_applied(args.tailored_dir, load_csv_index(args.csv))
        return

    cv_dirs = find_recent_cv_dirs(args.tailored_dir, args.count, args.include_applied)
    if not cv_dirs:
        print(f"No tailored CVs found under {args.tailored_dir}"
              + ("" if args.include_applied else " (already-applied ones are skipped; see --include-applied)"))
        sys.exit(0)

    csv_index = load_csv_index(args.csv)
    if not csv_index:
        print(f"Note: no CSV found at {args.csv} — falling back to resume.json for apply URLs.\n")

    os_type = ask_os()
    total = len(cv_dirs)
    print(f"\nProcessing the {total} most recent tailored CV(s) on {os_type}.\n")

    for i, cv_dir in enumerate(cv_dirs, 1):
        row = csv_index.get(cv_dir.name)
        url = resolve_apply_url(row, cv_dir)
        print(f"[{i}/{total}] {describe(row, cv_dir)}")
        print(f"        folder: {cv_dir}")

        if url:
            print(f"        apply:  {clean_for_terminal(url)}")
            open_target(os_type, url)
        else:
            print("        apply:  (no apply URL found — opening folder only)")
        open_target(os_type, str(cv_dir))

        nxt = " and continue" if i < total else ""
        ans = input(f"\nPress Enter to mark applied{nxt}, 's' to skip marking, or 'q' to quit: ").strip().lower()
        if ans == "q":
            print("Stopped.")
            break
        if ans == "s":
            print("        not marked.")
        else:
            company = clean_for_terminal((row.get("company") or "").strip()) if row else ""
            mark_applied(cv_dir, url, company)
        if i < total:
            print()

    print("\nDone.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        # Ctrl+C / closed stdin during one of the input() prompts: exit
        # cleanly instead of dumping a traceback.
        print("\nStopped.")
        sys.exit(130)
