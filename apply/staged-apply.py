#!/usr/bin/env python3
"""Staged apply helper.

Walks the most recently generated tailored CVs (one batch produced by the
COWORK/TAILOR Cowork prompts, up to 15 by default) and, one job at a time:

  1. opens the job's apply URL in the default browser, and
  2. opens that CV's folder in the file manager,

then waits for you to confirm before moving to the next job. Pressing Enter
marks the job as applied in the SQLite tracker (status="applied", applied_date
set to now) keyed by job_id (the tailored CV folder name); jobs already at
status="applied" are skipped on later runs unless --include-applied is given.
You are asked once, up front, which OS you are on so the right "open" command
is used.

The apply URL is looked up in the scraper's SQLite tracker (job_tracker.db)
by job_id (the tailored CV folder name), falling back to the row's job_url.

Usage:
    python3.11 apply/staged-apply.py                 # last 15 tailored CVs
    python3.11 apply/staged-apply.py --count 5       # last 5
    python3.11 apply/staged-apply.py --list-applied  # list applied companies
"""

import argparse
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# Reuse the scraper's SQLite layer (schema + connection settings) as the single
# source of truth for DB access. staged-apply.py runs as a script, so add the
# scraper dir to sys.path the same way scraper/main.py resolves `import sqlite`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scraper"))
import sqlite as db  # noqa: E402

BASE_DIR = Path.home() / "Documents" / "job-application-automation"
DB_PATH = db.DB_PATH
TAILORED_DIR = BASE_DIR / "CVs" / "tailored"

DEFAULT_COUNT = 15  # matches the per-batch limit in COWORK_PROMPT.txt / TAILOR_PROMPT.txt

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def clean_for_terminal(text: str) -> str:
    """Strip control characters so scraped DB/JSON values cannot inject
    terminal escape sequences when printed."""
    return _CONTROL_CHARS.sub("", text)


def as_web_url(value: str) -> str:
    """Return value only if it is a plain http(s) URL, else ''.

    Apply URLs come from the scraper's SQLite tracker; anything else
    (stray text, NULL, file paths) must not reach the OS opener, which
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


def load_db_index(db_path: Path) -> dict[str, dict[str, str]]:
    """Map job_id -> job row from the SQLite tracker. Empty dict if the DB is
    missing or unreadable.

    Skips connecting when the DB file is absent so this helper never creates an
    empty tracker. On any sqlite error we degrade to an empty index and the
    caller resolves no apply URL for those jobs."""
    index: dict[str, dict[str, str]] = {}
    if not db_path.exists():
        return index
    try:
        conn = db.get_connection(db_path)  # row_factory=Row set by the helper
        try:
            for row in conn.execute(
                "SELECT job_id, company, title, apply_url, job_url, status FROM jobs"
            ):
                job_id = (row["job_id"] or "").strip()
                if job_id:
                    index[job_id] = dict(row)
        finally:
            conn.close()
    except db.sqlite3.Error as e:
        print(f"Note: could not read {db_path}: {e}")
    return index


def find_recent_cv_dirs(
    tailored_dir: Path, count: int, applied_ids: set[str], include_applied: bool = False
) -> list[Path]:
    """The `count` most recently generated tailored CV folders (newest first).

    Folders whose job_id (the folder name) is already at status="applied" in the
    tracker are skipped unless include_applied is True."""
    if not tailored_dir.exists():
        return []
    dirs = [d for d in tailored_dir.iterdir() if d.is_dir() and (d / "resume.json").exists()]
    if not include_applied:
        dirs = [d for d in dirs if d.name not in applied_ids]
    dirs.sort(key=lambda d: (d / "resume.json").stat().st_mtime, reverse=True)
    return dirs[:count]


def mark_applied(db_path: Path, job_id: str, label: str) -> None:
    """Set status="applied" and applied_date=now on the job's tracker row.

    applied_date is a human-readable, text-sortable timestamp (YYYY-MM-DD HH:MM)."""
    applied_date = datetime.now().strftime("%Y-%m-%d %H:%M")
    try:
        conn = db.get_connection(db_path)
        try:
            rowcount = db.set_status(conn, job_id, "applied", applied_date=applied_date)
        finally:
            conn.close()
    except db.sqlite3.Error as e:
        print(f"  ! could not update tracker for {job_id}: {e}")
        return
    if rowcount == 0:
        print(f"  ! no tracker row for job_id {job_id} — not marked applied")
        return
    print(f"        marked applied: {label} ({applied_date})")


def list_applied(db_path: Path) -> None:
    """Print companies at status="applied" as one comma-separated line, oldest first.

    Queries the tracker by status directly (no marker files)."""
    if not db_path.exists():
        print(f"No tracker DB found at {db_path}")
        return
    try:
        conn = db.get_connection(db_path)
        try:
            rows = conn.execute(
                "SELECT company FROM jobs WHERE status = 'applied' "
                "ORDER BY applied_date, job_id"
            ).fetchall()
        finally:
            conn.close()
    except db.sqlite3.Error as e:
        print(f"Note: could not read {db_path}: {e}")
        return
    seen: set[str] = set()
    distinct: list[str] = []
    for row in rows:
        company = clean_for_terminal((row["company"] or "").strip())
        if company and company not in seen:
            seen.add(company)
            distinct.append(company)
    if not distinct:
        print("No jobs at status=\"applied\" in the tracker.")
        return
    print(", ".join(f'"{company}"' for company in distinct))


def resolve_apply_url(row: dict[str, str] | None) -> str:
    """DB apply_url, then DB job_url.

    Only plain http(s) URLs are returned (see as_web_url) — NULL/empty DB
    columns come back as None and are dropped without a special case."""
    if row:
        for key in ("apply_url", "job_url"):
            url = as_web_url(row.get(key) or "")
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
    parser.add_argument("--db", type=Path, default=DB_PATH,
                        help="Override the job tracker DB path")
    parser.add_argument("--include-applied", action="store_true",
                        help="Also process CVs whose tracker status is already \"applied\"")
    parser.add_argument("--list-applied", action="store_true",
                        help="List all companies at status=\"applied\" in the tracker, then exit")
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be >= 1")

    if args.list_applied:
        list_applied(args.db)
        return

    db_index = load_db_index(args.db)
    if not db_index:
        print(f"Note: no DB found at {args.db} — apply URLs will be unavailable.\n")
    applied_ids = {
        job_id for job_id, row in db_index.items() if (row.get("status") or "") == "applied"
    }

    cv_dirs = find_recent_cv_dirs(args.tailored_dir, args.count, applied_ids, args.include_applied)
    if not cv_dirs:
        print(f"No tailored CVs found under {args.tailored_dir}"
              + ("" if args.include_applied else " (already-applied ones are skipped; see --include-applied)"))
        sys.exit(0)

    os_type = ask_os()
    total = len(cv_dirs)
    print(f"\nProcessing the {total} most recent tailored CV(s) on {os_type}.\n")

    for i, cv_dir in enumerate(cv_dirs, 1):
        row = db_index.get(cv_dir.name)
        url = resolve_apply_url(row)
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
            mark_applied(args.db, cv_dir.name, describe(row, cv_dir))
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