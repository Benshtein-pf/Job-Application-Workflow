#!/usr/bin/env python3
"""SQLite storage layer for the job tracker.

Single source of truth for the schema, connection settings, and access helpers.
Imported by the scraper (scraper/main.py) and the one-time migration script, and
exposed as a small CLI used by the tailoring Cowork prompt:

    python3 sqlite.py list --status new --limit 15 --json
    python3 sqlite.py set-status <job_id> <status> --note "..."

Built on Python's standard-library sqlite3 module only (no third-party dependency),
so any environment that already has Python can read/update the tracker with no extra
install (the standalone `sqlite3` command-line tool is NOT installed by default).
"""

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path.home() / "Documents" / "job-application-automation" / "job_tracker.db"

# Canonical column order. The table schema below and every insert use this order;
# the scraper builds its insert rows against it.
COLUMNS = [
    "job_id", "date_found", "company", "title", "location",
    "is_remote", "job_url", "apply_url", "platform", "description",
    "status", "applied_date", "notes",
]

# Allowed values for the status lifecycle column (see CLAUDE.md).
VALID_STATUSES = [
    "new", "skipped", "tailored", "tailor_error", "applied", "submit_error",
]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id       TEXT PRIMARY KEY,          -- MD5 of job_url
    date_found   TEXT NOT NULL,
    company      TEXT,
    title        TEXT,
    location     TEXT,
    is_remote    INTEGER,                   -- 0/1
    job_url      TEXT NOT NULL UNIQUE,      -- dedup key
    apply_url    TEXT,
    platform     TEXT,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'new',
    applied_date TEXT,
    notes        TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
"""


def get_connection(db_path: Path | None = None) -> sqlite3.Connection:
    """Open a connection with WAL mode and sane concurrency pragmas.

    WAL lets a reader (the Cowork agent) query while the scraper writes;
    busy_timeout waits on a lock instead of raising "database is locked".

    The DB holds tracking data we don't want other local users reading, so the
    directory is locked to the owner (0700) and the db file plus its WAL/SHM
    sidecars to 0600 — sqlite3 otherwise creates them world-readable (0644).
    """
    db_path = Path(db_path) if db_path is not None else DB_PATH
    db_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(db_path.parent, 0o700)
    except OSError:
        pass  # non-POSIX FS or not owner; best-effort hardening
    conn = sqlite3.connect(db_path)
    for name in (db_path.name, db_path.name + "-wal", db_path.name + "-shm"):
        p = db_path.with_name(name)
        if p.exists():
            try:
                os.chmod(p, 0o600)
            except OSError:
                pass
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """Create the jobs table and index if they don't exist (idempotent)."""
    conn.executescript(_SCHEMA)


def existing_urls(conn: sqlite3.Connection) -> set[str]:
    """Return the set of job_url values already stored (for dedup)."""
    return {row["job_url"] for row in conn.execute("SELECT job_url FROM jobs")}


def insert_jobs(conn: sqlite3.Connection, rows) -> int:
    """Bulk-insert rows (each a tuple in COLUMNS order). Rows whose job_id or
    job_url already exist are ignored. Returns the number actually inserted."""
    placeholders = ",".join("?" for _ in COLUMNS)
    sql = f"INSERT OR IGNORE INTO jobs ({','.join(COLUMNS)}) VALUES ({placeholders})"
    with conn:  # transaction: commit on success, rollback on error
        cur = conn.executemany(sql, rows)
    return cur.rowcount


def set_status(
    conn: sqlite3.Connection,
    job_id: str,
    status: str,
    note: str | None = None,
    applied_date: str | None = None,
) -> int:
    """Update a job's status, and optionally its notes / applied_date.

    Returns the number of rows updated (0 when no job has that job_id). Raises
    ValueError if status is not one of VALID_STATUSES. Shared by the CLI
    (set-status) and importing callers (e.g. apply/staged-apply.py) so status
    writes go through one validated code path."""
    if status not in VALID_STATUSES:
        raise ValueError(
            f"invalid status {status!r}; valid: {', '.join(VALID_STATUSES)}"
        )
    sets = ["status = ?"]
    params: list = [status]
    if note is not None:
        sets.append("notes = ?")
        params.append(note)
    if applied_date is not None:
        sets.append("applied_date = ?")
        params.append(applied_date)
    params.append(job_id)
    sql = f"UPDATE jobs SET {', '.join(sets)} WHERE job_id = ?"
    with conn:  # transaction: commit on success, rollback on error
        cur = conn.execute(sql, params)
    return cur.rowcount


# --------------------------------------------------------------------------- CLI


def _cmd_list(args: argparse.Namespace) -> int:
    conn = get_connection()
    init_db(conn)
    sql = f"SELECT {','.join(COLUMNS)} FROM jobs"
    params: list = []
    if args.status:
        sql += " WHERE status = ?"
        params.append(args.status)
    sql += " ORDER BY date_found, job_id"
    if args.limit is not None:
        sql += " LIMIT ?"
        params.append(args.limit)
    rows = [dict(row) for row in conn.execute(sql, params)]
    conn.close()
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        for r in rows:
            print(f"[{r['status']}] {r['job_id']}  {r['company']} - {r['title']}")
    return 0


def _cmd_set_status(args: argparse.Namespace) -> int:
    conn = get_connection()
    init_db(conn)
    try:
        rowcount = set_status(
            conn, args.job_id, args.status,
            note=args.note, applied_date=args.applied_date,
        )
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    finally:
        conn.close()
    if rowcount == 0:
        print(f"error: no job with job_id '{args.job_id}'", file=sys.stderr)
        return 1
    print(f"ok: {args.job_id} -> {args.status}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Job tracker SQLite helper")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="List jobs, optionally filtered by status")
    p_list.add_argument("--status", help="Filter by status (e.g. new)")
    p_list.add_argument("--limit", type=int, help="Max rows to return")
    p_list.add_argument("--json", action="store_true", help="Output a JSON array")
    p_list.set_defaults(func=_cmd_list)

    p_set = sub.add_parser("set-status", help="Update a job's status / notes")
    p_set.add_argument("job_id")
    p_set.add_argument("status", help=f"One of: {', '.join(VALID_STATUSES)}")
    p_set.add_argument("--note", help="Set the notes column")
    p_set.add_argument("--applied-date", dest="applied_date", help="Set applied_date")
    p_set.set_defaults(func=_cmd_set_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
