---
name: linear-handoff
description: Prepare or execute an explicitly requested Linear handoff for reviewed Koitechs task drafts while preserving source IDs and preventing duplicates.
---

# linear-handoff

Read roles/linear-operator.md and docs/linear-handoff.md; follow their reconciliation and recovery contract.
Without an explicit remote-write request, produce the local plan only. When publication is requested, discover available Linear tools and inspect their actual schemas. Resolve real destination and metadata IDs, prepare the concrete plan, then act within the existing authorization. Do not require repeated approval for the same authorized batch.
If no connector is available, deliver local drafts and state the missing access. Do not use a different tracker as a substitute. Do not invent API payloads or say that local issues.json was imported.
