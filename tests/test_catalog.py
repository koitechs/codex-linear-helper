import importlib.util
from pathlib import Path
import unittest
import json
import subprocess
import sys
import tempfile
import hashlib

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('catalog', ROOT/'scripts/catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class CatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lines = catalog.paragraphs(ROOT/'input/07_GRANDAR_Каталог_технічних_задач.docx')

    def test_real_catalog_complete(self):
        issues = catalog.parse(self.lines, 'test', 'test-hash')
        self.assertEqual(len(issues), 170)
        self.assertEqual(len({x['task_id'] for x in issues}), 170)
        for task in issues:
            first, last = task['source_paragraphs']
            self.assertEqual(task['description'], '\n'.join(s for s in self.lines[first:last] if s))
        self.assertEqual(issues[0]['dependency_task_ids'], ['T-M1-024'])

    def test_missing_section_rejected(self):
        lines = list(self.lines)
        idx = next(i for i, s in enumerate(lines) if s == '■  Критерії приймання')
        lines[idx] = 'Unknown heading'
        with self.assertRaisesRegex(ValueError, 'missing/empty'):
            catalog.parse(lines, 'test', 'hash')

    def test_label_mismatch_rejected(self):
        lines = list(self.lines)
        idx = next(i for i, s in enumerate(lines) if s.startswith('Оцінка'))
        lines[idx] = lines[idx].replace('backend', 'mobile')
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            catalog.parse(lines, 'test', 'hash')

    def test_unknown_dependency_rejected(self):
        lines = list(self.lines)
        idx = lines.index('T-M1-024')
        lines[idx] = 'T-M1-999'
        with self.assertRaisesRegex(ValueError, 'unknown/self'):
            catalog.parse(lines, 'test', 'hash')

    def test_unknown_label_rejected(self):
        lines = list(self.lines)
        idx = next(i for i, s in enumerate(lines) if s.startswith('Оцінка'))
        lines[idx] += ', urgent'
        with self.assertRaisesRegex(ValueError, 'invalid labels'):
            catalog.parse(lines, 'test', 'hash')

    def test_missing_scope_status_rejected(self):
        lines = [s for s in self.lines if s != 'Планова задача']
        with self.assertRaisesRegex(ValueError, 'metadata'):
            catalog.parse(lines, 'test', 'hash')

    def test_partial_document_rejected(self):
        starts = [i for i,s in enumerate(self.lines) if catalog.HEADING.fullmatch(s)]
        with self.assertRaises(ValueError):
            catalog.parse(self.lines[:starts[-1]], 'test', 'hash')

    def test_extra_estimate_workstream_rejected(self):
        lines = list(self.lines)
        idx = next(i for i,s in enumerate(lines) if s.startswith('Оцінка'))
        lines[idx] = lines[idx].replace('Board labels', '; DevOps O 1 M 2 P 3 E 2.0 Board labels')
        with self.assertRaisesRegex(ValueError, 'estimate workstream'):
            catalog.parse(lines, 'test', 'hash')

    def test_expected_total_rejected(self):
        lines = list(self.lines)
        start = next(i for i,s in enumerate(lines) if catalog.HEADING.fullmatch(s))
        idx = next(i for i in range(start,len(lines)) if lines[i] == '12.0 год')
        lines[idx] = '999 год'
        with self.assertRaisesRegex(ValueError, 'Expected total'):
            catalog.parse(lines, 'test', 'hash')

    def test_milestone_mismatch_rejected(self):
        lines = list(self.lines)
        start = next(i for i,s in enumerate(lines) if catalog.HEADING.fullmatch(s))
        idx = next(i for i in range(start,len(lines)) if lines[i] == 'Основа та доступ')
        lines[idx] = 'M99'
        with self.assertRaisesRegex(ValueError, 'milestone metadata'):
            catalog.parse(lines, 'test', 'hash')

    def test_unknown_section_rejected(self):
        lines = list(self.lines)
        idx = next(i for i,s in enumerate(lines) if s == '■  Контекст і причина')
        lines.insert(idx, '■  Unsupported section')
        with self.assertRaisesRegex(ValueError, 'unsupported section'):
            catalog.parse(lines, 'test', 'hash')

    def test_duplicate_id_rejected(self):
        lines = list(self.lines)
        starts = [i for i,s in enumerate(lines) if catalog.HEADING.fullmatch(s)]
        lines[starts[1]] = lines[starts[0]]
        with self.assertRaisesRegex(ValueError, 'Duplicate Task IDs'):
            catalog.parse(lines, 'test', 'hash')

    def test_cli_preserves_source_and_existing_output(self):
        source = ROOT/'input/07_GRANDAR_Каталог_технічних_задач.docx'
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory(prefix='catalog test ') as tmp:
            out = Path(tmp)/'new project output'
            cmd = [sys.executable, str(ROOT/'scripts/catalog.py'), str(source),
                   '--out',str(out),'--project-key','another-client']
            first = subprocess.run(cmd,capture_output=True,text=True)
            self.assertEqual(first.returncode,0,first.stderr)
            payload = json.loads((out/'issues.json').read_text())
            self.assertEqual(payload['source_project_key'],'another-client')
            self.assertEqual(payload['source_sha256'],before)
            self.assertEqual(len(payload['issues']),170)
            snapshot = (out/'issues.json').read_bytes()
            second = subprocess.run(cmd,capture_output=True,text=True)
            self.assertNotEqual(second.returncode,0)
            self.assertEqual((out/'issues.json').read_bytes(),snapshot)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),before)

    def test_cli_requires_project_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)/'out'
            result = subprocess.run([sys.executable,str(ROOT/'scripts/catalog.py'),
                str(ROOT/'input/07_GRANDAR_Каталог_технічних_задач.docx'), '--out',str(out)],
                capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('--project-key',result.stderr)
            self.assertFalse(out.exists())


if __name__ == '__main__':
    unittest.main()
