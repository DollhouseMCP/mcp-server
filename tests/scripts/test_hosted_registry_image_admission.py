import importlib.util
import io
import json
from contextlib import redirect_stdout
from unittest.mock import patch
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('registry_admission', ROOT / 'scripts/hosted-deploy/registry_image_admission.py')
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)

RUNTIME = 'registry.example/app@sha256:' + 'a' * 64
MIGRATION = 'registry.example/migrate@sha256:' + 'b' * 64
DAEMON = {'OSType': 'linux', 'Architecture': 'x86_64'}


def image(reference, role):
    labels = {'org.dollhousemcp.engine-proof-source': 'c' * 40,
              'org.dollhousemcp.memory-upgrade-drain': 'v2'}
    return {'Id': 'sha256:' + ('d' if role == 'runtime' else 'e') * 64,
            'RepoDigests': [reference], 'Os': 'linux', 'Architecture': 'amd64',
            'RootFS': {'Type': 'layers', 'Layers': ['sha256:' + 'f' * 64]},
            'Config': {'User': '1001:1001', 'WorkingDir': '/app', 'Entrypoint': [], 'Labels': labels,
                       'Cmd': ['node', '--trace-warnings', 'dist/index.js'] if role == 'runtime' else ['node', 'dist/cli/migrate-database.js'],
                       'Healthcheck': {'Test': ['CMD', 'node'] if role == 'runtime' else ['NONE']}}}


class RegistryAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.images = [image(RUNTIME, 'runtime'), image(MIGRATION, 'migration')]

    def test_valid_pair_and_recheck_identity(self):
        result = subject.check_pair(RUNTIME, MIGRATION, self.images, DAEMON)
        self.assertEqual([x['reference'] for x in result], [RUNTIME, MIGRATION])
        self.images[0]['Id'] = 'sha256:' + '9' * 64
        self.assertNotEqual(result, subject.check_pair(RUNTIME, MIGRATION, self.images, DAEMON))

    def test_invalid_digest_identity_and_role_are_rejected(self):
        for mutate in (
            lambda x: x[0].update(RepoDigests=[]),
            lambda x: x[1].update(Architecture='arm64'),
            lambda x: x[0]['Config'].update(User='root'),
            lambda x: x[1]['Config'].update(Cmd=['node', 'dist/index.js']),
            lambda x: x[0]['Config']['Labels'].update({'org.dollhousemcp.memory-upgrade-drain': 'v1'}),
            lambda x: x[1]['Config']['Labels'].update({'org.dollhousemcp.engine-proof-source': '1' * 40}),
            lambda x: x[1]['RootFS'].update(Layers=[]),
        ):
            with self.subTest(mutate=mutate):
                values = [image(RUNTIME, 'runtime'), image(MIGRATION, 'migration')]
                mutate(values)
                with self.assertRaises(ValueError):
                    subject.check_pair(RUNTIME, MIGRATION, values, DAEMON)
        with self.assertRaises(ValueError):
            subject.check_pair(RUNTIME, RUNTIME, self.images, DAEMON)
        with self.assertRaises(ValueError):
            subject.check_pair('not-a-digest', MIGRATION, self.images, DAEMON)

    def test_preparation_pulls_both_before_inspection_and_refuses_failed_pull(self):
        calls = []

        def run(command, *args, **kwargs):
            calls.append(command)
            if command[1] == 'pull':
                return (0, b'', b'', None)
            if command[1] == 'info':
                return (0, json.dumps(DAEMON).encode(), b'', None)
            which = 0 if command[-1] == RUNTIME else 1
            return (0, json.dumps([self.images[which]]).encode(), b'', None)

        with patch.object(subject.scanner, 'bounded_process', side_effect=run), \
                patch.object(subject.sys, 'argv', ['admission', 'prepare', RUNTIME, MIGRATION]), \
                redirect_stdout(io.StringIO()):
            subject.main()
        self.assertEqual([call[1] for call in calls], ['pull', 'pull', 'info', 'image', 'image'])

        def fail_second(command, *args, **kwargs):
            calls.append(command)
            return (1 if command[-1] == MIGRATION else 0, b'', b'', None)

        calls.clear()
        with patch.object(subject.scanner, 'bounded_process', side_effect=fail_second), \
                patch.object(subject.sys, 'argv', ['admission', 'prepare', RUNTIME, MIGRATION]):
            with self.assertRaises(ValueError):
                subject.main()
        self.assertEqual([call[1] for call in calls], ['pull', 'pull'])

    def test_inspection_never_pulls(self):
        calls = []

        def run(command, *args, **kwargs):
            calls.append(command)
            payload = DAEMON if command[1] == 'info' else [self.images[0 if command[-1] == RUNTIME else 1]]
            return (0, json.dumps(payload).encode(), b'', None)

        with patch.object(subject.scanner, 'bounded_process', side_effect=run), \
                patch.object(subject.sys, 'argv', ['admission', 'inspect', RUNTIME, MIGRATION]), \
                redirect_stdout(io.StringIO()):
            subject.main()
        self.assertEqual([call[1] for call in calls], ['info', 'image', 'image'])


if __name__ == '__main__':
    unittest.main()
