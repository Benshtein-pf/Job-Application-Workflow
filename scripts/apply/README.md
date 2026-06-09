# scripts/apply

Helper scripts for the manual "apply" step that runs **after** tailoring — once
the Cowork tailoring prompt has produced a batch of tailored CVs, these scripts
walk you through actually opening each job to apply.

---

## `staged-apply.py`

Walks the most recently generated tailored CVs (one batch produced by the
COWORK/TAILOR Cowork prompts, up to 15 by default) and processes them **one job
at a time**. For each job it:

1. opens the job's **apply URL** in your default browser, and
2. opens that CV's **folder** in your file manager,

then waits for you to confirm before moving on. Pressing **Enter** marks the
job as applied; `s` moves on without marking; `q` quits.

Marking applied writes an `.applied` file into the CV folder — JSON with the
timestamp, company, and apply URL:

```json
{
  "applied_at": "2026-06-07T14:30:00+03:00",
  "company": "Acme Corp",
  "apply_url": "https://..."
}
```

Folders that already contain `.applied` are **skipped on later runs**, so
re-running the script only shows you jobs you haven't applied to yet (pass
`--include-applied` to revisit them).

Run with `--list-applied` to print every company you've marked applied as one
comma-separated line (oldest first) and exit, e.g. `"Globex", "Acme Corp"`.

You are asked **once**, up front, which OS you're on (`WINDOWS` / `LINUX` /
`MAC`) so the right "open" command is used.

### Where it gets its data

- **Which CVs:** the most recently modified folders under
  `~/Documents/job-application-automation/CVs/tailored/{job_id}/` (those
  containing a `resume.json`), newest first.
- **The apply URL:** looked up in the scraper's CSV
  (`~/Documents/job-application-automation/job_tracker.csv`) by `job_id` (the
  tailored CV folder name). Falls back to the row's `job_url`, then to an
  `apply_url`/`job_url` field inside `resume.json` if present. If none is found,
  it still opens the CV folder and warns.

### Usage

```bash
python3.11 scripts/apply/staged-apply.py            # last 15 tailored CVs
python3.11 scripts/apply/staged-apply.py --count 5  # last 5
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--count N` | `15` | How many of the most recent CVs to process |
| `--tailored-dir PATH` | `~/Documents/job-application-automation/CVs/tailored` | Override the tailored CVs directory |
| `--csv PATH` | `~/Documents/job-application-automation/job_tracker.csv` | Override the job tracker CSV |
| `--include-applied` | off | Also process CVs already marked with `.applied` |
| `--list-applied` | off | List all companies marked applied, then exit |

No third-party dependencies — standard library only.
