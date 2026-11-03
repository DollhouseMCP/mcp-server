"""Inert retained-intake refusal and identity tests; no daemon or scanner runs."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import image_scan_intake as intake


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.archive = self.root / 'target.tar'; self.archive.write_bytes(b'inert archive')
        self.head = '1' * 40; self.tree = '2' * 40
        self.approved = {'source': '07bf8185cd8a63ab0202745a10213ebffaff070b', 'tree': 'd51c9caf78a4bd8257f2de9b58e42e5338dbfd3a', 'run_id': '40929259427', 'attempt': 1, 'runtime_receipt_sha256': '3'*64}
        self.record = {'schema': 'retained-image-intake-v1', **self.approved, 'archive_sha256': hashlib.sha256(self.archive.read_bytes()).hexdigest(),
            'archive_bytes': self.archive.stat().st_size, 'platform': 'linux/arm64', 'store_id': 'sha256:'+'4'*64,
            'store_id_role': 'config', 'root_digest': None, 'manifest_digest': None, 'config_digest': 'sha256:'+'4'*64,
            'diff_ids': ['sha256:'+'5'*64], 'descriptor': None}
        self.graph = {k:self.record[k] for k in ('store_id','store_id_role','root_digest','manifest_digest','config_digest')}
        self.graph['layers'] = [{'diff_id': self.record['diff_ids'][0]}]

    def invoke(self, record=None, approved=None, github=None, git_values=None, raw=None):
        raw = raw if raw is not None else json.dumps(record or self.record).encode()
        path = self.root / 'intake.json'; path.write_bytes(raw)
        outputs = iter(git_values or [self.head, self.tree, ''])
        def git(*args, **kwargs):
            class Result: pass
            result = Result(); result.stdout = next(outputs).encode(); return result
        with patch.object(intake.subprocess, 'run', side_effect=git), patch.object(intake, 'verify_saved_image', return_value=self.graph) as verify:
            result = intake.validate_intake(path, hashlib.sha256(raw).hexdigest(), self.archive, self.head, self.tree,
                                           self.head if github is None else github, Path(intake.__file__).resolve().parent.parent, approved or self.approved)
            self.assertEqual(verify.call_args.kwargs['platform'], 'linux/arm64')
            self.assertEqual(verify.call_args.kwargs['expected_source'], self.approved['source'])
            return result

    def test_explicit_target_and_scanner_tuples_accept(self):
        self.assertEqual(self.invoke()[0], self.record)

    def test_clean_real_checkout_and_copied_helper_refusal(self):
        checkout = self.root / 'checkout'; (checkout / 'scripts').mkdir(parents=True)
        helper = checkout / 'scripts/image_scan_intake.py'; helper.write_text('fixture')
        def git(*args):
            return subprocess.run(['git', '-C', str(checkout), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()
        git('init', '-q'); git('add', 'scripts/image_scan_intake.py')
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
        head, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
        path = self.root / 'intake.json'; raw = json.dumps(self.record).encode(); path.write_bytes(raw)
        digest = hashlib.sha256(raw).hexdigest()
        with patch.object(intake, '__file__', str(helper)), patch.object(intake, 'verify_saved_image', return_value=self.graph):
            intake.validate_intake(path, digest, self.archive, head, tree, head, checkout, self.approved)
            helper.write_text('modified')
            with self.assertRaisesRegex(ValueError, 'modified or untracked'):
                intake.validate_intake(path, digest, self.archive, head, tree, head, checkout, self.approved)
        with patch.object(intake, '__file__', str(self.root / 'copied-helper.py')):
            with self.assertRaisesRegex(ValueError, 'does not belong'):
                intake.validate_intake(path, digest, self.archive, head, tree, head, checkout, self.approved)

    def test_bad_bindings_and_dirty_checkout_refuse(self):
        mutations = [('source','f'*40), ('tree','f'*40), ('run_id','1'), ('attempt',2), ('runtime_receipt_sha256','f'*64),
                     ('archive_sha256','f'*64), ('archive_bytes',1), ('platform','linux/ppc64le'), ('store_id_role','manifest'),
                     ('config_digest','sha256:'+'f'*64), ('diff_ids',['sha256:'+'f'*64])]
        for key,value in mutations:
            with self.subTest(key=key), self.assertRaises((ValueError, TypeError)):
                record=copy.deepcopy(self.record); record[key]=value; self.invoke(record)
        for kwargs in ({'github':'f'*40}, {'git_values':['f'*40,self.tree,'']}, {'git_values':[self.head,'f'*40,'']},
                       {'git_values':[self.head,self.tree,' M scripts/scan-built-image.py']}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError): self.invoke(**kwargs)
        with self.assertRaises(ValueError): self.invoke(raw=b'{"schema":"a","schema":"b"}')
        record=copy.deepcopy(self.record); record['unexpected']=True
        with self.assertRaises(ValueError): self.invoke(record)

if __name__ == '__main__': unittest.main()
