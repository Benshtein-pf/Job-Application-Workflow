# Job Application Automation

An end-to-end pipeline that **scrapes job postings, tailors your resume for
each one with an AI agent, and fills out the application form**

```
scraper  →  CSV (status="new")
         →  tailoring agent  →  CSV (status="tailored")  +  tailored PDF resume
         →  submission agent →  CSV (status="applied")   +  form filled, waiting for manual submit
```

All state lives in a single CSV file (`job_tracker.csv`) — there's no
database, no server, no accounts. Everything runs locally.

---

## ⚠️ Disclaimer

This project automates interactions with third-party sites (LinkedIn, Indeed,
and various job boards/ATS platforms) via scraping and browser automation.
That may be against the terms of service of those sites, and aggressive use
can get your account flagged or rate-limited.

- Use this **for your own job search, on your own accounts, at a reasonable
  pace**. Don't run it as a mass-application spam tool.
- The submission step **never clicks "Submit"** and **never logs in for you**
  — you review and submit every application yourself.
- You are responsible for how you use this. The author provides no warranty
  and is not liable for account bans, rate limiting, or anything else that
  results from running this code.

---

## How it's meant to be run

This repo is built around **AI coding agents driving the pipeline**, not
just providing library code for you to script against.

- **Primarily built and tested with [Claude Cowork](https://claude.ai)**
  (the hosted "cowork" sessions referenced throughout this README and in
  `CLAUDE.md`). This is the supported, tested path.
- The scraper and `render-cv.js` are plain Python/Node scripts and should
  work fine from **Claude Code**, **Codex**, or any other coding agent /
  terminal — but the tailoring and submission *prompts* are written
  specifically for a Claude Cowork session (they assume tool access like
  `mcp__claude-in-chrome__*` for browser control), though they will probably also work on Codex or Claude Code.
- If you adapt them to another agent, expect to do some translation work.
- To run steps on a schedule from **Claude Code**, use the built-in
  [`/loop`](https://docs.claude.com) command, e.g. `/loop 24h <prompt>`.
- To run the scraper periodically you can cron it from your mac.

---

## Repo layout

```
scraper/                  Python scraper (LinkedIn + Indeed -> job_tracker.csv)
  main.py
  CLAUDE.md / README.md

tailoring/                Resume tailoring (Claude Cowork prompts + renderer)
  COWORK_PROMPT.txt        Batch prompt: processes all status="new" rows
  TAILOR_PROMPT.txt        Single-job prompt: paste a URL or JD
  render-cv.js             resume.json -> HTML + PDF (via Playwright)
  Base-CV.html / .pdf      Reference copy of your base CV
  candidate_context.md     Background facts not in the CV (skills, adjacency, etc.)
  resume-template.json     Generic personal-data template

application/              Application submission (Claude Cowork prompt)
  SUBMISSION_PROMPT.md     Opens tabs, triggers autofill, uploads PDF, stops before submit

autofill-chrome-extension/  Manifest V3 extension that fills form fields
  content.js, bridge-main.js, manifest.json, popup.*
  candidate-data.json      Placeholder — replace with your real data
  selector-overrides.json  Per-hostname CSS selector overrides

setup/                    One-time setup
  SETUP_PROMPT.md          Guided setup prompt (run this first)
  linkedin-skills/         Helper script to pull your full LinkedIn skills list

private-files/            Gitignored — your real personal data lives here
package.json              Playwright dependency (repo root)
CLAUDE.md                 Full architecture reference for AI agents working in this repo
```

Runtime data (not committed to the repo) lives in
`~/Documents/job-application-automation/`:

```
job_tracker.csv           The central state file
autofill_issues.md         Log of fields the extension couldn't fill
resume-template.json       Your filled-in personal template
CVs/base/                   Your base CV (HTML)
CVs/tailored/{job_id}/      Tailored resume.json + HTML + PDF per job
```

---

## Prerequisites

- **Python 3.11** + `python-jobspy` + `pandas` (for the scraper)
- **Node.js** + npm (for `render-cv.js` / Playwright)
- **Google Chrome**, with the bundled autofill extension loaded as an
  unpacked extension
- A **Claude Cowork** session (claude.ai) with this repo's directory open,
  for the tailoring and submission steps

```bash
# Python deps
pip install python-jobspy pandas

# Node deps (run from repo root)
npm install playwright
npx playwright install chromium-headless-shell
```

---

## Setup (do this first, once)

Run **`setup/SETUP_PROMPT.md`** as a prompt in Claude Cowork (or Claude
Code/Codex — it's plain instructions, no Cowork-specific tools required). It
will:

1. Ask for your personal info, professional profile, and CV content.
2. Create the runtime directories under `~/Documents/job-application-automation/`.
3. Install Playwright and the headless Chromium build.
4. Generate your personal `resume-template.json` and `candidate_context.md`.
5. Personalize `tailoring/TAILOR_PROMPT.txt` and `tailoring/COWORK_PROMPT.txt`
   with your name, title, experience, and the repo's absolute path.
6. Tell you where to put your base CV (`CVs/base/{name-slug}-CV.html`).
7. Walk you through loading the autofill extension and filling in
   `autofill-chrome-extension/candidate-data.json`.
8. Run a final checklist and confirm everything is wired up.

Optionally, run **`setup/linkedin-skills/scrape-linkedin-skills.js`** to pull
your full, per-role-attributed skills list from LinkedIn — useful for
building an accurate `candidate_context.md`. See
`setup/linkedin-skills/README.md` for details.

---

## Running the pipeline

### 1. Scrape jobs

```bash
python3.11 scraper/main.py            # incremental: jobs from the last 24h
python3.11 scraper/main.py --full-sync  # full sync: jobs from the last 7 days
```

Appends new jobs to `job_tracker.csv` with `status = "new"`. Config (search
terms, title filters, blacklisted companies, allowed locations) lives at the
top of `scraper/main.py` — see `scraper/README.md` for details.

**Running it on a schedule:** from Claude Code, use `/loop`, e.g.

```
/loop 6h Run python3.11 scraper/main.py and report how many new jobs were found.
```

Or, since the scraper is a plain script, schedule it directly with `cron` on
your Mac (no Claude session needed):

```cron
0 */6 * * * cd ~/repos/job-application-automation && python3.11 scraper/main.py >> ~/Library/Logs/job-scraper.log 2>&1
```

### 2. Tailor your resume

In **Claude Cowork**, open this repo's directory and paste the contents of:

- `tailoring/COWORK_PROMPT.txt` — processes all `status="new"` rows (up to
  15 at a time): reads your base CV + `candidate_context.md`, qualifies the
  role, writes a tailored `resume.json`, and renders it to PDF via
  `render-cv.js`.
- `tailoring/TAILOR_PROMPT.txt` — for a single job: paste a job URL or raw
  job description text.

Rows that pass become `status = "tailored"` with a PDF at
`CVs/tailored/{job_id}/`. Underqualified or off-domain roles become
`status = "skipped"`.

You can also run this on a recurring schedule with `/loop` from Claude Code
(e.g. once a day, after the scraper runs) — paste `COWORK_PROMPT.txt` as the
loop prompt. Alternatively, set it up as a **scheduled task in Claude
Cowork** to run `COWORK_PROMPT.txt` automatically on a recurring basis.

### 3. Fill out applications

In **Claude Cowork**, paste the contents of `application/SUBMISSION_PROMPT.md`.
It will:

- Take up to 15 rows with `status = "tailored"`.
- Open each job's application page in Chrome (in batches of 3).
- Trigger the autofill extension via DOM data attributes.
- Upload the tailored PDF resume.
- Fill any remaining fields the extension can't handle (years of experience,
  salary expectations, notice period, etc.).
- **Stop at the submit button** and alert you.
- Update the CSV to `status = "applied"` and log any recurring missed fields
  to `autofill_issues.md`.

**Hard rules baked into this prompt:** never click submit, never log in on
your behalf, never write a cover letter.

> **Known limitation:** the resume upload step currently does **not** work
> end-to-end via Cowork — `mcp__claude-in-chrome__file_upload` cannot attach
> the tailored PDF to the file input on most ATS pages. Until that's fixed,
> use the **autofill Chrome extension** (`autofill-chrome-extension/`) for
> field-filling: click the extension icon and press **"Autofill This
> Page"** to fill the visible form, then attach the resume PDF yourself from
> `CVs/tailored/{job_id}/` and review before submitting.

### 4. Review and submit

Go through each opened tab, double-check the filled fields, and click
**Submit** yourself.

---

## The autofill extension

A Manifest V3 Chrome extension (`autofill-chrome-extension/`) that fills
common application fields (name, email, phone, LinkedIn URL, location, work
authorization, sponsorship). It does **not** run automatically — it's
triggered either:

- By the submission agent, via `data-*` attributes on `document.body`, or
- Manually, via the extension popup's **"Autofill This Page"** button.

It does **not** fill years of experience, salary, notice period, willingness
to relocate, or cover letters — those are handled by the submission prompt or
left for you.

**Install:**

1. Open `chrome://extensions`, enable **Developer Mode**.
2. Click **Load unpacked**, select `autofill-chrome-extension/`.
3. Replace the placeholder values in `autofill-chrome-extension/candidate-data.json`
   with your real data (the setup prompt walks you through this).

Platform support, the trigger protocol, and selector-override format are
documented in `autofill-chrome-extension/README.md`.

---

## CSV status lifecycle

`job_tracker.csv` has a `status` column that drives the whole pipeline:

| Status | Set by | Meaning |
|---|---|---|
| `new` | Scraper | Just found, not yet assessed |
| `skipped` | Tailoring | Underqualified or wrong domain |
| `tailored` | Tailoring | PDF ready, awaiting submission |
| `tailor_error` | Tailoring | PDF render failed |
| `applied` | Submission | Form filled, stopped before submit |
| `submit_error` | Submission | Login wall, upload failure, etc. |

---

## Privacy

Anything containing your personal data is gitignored:

- `private-files/` — your real `candidate-data.json`, `candidate_context.md`,
  resume template, etc.
- `~/Documents/job-application-automation/` — runtime CSV, tailored CVs,
  resumes.
- `autofill-chrome-extension/candidate-data.json` and
  `*/selector-overrides.json` overrides containing personal selectors.

Only placeholder/template versions of these files are committed.

---

## More details

For the full architecture reference (used by AI agents working in this repo,
but useful for humans too), see [`CLAUDE.md`](./CLAUDE.md). Component-level
docs:

- [`scraper/README.md`](./scraper/README.md)
- [`autofill-chrome-extension/README.md`](./autofill-chrome-extension/README.md)
- [`setup/linkedin-skills/README.md`](./setup/linkedin-skills/README.md)

---

## Planned updates

- **Migrate state from CSV to SQL.** `job_tracker.csv` currently has to be
  read/written in full by every agent step, which burns tokens as it grows.
  A small local database (e.g. SQLite) would let each step query/update only
  the rows it needs.
- **Improve `setup/SETUP_PROMPT.md`.** Make the guided setup more robust and
  reliable for new users/repos.
- **Fix the submission resume-upload bug.** Resolve the
  `mcp__claude-in-chrome__file_upload` issue described above so
  `application/SUBMISSION_PROMPT.md` can attach the tailored PDF end-to-end
  without falling back to the extension's manual button.
