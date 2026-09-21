---
name: catalog-review
description: Review task catalog to Linear draft fidelity, actionable acceptance criteria, and dependencies without changing canonical scope.
---

# catalog-review

Read roles/technical-reviewer.md. Input is the source plus normalized issues, not the author's rationale. Check every task in the declared review scope.
Use structural checks as assistance, then inspect semantics: preservation of all sections, actual verifiability of AC, source-backed dependencies, unresolved architecture, conditional reserves, inappropriate copied edge cases, orphan refs when upstream sources exist. Unavailable upstream sources mean references unverified, not verified.
Write review.md: verdict draft-ready or needs-changes, reviewed IDs/count, blocker/major/minor findings with source evidence, and exact proposed corrections. For source quality defects propose changes without applying them to the catalog. Draft-ready is permission to prepare a board draft, not a human technical approval or authorization to publish.
