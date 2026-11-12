"""A replica's own recovery evidence has the shape the tooling accepts, and holds no production secret.

Synthetic values only. The real tooling's own readers check what the writer produces.
"""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-replica'))
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
import export_archived_originals as originals
import export_control_files as export
import legacy_manual_recovery_import as manual
import write_recovery_evidence as evidence

SECRET = 'Zq7-SENTINEL-original'
ORIGIN = 'https://mcp.example.invalid'
OVERLAY = 'cutover-staging-e544-20261013-r2/'


def tar_of(members):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        for name, (raw, mode) in members.items():
            item = tarfile.TarInfo(name)
            item.size, item.mode = len(raw), mode
            archive.addfile(item, io.BytesIO(raw))
    return output.getvalue()


def evidence_archive():
    root = 'opt/dollhousemcp/'
    return tar_of({
        root + '.env.production': (b'TOKEN_SECRET=%s\nPORT=3000\nMAIL_HOST=mail.example.invalid\n' % SECRET.encode(), 0o600),
        root + '.env': (b'PORT=3000\n', 0o600),
        root + 'compose.yml': (b'services:\n  app:\n    environment:\n      T: %s\n' % SECRET.encode(), 0o600),
        root + 'Caddyfile': (b'example.invalid {\n}\n', 0o644),
        root + OVERLAY + 'candidate-overlay.json': (json.dumps({'t': SECRET}).encode(), 0o600),
        root + OVERLAY + 'notes.txt': (SECRET.encode(), 0o600),
        root + 'server/config.js': (SECRET.encode(), 0o644),
        'var/lib/other/.env': (SECRET.encode(), 0o600)})


def inspected(identifier, name, running=True):
    return {'Id': identifier * 64, 'Name': '/' + name, 'Image': 'sha256:' + 'a' * 64, 'RestartCount': 0,
            'State': {'Running': running, 'Restarting': False, 'OOMKilled': False, 'ExitCode': 0,
                      'StartedAt': '2026-01-01T00:00:0%sZ' % identifier, 'FinishedAt': '2026-01-01T00:00:09Z',
                      'Health': {'Status': 'healthy'}},
            'Mounts': [{'Type': 'volume', 'Name': 'data', 'Source': '/var/lib/x', 'Destination': '/data', 'RW': True}]}


class ArchivedOriginalsTests(unittest.TestCase):
    def exported(self):
        manifest, members = export.scrub(*originals.members(evidence_archive(), export.DEPLOY_DIR), export.DEPLOY_DIR)
        return manifest, {name: body for name, body, _ in members}

    def test_only_the_configuration_files_are_taken_and_no_secret_remains(self):
        manifest, files = self.exported()
        self.assertEqual(set(files), {'.env', '.env.production', 'Caddyfile', OVERLAY + 'candidate-overlay.json', 'compose.yml'})
        self.assertNotIn(SECRET.encode(), b''.join(files.values()))
        self.assertIn(b'TOKEN_SECRET=__DOLLHOUSE_REPLICA_TOKEN_SECRET__', files['.env.production'])
        self.assertIn(b'T: __DOLLHOUSE_REPLICA_TOKEN_SECRET__', files['compose.yml'])
        self.assertEqual(manifest['skipped']['init-db.sh'], 'absent')
        self.assertEqual({record['path']: record['mode'] for record in manifest['files']}['Caddyfile'], '0644')

    def run_script(self, raw, *arguments):
        return subprocess.run([sys.executable, str(SCRIPTS / 'hosted-replica' / 'export_archived_originals.py'), *arguments],
                              input=raw, capture_output=True, check=False)

    def test_command_reads_the_archive_and_writes_the_export_format(self):
        done = self.run_script(evidence_archive())
        self.assertEqual(done.returncode, 0)
        with tarfile.open(fileobj=io.BytesIO(done.stdout)) as archive:
            names = archive.getnames()
        self.assertEqual(names[0], 'control-files/MANIFEST.json')
        self.assertNotIn(SECRET.encode(), done.stdout + done.stderr)
        self.assertNotEqual(self.run_script(evidence_archive(), 'argument').returncode, 0)

    def test_an_unreadable_environment_file_refuses_the_export(self):
        raw = tar_of({'opt/dollhousemcp/.env.production': (b'# \xff\nTOKEN_SECRET=x\n', 0o600),
                      'opt/dollhousemcp/compose.yml': (SECRET.encode(), 0o600)})
        done = self.run_script(raw)
        self.assertEqual((done.returncode, done.stdout), (3, b''))


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(os.chdir, os.getcwd())
        self.work = Path(temporary.name).resolve()
        os.chdir(self.work)
        self.root = self.work / 'deploy'
        (self.root / 'server.prev').mkdir(parents=True)
        (self.root / 'server.prev' / 'index.js').write_text('previous source', encoding='utf-8')
        (self.work / 'prepared').mkdir()
        (self.work / 'prepared' / 'secrets.json').write_text(json.dumps({'TOKEN_SECRET': 'f' * 64}), encoding='utf-8')
        manifest, members = export.scrub(*originals.members(evidence_archive(), export.DEPLOY_DIR), export.DEPLOY_DIR)
        (self.work / evidence.ORIGINALS).write_bytes(export.archive(manifest, members))

    def completed(self, overrides=None):
        return evidence.completed_originals(self.root, overrides or {})

    def test_originals_are_completed_with_the_replica_values_and_overrides(self):
        (self.root / '.env').write_bytes(b'PORT=3000\n')
        files, report = self.completed({'MAIL_HOST': {'value': '', 'reason': 'no mail'}})
        self.assertEqual(files['.env.production'], (b'TOKEN_SECRET=%s\nPORT=3000\nMAIL_HOST=\n' % (b'f' * 64), 0o600))
        self.assertIn(b'f' * 64, files['compose.yml'][0])
        self.assertEqual(report['equal_to_the_current_file'], ['.env'])
        self.assertNotIn(b'__DOLLHOUSE_REPLICA_', b''.join(raw for raw, _ in files.values()))

    def test_an_original_may_not_need_a_value_the_replica_does_not_have(self):
        (self.work / 'prepared' / 'secrets.json').write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'no value for'):
            self.completed()

    def test_the_tooling_reads_the_archive_this_writes(self):
        files, _ = self.completed()
        files[OVERLAY + 'caddy-rebind-overlay.json'] = (b'{}', 0o600)
        archive = evidence.write_archive(self.work / 'filesystem.tar', self.root, files, {'server': self.root / 'server.prev'})
        raw = (self.work / 'filesystem.tar').read_bytes()
        self.assertEqual(archive, {'sha256': evidence.digest(raw), 'bytes': len(raw)})
        self.assertEqual((self.work / 'filesystem.tar').stat().st_mode & 0o777, 0o600)
        read = manual.fixed_members(self.root, raw)
        self.assertEqual(read['.env.production'], files['.env.production'])
        self.assertEqual(set(read), {'.env', '.env.production', 'Caddyfile', 'compose.yml', *manual.OVERLAYS})
        with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
            self.assertIn(str(self.root.relative_to('/')) + '/server/index.js', tar.getnames())

    def test_the_tooling_accepts_the_final_receipt_this_writes(self):
        services = (inspected('1', 'app'), inspected('2', 'app-postgres'), inspected('3', 'app-caddy'),
                    inspected('4', 'app-caddy-aborted-0123456789abcdef', running=False))
        public = [{'path': path, 'status': status, 'version': version, 'body_sha256': 'b' * 64}
                  for path, status, version in (('/healthz', 200, '2.1.0-beta.2'), ('/readyz', 200, '2.1.0-beta.2'), ('/mcp', 401, None))]
        final = evidence.final_receipt(ORIGIN, '2.1.0-beta.2', public, services, {'.caddy-state/state.json': 'c' * 64})
        recovered = manual.check_acceptance(final, ORIGIN)
        self.assertEqual((recovered['app'], recovered['postgres'], recovered['restored_old_profile_proxy'],
                          recovered['retained_aborted_proxy']), tuple(item['Id'] for item in services))
        for item in services:
            manual.verify_boot(final, item, item['State']['Running'])
        self.assertIn('rehearsal record', final['replica_rehearsal'])
        public[0]['status'] = 503
        with self.assertRaises(ValueError):
            manual.check_acceptance(evidence.final_receipt(ORIGIN, '2.1.0-beta.2', public, services, {}), ORIGIN)

    def test_the_original_proxy_has_the_serving_settings_without_recovery_ownership(self):
        serving = {'Id': 'abcdef012345' + '0' * 52, 'HostConfig': {'Memory': 1},
                   'Config': {'Hostname': 'abcdef012345', 'Image': 'caddy', 'Labels': {evidence.TOKEN_LABEL: 'a' * 32, 'kept': 'x'}},
                   'NetworkSettings': {'Networks': {'app_default': {'Aliases': ['caddy', 'abcdef012345']}}}}
        request = evidence.original_proxy_request(serving)
        self.assertEqual((request['Labels'], request['Image'], request['HostConfig']), ({'kept': 'x'}, 'caddy', {'Memory': 1}))
        self.assertNotIn('Hostname', request)
        self.assertEqual(request['NetworkingConfig'], {'EndpointsConfig': {'app_default': {'Aliases': ['caddy']}}})

    def test_the_application_is_restarted_only_while_its_boot_is_the_checkpoint_boot(self):
        app = inspected('1', 'app')
        later = {'app': {'id': app['Id'], 'started_at': '2025-12-31T00:00:00Z'}}
        self.assertEqual(evidence.restart_application(lambda name: app, 'app', later), 'already done')
        with self.assertRaisesRegex(ValueError, 'another application'):
            evidence.restart_application(lambda name: app, 'app', {'app': {'id': 'f' * 64, 'started_at': 'x'}})

    def test_command_is_refused_off_a_replica_and_needs_the_exact_request(self):
        request = dict.fromkeys(evidence.REQUEST, '/x')
        with patch.object(evidence.sys, 'stdin', io.StringIO(json.dumps(request))), \
                patch.object(evidence, 'declared_replica', side_effect=evidence.Refused('not declared')), \
                patch.object(evidence, 'write') as write:
            with self.assertRaises(evidence.Refused):
                evidence.main(['write_recovery_evidence.py'])
        write.assert_not_called()
        with patch.object(evidence.sys, 'stdin', io.StringIO(json.dumps(dict(request, token='0' * 32)))):
            with self.assertRaises(ValueError):
                evidence.main(['write_recovery_evidence.py'])


if __name__ == '__main__':
    unittest.main()
