/* Offline comparator for a complete read-only Linear connector snapshot. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const TASK = 'T-M\\d+-\\d+';
const SECTIONS = ['Контекст і причина', 'Обсяг роботи', 'Технічний підхід',
  'Критерії приймання', 'Граничні сценарії', 'Поза обсягом', 'Залежності', 'Посилання'];
const META = ['Milestone', 'Модуль', 'Статус обсягу', 'Expected', 'Оцінка', 'Board labels'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clean = s => String(s ?? '').replace(/\r\n?/g, '\n').normalize('NFC').trim();
const sorted = values => [...new Set(values)].sort();
const detailComplete = issue => issue._detail_complete === true && !issue._changed_during_read
  && typeof issue.description === 'string' && !/truncated, use [`']?get_issue/i.test(issue.description);

function identityMarker(line) {
  const text = clean(line).replace(/\*\*/g, '');
  return new RegExp('^(?:Task ID|task_id):\\s*' + TASK + '\\s*$').test(text)
    || /^source_project_key:\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*$/.test(text);
}

function identity(issue) {
  const ids = [];
  const prefix = clean(issue.title).match(new RegExp('^\\[?(' + TASK + ')\\]?(?=\\s|$|[:—–])'));
  if (prefix) ids.push(prefix[1]);
  for (const line of clean(issue.description).split('\n')) {
    const marker = line.replace(/\*\*/g, '').match(new RegExp('^\\s*(?:Task ID|task_id):\\s*(' + TASK + ')\\s*$'));
    if (marker) ids.push(marker[1]);
  }
  const keys = [...clean(issue.description).replace(/\*\*/g, '').matchAll(/^\s*source_project_key:\s*(\S+)\s*$/gm)].map(m => m[1]);
  return {ids: sorted(ids), source_keys: sorted(keys)};
}

function titleContent(issue) {
  return clean(issue.title).replace(new RegExp('^\\[?' + TASK + '\\]?\\s*(?:[—–:|-]\\s*)?'), '');
}

function plainLine(line) {
  // Only known paragraph/list wrappers; words, internal whitespace and checked boxes survive.
  return clean(line).replace(/^(?:•\s+|□\s+|[-*]\s+\[ \]\s+|[-*]\s+)/, '');
}

function sectionLines(name, lines) {
  const result = [];
  for (const raw of lines) {
    const line = plainLine(raw);
    if (!line) continue;
    if (name === 'Посилання') {
      const match = line.match(/^(?:\*\*)?(User Stories|Екрани|Факти|Припущення та питання)(?::?\*\*)?:?\s+(.+)$/);
      if (match) { result.push(match[1], match[2]); continue; }
    }
    if (name === 'Залежності') {
      const match = line.match(/^(?:\*\*)?(Blocking|Blocked by)(?::?\*\*)?:?\s+(.+)$/);
      if (match) { result.push(match[1], match[2]); continue; }
    }
    result.push(line);
  }
  return result;
}

function localContent(issue) {
  const lines = clean(issue.description).split('\n');
  if (!equal(lines.slice(1, 5), META.slice(0, 4)) || !lines[9]?.startsWith('Оцінка'))
    throw new Error('Unsupported draft metadata layout: ' + issue.task_id);
  const estimate = lines[9].match(/^Оцінка\s+(.+?)\s*Board labels\s+(.+)$/);
  if (!estimate) throw new Error('Unsupported source estimate: ' + issue.task_id);
  const metadata = Object.fromEntries(META.slice(0, 4).map((name, i) => [name, clean(lines[5 + i])]));
  metadata['Оцінка'] = clean(estimate[1]);
  metadata['Board labels'] = sorted(estimate[2].split(/[,;\s]+/).filter(Boolean));
  const sections = {};
  const parsedSections = {};
  let active;
  for (const line of lines.slice(10)) {
    const heading = line.replace(/^■\s*/, '');
    if (SECTIONS.includes(heading)) { active = heading; parsedSections[heading] = []; }
    else if (active) parsedSections[active].push(line);
  }
  for (const name of SECTIONS) {
    if (!Array.isArray(issue.sections?.[name])) throw new Error('Missing draft section: ' + name);
    sections[name] = sectionLines(name, issue.sections[name]);
    if (!equal(sections[name], sectionLines(name, parsedSections[name] || [])))
      throw new Error('Draft description/sections disagree: ' + issue.task_id + ' ' + name);
  }
  return {metadata, sections, extra: []};
}

function remoteContent(issue) {
  const metadata = {}, sections = {}, extra = [];
  let active = null;
  for (const raw of clean(issue.description).split('\n')) {
    if (!raw.trim()) continue;
    const line = clean(raw);
    if (identityMarker(line)) continue;
    const heading = line.replace(/^#{1,6}\s+|^■\s*/, '');
    if (SECTIONS.includes(heading)) {
      if (Object.hasOwn(sections, heading)) extra.push('Duplicate heading: ' + heading);
      active = heading; sections[heading] ??= []; continue;
    }
    if (active) { sections[active].push(line); continue; }
    const meta = line.replace(/\*\*/g, '').match(/^([^:]+):\s*(.*)$/);
    if (meta && META.includes(meta[1])) {
      if (Object.hasOwn(metadata, meta[1])) extra.push('Duplicate metadata: ' + line);
      metadata[meta[1]] = meta[1] === 'Board labels'
        ? sorted(meta[2].split(/[,;\s]+/).filter(Boolean)) : clean(meta[2]);
    } else extra.push(line);
  }
  for (const name of Object.keys(sections)) sections[name] = sectionLines(name, sections[name]);
  return {metadata, sections, extra};
}

function contentDiff(expected, actual) {
  const differences = [];
  for (const group of ['metadata', 'sections']) {
    for (const key of sorted([...Object.keys(expected[group]), ...Object.keys(actual[group])])) {
      const left = expected[group][key] ?? null, right = actual[group][key] ?? null;
      if (!equal(left, right)) differences.push({path: group + '.' + key, expected: left, actual: right});
    }
  }
  if (!equal(expected.extra, actual.extra)) differences.push({path: 'extra', expected: expected.extra, actual: actual.extra});
  return differences;
}

function sourceEdges(issues) {
  const edges = new Set(), unresolved = [];
  for (const issue of issues) {
    let direction;
    for (const raw of issue.sections['Залежності']) {
      const line = plainLine(raw);
      const heading = line.match(/^(Blocking|Blocked by)(?:\s|$)/);
      if (heading) direction = heading[1];
      const payload = heading ? line.slice(heading[0].length).trim() : line;
      const prefix = payload.match(new RegExp('^' + TASK + '(?:[,;\\s]+' + TASK + ')*'));
      const ids = prefix ? [...prefix[0].matchAll(/\bT-M\d+-\d+\b/g)].map(m => m[0]) : [];
      const otherIds = [...payload.slice(prefix?.[0].length || 0).matchAll(/\bT-M\d+-\d+\b/g)];
      if (otherIds.length) unresolved.push({task_id: issue.task_id, text: line});
      if (!heading && !prefix) direction = null;
      for (const target of ids) {
        if (!direction) unresolved.push({task_id: issue.task_id, text: line});
        else edges.add(JSON.stringify(direction === 'Blocking' ? [issue.task_id, target] : [target, issue.task_id]));
      }
    }
  }
  return {edges: [...edges].map(JSON.parse), unresolved};
}

function field(expected, actual) {
  return {status: equal(expected, actual) ? 'unchanged' : 'changed', expected, actual};
}

function reconcile(draft, snapshot, expectedProjectId) {
  if (!expectedProjectId) throw new Error('Explicit destination project ID required');
  if (!draft.source_project_key || !Array.isArray(draft.issues)) throw new Error('Invalid draft');
  if (snapshot.project?.id && snapshot.project.id !== expectedProjectId) throw new Error('Snapshot destination mismatch');
  const returnedIssues = snapshot.issues || [];
  const issues = returnedIssues.filter(issue => issue.archivedAt == null);
  const archivedIgnored = returnedIssues.length - issues.length;
  const localIndex = new Map(), remoteIndex = new Map(), byRemoteId = new Map();
  const globalProblems = [];
  if (!snapshot.enumeration_complete || !snapshot.workspace?.id || snapshot.project?.id !== expectedProjectId)
    globalProblems.push('incomplete_project_enumeration');
  if (snapshot.include_archived !== true) globalProblems.push('archived_inventory_not_included');
  // Validate snapshot pagination evidence too; a hand-edited complete flag is insufficient.
  const pages = snapshot.pages || [], cursors = new Set(), pageIds = new Set();
  if (!pages.length || pages.at(-1).hasNextPage !== false) globalProblems.push('pagination_not_complete');
  pages.forEach((page, index) => {
    if (!Array.isArray(page.issues) || (index < pages.length - 1 && page.hasNextPage !== true)
      || (index === 0 ? page.request_cursor !== null : page.request_cursor !== pages[index - 1].cursor))
      globalProblems.push('invalid_pagination_chain');
    if (page.hasNextPage && (!page.cursor || cursors.has(page.cursor))) globalProblems.push('invalid_pagination_cursor');
    if (page.cursor) cursors.add(page.cursor);
    for (const issue of page.issues || []) {
      const id = issue.uuid || issue.id;
      if (!id || pageIds.has(id)) globalProblems.push('duplicate_remote_record');
      pageIds.add(id);
    }
  });
  if (pageIds.size !== returnedIssues.length || returnedIssues.some(i => !pageIds.has(i.uuid || i.id))) globalProblems.push('snapshot_inventory_mismatch');
  const projectTeams = new Set((snapshot.project?.teams || []).map(t => t.id));
  for (const issue of draft.issues) {
    if (!new RegExp('^' + TASK + '$').test(issue.task_id) || issue.source_project_key !== draft.source_project_key)
      throw new Error('Invalid draft identity');
    localIndex.set(issue.task_id, [...(localIndex.get(issue.task_id) || []), issue]);
  }
  for (const issue of issues) {
    if (issue.projectId !== expectedProjectId || !projectTeams.has(issue.teamId)) globalProblems.push('remote_destination_mismatch');
    for (const id of sorted([issue.id, issue.uuid].filter(Boolean))) {
      if (byRemoteId.has(id)) globalProblems.push('duplicate_remote_record');
      byRemoteId.set(id, issue);
    }
    for (const taskId of identity(issue).ids) remoteIndex.set(taskId, [...(remoteIndex.get(taskId) || []), issue]);
  }
  const dependencies = sourceEdges(draft.issues), results = [];
  const identityCoverageComplete = issues.every(detailComplete);
  for (const local of draft.issues) {
    const taskId = local.task_id, candidates = remoteIndex.get(taskId) || [];
    const result = {task_id: taskId, title: local.title, status: null, reasons: [...new Set(globalProblems)],
      candidates: candidates.map(i => ({id: i.id, uuid: i.uuid, url: i.url, title: i.title})),
      fields: Object.fromEntries(['title', 'description', 'milestone', 'labels', 'dependencies'].map(name =>
        [name, {status: 'not_compared', reason: 'No unique, complete, unambiguous remote match yet'}])),
      changed_fields: [], unsupported_fields: ['estimate']};
    result.fields.estimate = {status: 'unmapped', expected_hours: localContent(local).metadata.Expected,
      actual: candidates.length === 1 ? (candidates[0].estimate ?? null) : null,
      actual_returned: candidates.length === 1 && candidates[0]._native_estimate_returned === true,
      reason: 'No explicit Expected-hours to native Linear estimate mapping; omitted value is not assumed zero.'};
    if (localIndex.get(taskId).length > 1) result.reasons.push('duplicate_draft_task_id');
    if (candidates.length > 1) result.reasons.push('duplicate_remote_task_id');
    if (!identityCoverageComplete) result.reasons.push('incomplete_remote_identity_coverage');
    if (result.reasons.length) result.status = 'conflict';
    else if (!candidates.length) result.status = 'missing';
    else {
      const remote = candidates[0], ownership = identity(remote);
      if (ownership.ids.length !== 1) result.reasons.push('conflicting_identity_markers');
      if (ownership.source_keys.some(key => key !== draft.source_project_key)) result.reasons.push('source_project_key_mismatch');
      result.identity_basis = ownership.source_keys.length ? 'task_id_and_source_key' : 'task_id_in_explicit_destination';
      if (!ownership.source_keys.length) result.provenance_note = 'Remote has no source_project_key; destination explicitly selected by user. Not a publication key.';
      if (remote.archivedAt) result.reasons.push('matched_issue_archived');
      if (remote._changed_during_read) result.reasons.push('issue_changed_during_snapshot');
      if (!detailComplete(remote)) result.reasons.push('incomplete_issue_detail');
      if (result.reasons.length) result.status = 'conflict';
      else {
        result.fields.title = field(clean(local.title), titleContent(remote));
        const expectedContent = localContent(local);
        // An unchanged raw draft description is supported as well as the board's Markdown layout.
        const actualContent = clean(local.description) === clean(remote.description) ? expectedContent : remoteContent(remote);
        const differences = contentDiff(expectedContent, actualContent);
        result.fields.description = {status: differences.length ? 'changed' : 'unchanged', differences,
          expected_raw_sha256: hash(local.description), actual_raw_sha256: hash(remote.description)};
        if (!Array.isArray(remote.labels)) result.reasons.push('labels_not_read');
        else result.fields.labels = field(sorted(local.labels), sorted(remote.labels.map(l => typeof l === 'string' ? l : l.name)));
        const milestoneCode = taskId.split('-')[1];
        const milestoneCandidates = (snapshot.project.milestones || []).filter(m =>
          clean(m.name) === expectedContent.metadata.Milestone
          || clean(m.name) === milestoneCode + ' — ' + expectedContent.metadata.Milestone);
        if (milestoneCandidates.length !== 1) {
          result.fields.milestone = {status: 'unmapped', expected: expectedContent.metadata.Milestone,
            actual: remote.projectMilestone ?? null, reason: 'No unique exact-name project milestone mapping'};
          result.unsupported_fields.push('milestone'); result.reasons.push('milestone_mapping_ambiguous_or_missing');
        } else if (!Object.hasOwn(remote, 'projectMilestone')) {
          result.fields.milestone = {status: 'unsupported', expected: milestoneCandidates[0],
            reason: 'Native milestone field not returned; cannot assume unassigned'};
          result.unsupported_fields.push('milestone'); result.reasons.push('milestone_not_read');
        } else {
          const mapped = milestoneCandidates[0];
          result.fields.milestone = field(mapped.id, remote.projectMilestone?.id ?? null);
          result.fields.milestone.expected_name = mapped.name;
          result.fields.milestone.actual_name = remote.projectMilestone?.name ?? null;
          result.fields.milestone.mapping = 'unique exact source name, optionally prefixed by source milestone code';
        }
        const expectedEdges = dependencies.edges.filter(edge => edge.includes(taskId));
        const actualEdges = [], relationProblems = [];
        if (!remote.relations || !Array.isArray(remote.relations.blocks) || !Array.isArray(remote.relations.blockedBy))
          relationProblems.push('relations_not_read');
        else for (const [kind, relations] of [['blocks', remote.relations.blocks], ['blockedBy', remote.relations.blockedBy]]) {
          for (const relation of relations) {
            const endpoint = byRemoteId.get(relation.id);
            let endpointId = 'linear:' + relation.id;
            if (endpoint) {
              const endpointIdentity = identity(endpoint), endpointIds = endpointIdentity.ids;
              if (endpointIds.length !== 1 || (remoteIndex.get(endpointIds[0]) || []).length !== 1)
                relationProblems.push('ambiguous_dependency_endpoint:' + relation.id);
              else endpointId = endpointIds[0];
              if (!detailComplete(endpoint) || endpoint.archivedAt
                || endpointIdentity.source_keys.some(key => key !== draft.source_project_key))
                relationProblems.push('conflicting_dependency_endpoint:' + relation.id);
            }
            actualEdges.push(kind === 'blocks' ? [taskId, endpointId] : [endpointId, taskId]);
          }
        }
        for (const edge of expectedEdges) for (const endpoint of edge) {
          if ((localIndex.get(endpoint) || []).length !== 1 || (remoteIndex.get(endpoint) || []).length !== 1)
            relationProblems.push('unresolved_dependency_endpoint:' + endpoint);
          else {
            const card = remoteIndex.get(endpoint)[0], owner = identity(card);
            if (owner.ids.length !== 1 || !detailComplete(card) || card.archivedAt
              || owner.source_keys.some(key => key !== draft.source_project_key))
              relationProblems.push('conflicting_dependency_endpoint:' + endpoint);
          }
        }
        if (dependencies.unresolved.some(item => item.task_id === taskId)) relationProblems.push('unclassified_source_dependency');
        const edgeSet = edges => sorted(edges.map(JSON.stringify)).map(JSON.parse);
        result.fields.dependencies = {...field(edgeSet(expectedEdges), edgeSet(actualEdges)),
          comparison: 'native directed blocking relations only; dependency text also compared in description',
          problems: sorted(relationProblems)};
        if (relationProblems.length) {
          result.fields.dependencies.status = 'unsupported'; result.unsupported_fields.push('dependencies');
          result.reasons.push(...relationProblems);
        }
        result.changed_fields = Object.keys(result.fields).filter(name => result.fields[name].status === 'changed');
        result.status = result.reasons.length ? 'conflict' : result.changed_fields.length ? 'changed' : 'unchanged';
      }
    }
    result.comparison_complete = false; // Native estimate intentionally not comparable without user mapping.
    results.push(result);
  }
  const counts = Object.fromEntries(['missing', 'unchanged', 'changed', 'conflict'].map(s => [s, results.filter(r => r.status === s).length]));
  const changedFieldCounts = {}, unsupportedFieldCounts = {};
  for (const result of results) {
    for (const field of result.changed_fields) changedFieldCounts[field] = (changedFieldCounts[field] || 0) + 1;
    for (const field of result.unsupported_fields) unsupportedFieldCounts[field] = (unsupportedFieldCounts[field] || 0) + 1;
  }
  return {format_version: 1, mode: 'read-only-reconciliation', remote_writes: 0,
    destination: {workspace: snapshot.workspace, project_id: expectedProjectId, project_name: snapshot.project?.name,
      project_url: snapshot.project?.url, teams: snapshot.project?.teams},
    source_project_key: draft.source_project_key, source_sha256: draft.source_sha256, draft_status: draft.status,
    snapshot_started_at: snapshot.started_at, snapshot_finished_at: snapshot.finished_at,
    pagination: {pages: pages.length, complete: snapshot.enumeration_complete === true && !globalProblems.length,
      remote_issues: returnedIssues.length, include_archived: snapshot.include_archived},
    archived_ignored: archivedIgnored, active_linear_issues: issues.length,
    identity_coverage_complete: identityCoverageComplete,
    access_errors: snapshot.errors || [], counts, changed_field_counts: changedFieldCounts,
    unsupported_field_counts: unsupportedFieldCounts,
    policies: {unchanged: 'All comparable fields equal; NOT full equality while estimate is unmapped.',
      normalization: 'Recognized title identity prefix, metadata layout, headings, list wrappers, reference/dependency wrappers and line endings only. Checked boxes and internal text preserved.',
      baseline: 'No last-synced baseline; differences do not establish which side is authoritative or authorize updates.',
      estimate: 'Native Linear estimate is unmapped. Source Expected and O/M/P/E are compared inside description.',
      identity: 'Explicit Task ID in title prefix or dedicated marker, scoped to selected project/team/workspace; never arbitrary dependency mentions.'},
    remote_duplicates: [...remoteIndex].filter(([, items]) => items.length > 1).map(([task_id, items]) => ({task_id, issue_ids: items.map(i => i.id)})),
    unmatched_remote_issues: issues.filter(i => !identity(i).ids.some(id => localIndex.has(id))).map(i => ({id: i.id, title: i.title, url: i.url})),
    unclassified_source_dependencies: dependencies.unresolved, results};
}

function markdown(report) {
  const lines = ['# Read-only reconciliation — ' + (report.destination.project_name || 'unavailable'), '',
    '**No Linear writes. This is a comparison, not a publish/update plan.**', '',
    'Draft status: `' + report.draft_status + '`. Source key: `' + report.source_project_key + '`.', '',
    '| Status | Tasks |', '| --- | ---: |', ...Object.entries(report.counts).map(([key, value]) => `| ${key} | ${value} |`), '',
    `Read ${report.pagination.remote_issues} issues over ${report.pagination.pages} pages. Enumeration complete: ${report.pagination.complete}.`,
    `Archived ignored: ${report.archived_ignored}. Active Linear issues: ${report.active_linear_issues}.`,
    `Access errors: ${report.access_errors.length}.`, '',
    'Changed field counts (including comparable fields of conflicts): `' + JSON.stringify(report.changed_field_counts) + '`.',
    'Unsupported/unmapped: `' + JSON.stringify(report.unsupported_field_counts) + '`.', '',
    ...Object.values(report.policies).map(text => '- ' + text), '',
    'Raw inputs and complete structured differences are retained in the adjacent JSON files.', ''];
  if (report.access_errors.length) lines.push('## Access errors', '', '```json', JSON.stringify(report.access_errors, null, 2), '```', '');
  for (const result of report.results) {
    lines.push(`## ${result.task_id} — ${result.status}`, '', result.title, '',
      ...result.candidates.map(i => `- [${i.id}](${i.url})`), '',
      'Changed fields: ' + (result.changed_fields.join(', ') || 'none / not compared') + '.',
      'Unsupported/unmapped: ' + result.unsupported_fields.join(', ') + '.', '');
    if (result.reasons.length) lines.push('Conflicts: ' + result.reasons.join('; '), '');
    if (result.provenance_note) lines.push(result.provenance_note, '');
    for (const [name, value] of Object.entries(result.fields)) {
      if (value.status === 'unchanged') continue;
      lines.push('### ' + name + ' — ' + value.status, '', '```json', JSON.stringify(value, null, 2), '```', '');
    }
  }
  return lines.join('\n');
}

function writeReport(draftPath, snapshotPath, out, projectId) {
  const draftBytes = fs.readFileSync(draftPath), snapshotBytes = fs.readFileSync(snapshotPath);
  const report = reconcile(JSON.parse(draftBytes), JSON.parse(snapshotBytes), projectId);
  report.inputs = {draft_path: path.resolve(draftPath), draft_sha256: hash(draftBytes),
    snapshot_path: path.resolve(snapshotPath), snapshot_sha256: hash(snapshotBytes)};
  fs.mkdirSync(out, {recursive: false}); // Never overwrite a previous run, even partially.
  fs.writeFileSync(path.join(out, 'reconciliation.json'), JSON.stringify(report, null, 2), {flag: 'wx'});
  fs.writeFileSync(path.join(out, 'reconciliation.md'), markdown(report), {flag: 'wx'});
  fs.copyFileSync(draftPath, path.join(out, 'draft-input.json'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(snapshotPath, path.join(out, 'linear-snapshot.json'), fs.constants.COPYFILE_EXCL);
  return report;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--draft', '--snapshot', '--out', '--project-id'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid arguments');
      options[args[i]] = args[i + 1];
    }
    if (Object.keys(options).length !== 4) throw new Error('Usage: node scripts/reconcile.cjs --draft issues.json --snapshot linear-snapshot.json --out NEW_DIRECTORY --project-id UUID');
    const report = writeReport(options['--draft'], options['--snapshot'], options['--out'], options['--project-id']);
    console.log(JSON.stringify({counts: report.counts, changed_fields: report.changed_field_counts,
      unsupported: report.unsupported_field_counts, access_errors: report.access_errors, pagination: report.pagination}, null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}

module.exports = {identity, localContent, remoteContent, sourceEdges, reconcile, writeReport, markdown};
