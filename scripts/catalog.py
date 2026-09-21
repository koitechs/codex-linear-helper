"""Offline, fail-closed reader for the GRANDAR 2026-09-08 task catalog."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
HEADING = re.compile(r'^Задача (T)[ -](M\d+)[ -](\d+)$')
SECTIONS = ('Контекст і причина', 'Обсяг роботи', 'Технічний підхід',
            'Критерії приймання', 'Граничні сценарії', 'Поза обсягом',
            'Залежності', 'Посилання')
LABELS = {'Back-end': 'backend', 'Web/Admin': 'frontend', 'Mobile App': 'mobile'}
ESTIMATE = re.compile(r'(Back-end|Web/Admin|Mobile App)\s+O\s+([\d.]+)\s+M\s+([\d.]+)\s+P\s+([\d.]+)\s+E\s+([\d.]+)')


def paragraphs(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read('word/document.xml'))
    if root.find('.//w:ins', NS) is not None or root.find('.//w:del', NS) is not None:
        raise ValueError('Tracked changes require document review before extraction')
    if root.find('.//w:drawing', NS) is not None:
        raise ValueError('Embedded drawings require document review before extraction')
    return [''.join(t.text or '' for t in p.findall('.//w:t', NS)).strip()
            for p in root.findall('.//w:p', NS)]


def parse(lines, project_key, source_hash):
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', project_key):
        raise ValueError('Project key must be a stable lowercase client/project slug')
    milestones = dict(re.findall(r'^Milestone (M\d+) (.+)$', '\n'.join(lines), re.M))
    starts = [(i, '-'.join(m.groups())) for i, s in enumerate(lines)
              if (m := HEADING.fullmatch(s))]
    if not starts:
        raise ValueError('No supported task headings; use catalog-intake for this layout')
    issues = []
    for n, (start, task_id) in enumerate(starts):
        end = starts[n+1][0] if n+1 < len(starts) else len(lines)
        # Milestone summaries belong to the next group, not the previous task.
        for j in range(start+1, end):
            if lines[j].startswith('Milestone M'):
                end = j
                break
        body = [x for x in lines[start+1:end] if x]
        if not body or body[0] in ('Milestone', 'Модуль'):
            raise ValueError(f'{task_id}: missing title')
        if (body[1:5] != ['Milestone', 'Модуль', 'Статус обсягу', 'Expected']
                or len(body) < 10 or not re.fullmatch(r'[\d.]+ год', body[8])
                or not body[9].startswith('Оцінка')):
            raise ValueError(f'{task_id}: missing/unsupported task metadata')
        milestone_id = task_id.split('-')[1]
        if milestones.get(milestone_id) != body[5]:
            raise ValueError(f'{task_id}: milestone metadata mismatch')
        sections = {}
        active = None
        for line in body:
            heading = line.removeprefix('■').strip()
            if heading in SECTIONS:
                if heading in sections:
                    raise ValueError(f'{task_id}: duplicate section {heading}')
                active = heading
                sections[active] = []
            elif line.startswith('■'):
                raise ValueError(f'{task_id}: unsupported section {heading}')
            elif active:
                sections[active].append(line)
        if any(not sections.get(s) for s in SECTIONS):
            raise ValueError(f'{task_id}: missing/empty required section')
        estimate = next((s for s in body if s.startswith('Оцінка')), '')
        if 'Board labels' not in estimate:
            raise ValueError(f'{task_id}: missing board labels')
        labels = re.split(r'[,;\s]+', estimate.split('Board labels', 1)[1].strip())
        if not labels or len(labels) != len(set(labels)) or set(labels)-set(LABELS.values()):
            raise ValueError(f'{task_id}: invalid labels')
        estimate_cells = estimate.split('Board labels', 1)[0].removeprefix('Оцінка').strip()
        workstreams = ESTIMATE.findall(estimate_cells)
        if (ESTIMATE.sub('', estimate_cells).strip(' ;')
                or len(workstreams) != len({w[0] for w in workstreams})):
            raise ValueError(f'{task_id}: unsupported/duplicate estimate workstream')
        if not workstreams or set(labels) != {LABELS[w[0]] for w in workstreams}:
            raise ValueError(f'{task_id}: labels/workstream mismatch')
        for w, o, m, p, e in workstreams:
            if not 0 <= float(o) <= float(m) <= float(p) <= 16:
                raise ValueError(f'{task_id}: invalid O/M/P for {w}')
            if abs((float(o)+4*float(m)+float(p))/6-float(e)) > 0.11:
                raise ValueError(f'{task_id}: E mismatch for {w}')
        expected_total = sum((float(o)+4*float(m)+float(p))/6 for w,o,m,p,e in workstreams)
        if abs(float(body[8].split()[0])-expected_total) > 0.11:
            raise ValueError(f'{task_id}: Expected total mismatch')
        dependencies = list(dict.fromkeys(re.findall(r'T-M\d+-\d+', '\n'.join(sections['Залежності']))))
        source_text = '\n'.join(body)
        issues.append(dict(task_id=task_id, title=body[0], labels=labels,
                           source_project_key=project_key, source_sha256=source_hash,
                           source_paragraphs=[start+1, end],
                           description=source_text, sections=sections,
                           estimate_source=estimate, dependency_task_ids=dependencies,
                           technical_validation_required='Requires Tech Lead validation' in source_text,
                           content_sha256=hashlib.sha256(source_text.encode()).hexdigest()))
    ids = [x['task_id'] for x in issues]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate Task IDs')
    for issue in issues:
        missing = set(issue['dependency_task_ids'])-set(ids)
        if missing or issue['task_id'] in issue['dependency_task_ids']:
            raise ValueError(f"{issue['task_id']}: unknown/self dependencies {missing}")
    # Compare the declared document count, when present, to avoid partial exports.
    preamble = [s for s in lines[:starts[0][0]] if s]
    if 'Задачі' in preamble:
        pos = preamble.index('Задачі')
        numbers = [int(s) for s in preamble[pos+1:pos+6] if s.isdecimal()]
        if numbers and numbers[0] != len(issues):
            raise ValueError(f'Declared {numbers[0]} tasks, extracted {len(issues)}')
    return issues


def build(source, out, key):
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    issues = parse(paragraphs(source), key, digest)
    # New output directory prevents a failed run from leaving an apparently current old draft.
    out.mkdir(parents=True, exist_ok=False)
    payload = dict(format_version=1, source_file=source.name, source_sha256=digest,
                   source_project_key=key, status='draft-unreviewed', issues=issues)
    (out/'issues.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    checks = dict(task_count=len(issues), unique_ids=True, required_sections=True,
                  labels_match_workstreams=True, estimates_valid=True,
                  dependency_ids_exist=True, semantic_review='not_run',
                  remote_writes=0, technical_validation_count=sum(x['technical_validation_required'] for x in issues))
    (out/'checks.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding='utf-8')
    preview = ['# Linear draft · '+key, '',
               f'{len(issues)} задач. Структурне перенесення; змістовне рев’ю ще не проведено. У Linear нічого не створено.', '']
    for issue in issues:
        preview += ['## '+issue['task_id']+' · '+issue['title'], '',
                    'Labels: '+', '.join(issue['labels']), '',
                    f"Source paragraphs: {issue['source_paragraphs'][0]}–{issue['source_paragraphs'][1]}", '']
        # Quoted paragraphs keep client text separate from agent instructions.
        preview += ['> '+s for s in issue['description'].splitlines()] + ['']
    (out/'preview.md').write_text('\n'.join(preview), encoding='utf-8')
    return checks


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--project-key', required=True,
                        help='Stable unique client/project slug; reuse for later versions of the same project')
    args = parser.parse_args()
    try:
        print(json.dumps(build(args.source, args.out, args.project_key), ensure_ascii=False, indent=2))
    except (ValueError, OSError, zipfile.BadZipFile, ET.ParseError) as exc:
        parser.exit(1, f'Catalog not exported: {exc}\n')
