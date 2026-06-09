# scripts/linkedin-skills

Pull the **complete, per-role-attributed skills list** from a LinkedIn profile —
used during setup to populate `candidate_context.md` accurately.

---

## Why this exists

The `linkedin-scraper-mcp` server (`get_my_profile` / `get_person_profile`) only
returns the **top ~10 skills** and collapses each role's list as `+N skills`. It
has **no "full" mode** and no flat all-skills option, regardless of `max_scrolls`
(confirmed against the installed source and the upstream repo). So it cannot tell
you which skills belong to which role beyond the first handful.

This script gets the rest by scraping the profile's `/details/skills/` page
directly with Playwright, **reusing the session the MCP already authenticated** —
no second login.

## `scrape-linkedin-skills.js`

What it does:

1. Copies the MCP's session profile (`~/.linkedin-mcp/profile`) to a temp dir so
   the original is never touched, and strips lock files so the copy is reusable.
2. Launches this repo's bundled Playwright Chromium (same revision as the
   profile, so the stored session loads) against the copy.
3. Navigates to `https://www.linkedin.com/in/<username>/details/skills/`.
4. The page has no "Show more" button — skills lazy-load in a virtualized list
   under four category tabs (All / Tools & Technologies / Industry Knowledge /
   Other Skills). The script discovers those tabs **by shape, not English text**
   (the UI may be localized, e.g. Hebrew), clicks each, scrolls to load, and
   **unions** the results.
5. Emits each skill with its role/company attribution, then deletes the temp copy
   (it holds live session cookies).

### Prerequisites

- The LinkedIn MCP must be **authenticated** (a session exists at
  `~/.linkedin-mcp/profile`). See setup Step 2.
- **Close the MCP browser first** so the session profile is free — call the MCP
  `close_session` tool (or stop the server) before running.
- Playwright Chromium installed (`npm install playwright && npx playwright install
  chromium`, from the repo root — same dependency `render-cv.js` uses).

### Usage

```bash
node scripts/linkedin-skills/scrape-linkedin-skills.js <username> [options]
```

`<username>` is the profile handle from `linkedin.com/in/<username>` (e.g.
`jane-doe`). **Required — never hardcode it; pass the relevant/authenticated
user's handle.** Derive it from the `url` that `get_my_profile` resolves off
`/in/me/`.

| Flag | Default | Meaning |
|---|---|---|
| `--profile PATH` | `~/.linkedin-mcp/profile` | Session profile dir to copy |
| `--out PATH` | stdout | Write the JSON result here |
| `--headed` | off | Show the browser (debugging); default is headless |
| `--no-sandbox` | off | Disable the Chromium sandbox. Less secure — only if the sandboxed launch fails (root, restricted user namespaces); the script prints a hint when that happens |

### Output

```json
{
  "username": "jane-doe",
  "count": 35,
  "skills": [
    { "skill": "Docker", "attribution": "3 experiences at Taboola and 2 other companies" },
    { "skill": "OpenTelemetry", "attribution": "Site Reliability Engineer at Israeli Navy" }
  ]
}
```

The `attribution` is the role/company line LinkedIn shows under each skill — that
is the per-role mapping setup uses to build each role's tech stack independently.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `2` | Auth wall — stored session expired/rejected; re-login the MCP and retry |
| `1` | Other error (missing username, profile, Playwright, etc.) |

### Caveats

LinkedIn's markup is obfuscated, localized, and changes over time; this scraper
is inherently more fragile than a stable API and may need updating if the skills
page layout changes.
