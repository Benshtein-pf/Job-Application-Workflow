# Job Application Automation

End-to-end pipeline that scrapes jobs, tailors the resume per role, and fills
application forms — stopping before the submit button.

---

## Pipeline overview

```
scraper  →  SQLite (status="new")
         →  tailoring Cowork  →  SQLite (status="tailored")  +  tailored PDF
         →  submission Cowork →  SQLite (status="applied")   +  form filled, waiting for manual submit
```

Central state lives entirely in the SQLite database at
`~/Documents/job-application-automation/job_tracker.db` (stdlib `sqlite3`, WAL mode — no
server, no third-party dependency). The `status` column drives every step. All access goes
through `scraper/sqlite.py`: the scraper imports it; the Cowork prompts call its CLI
(`list` / `set-status`).

---

## Parts

### 1. Scraper (`scraper/`)

Scrapes LinkedIn and Indeed for backend engineering roles.

```bash
python3.11 scraper/main.py            # incremental: last 24h
python3.11 scraper/main.py --full-sync  # full sync: last 7h (168h)
```

**Install deps** (no requirements.txt):
```bash
pip install python-jobspy pandas
```

All config is at the top of `scraper/main.py`:
- `SEARCH_TERMS` — LinkedIn search queries
- `EXCLUDE_TITLE_KEYWORDS` — title-level filter (DevOps, QA, junior, etc.)
- `BLACKLISTED_COMPANIES` — companies to skip
- `ALLOWED_DISTRICTS` — location filter

The DB path (`DB_PATH`) and schema live in `scraper/sqlite.py`
(`~/Documents/job-application-automation/job_tracker.db`).

Each new job is inserted with `status = "new"` via `INSERT OR IGNORE` (dedup on
`job_id` / `job_url`). `job_id` is an MD5 of the URL.

---

### 2. Resume Tailoring (`tailoring/`)

Two Claude Code prompts — use the right one for the task:

| Prompt | Use case |
|---|---|
| `COWORK_PROMPT.txt` | Batch: reads the DB, processes all `status="new"` rows (up to 15) |
| `TAILOR_PROMPT.txt` | Single job: paste/give a URL or raw JD text |

**How it works:**
Cowork reads the base CV and `candidate_context.md`, qualifies the role, and writes a tailored
`resume.json`. The `render-cv.js` script then converts that JSON to HTML + PDF via Playwright.
The model never generates HTML directly — only structured data.

**How to run (Claude cowork):**
1. Open `~/Documents/job-application-automation` in Cowork.
2. Paste `tailoring/COWORK_PROMPT.txt`, or `tailoring/TAILOR_PROMPT.txt` followed by the job description.

**Setup (one-time, per machine):**
```bash
# Install Playwright (run from repo root)
npm install playwright

# Install Chromium (run from repo root)
npx playwright install chromium-headless-shell
```

**Cowork sessions:** Run these two commands at the start of each Cowork session before running render-cv.js:
```bash
# 1. Install Chromium headless shell
cd ~/repos/job-application-automation && npx playwright install chromium-headless-shell

# 2. Extract libXdamage (the sandbox is missing this system library — no root needed)
cd ~ && apt-get download libxdamage1 2>/dev/null && dpkg-deb -x libxdamage1_*.deb libxdamage_extracted
```

Then prefix any `node render-cv.js` call with the library path:
```bash
LD_LIBRARY_PATH=~/libxdamage_extracted/usr/lib/aarch64-linux-gnu \
  node ~/repos/job-application-automation/tailoring/render-cv.js <resume.json>
```
Also create `~/Documents/job-application-automation/resume-template.json` — copy the generic
template from `tailoring/resume-template.json` and fill in your personal info. See the prompts'
SETUP comment for details.

**Key files:**
- `tailoring/Base-CV.html` — base CV template (also deployed to `~/Documents/job-application-automation/CVs/base/`)
- `tailoring/candidate_context.md` — authoritative background facts not in the CV
- `tailoring/render-cv.js` — converts `resume.json` → `{First-Last}.html` + `{First-Last}.pdf`
- `~/Documents/job-application-automation/resume-template.json` — personal data template (pre-filled, gitignored)
- Tailored output: `~/Documents/job-application-automation/CVs/tailored/{job_id}/resume.json` + `.{html,pdf}`

---

### 3. Application Submission (`application/`)

Claude Cowork workflow that opens application tabs, triggers the autofill
extension, handles missed fields, uploads the tailored PDF, and stops at the
submit button — never clicking it.

**How to run:**
1. Paste `application/SUBMISSION_PROMPT.md` as your prompt in Claude Cowork.
2. Cowork reads the DB (via `scraper/sqlite.py`), takes up to 15 `status="tailored"`
   rows, opens them in Chrome (groups of 3), and processes each form.

**What Cowork does:**
- Triggers the autofill extension via body data attributes (see below).
- Uploads `CVs/tailored/{job_id}/{candidate-name}.pdf` via `mcp__claude-in-chrome__file_upload`.
- Fills any fields the extension missed (years exp, salary, notice period, etc.).
- Stops at the submit button and alerts you.
- Updates the job's DB status (via `sqlite.py set-status`) and appends missed-field bugs to `autofill_issues.md`.

**Hard constraints:**
- NEVER click submit. NEVER log in. NEVER write a cover letter.
- Only process rows where `status == "tailored"`.

---

### 4. Autofill Chrome Extension (`autofill-chrome-extension/`)

Manifest V3 content script that fills job application forms when triggered by
Cowork via DOM data attributes, or manually via the extension popup button.

**Install (load unpacked):**
1. Open `chrome://extensions`, enable Developer Mode.
2. Click "Load unpacked" and select `autofill-chrome-extension/`.

**Manual trigger (popup button):**
Click the extension icon and press "Autofill This Page" to run the fill
logic on the active tab without any Cowork/DOM setup. The popup sends a
`{ type: 'job-autofill-run' }` message to the content script via
`chrome.tabs.sendMessage`, which calls `runFill('')` directly and shows
"Done!" or "Done (N skipped)" based on the response. No `job_id` is set in
this mode, so the resume path in `data-resume-input` falls back to empty.

**Trigger protocol (how Cowork activates the extension):**
```javascript
document.body.setAttribute('data-job-id', '{job_id}');
document.body.setAttribute('data-ready-to-fill', 'true');
// Poll for completion:
await new Promise(resolve => {
  const deadline = Date.now() + 15000;
  const check = () => {
    if (document.body.getAttribute('data-fill-done') === 'true') return resolve();
    if (Date.now() > deadline) return resolve(); // timeout
    setTimeout(check, 500);
  };
  check();
});
```

**Output attributes set by the extension:**
| Attribute | Content |
|---|---|
| `data-fill-done` | `"true"` when done |
| `data-fill-skipped` | JSON array of field keys not filled |
| `data-resume-input` | JSON with `pdf_path`, `selector`, `frame_url`, `shadow_host` |

**Platform support:**
| Platform | Status |
|---|---|
| Greenhouse | Full |
| Greenhouse embed (iframe) | Full |
| Lever | Full |
| LinkedIn Easy Apply (shadow DOM) | Full — auto-advances pages, stops at resume upload |
| Rippling | Full — uses MAIN-world bridge for React dial-code selector |
| Comeet | Full — cross-origin iframe via postMessage |
| Oracle Cloud | Two-step (email-first flow) |
| Workday | Partial — basic fields only, dropdowns skipped |
| Dueto | Heuristic only |
| Generic | Heuristic only |

**Candidate data:** `autofill-chrome-extension/candidate-data.json`
**Selector overrides:** `autofill-chrome-extension/selector-overrides.json`

The extension does NOT fill: years of experience, salary, notice period,
relocate, or cover letter fields — those are Cowork's responsibility.

---

## File layout

```
scraper/
  main.py                  Scraper script
  sqlite.py                SQLite storage layer: schema + connection + CLI (list / set-status)
  migrate_csv_to_sqlite.py One-time CSV -> SQLite import
  README.md                Scraper-specific guidance

tailoring/
  COWORK_PROMPT.txt        Batch tailoring prompt (reads/updates the DB via sqlite.py)
  TAILOR_PROMPT.txt        Single-job tailoring prompt
  render-cv.js             Converts resume.json -> HTML + PDF via Playwright
  resume-template.json     Generic template (copy to ~/Documents/…, fill in personal info)
  Base-CV.html             Base CV (HTML source)
  Base-CV.pdf              Base CV (PDF reference copy)
  candidate_context.md     Background facts for tailoring

application/
  SUBMISSION_PROMPT.md     Application submission prompt

autofill-chrome-extension/
  manifest.json
  content.js               Main content script (all platform handlers)
  bridge-main.js           MAIN-world bridge for Rippling React components
  candidate-data.json      Placeholder template — copy from private-files/ before use
  selector-overrides.json  Per-hostname CSS selector overrides
  popup.html / popup.js    Extension popup (auto-redirect toggle)

private-files/             Gitignored — personal data files go here
  candidate-data.json      Real candidate data (copied to autofill-chrome-extension/ locally)
  resume-template.json     Personal version of the template (pre-filled)

package.json               Playwright dependency (npm install from repo root)
node_modules/              Playwright runtime

~/Documents/job-application-automation/   (runtime data, not in repo)
  job_tracker.db           SQLite tracker (source of truth; WAL -wal/-shm sidecars)
  job_tracker.csv          Legacy CSV (kept after one-time migration; no longer written)
  autofill_issues.md
  resume-template.json     Personal template — filled in during setup
  CVs/base/Base-CV.html
  CVs/tailored/{job_id}/
    resume.json            Tailored structured data (model output)
    {First-Last}.html      Rendered HTML (render-cv.js output)
    {First-Last}.pdf       Rendered PDF (render-cv.js output)
```

---

## Status lifecycle

| Status | Set by | Meaning |
|---|---|---|
| `new` | Scraper | Just found, not yet assessed |
| `skipped` | Tailoring | Underqualified or wrong domain |
| `tailored` | Tailoring | PDF ready, awaiting submission |
| `tailor_error` | Tailoring | PDF render failed |
| `applied` | Submission | Form filled, stopped before submit |
| `submit_error` | Submission | Login wall, upload fail, etc. |
