---
name: catalog-to-linear
description: Prepare Linear task drafts from the seventh Koitechs PDD task catalog and coordinate intake, review, and authorized handoff.
---

# catalog-to-linear

Read project AGENTS.md, README.md and roles/coordinator.md. Resolve paths from the project root (three levels above this skill folder).
1. Use catalog-intake on the user-selected document; if several unrelated inputs exist, ask which one to process. Do not use newest modification time as authority.
2. Choose a stable lowercase client/project slug, unique to that project (e.g. acme-portal). Reuse it for later versions of the same project; use grandar-demo only for the bundled demo. Run scripts/catalog.py SOURCE --out output/PROJECT-RUN --project-key PROJECT. Use a new output directory per run. Inspect issues.json, checks.json and preview.md. A parser error is a format/content issue, not permission to drop tasks. Find a Python 3.10+ interpreter in the environment; if unavailable, explain the installation needed. Do routine execution yourself, not by asking a nontechnical user to run terminal commands.
3. Delegate source/output comparison to agents/analyst.md and independent semantic review to agents/reviewer.md when available. Each gets separate output files. Review only after intake exists. Otherwise execute sequential roles and disclose that review is not independent.
4. Use catalog-review to record unresolved findings; correct extraction defects, not product scope. Keep source immutable. Re-run checks after edits.
5. Use linear-handoff for a local plan or explicitly authorized remote operation. Return links to preview, findings and actual published issues when applicable. Never equate dry run with publication.
