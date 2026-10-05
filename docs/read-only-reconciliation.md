# Read-only reconciliation

This stage consumes an existing reviewed `issues.json`. It does not run the DOCX parser,
create an import payload, choose a winning duplicate, or change Linear.

## Collect a live snapshot through the available Linear connector

`scripts/linear_snapshot.cjs` exports `collectLinearSnapshot(read, options)`.
The host supplies the connector transport. Only these operations are allowed:
`get_project`, `get_workspace`, `list_issues`, `get_issue`.
For the Codex Linear connector, map them to `mcp__codex_apps__linear_<operation>`.
No credentials need to be placed in the repository.

```javascript
const {collectLinearSnapshot} = require('./scripts/linear_snapshot.cjs');
const snapshot = await collectLinearSnapshot(
  (operation, args) => connectorRead(operation, args),
  {
    project: 'GRANDAR MVP',
    expectedProjectId: '838d04c1-36b9-4cd8-adc5-765fa378f10b',
    pageSize: 50,
  }
);
// Host writes JSON.stringify(snapshot) to a NEW local snapshot file exclusively.
```

`connectorRead` is the host's read-tool bridge, not an included standalone API client.
The snapshot includes workspace/project/team evidence, raw paginated list responses,
full issue descriptions, native blocking relations, timestamps and read errors.
All pages use the resolved project UUID and include archived issues. Repeated cursors,
overlapping issue IDs, incorrect destinations and pagination failures stop collection.
Every listed issue is hydrated with `includeRelations: true`; list descriptions alone
are insufficient. Detail failures are recorded instead of treated as empty content.
Incomplete identity coverage makes all task classifications conflicts: an unread card
could hide a duplicate even when another matching card is available.
This is a point-in-time observation, not a transactional snapshot. Changes detected
between list and detail reads become conflicts; concurrent changes after reads cannot
be excluded without another snapshot.

## Generate a report from the saved snapshot

Node.js 18+; no third-party packages. The CLI is offline and has no write path to Linear.
The output parent must exist and the output directory itself must NOT exist.

```powershell
node scripts/reconcile.cjs --draft output/grandar-demo-20260921-review-01/issues.json --snapshot output/grandar-reconciliation-20260921-01/linear-snapshot.json --out output/grandar-reconciliation-20260921-01/report --project-id 838d04c1-36b9-4cd8-adc5-765fa378f10b
node --test tests/reconcile.test.cjs
```

Use a new run directory for each subsequent snapshot/report. The report directory contains
`reconciliation.md`, `reconciliation.json`, and immutable input copies `draft-input.json`
and `linear-snapshot.json`. SHA-256 hashes bind the report to the exact inputs.
The original draft and earlier runs are not overwritten.

## Classification and comparison rules

- `missing`: no explicit Task ID match in a completely enumerated, hydrated destination.
- `unchanged`: all comparable fields match. This does **not** claim equality of unmapped estimate.
- `changed`: at least one comparable field differs, with expected/actual values and content-section diffs.
- `conflict`: duplicate source/remote Task IDs, disagreeing identity markers, source-key mismatch,
  incomplete reads, archived matches, ambiguous milestone/dependency mapping, or detected read drift.

Identity comes from an anchored title prefix such as `T-M1-001 — ...` or a dedicated
`Task ID: T-M1-001` / `task_id: T-M1-001` line. Arbitrary Task IDs in dependency text
never identify an issue. No fuzzy title matching is attempted. Duplicate candidates
are all listed and their fields remain `not_compared`, because none is authoritative.
When the remote source-project marker is absent, the explicit user-selected destination
and Task ID form a comparison candidate, with a provenance note. This fallback is not
a publication/synchronization key. Conflicting explicit source keys are rejected.

Title comparison removes only the recognized Task ID prefix. Content comparison handles
the existing draft layout and the board's Markdown metadata and eight named sections.
Known headings, bullet/unchecked-box wrappers, reference/dependency label wrappers and
line endings normalize; words, internal spacing, punctuation and checked boxes remain.
Extra or unrecognized remote content is retained as a difference, never dropped. This
is structural content comparison, not an AI judgment that paraphrases mean the same thing.

Labels compare as sets, including extra manual labels. Native milestones map only by a
unique exact source name, optionally prefixed by the source milestone code (`M1 — ...`).
Missing metadata is not assumed empty. Native estimate is always `unmapped` in this
minimal implementation: no hours-to-points mapping is inferred, even when numbers happen
to match. Source Expected hours and workstream O/M/P/E remain part of content comparison.

Dependencies compare directed native blocking edges against explicit `Blocking` /
`Blocked by` source declarations. Reciprocal declarations are deduplicated. Textual
conditions stay in content; they are not invented as issue relations. Missing/duplicate
or conflicting endpoints are reported; extra external edges retain the Linear identifier.
Unrelated/duplicateOf relations are not interpreted as blocking dependencies.

There is no last-synced baseline. Differences do not establish whether a remote edit or
the draft is authoritative. A reviewed-needs-changes or DRAFT source keeps that status.
There is no approval executor, create/update/publish implementation, or `sync-state` writer.

## Tests

The Node tests cover pagination, cursor loops, access/detail failures, exact destination,
identity ambiguity, duplicate Task IDs, all comparable fields, unmapped estimates,
format normalization, blocking direction/endpoints and output overwrite prevention.
Existing parser tests remain available via `python3 -m unittest discover -s tests`.
