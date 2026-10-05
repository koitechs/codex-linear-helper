'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {identity, reconcile, localContent, sourceEdges, writeReport} = require('../scripts/reconcile.cjs');
const {collectLinearSnapshot, READ_OPERATIONS} = require('../scripts/linear_snapshot.cjs');

const names = ['Контекст і причина', 'Обсяг роботи', 'Технічний підхід', 'Критерії приймання',
  'Граничні сценарії', 'Поза обсягом', 'Залежності', 'Посилання'];
function task(id = 'T-M1-001', deps = ['None']) {
  const sections = Object.fromEntries(names.map(name => [name, ['Text for ' + name]]));
  sections['Залежності'] = deps; sections['Посилання'] = ['User Stories', 'US-1', 'Екрани', 'SCR-1'];
  sections['Критерії приймання'] = ['□  Keep this acceptance criterion.'];
  const issue = {task_id: id, title: 'Implement feature', source_project_key: 'example', labels: ['backend'], sections};
  issue.description = [issue.title, 'Milestone', 'Модуль', 'Статус обсягу', 'Expected',
    'Foundation', 'Module', 'DRAFT', '2.0 год',
    'Оцінка  Back-end O 1 M 2 P 3 E 2.0Board labels  backend',
    ...Object.entries(sections).flatMap(([key, values]) => ['■  ' + key, ...values])].join('\n');
  return issue;
}
function remote(local, id = 'ISS-1') {
  const canonical = localContent(local);
  const description = [...Object.entries(canonical.metadata).map(([name, value]) =>
    `**${name}:** ${Array.isArray(value) ? value.join(', ') : value}`), '',
    ...Object.entries(local.sections).flatMap(([name, lines]) => ['## ' + name, '', ...lines.map(line =>
      line.replace(/^□\s+/, '- [ ] ').replace(/^•\s+/, '* ')), ''])].join('\n');
  return {id, uuid: 'uuid-' + id, title: local.task_id + ' — ' + local.title, description,
    projectId: 'project', teamId: 'team', updatedAt: '2026-09-21T00:00:00Z', archivedAt: null,
    labels: [...local.labels], projectMilestone: {id: 'milestone', name: 'M1 — Foundation'},
    relations: {blocks: [], blockedBy: []}, _detail_complete: true,
    url: 'https://linear.app/example/issue/' + id};
}
function snapshot(issues) {
  return {project: {id: 'project', name: 'Example', teams: [{id: 'team'}],
    milestones: [{id: 'milestone', name: 'M1 — Foundation'}]}, workspace: {id: 'workspace'},
    enumeration_complete: true, include_archived: true, issues, errors: [],
    pages: [{request_cursor: null, issues: structuredClone(issues), hasNextPage: false}]};
}
function compare(locals, remotes, mutate = () => {}) {
  const snap = snapshot(remotes); mutate(snap);
  return reconcile({source_project_key: 'example', status: 'draft', issues: locals}, snap, 'project');
}

test('exact normalized match; estimate explicitly unmapped even if numeric values match', () => {
  const local = task(), issue = remote(local); issue.estimate = 2;
  const result = compare([local], [issue]).results[0];
  assert.equal(result.status, 'unchanged'); assert.equal(result.fields.estimate.status, 'unmapped');
  assert.equal(result.comparison_complete, false);
});
test('explicit identity only, never dependency mentions; no fuzzy title fallback', () => {
  assert.deepEqual(identity({title: 'Feature', description: 'Blocked by T-M1-001'}).ids, []);
  const local = task(), issue = remote(local); issue.title = local.title; issue.description += '\nT-M1-001';
  assert.equal(compare([local], [issue]).results[0].status, 'missing');
});
test('dedicated Task ID marker and source key are supported without title prefix', () => {
  const local = task(), issue = remote(local); issue.title = local.title;
  issue.description = '**Task ID:** T-M1-001\n**source_project_key:** example\n' + issue.description;
  assert.equal(compare([local], [issue]).results[0].status, 'unchanged');
});
test('duplicate remote Task IDs are conflicts; neither candidate is selected', () => {
  const local = task(), result = compare([local], [remote(local), remote(local, 'ISS-2')]).results[0];
  assert.equal(result.status, 'conflict'); assert.equal(result.candidates.length, 2);
  assert.ok(result.reasons.includes('duplicate_remote_task_id'));
});
test('duplicate local Task IDs are conflicts', () => {
  const local = task(); assert.equal(compare([local, local], [remote(local)]).counts.conflict, 2);
});
test('title/marker disagreement and wrong source key are conflicts', () => {
  const local = task(), issue = remote(local); issue.description = 'Task ID: T-M1-002\n' + issue.description;
  assert.ok(compare([local], [issue]).results[0].reasons.includes('conflicting_identity_markers'));
  issue.description = '**source_project_key:** another-project\n' + remote(local).description;
  assert.ok(compare([local], [issue]).results[0].reasons.includes('source_project_key_mismatch'));
});
test('title, labels, milestone and description differences are explicit', () => {
  const local = task(), issue = remote(local);
  issue.title += ' revised'; issue.labels.push('manual-label'); issue.projectMilestone = null;
  issue.description = issue.description.replace('Keep this acceptance criterion.', 'Changed criterion.');
  const result = compare([local], [issue]).results[0];
  assert.equal(result.status, 'changed');
  assert.deepEqual(result.changed_fields.sort(), ['description', 'labels', 'milestone', 'title']);
  assert.equal(result.fields.description.differences[0].path, 'sections.Критерії приймання');
  assert.deepEqual(result.fields.labels.actual, ['backend', 'manual-label']);
});
test('labels are sets; empty native milestone differs; missing milestone mapping conflicts', () => {
  const local = task(); local.labels.push('frontend'); const issue = remote(local); issue.labels.reverse();
  assert.equal(compare([local], [issue]).results[0].fields.labels.status, 'unchanged');
  assert.equal(compare([local], [issue], s => s.project.milestones = []).counts.conflict, 1);
});
test('format wrappers normalize but changed checkbox state and inner text do not', () => {
  const local = task(), issue = remote(local);
  issue.description = issue.description.replace(/\n/g, '\r\n').replace('User Stories\r\nUS-1', '**User Stories:** US-1')
    .replace('Екрани\r\nSCR-1', 'Екрани SCR-1');
  assert.equal(compare([local], [issue]).counts.unchanged, 1);
  issue.description = issue.description.replace('- [ ]', '- [x]');
  assert.equal(compare([local], [issue]).counts.changed, 1);
});
test('dependencies retain direction, deduplicate reciprocal source declarations and detect missing native links', () => {
  const a = task('T-M1-001', ['Blocking', 'T-M1-002']), b = task('T-M1-002', ['Blocked by', 'T-M1-001']);
  assert.deepEqual(sourceEdges([a, b]).edges, [['T-M1-001', 'T-M1-002']]);
  const ra = remote(a), rb = remote(b, 'ISS-2');
  ra.relations.blocks.push({id: rb.id}); rb.relations.blockedBy.push({id: ra.id});
  assert.equal(compare([a, b], [ra, rb]).counts.unchanged, 2);
  ra.relations = {blocks: [], blockedBy: [{id: rb.id}]};
  const result = compare([a, b], [ra, rb]).results[0];
  assert.equal(result.fields.dependencies.status, 'changed');
  assert.deepEqual(result.fields.dependencies.actual, [['T-M1-002', 'T-M1-001']]);
});
test('source edge conditions stay in content; explicit ID before condition still creates edge', () => {
  const a = task('T-M1-001', ['Blocked by', 'T-M1-002, Умова початку: OQ-10.']);
  assert.deepEqual(sourceEdges([a]).edges, [['T-M1-002', 'T-M1-001']]);
  assert.equal(sourceEdges([a]).unresolved.length, 0);
  const b = task('T-M1-001', ['Blocked by', 'Approved contract; see T-M1-002']);
  assert.equal(sourceEdges([b]).edges.length, 0); assert.equal(sourceEdges([b]).unresolved.length, 1);
});
test('missing, ambiguous and external dependency endpoints are never silently discarded', () => {
  const a = task('T-M1-001', ['Blocking', 'T-M1-002']), b = task('T-M1-002');
  assert.equal(compare([a, b], [remote(a)]).results[0].status, 'conflict');
  const ra = remote(a), rb = remote(b, 'ISS-2'); ra.relations.blocks = [{id: rb.id}];
  assert.equal(compare([a, b], [ra, rb, remote(b, 'ISS-3')]).results[0].status, 'conflict');
  const local = task(), issue = remote(local); issue.relations.blocks = [{id: 'EXTERNAL-1'}];
  const result = compare([local], [issue]).results[0];
  assert.equal(result.status, 'changed'); assert.equal(result.fields.dependencies.actual[0][1], 'linear:EXTERNAL-1');
});
test('incomplete enumeration never reports missing or unchanged', () => {
  const local = task();
  assert.equal(compare([local], [], s => s.enumeration_complete = false).counts.conflict, 1);
  assert.equal(compare([local], [remote(local)], s => s.pages[0].hasNextPage = true).counts.conflict, 1);
  assert.equal(compare([local], [remote(local)], s => s.pages[0].issues = []).counts.conflict, 1);
});
test('partial detail, truncated descriptions, unread labels/relations and drift conflict', () => {
  const local = task();
  for (const mutate of [i => i._detail_complete = false, i => i.description += ' (truncated, use `get_issue`)',
    i => delete i.labels, i => delete i.relations, i => i._changed_during_read = true]) {
    const issue = remote(local); mutate(issue); assert.equal(compare([local], [issue]).counts.conflict, 1);
  }
});
test('archived issues are diagnostic only and cannot create matching conflicts', () => {
  const local = task(), active = remote(local), archived = remote(local, 'ISS-2');
  archived.archivedAt = '2026-01-01'; archived._detail_complete = false;
  const report = compare([local], [active, archived]);
  assert.equal(report.archived_ignored, 1); assert.equal(report.active_linear_issues, 1);
  assert.equal(report.pagination.remote_issues, 2); assert.equal(report.counts.unchanged, 1);
  assert.equal(report.counts.conflict, 0); assert.deepEqual(report.remote_duplicates, []);
  const archivedOnly = compare([local], [archived]);
  assert.equal(archivedOnly.counts.missing, 1); assert.deepEqual(archivedOnly.unmatched_remote_issues, []);
});
test('wrong project/team cannot match; wrong requested destination rejected', () => {
  const local = task(), issue = remote(local); issue.projectId = 'wrong';
  assert.equal(compare([local], [issue]).counts.conflict, 1);
  issue.projectId = 'project'; issue.teamId = 'wrong'; assert.equal(compare([local], [issue]).counts.conflict, 1);
  assert.throws(() => reconcile({source_project_key: 'example', issues: [local]}, snapshot([]), 'wrong'), /destination/);
});
test('draft sections inconsistent with original description are rejected', () => {
  const local = task(); local.sections['Контекст і причина'] = ['Changed only in cached sections'];
  assert.throws(() => localContent(local), /disagree/);
});
test('unidentified unread or drifting cards prevent a definitive missing result', () => {
  const local = task(), issue = remote(local); issue.title = 'No visible task marker';
  issue.description = 'Truncated list snippet'; issue._detail_complete = false;
  assert.ok(compare([local], [issue]).results[0].reasons.includes('incomplete_remote_identity_coverage'));
  issue._detail_complete = true; issue._changed_during_read = true;
  assert.equal(compare([local], [issue]).counts.missing, 0);
});
test('missing milestone field is unsupported, explicit null is a comparable absence', () => {
  const local = task(), issue = remote(local); delete issue.projectMilestone;
  assert.equal(compare([local], [issue]).results[0].fields.milestone.status, 'unsupported');
  issue.projectMilestone = null;
  assert.equal(compare([local], [issue]).results[0].fields.milestone.status, 'changed');
});
test('conflicting dependency endpoint ownership, hydration, archive or drift blocks equality', () => {
  for (const mutate of [i => i.description = 'source_project_key: other\n' + i.description,
    i => i._detail_complete = false, i => i.archivedAt = '2026-01-01', i => i._changed_during_read = true]) {
    const a = task('T-M1-001', ['Blocking', 'T-M1-002']), b = task('T-M1-002');
    const ra = remote(a), rb = remote(b, 'ISS-2'); ra.relations.blocks = [{id: rb.id}]; mutate(rb);
    const result = compare([a, b], [ra, rb]).results[0];
    assert.equal(result.status, 'conflict'); assert.notEqual(result.fields.dependencies.status, 'unchanged');
  }
});
test('active-only snapshot cannot establish missing', () => {
  assert.equal(compare([task()], [], s => s.include_archived = false).counts.conflict, 1);
});
test('an unread unidentified card may hide a duplicate of an otherwise valid match', () => {
  const local = task(), valid = remote(local), unread = remote(task('T-M1-002'), 'ISS-2');
  unread.title = 'Task without visible marker'; unread.description = 'Snippet'; unread._detail_complete = false;
  assert.equal(compare([local], [valid, unread]).counts.conflict, 1);
  unread._detail_complete = true; unread.description = '… (truncated, use `get_issue` for full description)';
  assert.equal(compare([local], [valid, unread]).counts.conflict, 1);
});
test('malformed identity-like text remains visible as a description difference', () => {
  const local = task(), issue = remote(local); issue.description += '\nTask ID: unexpected manual content';
  const result = compare([local], [issue]).results[0];
  assert.equal(result.status, 'changed');
  assert.ok(JSON.stringify(result.fields.description.differences).includes('unexpected manual content'));
});
test('report output must be new and never overwrites existing input/output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-reconcile-test-'));
  try {
    const local = task(), draftPath = path.join(dir, 'draft.json'), snapshotPath = path.join(dir, 'snapshot.json');
    const draftBytes = JSON.stringify({source_project_key: 'example', issues: [local]});
    fs.writeFileSync(draftPath, draftBytes); fs.writeFileSync(snapshotPath, JSON.stringify(snapshot([remote(local)])));
    const out = path.join(dir, 'report'); writeReport(draftPath, snapshotPath, out, 'project');
    const reportBytes = fs.readFileSync(path.join(out, 'reconciliation.json'));
    assert.throws(() => writeReport(draftPath, snapshotPath, out, 'project'), /EEXIST/);
    assert.equal(fs.readFileSync(draftPath, 'utf8'), draftBytes);
    assert.deepEqual(fs.readFileSync(path.join(out, 'reconciliation.json')), reportBytes);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

function transportFixture(mode = '') {
  const local = task(), cards = [remote(local), remote(task('T-M1-002'), 'ISS-2'), remote(task('T-M1-003'), 'ISS-3')];
  const calls = [];
  return {calls, read: async (name, args) => {
    calls.push({name, args}); assert.ok(READ_OPERATIONS.includes(name));
    if (mode === 'auth') throw new Error('Unauthorized');
    if (name === 'get_project') return snapshot([]).project;
    if (name === 'get_workspace') return {id: 'workspace'};
    if (name === 'list_issues') {
      const index = args.cursor ? Number(args.cursor) : 0;
      if (mode === 'page-error' && index === 1) throw new Error('Network failure');
      return {issues: [cards[index]], hasNextPage: index < 2, cursor: mode === 'cursor-loop' ? '1' : String(index + 1)};
    }
    if (name === 'get_issue') {
      if (mode === 'detail-error' && args.id === 'ISS-2') throw new Error('Detail unavailable');
      return cards.find(i => i.id === args.id);
    }
    throw new Error('Unexpected operation');
  }};
}
test('collector reads all pages and full details including relations using only allowed read operations', async () => {
  const t = transportFixture(), result = await collectLinearSnapshot(t.read, {project: 'Example', expectedProjectId: 'project'});
  assert.equal(result.pages.length, 3); assert.equal(result.issues.length, 3); assert.equal(result.enumeration_complete, true);
  assert.deepEqual(result.errors, []); assert.equal(result.remote_writes, 0);
  assert.deepEqual(t.calls.filter(c => c.name === 'list_issues').map(c => c.args.cursor), [undefined, '1', '2']);
  assert.ok(t.calls.filter(c => c.name === 'list_issues').every(c => c.args.includeArchived && c.args.project === 'project'));
  assert.ok(t.calls.filter(c => c.name === 'get_issue').every(c => c.args.includeRelations));
});
test('collector auth/page failures and cursor loops are captured, never marked complete', async () => {
  for (const mode of ['auth', 'page-error', 'cursor-loop']) {
    const t = transportFixture(mode), result = await collectLinearSnapshot(t.read, {project: 'Example'});
    assert.equal(result.enumeration_complete, false); assert.ok(result.errors.length > 0);
  }
});
test('detail failures preserve inventory and prevent unchanged for affected task', async () => {
  const t = transportFixture('detail-error'), result = await collectLinearSnapshot(t.read, {project: 'Example'});
  assert.equal(result.enumeration_complete, true); assert.equal(result.issues.length, 3);
  assert.equal(result.issues[1]._detail_complete, false); assert.equal(result.errors[0].stage, 'detail');
  const report = reconcile({source_project_key: 'example', issues: [task('T-M1-002')]}, result, 'project');
  assert.equal(report.counts.conflict, 1);
});
test('collector scopes every page by canonical project UUID, excluding foreign issues', async () => {
  const t = transportFixture();
  const read = async (name, args) => {
    const value = await t.read(name, args);
    if (name === 'get_project') return {...value, id: 'P-EXAMPLE-1', uuid: 'project'};
    if (name === 'list_issues') return {...value, issues: [...value.issues,
      {...value.issues[0], id: 'FOREIGN-' + value.cursor, uuid: 'foreign-' + value.cursor, projectId: 'other'}]};
    return value;
  };
  const result = await collectLinearSnapshot(read, {project: 'Example', expectedProjectId: 'project', expectedIssueCount: 3});
  assert.equal(result.project.id, 'project'); assert.equal(result.issues.length, 3);
  assert.ok(result.pages.every(p => p.excluded_issue_count === 1 && p.issues.every(i => i.projectId === 'project')));
  assert.ok(t.calls.filter(c => c.name === 'list_issues').every(c => c.args.project === 'project'));
});
test('unexpected scoped count stops before hydration or reconciliation', async () => {
  const t = transportFixture();
  const result = await collectLinearSnapshot(t.read, {project: 'Example', expectedIssueCount: 170});
  assert.equal(result.enumeration_complete, false);
  assert.match(result.errors[0].error, /expected 170 issues, received 3/);
  assert.equal(t.calls.filter(c => c.name === 'get_issue').length, 0);
});
