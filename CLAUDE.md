# Job Application Automation

End-to-end pipeline that scrapes jobs, tailors the resume per role, and fills
application forms — stopping before the submit button.

---

## Pipeline overview

```
scraper  →  CSV (status="new")
         →  tailoring Cowork  →  CSV (status="tailored")  +  tailored PDF
         →  submission Cowork →  CSV (status="applied")   +  form filled, waiting for manual submit
```

Central state lives entirely in `~/Documents/job-application-automation/job_tracker.csv`.
No database. The `status` column drives every step.

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
- `CSV_PATH` — `~/Documents/job-application-automation/job_tracker.csv`

Each new job appended with `status = "new"`. `job_id` is an MD5 of the URL.

---

### 2. Resume Tailoring (`tailoring/`)

Two Claude Code prompts — use the right one for the task:

| Prompt | Use case |
|---|---|
| `COWORK_PROMPT.txt` | Batch: reads CSV, processes all `status="new"` rows (up to 15) |
| `TAILOR_PROMPT.txt` | Single job: paste/give a URL or raw JD text |

**How it works:**
Cowork reads the base CV and `candidate_context.md`, qualifies the role, and writes a tailored
`resume.json`. The `render-cv.js` script then converts that JSON to HTML + PDF via Playwright.
The model never generates HTML directly — only structured data.

**How to run (Claude cowork):**
1. Open `~/Documents/job-application-automation` in Cowork.
2. Paste your personalized `COWORK_PROMPT.txt`, or `TAILOR_PROMPT.txt` followed by the job
   description, from `private-files/{timestamp}-generated-prompts/`. The `tailoring/` versions are
   generic templates; setup generates personalized copies into that gitignored folder.

**Setup (one-time):**
```bash
# Install Playwright (run from repo root)
npm install playwright && npx playwright install chromium
```
Also create `~/Documents/job-application-automation/resume-template.json` — copy the generic
template from `tailoring/resume-template.json` and fill in your personal info. See the prompts'
SETUP comment for details.

**Key files:**
- `tailoring/Base-CV.html` — base CV template (also deployed to `~/Documents/job-application-automation/CVs/base/`)
- `tailoring/candidate_context.md` — authoritative background facts not in the CV
- `tailoring/render-cv.js` — converts `resume.json` → `{First-Last}.html` + `{First-Last}.pdf`
- `scripts/apply/staged-apply.py` — after tailoring, walks the most recent tailored CVs (up to 15) one at a time: opens each job's apply URL (looked up in the CSV by `job_id`) in the default browser and opens the CV folder. Asks once which OS you're on (WINDOWS/LINUX/MAC) and waits for Enter between jobs. Run with `python3.11 scripts/apply/staged-apply.py` (`--count N` to change the batch size). See `scripts/apply/README.md`
- `~/Documents/job-application-automation/resume-template.json` — personal data template (pre-filled, gitignored)
- Tailored output: `~/Documents/job-application-automation/CVs/tailored/{job_id}/resume.json` + `.{html,pdf}`

---

### 3. Application Submission (`application/`)

Claude Cowork workflow that opens application tabs, triggers the autofill
extension, handles missed fields, uploads the tailored PDF, and stops at the
submit button — never clicking it.

**How to run:**
1. Paste `application/SUBMISSION_PROMPT.md` as your prompt in Claude Cowork.
2. Cowork reads the CSV, takes up to 15 `status="tailored"` rows, opens them
   in Chrome (groups of 3), and processes each form.

**What Cowork does:**
- Triggers the autofill extension via body data attributes (see below).
- Uploads `CVs/tailored/{job_id}/{candidate-name}.pdf` via `mcp__claude-in-chrome__file_upload`.
- Fills any fields the extension missed (years exp, salary, notice period, etc.).
- Stops at the submit button and alerts you.
- Updates CSV status and appends missed-field bugs to `autofill_issues.md`.

**Hard constraints:**
- NEVER click submit. NEVER log in. NEVER write a cover letter.
- Only process rows where `status == "tailored"`.

---

### 4. Autofill Chrome Extension (`autofill-chrome-extension/`)

Manifest V3 content script that fills job application forms when triggered by
Cowork via DOM data attributes.

**Install (load unpacked):**
1. Open `chrome://extensions`, enable Developer Mode.
2. Click "Load unpacked" and select `autofill-chrome-extension/`.

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
  CLAUDE.md                Scraper-specific guidance

tailoring/
  COWORK_PROMPT.txt        Batch tailoring prompt (reads CSV)
  TAILOR_PROMPT.txt        Single-job tailoring prompt
  render-cv.js             Converts resume.json -> HTML + PDF via Playwright
  resume-template.json     Generic template (copy to ~/Documents/…, fill in personal info)
  Base-CV.html             Base CV (HTML source)
  Base-CV.pdf              Base CV (PDF reference copy)
  candidate_context.md     Background facts for tailoring

scripts/
  README.md                Index of helper scripts
  apply/
    staged-apply.py        Staged apply: opens each tailored job's apply URL + CV folder, one at a time
    README.md              What the apply script does and how to run it
  linkedin-skills/
    scrape-linkedin-skills.js  Setup helper: scrapes full per-role skills from LinkedIn (MCP truncates these)
    README.md              What the scraper does and how to run it

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
  {timestamp}-generated-prompts/   Personalized COWORK/TAILOR prompts (paste into Cowork)

package.json               Playwright dependency (npm install from repo root)
node_modules/              Playwright runtime

~/Documents/job-application-automation/   (runtime data, not in repo)
  job_tracker.csv
  autofill_issues.md
  resume-template.json     Personal template — filled in during setup
  CVs/base/Base-CV.html
  CVs/tailored/{job_id}/
    resume.json            Tailored structured data (model output)
    {First-Last}.html      Rendered HTML (render-cv.js output)
    {First-Last}.pdf       Rendered PDF (render-cv.js output)
```

---

## CSV status lifecycle

| Status | Set by | Meaning |
|---|---|---|
| `new` | Scraper | Just found, not yet assessed |
| `skipped` | Tailoring | Underqualified or wrong domain |
| `tailored` | Tailoring | PDF ready, awaiting submission |
| `tailor_error` | Tailoring | PDF render failed |
| `applied` | Submission | Form filled, stopped before submit |
| `submit_error` | Submission | Login wall, upload fail, etc. |
