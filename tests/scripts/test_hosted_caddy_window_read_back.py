import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'hosted-window' / 'read_back.py'
spec = importlib.util.spec_from_file_location('read_back', SCRIPT)
read_back = importlib.util.module_from_spec(spec)
spec.loader.exec_module(read_back)

RUNTIME, MIGRATION, CADDY = ('registry.example/%s@sha256:%s' % pair for pair in (('app', 'a' * 64), ('app', 'b' * 64), ('caddy', 'c' * 64)))
DATABASE = 'd' * 64


class ReadBackTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name).resolve()
        self.deploy, self.checkpoint = self.folder / 'deploy', self.folder / 'checkpoint'
        (self.deploy / '.caddy-state').mkdir(parents=True)
        self.checkpoint.mkdir()
        self.migrations = ['CREATE TABLE fixture_%d();' % number for number in range(3)]
        self.before = self.hashes()[:2]
        self.plan = {'instance': 'site', 'deploy_dir': str(self.deploy), 'public_base_url': 'https://site.example.invalid',
                     'images': {'runtime': RUNTIME, 'migration': MIGRATION, 'caddy': CADDY},
                     'caddy_volumes': {'data': 'site_data_v2', 'config': 'site_config_v2'},
                     'source': {'commit': '1' * 40}, 'versions': {'legacy': '2.1.0-beta.2', 'upgraded': '2.1.0-beta.3'}}
        self.containers = {
            'site': {'Config': {'Image': RUNTIME}, 'State': {'Health': {'Status': 'healthy'}}},
            'site-caddy': {'Config': {'Image': CADDY}, 'Mounts': [
                {'Type': 'volume', 'Name': 'site_data_v2'}, {'Type': 'volume', 'Name': 'site_config_v2'}, {'Type': 'bind'}]},
            'site-postgres': {'Id': DATABASE, 'RestartCount': 0, 'State': {'StartedAt': '2026-11-09T00:00:00Z'}},
        }
        self.ledger = self.hashes()
        self.public = {'/healthz': (200, {'version': '2.1.0-beta.3'}), '/readyz': (200, {'version': '2.1.0-beta.3'}), '/mcp': (401, {})}
        self.journal_gap, self.tag = False, None
        self.calls = []
        (self.deploy / '.caddy-state' / 'state.json').write_text(json.dumps({'pending': None, 'completed': {'source': 'fixture'}}))
        (self.deploy / 'DEPLOYED_REVISION').write_text('1' * 40 + '\n')
        (self.checkpoint / 'manifest.json').write_text(json.dumps({'source_database': {
            'id': DATABASE, 'started_at': '2026-11-09T00:00:00Z', 'restart_count': 0, 'other': 'ignored'}}))
        (self.checkpoint / 'observation.jsonl').write_text(
            json.dumps({'table': 'fixture', 'rows': 1}) + '\n' + json.dumps({'ledger': True, 'hashes': self.before}) + '\n')

    def hashes(self):
        return [hashlib.sha256(text.encode()).hexdigest() for text in self.migrations]

    def run_fake(self, argv, timeout=60):
        self.calls.append(argv)
        if argv[:2] == ['docker', 'inspect']:
            return json.dumps([self.containers[argv[2]]]).encode()
        if argv[:3] == ['docker', 'exec', DATABASE]:
            return json.dumps(self.ledger).encode()
        if argv[:2] == ['docker', 'create']:
            return b'created-container\n'
        if argv[:2] == ['docker', 'cp']:
            target = Path(argv[-1])
            (target / 'meta').mkdir(parents=True)
            entries = [{'idx': index + (1 if self.journal_gap and index else 0), 'tag': '%04d_fixture' % index}
                       for index in range(len(self.migrations))]
            if self.tag:
                entries[0]['tag'] = self.tag
            (target / 'meta' / '_journal.json').write_text(json.dumps({'entries': list(reversed(entries))}))
            for index, text in enumerate(self.migrations):
                (target / ('%04d_fixture.sql' % index)).write_text(text)
            return b''
        if argv[:2] == ['docker', 'rm']:
            return b''
        if argv[0] == 'curl':
            status, body = self.public[argv[-1].replace(self.plan['public_base_url'], '')]
            return (json.dumps(body) + '\n%d' % status).encode()
        raise AssertionError(argv)

    def result(self):
        return read_back.report(self.plan, str(self.checkpoint), self.run_fake)

    def test_every_check_passes_and_nothing_that_serves_is_changed(self):
        result = self.result()
        self.assertTrue(result['complete'] and result['passed'], result)
        self.assertEqual(len(result['checks']), 11)
        self.assertEqual((result['ledger_entries_before'], result['ledger_entries']), (2, 3))
        verbs = [argv[1] for argv in self.calls if argv[0] == 'docker']
        self.assertEqual(sorted(set(verbs)), ['cp', 'create', 'exec', 'inspect', 'rm'])
        # The one container made from the migration image has no network, is never started and is removed.
        self.assertIn(['docker', 'create', '--network', 'none', MIGRATION, 'true'], self.calls)
        self.assertIn(['docker', 'rm', 'created-container'], self.calls)
        self.assertNotIn('start', verbs)
        self.assertIn('BEGIN READ ONLY', [argv for argv in self.calls if argv[1] == 'exec'][0][-1])

    def test_each_difference_fails_exactly_its_own_check(self):
        cases = {
            'the app runs the pinned runtime image by digest': lambda: self.containers['site']['Config'].update(Image='registry.example/app:latest'),
            'the app is healthy': lambda: self.containers['site']['State'].update(Health={'Status': 'starting'}),
            'the proxy runs the pinned Caddy image by digest': lambda: self.containers['site-caddy']['Config'].update(Image=RUNTIME),
            'the proxy uses the new volumes': lambda: self.containers['site-caddy']['Mounts'][0].update(Name='site_data_old'),
            'the database is the same container and boot as at the checkpoint': lambda: self.containers['site-postgres']['State'].update(
                StartedAt='2026-11-09T09:00:00Z'),
            'the migration ledger is the pinned migration image\'s ledger': lambda: self.migrations.append('CREATE TABLE not_applied();'),
            'the checkpoint\'s ledger is the start of the migration ledger': lambda: (
                self.checkpoint / 'observation.jsonl').write_text(json.dumps({'hashes': ['f' * 64] + self.before[1:]})),
            'the transition is complete and nothing is pending': lambda: (self.deploy / '.caddy-state' / 'state.json').write_text(
                json.dumps({'pending': {'token': '0' * 32}, 'completed': {'source': 'fixture'}})),
            'the deployed revision is the pinned source': lambda: (self.deploy / 'DEPLOYED_REVISION').write_text('2' * 40),
            'the public path answers 200, 200 and 401': lambda: self.public.update({'/mcp': (200, {})}),
            'the public version is the upgraded version': lambda: self.public.update({'/readyz': (200, {'version': '2.1.0-beta.2'})}),
        }
        self.assertEqual(set(cases), set(self.result()['checks']))
        saved = (copy.deepcopy(self.containers), list(self.migrations), dict(self.public))
        files = {path: path.read_bytes() for path in (self.checkpoint / 'observation.jsonl', self.deploy / 'DEPLOYED_REVISION',
                                                      self.deploy / '.caddy-state' / 'state.json')}
        for name, change in cases.items():
            with self.subTest(name):
                change()
                result = self.result()
                self.assertEqual([check for check, passed in result['checks'].items() if not passed], [name])
                self.assertFalse(result['passed'])
            self.containers, self.migrations, self.public = copy.deepcopy(saved[0]), list(saved[1]), dict(saved[2])
            for path, raw in files.items():
                path.write_bytes(raw)

    def test_the_expected_ledger_follows_the_image_not_a_number(self):
        # A later image with one more migration, applied: the same checks pass with a longer ledger.
        self.migrations.append('CREATE TABLE added_later();')
        self.ledger = self.hashes()
        result = self.result()
        self.assertTrue(result['passed'])
        self.assertEqual((result['ledger_entries_before'], result['ledger_entries']), (2, 4))
        # The journal's order decides, whatever order the file lists its entries in.
        self.ledger = list(reversed(self.hashes()))
        self.assertFalse(self.result()['checks']['the migration ledger is the pinned migration image\'s ledger'])

    def test_what_cannot_be_read_is_not_a_pass_and_the_helper_container_is_still_removed(self):
        self.journal_gap = True
        result = self.result()
        self.assertEqual((result['complete'], result['passed']), (False, False))
        self.assertIn('without a gap', result['error'])
        self.assertIn(['docker', 'rm', 'created-container'], self.calls)
        self.journal_gap = False
        original, self.calls = self.run_fake, []

        def failing(argv, timeout=60):
            if argv[:2] == ['docker', 'cp']:
                self.calls.append(argv)
                raise subprocess.CalledProcessError(1, argv)
            return original(argv, timeout)

        result = read_back.report(self.plan, str(self.checkpoint), failing)
        self.assertEqual((result['complete'], result['passed']), (False, False))
        self.assertIn(['docker', 'rm', 'created-container'], self.calls)
        (self.checkpoint / 'observation.jsonl').write_text(json.dumps({'table': 'fixture'}) + '\n')
        self.assertIn('holds no migration ledger', self.result()['error'])

    def test_the_command_exits_three_unless_every_check_passed(self):
        plan = self.folder / 'plan.json'
        plan.write_text(json.dumps(self.plan))
        done = subprocess.run([sys.executable, '-B', str(SCRIPT), str(plan), str(self.folder / 'absent')], capture_output=True)
        self.assertEqual(done.returncode, 3)
        self.assertFalse(json.loads(done.stdout)['complete'])
        for arguments in (['plan.json', str(self.checkpoint)], [str(plan), str(self.folder) + '/../checkpoint']):
            refused = subprocess.run([sys.executable, '-B', str(SCRIPT), *arguments], capture_output=True)
            self.assertEqual((refused.returncode, refused.stdout), (1, b''))
            self.assertIn(b'must be an absolute path as written', refused.stderr)

    def test_a_folder_or_a_migration_name_that_leads_elsewhere_is_not_followed(self):
        self.plan['deploy_dir'] = str(self.deploy) + '/../deploy'
        result = self.result()
        self.assertEqual((result['complete'], result['passed']), (False, False))
        self.assertIn('the deployment folder in the plan must be an absolute path as written', result['error'])
        self.plan['deploy_dir'] = str(self.deploy)
        result = read_back.report(self.plan, str(self.checkpoint) + '/.', self.run_fake)
        self.assertIn('the checkpoint folder must be an absolute path as written', result['error'])
        self.plan['deploy_dir'] = str(self.deploy)
        self.tag = '../../elsewhere'
        result = self.result()
        self.assertEqual((result['complete'], result['passed']), (False, False))
        self.assertIn('outside its own folder', result['error'])


if __name__ == '__main__':
    unittest.main()
