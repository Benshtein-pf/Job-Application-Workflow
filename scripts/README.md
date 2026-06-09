# scripts

Helper scripts for the job-application pipeline, grouped by purpose. Each
subdirectory has its own README with full details.

| Directory | What it's for |
|---|---|
| [`apply/`](apply/README.md) | The manual **apply** step that runs *after* tailoring — walks the most recent tailored CVs one at a time, opening each job's apply URL and CV folder. |
| [`linkedin-skills/`](linkedin-skills/README.md) | **Setup helper** — scrapes the complete, per-role-attributed skills list from a LinkedIn profile (the data the LinkedIn MCP truncates), used to build `candidate_context.md`. |
