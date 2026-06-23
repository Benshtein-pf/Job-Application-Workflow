#!/usr/bin/env python3
"""Job scraper using python-jobspy. Scrapes LinkedIn and Indeed, deduplicates against
the SQLite job tracker, filters by title relevance, and inserts new results."""

import argparse
import hashlib
import random
import time

import pandas as pd
from jobspy import scrape_jobs

import sqlite as db

SEARCH_TERMS = [
    "senior backend engineer",
    "senior software engineer",
    "backend engineer",
]

SITES = ["linkedin", "indeed"]

EXCLUDE_TITLE_KEYWORDS = [
    # seniority/role level
    # wrong disciplines (still appear in LinkedIn results)
    "manager", "director", "vp", "principal", "intern", "junior", "lead", "staff",
    "qa", "quality assurance", "in tests",
    "frontend", "front-end", "front end",
    "devops", "dev ops", "mlops", "devsecops",
    "embedded",
    "security engineer", "ai research",
]

BLACKLISTED_COMPANIES: list[str] = [
    # add company names here (case-insensitive)
    "Oligo", "Unity", "Forter", "Nominal", "Mind", "Wiz", "vHive", "SentinelOne", "Terra", "Sola", "Taboola", "Navan", "Unframe", "Gong", "Coralogix"
]

ALLOWED_DISTRICTS = [
    "Tel Aviv District",  # LinkedIn format
    ", TA, IL",           # Indeed format (Tel Aviv state code)
]


def make_job_id(url: str) -> str:
    # Non-cryptographic dedup key (not a security primitive). usedforsecurity=False
    # documents that and avoids ValueError on FIPS-enabled builds.
    return hashlib.md5(url.encode(), usedforsecurity=False).hexdigest()


def title_is_relevant(title: str) -> bool:
    lower = title.lower()
    return not any(kw in lower for kw in EXCLUDE_TITLE_KEYWORDS)


def location_is_allowed(location: str) -> bool:
    return any(district in location for district in ALLOWED_DISTRICTS)


INDEED_SEARCH_TERM = 'title:(backend OR fullstack OR "full stack") engineer'


def _do_scrape(site: str, term: str, hours_old: int) -> pd.DataFrame | None:
    """Single scrape_jobs call with error handling. Returns None on failure."""
    try:
        df = scrape_jobs(
            site_name=[site],
            search_term=term,
            location="Tel Aviv, Israel",
            results_wanted=100,
            hours_old=hours_old,
            job_type="fulltime",
            linkedin_fetch_description=True,
            country_indeed="israel",
        )
    except Exception as e:
        print(f"  WARNING: {site} failed for '{term}': {e}")
        return None

    if df.empty:
        print(f"  WARNING: {site} returned 0 results for '{term}'")
        return None

    return df


def scrape_all(hours_old: int) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []

    # LinkedIn: one call per search term
    for term in SEARCH_TERMS:
        print(f"Scraping linkedin for '{term}'...")
        df = _do_scrape("linkedin", term, hours_old)
        if df is not None:
            df["platform"] = "linkedin"
            frames.append(df)
            print(f"  Got {len(df)} results")
        time.sleep(random.uniform(2, 4))

    # Indeed: single title-scoped query to avoid irrelevant results
    # (Indeed ignores job_type when hours_old is set, so a broad keyword search
    #  returns QA, firmware, DevOps etc. — title: operator restricts to role type)
    print(f"Scraping indeed (title query)...")
    df = _do_scrape("indeed", INDEED_SEARCH_TERM, hours_old)
    if df is not None:
        df["platform"] = "indeed"
        frames.append(df)
        print(f"  Got {len(df)} results")

    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


def run(full_sync: bool) -> None:
    hours_old = 168 if full_sync else 24
    print(f"Running {'full sync (168h)' if full_sync else 'incremental (24h)'}\n")

    raw = scrape_all(hours_old)
    total_scraped = len(raw)
    if total_scraped == 0:
        print("\nNo results scraped.")
        return

    # Normalise job_url to string and drop rows without one
    raw["job_url"] = raw["job_url"].astype(str)
    raw = raw[raw["job_url"].ne("") & raw["job_url"].ne("nan")].copy()

    # Deduplicate within the scraped batch itself
    before_dedup = len(raw)
    raw.drop_duplicates(subset="job_url", inplace=True)
    within_batch_dupes = before_dedup - len(raw)

    conn = db.get_connection()
    db.init_db(conn)
    existing = db.existing_urls(conn)
    is_new = ~raw["job_url"].isin(existing)
    dupes = int((~is_new).sum())
    new = raw[is_new].copy()

    # Relevance filter
    if not new.empty:
        relevant_mask = new["title"].fillna("").apply(title_is_relevant)
        filtered_out = int((~relevant_mask).sum())
        new = new[relevant_mask].copy()
    else:
        filtered_out = 0

    # Location filter
    if not new.empty:
        location_mask = new["location"].fillna("").apply(location_is_allowed)
        filtered_location = int((~location_mask).sum())
        new = new[location_mask].copy()
    else:
        filtered_location = 0

    # Company blacklist filter
    if not new.empty and BLACKLISTED_COMPANIES:
        blacklist_lower = [c.lower() for c in BLACKLISTED_COMPANIES]
        blacklist_mask = ~new["company"].fillna("").str.lower().isin(blacklist_lower)
        filtered_blacklist = int((~blacklist_mask).sum())
        new = new[blacklist_mask].copy()
    else:
        filtered_blacklist = 0

    # Build rows to insert
    today = pd.Timestamp.now().strftime("%Y-%m-%d")
    out = pd.DataFrame({
        "job_id": new["job_url"].apply(make_job_id),
        "date_found": today,
        "company": new["company"].fillna(""),
        "title": new["title"].fillna(""),
        "location": new["location"].fillna(""),
        "is_remote": new["is_remote"].fillna(False),
        "job_url": new["job_url"],
        "apply_url": new["job_url_direct"].fillna("") if "job_url_direct" in new.columns else "",
        "platform": new["platform"],
        "description": new["description"].fillna("") if "description" in new.columns else "",
        "status": "new",
        "applied_date": "",
        "notes": "",
    })

    # Insert into the SQLite tracker (INSERT OR IGNORE dedups on job_id / job_url)
    inserted = 0
    if not out.empty:
        rows = []
        for rec in out[db.COLUMNS].to_dict("records"):
            rec["is_remote"] = int(bool(rec["is_remote"]))  # numpy bool -> 0/1 int
            rows.append(tuple(rec[col] for col in db.COLUMNS))
        inserted = db.insert_jobs(conn, rows)
    conn.close()

    # Summary
    added = len(out)
    print(f"\n{'='*60}")
    print(f"Total scraped:          {total_scraped}")
    print(f"Within-batch dupes:     {within_batch_dupes}")
    print(f"Skipped (CSV dupes):    {dupes}")
    print(f"Filtered out (title):   {filtered_out}")
    print(f"Filtered out (location):{filtered_location}")
    print(f"Filtered out (company): {filtered_blacklist}")
    print(f"New jobs added:         {added}")
    print(f"  (check: {within_batch_dupes} + {dupes} + {filtered_out} + {filtered_location} + {filtered_blacklist} + {added} = {within_batch_dupes + dupes + filtered_out + filtered_location + filtered_blacklist + added} / {total_scraped})")
    print(f"{'='*60}")
    if inserted != added:
        print(f"NOTE: {added - inserted} of {added} already present in DB (INSERT OR IGNORE skipped them)")
    if added:
        print("\nNew jobs:")
        for _, row in out.iterrows():
            print(f"  [{row['company']}] — {row['title']} — {row['job_url']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape jobs via JobSpy")
    parser.add_argument("--full-sync", action="store_true", help="Scrape last 168 hours instead of 24")
    args = parser.parse_args()
    run(full_sync=args.full_sync)
