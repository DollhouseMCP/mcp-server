"""The control file export is read-only and never lets a secret value leave the host.

Every value here is synthetic.
"""
import ast
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
import export_control_files as export

SOURCE = SCRIPTS / 'hosted-replica' / 'export_control_files.py'
PASSWORD = 'Zq7-SENTINEL-database'
SIGNING = 'sentinelplainwordsigning'
OPAQUE = 'Ov23SENTINELopaque0001'
SHORT = 'abc'
URL_ONLY = 'sentinelurlonly'
QUOTED = 'sentinelquotedcomment'
SINGLE = 'quoted9words in a phrase'
SECRETS = (PASSWORD, SIGNING, OPAQUE, URL_ONLY, QUOTED, SINGLE)


class ExportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'deploy'
        self.root.mkdir()
        self.write('.env.production', '\n'.join([
            '# settings', 'POSTGRES_PASSWORD=' + PASSWORD, 'DOLLHOUSE_COOKIE_SIGNING_SECRET="%s"' % SIGNING,
            'DOLLHOUSE_GITHUB_CLIENT_ID=%s # note' % OPAQUE, 'DOLLHOUSE_PIN_TOKEN=' + SHORT,
            'DOLLHOUSE_INVITE_TOKEN_SECRET="%s" # signing key' % QUOTED, "export SMTP_PASSWORD='%s'   # two words" % SINGLE,
            'DOLLHOUSE_QUOTED_ID="%s" # an identifier in quotes' % OPAQUE,
            'DOLLHOUSE_DATABASE_URL=postgres://dollhouse:%s@postgres:5432/dollhousemcp' % PASSWORD,
            'DOLLHOUSE_OTHER_URL=https://user:%s@example.invalid/path' % URL_ONLY,
            'DOLLHOUSE_HTTP_PORT=3000', 'DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.example.invalid',
            'DOLLHOUSE_LOG_DIR=/var/log/dollhouse/application/2026', 'EMPTY=', '']), 0o600)
        self.write('.env', 'POSTGRES_PASSWORD=%s\nDOLLHOUSE_HTTP_PORT=3000\n' % PASSWORD, 0o600)
        self.write('compose.yml', 'services:\n  app:\n    environment:\n      A: "%s"\n      B: %s\n      C: %s\n      D: %s\n' % (
            SIGNING, OPAQUE, QUOTED, SINGLE), 0o600)
        self.write('Caddyfile', 'mcp.example.invalid {\n\treverse_proxy http://dollhousemcp:3000\n}\n', 0o644)
        self.write('.caddy-state/state.json', json.dumps({'token': 'a' * 32, 'note': PASSWORD}), 0o600)
        self.write('.legacy-handoff/receipt.json', '{"schema":1}', 0o600)
        self.write('cutover-staging-x1-r2/candidate-overlay.json', '{"services":{}}', 0o600)
        self.write('cutover-staging-x1-r2/notes.txt', SIGNING, 0o600)
        self.write('init-db.sql', 'ALTER ROLE app PASSWORD %s' % PASSWORD, 0o640)
        self.write('DEPLOYED_AT', b'\xff\xfe binary', 0o600)
        os.symlink(self.root / '.env', self.root / 'init-db.sh')

    def write(self, relative, content, mode):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode('utf-8'))
        path.chmod(mode)

    def exported(self):
        manifest, members = export.export(str(self.root))
        data = export.archive(manifest, members)
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            files = {item.name: (tar.extractfile(item).read(), item.mode) for item in tar}
        return manifest, files, data

    def test_no_secret_value_is_in_the_archive(self):
        _, _, data = self.exported()
        for value in SECRETS:
            self.assertNotIn(value.encode(), data)

    def test_environment_keeps_settings_and_names_every_replacement(self):
        manifest, files, _ = self.exported()
        body = files['control-files/.env.production'][0].decode()
        self.assertIn('POSTGRES_PASSWORD=__DOLLHOUSE_REPLICA_POSTGRES_PASSWORD__', body)
        self.assertIn('DOLLHOUSE_PIN_TOKEN=__DOLLHOUSE_REPLICA_DOLLHOUSE_PIN_TOKEN__', body)
        self.assertIn('DOLLHOUSE_GITHUB_CLIENT_ID=__DOLLHOUSE_REPLICA_DOLLHOUSE_GITHUB_CLIENT_ID__', body)
        self.assertIn('postgres://dollhouse:__DOLLHOUSE_REPLICA_POSTGRES_PASSWORD__@postgres:5432/dollhousemcp', body)
        self.assertIn('https://user:__DOLLHOUSE_REPLICA_URL_PASSWORD__@example.invalid/path', body)
        for kept in ('DOLLHOUSE_HTTP_PORT=3000', 'DOLLHOUSE_PUBLIC_BASE_URL=https://mcp.example.invalid',
                     'DOLLHOUSE_LOG_DIR=/var/log/dollhouse/application/2026', '# settings'):
            self.assertIn(kept, body)
        self.assertEqual(manifest['environment_names'], {
            'DOLLHOUSE_COOKIE_SIGNING_SECRET': 'secret', 'DOLLHOUSE_DATABASE_URL': 'kept',
            'DOLLHOUSE_GITHUB_CLIENT_ID': 'opaque', 'DOLLHOUSE_HTTP_PORT': 'kept', 'DOLLHOUSE_LOG_DIR': 'kept',
            'DOLLHOUSE_INVITE_TOKEN_SECRET': 'secret', 'DOLLHOUSE_OTHER_URL': 'kept', 'DOLLHOUSE_PIN_TOKEN': 'secret',
            'DOLLHOUSE_PUBLIC_BASE_URL': 'kept', 'DOLLHOUSE_QUOTED_ID': 'opaque', 'EMPTY': 'empty',
            'POSTGRES_PASSWORD': 'secret', 'SMTP_PASSWORD': 'secret'})
        self.assertEqual(manifest['secrets_too_short_to_search'], ['DOLLHOUSE_PIN_TOKEN'])
        self.assertNotIn(SHORT, json.dumps(manifest))

    def test_a_secret_copied_into_another_file_is_replaced_there(self):
        manifest, files, _ = self.exported()
        compose = files['control-files/compose.yml'][0].decode()
        self.assertIn('A: "__DOLLHOUSE_REPLICA_DOLLHOUSE_COOKIE_SIGNING_SECRET__"', compose)
        self.assertRegex(compose, r'B: __DOLLHOUSE_REPLICA_DOLLHOUSE_(GITHUB_CLIENT|QUOTED)_ID__')
        self.assertIn('C: __DOLLHOUSE_REPLICA_DOLLHOUSE_INVITE_TOKEN_SECRET__', compose)
        self.assertIn('D: __DOLLHOUSE_REPLICA_SMTP_PASSWORD__', compose)
        state = json.loads(files['control-files/.caddy-state/state.json'][0])
        self.assertEqual(state, {'token': 'a' * 32, 'note': '__DOLLHOUSE_REPLICA_POSTGRES_PASSWORD__'})
        records = {record['path']: record for record in manifest['files']}
        self.assertEqual((records['compose.yml']['replacements'], records['Caddyfile']['replacements']), (4, 0))

    def test_only_listed_regular_text_files_are_exported(self):
        manifest, files, _ = self.exported()
        self.assertEqual(sorted(files), ['control-files/' + name for name in sorted([
            '.caddy-state/state.json', '.env', '.env.production', '.legacy-handoff/receipt.json', 'Caddyfile',
            'MANIFEST.json', 'compose.yml', 'cutover-staging-x1-r2/candidate-overlay.json'])])
        self.assertEqual(manifest['skipped']['init-db.sh'], 'unreadable')
        self.assertEqual(manifest['skipped']['DEPLOYED_AT'], 'not text')
        self.assertEqual(manifest['skipped']['post-migration-grants.sql'], 'absent')
        self.assertEqual(files['control-files/Caddyfile'][1], 0o644)
        self.assertEqual(files['control-files/.env.production'][1], 0o600)

    def test_export_is_refused_when_a_secret_would_survive(self):
        with patch.object(export, 'scrubbed', side_effect=lambda raw, secrets: (raw, 0)):
            with self.assertRaisesRegex(export.Refused, 'a secret value survived in '):
                export.export(str(self.root))

    def test_export_is_refused_when_an_environment_file_cannot_be_read_as_text(self):
        # One undecodable byte, even in a comment, would leave the file's secrets unknown to the search.
        self.write('.env.production', b'# caf\xff\nTOKEN_SECRET=%s\n' % QUOTED.encode(), 0o600)
        with self.assertRaisesRegex(export.Refused, r'environment file \.env\.production is not text'):
            export.export(str(self.root))

    def test_export_is_refused_when_a_value_continues_over_more_than_one_line(self):
        # Only the first line of such a value is an assignment. The rest would be exported as it is.
        body = 'ab12' * 12
        for opening, closing in (('"', '"'), ("'", "'"), ('"begin \\"', '"')):
            with self.subTest(opening=opening):
                self.write('.env.production', ('PRIVATE_KEY=%s-----BEGIN-----\n%s\n-----END-----%s\nPORT=3000\n'
                                               % (opening, body, closing)).encode(), 0o600)
                with self.assertRaisesRegex(export.Refused, r'the value of PRIVATE_KEY continues over more than one line'):
                    export.export(str(self.root))

    def test_a_quoted_value_that_ends_on_its_line_is_replaced(self):
        self.write('.env.production', ('TOKEN_SECRET="%s"\nNOTE=\'two words\'\nESCAPED_TOKEN="a\\"%s"\n'
                                       % (QUOTED, 'cd34' * 6)).encode(), 0o600)
        manifest, files, data = self.exported()
        self.assertNotIn(QUOTED.encode(), data)
        self.assertNotIn(('cd34' * 6).encode(), data)
        self.assertIn(b"NOTE='two words'", files['control-files/.env.production'][0])

    def test_export_is_refused_when_an_environment_file_is_not_a_regular_file(self):
        (self.root / '.env').unlink()
        os.symlink(self.root / '.env.production', self.root / '.env')
        with self.assertRaisesRegex(export.Refused, r'environment file \.env is unreadable'):
            export.export(str(self.root))

    def test_an_absent_environment_file_is_only_noted(self):
        (self.root / '.env').unlink()
        manifest, files, data = self.exported()
        self.assertEqual(manifest['skipped']['.env'], 'absent')
        self.assertNotIn('control-files/.env', files)
        for value in SECRETS:
            self.assertNotIn(value.encode(), data)

    def test_refusal_writes_nothing(self):
        script = ('import sys; sys.path.insert(0, %r); import export_control_files as e; e.DEPLOY_DIR = %r; '
                  'e.scrubbed = lambda raw, secrets: (raw, 0); sys.exit(e.main(["x"]))') % (
                      str(SOURCE.parent), str(self.root))
        done = subprocess.run([sys.executable, '-c', script], capture_output=True, check=False)
        self.assertEqual((done.returncode, done.stdout), (3, b''))
        self.assertNotIn(SIGNING.encode(), done.stderr)

    def test_command_takes_no_argument(self):
        with self.assertRaises(ValueError):
            export.main(['export_control_files.py', str(self.root)])

    def test_host_is_unchanged(self):
        def snapshot():
            return sorted((str(path), path.lstat().st_mtime_ns, path.lstat().st_mode, path.lstat().st_size)
                          for path in self.root.rglob('*'))
        before = snapshot()
        self.exported()
        self.assertEqual(snapshot(), before)

    def test_source_can_only_read(self):
        tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
        imported = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        self.assertEqual(imported, {'hashlib', 'io', 'json', 'os', 're', 'stat', 'sys', 'tarfile'})
        self.assertFalse([node for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)])
        calls = {node.func.attr for node in ast.walk(tree)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                 and isinstance(node.func.value, ast.Name) and node.func.value.id == 'os'}
        self.assertEqual(calls, {'open', 'fstat', 'read', 'close', 'listdir', 'stat'})
        flags = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
                 and isinstance(node.value, ast.Name) and node.value.id == 'os' and node.attr.startswith('O_')}
        self.assertEqual(flags, {'O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_CLOEXEC', 'O_DIRECTORY'})
        self.assertFalse([node for node in ast.walk(tree) if isinstance(node, ast.Name) and node.id == 'open'])


if __name__ == '__main__':
    unittest.main()
