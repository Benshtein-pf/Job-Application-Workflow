# Staged Apply (`apply/`)

A small, interactive helper for working through a batch of tailored CVs **by
hand**, one job at a time. It is the manual alternative to the Cowork submission
workflow in `application/`: instead of driving the browser and autofill
extension, it just opens each job's apply page and its CV folder for you, then
records which ones you applied to.

```
tailoring  →  CVs/tailored/{job_id}/  →  apply/staged-apply.py  →  tracker status="applied"
```

---

## What it does

For each of the most recently tailored CVs (newest first, 15 by default), the
script:

1. Opens the job's **apply URL** in your default browser.
2. Opens that CV's **folder** in your file manager (so the tailored PDF is right
   there to upload).
3. Waits for you to confirm before moving on. Pressing **Enter** marks the job
   applied; `s` skips marking; `q` quits.

You are asked **once, up front**, which OS you are on (Windows / Linux / Mac) so
the right "open" command is used. WSL is detected automatically and paths are
translated via `wslpath` + `explorer.exe`.

## Marking applied

Confirming a job updates its row in the SQLite tracker — `status="applied"` and
`applied_date` set to now (`YYYY-MM-DD HH:MM`) — keyed by `job_id` (the CV folder
name). Jobs already at `status="applied"` are **skipped** on later runs unless you
pass `--include-applied`.

## Where the data comes from

- **Which CVs exist** — the folders under
  `~/Documents/job-application-automation/CVs/tailored/{job_id}/` that contain a
  `resume.json`. The folder name is the `job_id`.
- **Apply URL, company, title** — looked up in the SQLite tracker
  (`~/Documents/job-application-automation/job_tracker.db`) by `job_id`. The URL
  falls back: `apply_url` → `job_url`. Only plain `http(s)` URLs are ever handed
  to the OS opener.
- **Which CVs are already applied** — jobs at `status="applied"` in the tracker
  (skipped unless `--include-applied`).

All DB access goes through `scraper/sqlite.py` (the shared storage layer): reads
via `get_connection`, status writes via `set_status` — the same code path as the
`scraper/sqlite.py set-status` CLI.

---

## Usage

```bash
python3.11 apply/staged-apply.py                 # walk the last 15 tailored CVs
python3.11 apply/staged-apply.py --count 5       # just the last 5
python3.11 apply/staged-apply.py --include-applied   # also revisit already-applied ones
python3.11 apply/staged-apply.py --list-applied  # print applied companies, then exit
```

Stdlib only — no dependencies, no install.

### Flags

| Flag | Meaning |
|---|---|
| `--count N` | How many of the most recent CVs to process (default 15) |
| `--include-applied` | Also process jobs already at `status="applied"` in the tracker |
| `--list-applied` | List companies at `status="applied"` (one line), then exit |
| `--tailored-dir PATH` | Override the tailored-CVs directory |
| `--db PATH` | Override the job tracker DB path |

---

## Notes

- This script only opens pages and updates the tracker status — it never submits
  a form or clicks anything on the apply page. That stays your call.
- `Ctrl+C` / closed stdin at a prompt exits cleanly (no traceback).
- A working copy also lives in `private-files/` (gitignored) for local edits.
