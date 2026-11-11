"""Read-only reconciliation preflight with inert Docker and private files; never hosted proof."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import unittest
import unittest.mock
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import legacy_control_resolution as resolution
import legacy_handoff as handoff
import legacy_reconcile_action as reconcile
import legacy_reconcile_preflight as preflight
from hosted_manual_reconciliation_fixture import ManualPacket
import test_hosted_caddy_legacy_reconciliation as base

BEFORE_REQUEST = ['pinned_helper', 'native_host', 'retained_transition', 'deployment_lock', 'request']
AFTER_REQUEST = ['receipt_identities', 'recovery_receipt', 'failed_state', 'handoff_markers', 'operation_absent',
                 *reconcile.SERVING_PROOFS, 'public_acceptance', 'compose_model', 'unchanged']
CHANGING = {'create', 'run', 'start', 'stop', 'restart', 'kill', 'rm', 'rename', 'pull', 'push', 'cp', 'update',
            'network', 'compose', 'build', 'commit', 'load', 'tag'}


def tree(root):
    """Every path with its type, mode, size, times and content hash."""
    rows = []
    for base_path, directories, names in os.walk(root):
        for name in directories + names:
            path = Path(base_path) / name
            info = path.lstat()
            content = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() and not path.is_symlink() else None
            rows.append((str(path), info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns, content))
    return sorted(rows)


class PreflightTests(unittest.TestCase):
    # The reconciliation suite's inert host: same fixture, Docker adapter and Compose model check.
    setUp = base.ReconciliationTests.setUp
    run_docker = base.ReconciliationTests.run_docker
    known_stop_recovery = base.ReconciliationTests.known_stop_recovery
    verify_model = base.ReconciliationTests.verify_model

    def packet(self):
        packet = ManualPacket(self)
        lock = self.fx.root / '.caddy-deploy.lock'
        lock.write_bytes(b'')
        lock.chmod(0o600)
        self.value = {'deploy_dir': str(self.fx.root), 'instance': packet.value['instance'],
                      'checkpoint_dir': packet.value['checkpoint_dir'], 'manual_evidence_dir': str(packet.evidence)}
        return packet

    def run_preflight(self, value=None, run=None, public=None):
        return preflight.preflight(value or self.value, run or self.run_docker, self.fx.p.fx.qualify,
                                   public or self.public, self.verify_model, host=lambda: None)

    def outcomes(self, result):
        return {item['control']: item['outcome'] for item in result['controls']}

    def test_every_control_passes_and_nothing_changes(self):
        packet = self.packet()
        before, issued = tree(self.fx.root), len(self.fx.calls)
        result = self.run_preflight()
        self.assertEqual([item['control'] for item in result['controls']], BEFORE_REQUEST + AFTER_REQUEST)
        self.assertEqual(set(self.outcomes(result).values()), {'PASS'})
        self.assertEqual((result['complete'], result['passed'], result['refused'], result['not_run']),
                         (True, len(BEFORE_REQUEST + AFTER_REQUEST), 0, 0))
        self.assertEqual(tree(self.fx.root), before)
        commands = self.fx.calls[issued:]
        self.assertTrue(commands)
        self.assertEqual({argv[1] for argv in commands} & CHANGING, set())
        self.assertFalse(any(argv[1:3] == ['volume', 'create'] for argv in commands))
        self.assertFalse(resolution.operation_path(self.fx.root, packet.value['token']).exists())
        self.assertFalse(list(Path(preflight.tempfile.gettempdir()).glob('legacy-reconcile-preflight-*')))
        self.assertEqual(preflight.MEMORY, Path('/run'))

    def test_only_docker_observations_reach_the_daemon(self):
        seen = []
        guarded = preflight.observing(lambda argv, *_: seen.append(argv) or b'')
        allowed = (['docker', 'ps', '--all'], ['docker', 'inspect', 'x'], ['docker', 'container', 'inspect', 'x'],
                   ['docker', 'image', 'inspect', 'x'], ['docker', 'volume', 'inspect', 'x'], ['docker', 'volume', 'ls'],
                   ['docker', 'exec', 'x', 'sh', '-c', 'true'], ['docker', 'info'], ['docker', 'context', 'inspect'])
        for argv in allowed:
            guarded(argv, 1, 1)
        self.assertEqual(seen, list(allowed))
        for argv in (['docker', 'stop', 'x'], ['docker', 'start', 'x'], ['docker', 'rm', 'x'], ['docker', 'rename', 'x', 'y'],
                     ['docker', 'create', 'x'], ['docker', 'run', 'x'], ['docker', 'pull', 'x'], ['docker', 'volume', 'create', 'x'],
                     ['docker', 'volume', 'rm', 'x'], ['docker', 'container', 'rm', 'x'], ['docker', 'image', 'rm', 'x'],
                     ['docker', 'compose', 'up'], ['docker', 'network', 'rm', 'x'], ['podman', 'ps'], ['docker'], []):
            with self.subTest(argv=argv), self.assertRaisesRegex(ValueError, 'not an observation'):
                guarded(argv, 1, 1)
        self.assertEqual(len(seen), len(allowed))

    def test_a_control_that_tries_to_change_the_host_is_refused_before_docker(self):
        self.packet()
        issued = len(self.fx.calls)
        with patch.object(reconcile, 'census', side_effect=lambda root, instance, data, run: run(
                ['docker', 'rm', '--force', data['retained']['Id']], 10, 65536)):
            result = self.run_preflight()
        refused = [item for item in result['controls'] if item['outcome'] == 'REFUSED']
        self.assertEqual([item['control'] for item in refused], ['proxy_census'])
        self.assertIn('not an observation: docker rm', refused[0]['reason'])
        self.assertFalse(any(argv[1] == 'rm' for argv in self.fx.calls[issued:]))

    def test_a_complete_preflight_is_followed_by_a_real_reconciliation(self):
        packet = self.packet()
        self.assertTrue(self.run_preflight()['complete'])
        request = packet.generate()
        manual, identities = request.pop('manual_evidence_dir'), request.pop('receipt_identities')
        result = reconcile.reconcile(self.fx.root, request, manual, self.run_docker, self.fx.p.fx.qualify,
                                     public=self.public, verify_compose=self.verify_model, receipt_identities=identities)
        self.assertEqual(result['outcome'], 'RECONCILED')

    def test_one_run_reports_every_defect_and_still_runs_the_later_controls(self):
        self.packet()
        self.fx.active_config = b'{"fixture":"another active configuration"}'
        original = self.run_docker

        def extra_proxy(argv, timeout, maximum):
            raw = original(argv, timeout, maximum)
            if argv[1] == 'ps' and 'label=com.docker.compose.service=caddy' in argv:
                return raw + b'9' * 64 + b'\n'
            return raw

        def refused_public(_origin):
            raise ValueError('fixture public acceptance refused')

        before = tree(self.fx.root)
        result = self.run_preflight(run=extra_proxy, public=refused_public)
        outcomes = self.outcomes(result)
        refused = {name for name, outcome in outcomes.items() if outcome == 'REFUSED'}
        self.assertEqual(refused, {'serving_config', 'proxy_census', 'public_acceptance'})
        self.assertEqual({name for name, outcome in outcomes.items() if outcome == 'NOT_RUN'}, set())
        self.assertEqual((outcomes['compose_model'], outcomes['unchanged']), ('PASS', 'PASS'))
        reasons = {item['control']: item['reason'] for item in result['controls'] if item['outcome'] == 'REFUSED'}
        self.assertIn('serving configuration differs', reasons['serving_config'])
        self.assertIn('label census', reasons['proxy_census'])
        self.assertEqual((result['complete'], result['refused']), (False, 3))
        self.assertEqual(tree(self.fx.root), before)

    def test_a_refused_request_names_what_could_not_run(self):
        self.packet()
        value = {**self.value, 'manual_evidence_dir': str(self.fx.root / 'absent-evidence')}
        result = self.run_preflight(value=value)
        outcomes = self.outcomes(result)
        self.assertEqual(outcomes['request'], 'REFUSED')
        self.assertEqual({outcomes[name] for name in AFTER_REQUEST}, {'NOT_RUN'})
        self.assertTrue(all(item['needs'] == ['request'] for item in result['controls'] if item['outcome'] == 'NOT_RUN'))
        self.assertEqual((result['complete'], result['not_run']), (False, len(AFTER_REQUEST)))
        # The lock was released: a second run can take it again.
        self.assertEqual(self.outcomes(self.run_preflight(value=value))['deployment_lock'], 'PASS')

    def test_a_missing_lock_file_is_refused_and_never_created(self):
        self.packet()
        lock = self.fx.root / '.caddy-deploy.lock'
        lock.unlink()
        outcomes = self.outcomes(self.run_preflight())
        self.assertEqual((outcomes['deployment_lock'], outcomes['request']), ('REFUSED', 'NOT_RUN'))
        self.assertFalse(lock.exists())

    def test_an_existing_operation_and_a_changed_marker_are_each_refused(self):
        packet = self.packet()
        operation = resolution.operation_path(self.fx.root, packet.value['token'])
        operation.mkdir(mode=0o700, parents=True)
        self.assertEqual(self.outcomes(self.run_preflight())['operation_absent'], 'REFUSED')
        operation.rmdir()
        state = copy.deepcopy(self.fx.state)
        state['pending']['source']['bytes'] += 1
        (self.state_dir / 'state.json').write_bytes(handoff.encoded(state))
        result = self.run_preflight()
        refused = [item for item in result['controls'] if item['outcome'] == 'REFUSED']
        self.assertEqual([item['control'] for item in refused], ['request'], refused)
        self.assertIn('source or receipt changed', refused[0]['reason'])

    def test_lock_and_temporary_model_are_released_on_a_termination_signal_and_on_a_kill(self):
        lock = self.fx.root / '.caddy-deploy.lock'
        lock.write_bytes(b'')
        lock.chmod(0o600)
        memory = self.fx.root / 'memory'
        memory.mkdir(mode=0o700)
        held = preflight.existing_lock(self.fx.root)
        self.assertIs(os.get_inheritable(held), False)
        os.close(held)
        child = (
            'import sys, time; from pathlib import Path\n'
            'sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[2])\n'
            'import legacy_reconcile_preflight as p\n'
            'p.MEMORY = Path(sys.argv[4]); p.exit_on_signal()\n'
            'lock = p.existing_lock(Path(sys.argv[3]))\n'
            'def hold(path, *_):\n'
            '    print(path.parent, flush=True); time.sleep(60)\n'
            'p.compose_model(Path(sys.argv[3]), "site", {"app": 1, "postgres": 2, "proxy": 3}, hold)\n')
        for number, cleaned in ((signal.SIGTERM, True), (signal.SIGKILL, False)):
            with self.subTest(signal=number):
                process = subprocess.Popen(
                    [sys.executable, '-c', 'import legacy_control_compose as c; c.model = lambda *a: {}\n' + child,
                     str(SCRIPTS / 'hosted-deploy'), str(SCRIPTS), str(self.fx.root), str(memory)],
                    stdout=subprocess.PIPE, env={**os.environ, 'PYTHONPATH': str(SCRIPTS / 'hosted-deploy'),
                                                 'PYTHONDONTWRITEBYTECODE': '1'})
                directory = Path(process.stdout.readline().decode().strip())
                self.assertTrue((directory / 'compose.yml').exists())
                with self.assertRaises(BlockingIOError):
                    preflight.existing_lock(self.fx.root)
                process.send_signal(number)
                self.assertEqual(process.wait(timeout=20), 128 + number if cleaned else -number)
                process.stdout.close()
                os.close(preflight.existing_lock(self.fx.root))
                self.assertEqual(directory.exists(), not cleaned)
                self.assertEqual(directory.stat().st_mode & 0o777 if directory.exists() else 0o700, 0o700)

    def test_command_line_accepts_paths_only_and_reports_incomplete_as_status_three(self):
        def invoke(payload, result=None):
            stream = unittest.mock.Mock(buffer=io.BytesIO(json.dumps(payload).encode()))
            with patch.object(preflight.sys, 'argv', ['preflight', 'preflight-legacy-reconciliation']), \
                    patch.object(preflight.sys, 'stdin', stream), patch('builtins.print'), \
                    patch.object(preflight, 'exit_on_signal'), \
                    patch.object(preflight, 'preflight', return_value=result) as called:
                return preflight.main(), called
        paths = {'deploy_dir': '/fixture', 'instance': 'site', 'checkpoint_dir': '/c', 'manual_evidence_dir': '/m'}
        self.assertEqual(invoke(paths, {'complete': True})[0], 0)
        self.assertEqual(invoke(paths, {'complete': False})[0], 3)
        for payload in ({**paths, 'token': '0' * 32}, {**paths, 'instance': 1}, {'deploy_dir': '/fixture'}, []):
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, 'never tokens'):
                invoke(payload)
        with patch.object(preflight.sys, 'argv', ['preflight', 'reconcile-legacy']), \
                self.assertRaisesRegex(ValueError, 'explicit preflight action'):
            preflight.main()


if __name__ == '__main__':
    unittest.main()
