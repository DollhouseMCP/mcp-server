"""Private records and stand-ins only; no host, Docker, proxy or network is touched."""
import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'hosted-deploy'))
import legacy_handoff as handoff
import legacy_update_completion as completion

TOKEN, HOST = '7' * 32, 'fixture-host'
LEGACY_APP, NEW_APP = 'a' * 64, 'b' * 64
RUNTIME = 'registry.example/app@sha256:' + 'c' * 64
REVISION = '1' * 40
ORIGIN = 'https://site.example.invalid'
AT = datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc)


class CompletionTests(unittest.TestCase):
    """An update whose forward write was issued and whose upgraded app runs, stopped at its public acceptance."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.window = self.root / '.legacy-recovery' / ('window-' + TOKEN)
        self.window.mkdir(parents=True, mode=0o700)
        self.put('armed.json', {'request': {'token': TOKEN, 'app_id': LEGACY_APP}})
        self.issue()
        self.value = {'deploy_dir': str(self.root), 'instance': 'site', 'data_volume': 'new-data', 'config_volume': 'new-config',
                      'token': TOKEN, 'public_base_url': ORIGIN, 'timeout': 60, 'runtime_image': RUNTIME, 'revision': REVISION}
        self.control = {'phase': 'probed', 'public_origin': ORIGIN}
        self.pending = {'kind': 'update', 'token': TOKEN, 'volumes': ['new-data', 'new-config'], 'control': self.control}
        self.app = {'Id': NEW_APP, 'Name': '/site', 'Config': {'Image': RUNTIME}, 'State': {'Running': True, 'Restarting': False}}
        self.listed, self.calls, self.fail = [NEW_APP], [], None
        for name, stand_in in (('pending_control', self.pending_control), ('accept', self.step('accept', 'accepted')),
                               ('release', self.step('release', 'released')), ('complete', self.complete)):
            patcher = patch.object(completion, name, stand_in)
            patcher.start()
            self.addCleanup(patcher.stop)
        identity = patch.object(handoff, 'host_identity', return_value=HOST)
        identity.start()
        self.addCleanup(identity.stop)

    def put(self, name, value):
        path = self.window / name
        path.write_bytes(handoff.encoded(value))
        path.chmod(0o600)

    def issue(self, **changed):
        armed_sha = handoff.digest((self.window / 'armed.json').read_bytes())
        self.put('forward-write-issued.json', {'kind': 'legacy-forward-write-issued', 'armed_sha256': armed_sha,
                                               'host': HOST, 'token': TOKEN, 'checkpoint_sha256': '9' * 64, **changed})

    def pending_control(self, root, token, phase=None):
        if self.pending is None or token != self.pending['token']:
            raise ValueError('no matching staged Caddy transition')
        return {'pending': self.pending}, self.pending, self.pending['control']

    def step(self, name, after):
        def run(request, root):
            self.calls.append((name, request['token'], request['public_base_url'], request['timeout'], request['allow_bootstrap']))
            if self.fail == name:
                raise ValueError(name + ' fixture failure')
            self.control['phase'] = after
        return run

    def complete(self, root, token, instance):
        self.calls.append(('complete', token, instance, self.marker('DEPLOYED_REVISION')))
        if self.fail == 'complete':
            raise ValueError('complete fixture failure')
        self.pending = None

    def docker(self, argv, timeout, maximum):
        if argv[1] == 'ps':
            self.assertEqual(argv[4:8], ['--filter', 'label=com.docker.compose.project=site', '--filter',
                                         'label=com.docker.compose.service=dollhousemcp'])
            return ''.join(item + '\n' for item in self.listed).encode()
        self.assertEqual(argv, ['docker', 'container', 'inspect', self.listed[0]])
        return json.dumps([self.app]).encode()

    def marker(self, name):
        path = self.root / name
        return path.read_text() if path.exists() else None

    def completed(self):
        return completion.complete_update(self.root, self.value, self.docker, lambda: AT)

    def refused(self, message):
        """A refusal runs no step and writes no marker."""
        with self.assertRaisesRegex(ValueError, message):
            self.completed()
        self.assertEqual(self.calls, [])
        self.assertIsNone(self.marker('DEPLOYED_REVISION'))

    def test_from_a_failed_acceptance_it_runs_every_step_that_is_left_in_order(self):
        result = self.completed()
        probe = (TOKEN, ORIGIN, 60, True)
        self.assertEqual(self.calls, [('accept', *probe), ('release', *probe), ('complete', TOKEN, 'site', REVISION + '\n')])
        self.assertEqual(result, {'outcome': 'COMPLETED', 'stood_at': 'probed', 'token': TOKEN, 'app_id': NEW_APP})
        self.assertEqual((self.marker('DEPLOYED_REVISION'), self.marker('DEPLOYED_AT')), (REVISION + '\n', '2026-01-02T03:04:05Z\n'))

    def test_it_goes_on_from_where_the_release_stands(self):
        for stage, expected in (('accepted', ['release', 'complete']), ('released', ['complete'])):
            with self.subTest(stage=stage):
                self.control['phase'], self.pending['control'], self.calls = stage, self.control, []
                pending = self.pending
                self.assertEqual(self.completed()['stood_at'], stage)
                self.assertEqual([call[0] for call in self.calls], expected)
                self.pending = pending

    def test_a_failed_acceptance_changes_nothing_and_the_action_can_be_named_again(self):
        self.fail = 'accept'
        with self.assertRaisesRegex(ValueError, 'accept fixture failure'):
            self.completed()
        self.assertEqual([call[0] for call in self.calls], ['accept'])
        self.assertEqual((self.control['phase'], self.marker('DEPLOYED_REVISION')), ('probed', None))
        self.fail = None
        self.assertEqual(self.completed()['stood_at'], 'probed')

    def test_a_run_that_ends_before_the_completion_record_can_be_named_again(self):
        self.fail = 'complete'
        with self.assertRaisesRegex(ValueError, 'complete fixture failure'):
            self.completed()
        # The markers are written and the transition is still pending, so the action still applies.
        self.assertEqual((self.control['phase'], self.marker('DEPLOYED_REVISION')), ('released', REVISION + '\n'))
        self.fail = None
        self.assertEqual(self.completed()['stood_at'], 'released')
        self.assertEqual([call[0] for call in self.calls], ['accept', 'release', 'complete', 'complete'])

    def test_it_refuses_unless_the_forward_write_of_this_transition_was_issued_on_this_host(self):
        (self.window / 'forward-write-issued.json').unlink()
        self.refused('no forward write was issued')
        for changed in ({'token': '8' * 32}, {'host': 'another-host'}, {'armed_sha256': '0' * 64}, {'kind': 'other'}):
            with self.subTest(changed=changed):
                self.issue(**changed)
                self.refused('does not bind this transition')
        self.issue()
        self.value['token'] = '8' * 32
        self.refused('no legacy recovery window exists')

    def test_it_refuses_a_release_that_does_not_stand_at_one_of_its_last_steps(self):
        for stage in ('prepared', 'fenced', 'releasing'):
            with self.subTest(stage=stage):
                self.control['phase'] = stage
                self.refused('does not stand at acceptance, release or completion')
        self.pending['control'] = None
        self.refused('does not stand at acceptance, release or completion')

    def test_it_refuses_another_transition_volumes_or_origin(self):
        self.pending['volumes'] = ['old-data', 'old-config']
        self.refused('not this update')
        self.pending.update(volumes=['new-data', 'new-config'], kind='rollback')
        self.refused('not this update')
        self.pending['kind'] = 'update'
        self.control['public_origin'] = 'https://other.example.invalid'
        self.refused('public acceptance origin changed')
        self.pending = None
        self.refused('no matching staged Caddy transition')

    def test_it_refuses_unless_the_update_started_the_upgraded_app(self):
        cases = (
            ('the legacy container', {'Id': LEGACY_APP}),
            ('another image', {'Config': {'Image': 'registry.example/app@sha256:' + 'd' * 64}}),
            ('not running', {'State': {'Running': False, 'Restarting': False}}),
            ('restarting', {'State': {'Running': True, 'Restarting': True}}),
            ('another name', {'Name': '/other'}),
        )
        for what, changed in cases:
            with self.subTest(what=what):
                original = dict(self.app)
                self.app.update(changed)
                self.listed = [self.app['Id']]
                self.refused('not a running container that this update created')
                self.app, self.listed = original, [NEW_APP]
        for listed in ([], [NEW_APP, LEGACY_APP], ['short']):
            with self.subTest(listed=listed):
                self.listed = listed
                self.refused('missing or ambiguous')

    def test_the_request_is_exact(self):
        with patch.object(completion, 'validate_request', return_value=self.root):
            self.assertEqual(completion.validate(self.value), self.root)
            for changed in ({'runtime_image': 'registry.example/app:latest'}, {'revision': 'main'}, {'timeout': 601},
                            {'timeout': True}, {'timeout': '60'}, {'public_base_url': 'https://site.example.invalid/path'},
                            {'runtime_image': None}, {'extra': 1}):
                with self.subTest(changed=changed), self.assertRaises(ValueError):
                    completion.validate({**self.value, **changed})
            with self.assertRaises(ValueError):
                completion.validate({key: item for key, item in self.value.items() if key != 'revision'})


if __name__ == '__main__':
    unittest.main()
