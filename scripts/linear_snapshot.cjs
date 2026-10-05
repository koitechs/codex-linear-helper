/* Read-only connector adapter. Inject a read(name, args) transport; no write API. */
'use strict';

const READ_OPERATIONS = Object.freeze(['get_project', 'get_workspace', 'list_issues', 'get_issue']);
const FIELDS = ['id', 'uuid', 'title', 'description', 'projectMilestone', 'estimate',
  'url', 'labels', 'projectId', 'teamId', 'archivedAt', 'updatedAt'];

function unpack(result) {
  if (result?.isError) throw new Error(JSON.stringify(result));
  if (Array.isArray(result?.content)) {
    const text = result.content.find(item => item.type === 'text')?.text;
    if (!text) throw new Error('Connector returned no JSON text');
    return JSON.parse(text);
  }
  return result;
}

async function collectLinearSnapshot(transport, options) {
  const snapshot = {format_version: 1, started_at: new Date().toISOString(),
    requested_project: options.project, include_archived: true, read_only: true,
    remote_writes: 0, pages: [], issues: [], errors: [], enumeration_complete: false};
  const read = async (name, args) => {
    if (!READ_OPERATIONS.includes(name)) throw new Error('Operation not read-only: ' + name);
    return unpack(await transport(name, args));
  };
  try {
    snapshot.project = await read('get_project', {query: options.project, includeMilestones: true});
    if (!snapshot.project?.id || !snapshot.project?.name) throw new Error('Invalid project response');
    // Connector id can be a display identifier (P-KOI-4); issue.projectId is the UUID.
    if (snapshot.project.uuid) snapshot.project = {...snapshot.project,
      identifier: snapshot.project.id, id: snapshot.project.uuid};
    if (options.expectedProjectId && snapshot.project.id !== options.expectedProjectId)
      throw new Error('Destination project ID mismatch');
    snapshot.workspace = await read('get_workspace', {});
    if (!snapshot.workspace?.id) throw new Error('Workspace identity missing');
    let cursor;
    const cursors = new Set(), ids = new Set(), listed = [];
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber >= 10000) throw new Error('Pagination limit exceeded');
      const args = {project: snapshot.project.id, includeArchived: true,
        limit: options.pageSize || 50, fields: FIELDS};
      if (cursor) args.cursor = cursor;
      const page = await read('list_issues', args);
      if (!Array.isArray(page.issues) || typeof page.hasNextPage !== 'boolean')
        throw new Error('Invalid pagination response');
      const scopedIssues = page.issues.filter(issue => issue.projectId === snapshot.project.id);
      snapshot.pages.push({request_cursor: cursor ?? null, ...page, issues: scopedIssues,
        excluded_issue_count: page.issues.length - scopedIssues.length});
      for (const issue of scopedIssues) {
        const key = issue.uuid || issue.id;
        if (!key || ids.has(key)) throw new Error('Repeated/missing issue ID across pages');
        ids.add(key); listed.push(issue);
      }
      if (!page.hasNextPage) break;
      if (!page.cursor || cursors.has(page.cursor)) throw new Error('Missing/repeated pagination cursor');
      cursors.add(page.cursor); cursor = page.cursor;
    }
    if (options.expectedIssueCount !== undefined && listed.length !== options.expectedIssueCount)
      throw new Error(`Project ${snapshot.project.id}: expected ${options.expectedIssueCount} issues, received ${listed.length}; reconciliation must not run`);
    snapshot.enumeration_complete = true;
    // Every card is hydrated: list descriptions may be truncated, relations are absent.
    for (let offset = 0; offset < listed.length; offset += 6) {
      const batch = listed.slice(offset, offset + 6);
      const results = await Promise.allSettled(batch.map(issue =>
        read('get_issue', {id: issue.id, includeRelations: true})));
      results.forEach((result, index) => {
        const listIssue = batch[index];
        if (result.status === 'rejected') {
          const error = String(result.reason);
          snapshot.errors.push({stage: 'detail', issue_id: listIssue.id, error});
          snapshot.issues.push({...listIssue, _detail_complete: false, _read_error: error});
          return;
        }
        const detail = result.value;
        const identityOK = detail.id === listIssue.id && detail.projectId === snapshot.project.id
          && (!listIssue.uuid || detail.uuid === listIssue.uuid);
        const drift = detail.updatedAt !== listIssue.updatedAt;
        snapshot.issues.push({...listIssue, ...detail, _detail_complete: identityOK,
          _changed_during_read: drift, _list_updated_at: listIssue.updatedAt,
          _native_estimate_returned: Object.hasOwn(detail, 'estimate') || Object.hasOwn(listIssue, 'estimate')});
        if (!identityOK) snapshot.errors.push({stage: 'detail', issue_id: listIssue.id,
          error: 'Detail identity or destination mismatch'});
      });
      if (options.onProgress) options.onProgress(Math.min(offset + 6, listed.length), listed.length);
    }
  } catch (error) {
    snapshot.errors.push({stage: 'collection', error: String(error)});
  }
  snapshot.finished_at = new Date().toISOString();
  return snapshot;
}

module.exports = {collectLinearSnapshot, unpack, READ_OPERATIONS};
