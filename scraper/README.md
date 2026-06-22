# job-scraper

Scrapes LinkedIn and Indeed for backend/software engineering jobs in Tel Aviv District, deduplicates against a local SQLite tracker, and inserts new results.

## Requirements

- Python 3.11
- `python-jobspy`
- `pandas`

```bash
pip install python-jobspy pandas
```

## Usage

```bash
# Incremental run — scrapes last 24 hours
python3.11 main.py

# Full sync — scrapes last 168 hours (7 days)
python3.11 main.py --full-sync
```

Results are inserted into `~/Documents/job-application-automation/job_tracker.db` (SQLite).
Migrate an existing CSV once with `python3 migrate_csv_to_sqlite.py`.

## What it does

- Scrapes **LinkedIn** with 3 search terms: `senior backend engineer`, `senior software engineer`, `backend engineer`
- Scrapes **Indeed** with a title-scoped query to avoid irrelevant results: `title:(backend OR fullstack OR "full stack") engineer`
- Deduplicates against existing `job_url` entries in the DB (`INSERT OR IGNORE`)
- Filters out irrelevant titles (managers, frontend, DevOps, QA, etc.)
- Filters to Tel Aviv District only
- Prints a summary with a count check

## Customization

All configuration lives at the top of `main.py`.

### Change the output file

```python
# scraper/sqlite.py
DB_PATH = Path.home() / "Documents" / "job-application-automation" / "job_tracker.db"
```

Point this to any path you like.

### Change the location

In `_do_scrape`, set `location` to your city:

```python
location="Tel Aviv, Israel",
```

Then update `ALLOWED_DISTRICTS` to match how LinkedIn and Indeed format that location:

```python
ALLOWED_DISTRICTS = [
    "Tel Aviv District",  # LinkedIn format
    ", TA, IL",           # Indeed format (state code)
]
```

LinkedIn typically uses `"<District/Region name>"`. Indeed uses a state/region code suffix like `", CA, US"` for California or `", ON, CA"` for Ontario. Run the script once and check the raw `location` values stored in the DB (e.g. `python3 sqlite.py list --limit 5`) to confirm the exact format for your area.

For Indeed, also update `country_indeed` in `_do_scrape`:

```python
country_indeed="israel",
```

Supported country values are listed in the [python-jobspy docs](https://github.com/Bunsly/JobSpy).

### Change the search terms

**LinkedIn** — edit `SEARCH_TERMS`. Each entry triggers a separate scrape call:

```python
SEARCH_TERMS = [
    "senior backend engineer",
    "senior software engineer",
    "backend engineer",
]
```

**Indeed** — edit `INDEED_SEARCH_TERM`. Indeed's `title:` operator restricts matches to the job title, which prevents broad keyword searches from returning irrelevant roles (QA, DevOps, etc.). Adjust the OR terms to match your target roles:

```python
INDEED_SEARCH_TERM = 'title:(backend OR fullstack OR "full stack") engineer'
```

### Filter out irrelevant titles

Add or remove keywords in `EXCLUDE_TITLE_KEYWORDS`. Any job whose title contains one of these strings (case-insensitive) is dropped:

```python
EXCLUDE_TITLE_KEYWORDS = [
    "manager", "director", "vp", "lead",
    "frontend", "devops", "qa",
    # add your own...
]
```

### Adjust scrape window

The default incremental run scrapes the last 24 hours. `--full-sync` scrapes the last 168 hours (7 days). To change these, edit the `hours_old` line in `run()`:

```python
hours_old = 168 if full_sync else 24
```

## Tracker columns

| Column | Description |
|---|---|
| `job_id` | MD5 hash of the job URL |
| `date_found` | Date the job was scraped |
| `company` | Company name |
| `title` | Job title |
| `location` | Job location |
| `is_remote` | Whether the job is remote |
| `job_url` | Link to the job posting |
| `platform` | `linkedin` or `indeed` |
| `status` | Tracking status (default: `new`) |
| `applied_date` | Date you applied |
| `notes` | Free-form notes |
