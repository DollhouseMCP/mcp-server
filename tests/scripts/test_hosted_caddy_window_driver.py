import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts' / 'hosted-window' / 'window_driver.py'
GOLDEN = Path(__file__).resolve().parent / 'hosted-window-runbook.golden.md'
spec = importlib.util.spec_from_file_location('window_driver', SCRIPT)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

PLAN = {
    'schema': 'hosted-window-plan-v1',
    'source': {'dir': '/srv/window/source', 'commit': '1' * 40, 'tree': '2' * 40},
    'deploy_dir': '/opt/dollhousemcp', 'instance': 'site', 'hostname': 'site.example.invalid',
    'public_base_url': 'https://site.example.invalid',
    'images': {'runtime': 'registry.example/app@sha256:' + 'a' * 64, 'migration': 'registry.example/app@sha256:' + 'b' * 64,
               'caddy': 'registry.example/caddy@sha256:' + 'c' * 64},
    'caddy_volumes': {'data': 'site_caddy_data_v2', 'config': 'site_caddy_config_v2'},
    'reconciliation_input': '/srv/window/reconciliation-input.json', 'docker_config': '/srv/window/registry-auth',
    'versions': {'legacy': '2.1.0-beta.2', 'upgraded': '2.1.0-beta.3'},
}
ORDER = ['preflight', 'prepare-legacy-reconciliation', 'reconcile-legacy', 'prepare-caddy-offline', 'legacy-offline-update',
         'verify', 'read-back']
CHECKPOINT = '/srv/window/checkpoint'
OPEN = {'pending': False, 'token': None, 'armed': False, 'forward_write': False, 'proxy_running': False}


class FakeProcess:
    def __init__(self, world, name, kwargs):
        self.pid, self.name = 4242, name
        self.polls, self.returncode = world.polls.get(self.name, 0), None
        self.code = world.exits.get(self.name, 0)
        kwargs['stdout'].write(world.outputs.get(self.name, b''))
        kwargs['stderr'].write(('%s said something\n' % self.name).encode())
        world.on_poll = world.during.get(self.name)
        self.world = world

    def poll(self):
        if self.world.on_poll:
            self.world.on_poll()
        if self.polls > 0:
            self.polls -= 1
            return None
        self.returncode = self.code
        return self.returncode


class DriverTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name).resolve()
        self.plan = self.folder / 'plan.json'
        self.journal = self.folder / 'journal'
        self.input = str(self.folder / 'reconciliation-input.json')
        Path(self.input).write_text('{}')
        self.base = dict(PLAN, reconciliation_input=self.input)
        self.write_plan(self.base)
        self.started, self.source_checks, self.exits, self.polls, self.outputs, self.during = [], [], {}, {}, {}, {}
        self.outputs['prepare-legacy-reconciliation'] = b'{"request": "fixture"}'
        self.on_poll, self.now, self.dirty, self.markers, self.accept = None, 0.0, False, dict(OPEN), 'e' * 64
        self.stop = driver.Stop()
        self.tools = {'check_source': self.check_source, 'check_checkpoint': self.check_checkpoint,
                      'markers': lambda plan: dict(self.markers), 'declared': self.declared,
                      'process': {'popen': self.popen, 'clock': self.clock, 'sleep': self.sleep}}
        quiet = patch.object(driver, 'say')
        self.said = quiet.start()
        self.addCleanup(quiet.stop)

    def write_plan(self, plan):
        self.plan.write_text(json.dumps(plan))

    @staticmethod
    def name(argv, stdin):
        if 'read_back.py' in argv[1]:
            return 'read-back'
        if 'reconcile-after-recovery' in stdin:
            return 'reconcile-legacy-after-recovery'
        return 'preflight' if argv[-1] == 'preflight-legacy-reconciliation' else argv[-1]

    def popen(self, argv, **kwargs):
        name = self.name(argv, kwargs['stdin'].name)
        self.started.append((name, argv, kwargs))
        return FakeProcess(self, name, kwargs)

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds

    def check_source(self, plan, env):
        self.source_checks.append(len(self.started))
        if self.dirty:
            raise driver.Refused('the pinned source is not clean')

    def check_checkpoint(self, plan, directory):
        if not self.accept:
            raise driver.Refused('the tooling does not accept the checkpoint: fixture')
        return self.accept

    def declared(self):
        raise driver.Refused('the plan has a replica section and this host is not declared as a replica')

    def drive(self, **arguments):
        return driver.run(self.plan, self.journal, stop=self.stop, tools=self.tools, **arguments)

    def names(self):
        return [name for name, _, _ in self.started]

    def events(self):
        return [json.loads(line) for line in (self.journal / 'journal.jsonl').read_text().splitlines()]

    def status(self):
        return driver.status(self.plan, self.journal, self.tools)

    # The plan ------------------------------------------------------------------------------------------------------

    def test_a_plan_is_exact_and_names_every_image_by_digest(self):
        self.assertIsNone(driver.load_plan(self.plan)['replica'])
        changes = {
            'an unknown field': lambda plan: plan.update(extra=1),
            'a missing field': lambda plan: plan.pop('hostname'),
            'an image by tag': lambda plan: plan['images'].update(runtime='registry.example/app:latest'),
            'a relative path': lambda plan: plan.update(reconciliation_input='input.json'),
            'a path with a way out': lambda plan: plan['source'].update(dir='/srv/window/../other'),
            'a short commit': lambda plan: plan['source'].update(commit='1' * 12),
            'another origin': lambda plan: plan.update(public_base_url='https://other.example.invalid'),
            'one volume twice': lambda plan: plan['caddy_volumes'].update(config='site_caddy_data_v2'),
            'no upgrade': lambda plan: plan['versions'].update(upgraded='2.1.0-beta.2'),
            'another schema': lambda plan: plan.update(schema='hosted-window-plan-v2'),
        }
        for name, change in changes.items():
            with self.subTest(name):
                plan = copy.deepcopy(PLAN)
                change(plan)
                self.write_plan(plan)
                with self.assertRaises(driver.Refused):
                    driver.load_plan(self.plan)
        self.plan.write_text('not json')
        with self.assertRaisesRegex(driver.Refused, 'cannot be read'):
            driver.load_plan(self.plan)

    def test_a_replica_section_is_refused_on_a_host_that_is_not_a_declared_replica(self):
        self.write_plan(dict(self.base, replica={'pins_dir': '/srv/replica'}))
        with self.assertRaisesRegex(driver.Refused, 'not declared as a replica'):
            driver.load_plan(self.plan, self.declared)
        with self.assertRaisesRegex(driver.Refused, 'not declared as a replica'):
            self.drive()
        self.assertEqual(self.started, [])
        self.assertFalse(self.journal.exists())

    def test_on_a_declared_replica_reconciliation_runs_through_the_pin_launcher(self):
        declared = lambda: 'f' * 64
        for bad in ({'pins_dir': 'relative'}, {'path_prefix': '/srv/shim'}, {'pins_dir': '/srv/replica', 'other': '/x'}, []):
            self.write_plan(dict(PLAN, replica=bad))
            with self.assertRaisesRegex(driver.Refused, 'replica must hold'):
                driver.load_plan(self.plan, declared)
        self.write_plan(dict(PLAN, replica={'pins_dir': '/srv/replica', 'path_prefix': '/srv/shim'}))
        plan = driver.load_plan(self.plan, declared)
        listed = {step.name: step for step in driver.steps(plan, self.journal)}
        launcher = '/srv/window/source/scripts/hosted-replica/run_with_replica_pins.py'
        for name in ('preflight', 'prepare-legacy-reconciliation', 'reconcile-legacy'):
            action = 'preflight-legacy-reconciliation' if name == 'preflight' else name
            self.assertEqual((listed[name].argv, listed[name].cwd), (['python3', launcher, action], '/srv/replica'))
        self.assertEqual(listed['legacy-offline-update'].argv, ['bash', '/srv/window/source/scripts/hosted-deploy.sh', 'legacy-offline-update'])
        self.assertTrue(driver.environment(plan)['PATH'].startswith('/srv/shim:/usr/local/sbin:'))
        self.assertIn('## Rehearsal differences', driver.runbook(plan))

    # Every step ----------------------------------------------------------------------------------------------------

    def test_all_phases_run_in_order_each_as_one_child_with_the_fixed_environment(self):
        with patch.dict(os.environ, {'DOLLHOUSE_HOSTED_LEGACY_CHECKPOINT': '/stale', 'DOLLHOUSE_HOSTED_PROXY_MODE': 'caddy-http',
                                     'HOME': '/root'}):
            self.assertEqual(self.drive(checkpoint=CHECKPOINT), 0)
        self.assertEqual(self.names(), ORDER)
        base = driver.environment(driver.load_plan(self.plan))
        self.assertEqual(set(base) - {'DOCKER_CONFIG'}, {
            'PATH', 'HOME', 'LANG', 'PYTHONDONTWRITEBYTECODE', 'DOLLHOUSE_HOSTED_SOURCE_DIR', 'DOLLHOUSE_HOSTED_GIT_REF',
            'DOLLHOUSE_HOSTED_DEPLOY_DIR', 'DOLLHOUSE_HOSTED_INSTANCE_NAME', 'DOLLHOUSE_HOSTED_HOSTNAME', 'DOLLHOUSE_PUBLIC_BASE_URL',
            'DOLLHOUSE_HOSTED_IMAGE_MODE', 'DOLLHOUSE_HOSTED_RUNTIME_IMAGE', 'DOLLHOUSE_HOSTED_MIGRATION_IMAGE',
            'DOLLHOUSE_HOSTED_CADDY_IMAGE', 'DOLLHOUSE_HOSTED_CADDY_DATA_VOLUME', 'DOLLHOUSE_HOSTED_CADDY_CONFIG_VOLUME'})
        for name, argv, kwargs in self.started:
            with self.subTest(name):
                self.assertTrue(all(isinstance(word, str) for word in argv))
                self.assertNotIn('shell', kwargs)
                self.assertTrue(kwargs['start_new_session'] and kwargs['close_fds'])
                # Only the update is given the checkpoint. A variable from the operator's session reaches no step.
                expected = dict(base, HOME='/root', **({'DOLLHOUSE_HOSTED_LEGACY_CHECKPOINT': CHECKPOINT}
                                                       if name == 'legacy-offline-update' else {}))
                self.assertEqual(kwargs['env'], expected)
        stdin = {name: kwargs['stdin'].name for name, _, kwargs in self.started}
        request = str(self.journal / 'reconcile-request.json')
        self.assertEqual(stdin, {'preflight': self.input, 'prepare-legacy-reconciliation': self.input,
                                 'reconcile-legacy': request, 'prepare-caddy-offline': os.devnull,
                                 'legacy-offline-update': os.devnull, 'verify': os.devnull, 'read-back': os.devnull})
        self.assertEqual(Path(request).read_bytes(), b'{"request": "fixture"}')
        self.assertEqual(self.started[-1][1][2:], [str(self.journal / 'plan.json'), CHECKPOINT])

    def test_the_journal_is_private_and_records_each_step_before_and_after(self):
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 0)
        self.assertEqual(self.journal.stat().st_mode & 0o777, 0o700)
        self.assertEqual({path.stat().st_mode & 0o777 for path in self.journal.iterdir()
                          if path.name in ('plan.json', 'journal.jsonl', 'reconcile-request.json')}, {0o600})
        events = self.events()
        self.assertEqual([event['event'] for event in events][:3], ['opened', 'started', 'finished'])
        pairs = [(event['event'], event['step']) for event in events if event['event'] in ('started', 'finished')]
        self.assertEqual(pairs, [(kind, name) for name in ORDER for kind in ('started', 'finished')])
        finished = [event for event in events if event['event'] == 'finished'][0]
        self.assertEqual(finished['stderr_sha256'], driver.file_hash(self.journal / 'preflight.stderr'))
        self.assertEqual(events[-1]['event'], 'phases-passed')
        self.assertEqual(driver.progress(events), (ORDER[:4] + ['checkpoint'] + ORDER[4:], None))

    def test_the_first_failure_stops_the_window_and_nothing_is_retried(self):
        self.exits['reconcile-legacy'] = 3
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 3)
        self.assertEqual(self.names(), ORDER[:3])
        self.assertIn('reconcile-legacy said something', self.said.call_args_list[-2].args[0])
        self.exits.clear()
        with self.assertRaisesRegex(driver.Refused, r'ended at reconcile-legacy \(failed\)'):
            self.drive(checkpoint=CHECKPOINT)
        self.assertEqual(self.names(), ORDER[:3])
        self.assertEqual((self.status()['ended'], self.status()['recovery_action']), (['failed', 'reconcile-legacy'], None))

    def test_a_step_that_started_and_never_reported_is_an_unknown_outcome(self):
        self.assertEqual(self.drive(last=0), 0)
        driver.Journal(self.journal).write({'event': 'started', 'step': 'reconcile-legacy'})
        with self.assertRaisesRegex(driver.Refused, r'ended at reconcile-legacy \(unknown\)'):
            self.drive()
        self.assertEqual(self.names(), ['preflight'])

    def test_a_missing_input_file_refuses_before_anything_starts(self):
        Path(self.input).unlink()
        with self.assertRaisesRegex(driver.Refused, 'preflight cannot read its input file'):
            self.drive()
        self.assertEqual((self.started, [event['event'] for event in self.events()]), ([], ['opened']))

    def test_a_command_that_cannot_be_started_is_a_failed_step(self):
        def missing(argv, **kwargs):
            raise FileNotFoundError(argv[0])
        self.tools['process']['popen'] = missing
        self.assertEqual(self.drive(), 3)
        self.assertEqual([event['exit'] for event in self.events() if event['event'] == 'finished'], [127])

    # The hand-over -------------------------------------------------------------------------------------------------

    def test_the_run_waits_at_the_hand_over_until_the_tooling_accepts_a_checkpoint(self):
        self.assertEqual(self.drive(), 4)
        self.assertEqual(self.names(), ORDER[:4])
        self.assertEqual(self.status()['recovery_action'], 'abandon-caddy-offline')
        self.accept = None
        with self.assertRaisesRegex(driver.Refused, 'does not accept the checkpoint'):
            self.drive(checkpoint=CHECKPOINT)
        with self.assertRaisesRegex(driver.Refused, 'absolute path'):
            self.drive(checkpoint='relative')
        self.assertEqual(self.names(), ORDER[:4])
        self.accept = 'e' * 64
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 0)
        self.assertEqual(self.names(), ORDER)
        accepted = [event for event in self.events() if event['event'] == 'checkpoint-accepted']
        self.assertEqual([(event['checkpoint_dir'], event['header_sha256']) for event in accepted], [(CHECKPOINT, 'e' * 64)])

    def test_a_run_can_end_after_any_phase_and_go_on_later_with_the_accepted_checkpoint(self):
        self.assertEqual(self.drive(last=1), 0)
        self.assertEqual(self.names(), ORDER[:3])
        self.assertEqual(self.drive(last=4, checkpoint=CHECKPOINT), 0)
        self.assertEqual(self.names(), ORDER[:5])
        with self.assertRaisesRegex(driver.Refused, 'already accepted another checkpoint'):
            self.drive(checkpoint='/srv/window/other')
        self.assertEqual(self.drive(), 0)
        self.assertEqual(self.names(), ORDER)
        self.assertEqual(self.started[-1][1][-1], CHECKPOINT)

    def test_a_second_attempt_starts_at_phase_two_in_a_new_journal(self):
        self.assertEqual(self.drive(first=2, checkpoint=CHECKPOINT), 0)
        self.assertEqual(self.names(), ORDER[3:])

    def test_a_journal_that_started_at_phase_two_never_reaches_back_to_reconciliation(self):
        self.assertEqual(self.drive(first=2), 4)
        self.assertEqual(self.names(), ['prepare-caddy-offline'])
        # Going on without --first keeps the journal's own first phase: reconciliation already ran and must not run again.
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 0)
        self.assertEqual(self.names(), ORDER[3:])
        self.assertEqual(self.events()[0]['first'], 2)
        for other in (0, 1, 4):
            with self.assertRaisesRegex(driver.Refused, 'opened to start at phase 2'):
                self.drive(first=other)
        self.assertEqual(self.drive(first=2), 0)
        self.assertEqual(self.names(), ORDER[3:])
        self.journal = self.folder / 'third'
        with self.assertRaisesRegex(driver.Refused, 'needs the accepted checkpoint'):
            self.drive(first=4)

    def test_a_changed_plan_needs_a_new_journal(self):
        self.assertEqual(self.drive(last=0), 0)
        self.write_plan(dict(self.base, caddy_volumes={'data': 'site_caddy_data_v3', 'config': 'site_caddy_config_v3'}))
        with self.assertRaisesRegex(driver.Refused, 'belongs to another plan'):
            self.drive()
        (self.folder / 'empty').mkdir()
        self.journal = self.folder / 'empty'
        with self.assertRaisesRegex(driver.Refused, 'not a journal'):
            self.drive()

    # The pinned source ---------------------------------------------------------------------------------------------

    def test_the_source_is_checked_first_and_again_before_every_step_that_changes_the_host(self):
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 0)
        # Before anything, then before reconcile-legacy, prepare-caddy-offline and legacy-offline-update.
        self.assertEqual(self.source_checks, [0, 2, 3, 4])

    def test_a_source_that_is_not_clean_stops_the_next_changing_step_and_the_run_can_go_on_once_it_is(self):
        self.assertEqual(self.drive(), 4)
        self.dirty = True
        with self.assertRaisesRegex(driver.Refused, 'not clean'):
            self.drive(checkpoint=CHECKPOINT)
        self.assertEqual(self.names(), ORDER[:4])
        self.dirty = False
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 0)
        self.assertEqual(self.names(), ORDER)

    def test_the_real_source_check_refuses_another_commit_and_any_added_or_cached_file(self):
        source = self.folder / 'source'
        (source / 'scripts' / 'hosted-window').mkdir(parents=True)
        (source / 'scripts' / 'hosted-window' / 'window_driver.py').write_bytes(SCRIPT.read_bytes())
        (source / '.gitignore').write_text('__pycache__/\n')
        git = ['git', '-C', str(source), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false']
        for words in (['init', '--quiet'], ['add', '.'], ['commit', '--quiet', '-m', 'fixture']):
            subprocess.run(git + words, check=True, capture_output=True)
        commit, tree = (subprocess.run(git + ['rev-parse', name], check=True, capture_output=True).stdout.decode().strip()
                        for name in ('HEAD', 'HEAD^{tree}'))
        plan = dict(PLAN, replica=None, source={'dir': str(source), 'commit': commit, 'tree': tree})
        env = dict(driver.environment(plan), PATH=os.environ['PATH'])
        own = importlib.util.spec_from_file_location('pinned_driver', source / 'scripts' / 'hosted-window' / 'window_driver.py')
        pinned = importlib.util.module_from_spec(own)
        own.loader.exec_module(pinned)
        pinned.check_source(plan, env)
        with self.assertRaisesRegex(driver.Refused, 'not the pinned source'):
            driver.check_source(plan, env)
        other = dict(plan, source=dict(plan['source'], tree='3' * 40))
        with self.assertRaisesRegex(pinned.Refused, 'planned commit and tree'):
            pinned.check_source(other, env)
        cache = source / 'scripts' / '__pycache__'
        cache.mkdir()
        (cache / 'module.pyc').write_bytes(b'cache')
        with self.assertRaisesRegex(pinned.Refused, 'not clean'):
            pinned.check_source(plan, env)

    # Signals and time ----------------------------------------------------------------------------------------------

    def test_a_stop_signal_waits_for_the_running_step_and_stops_before_the_next(self):
        self.polls['reconcile-legacy'] = 3
        self.during['reconcile-legacy'] = lambda: setattr(self.stop, 'asked', 'SIGTERM')
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 5)
        self.assertEqual(self.names(), ORDER[:3])
        events = [(event['event'], event.get('during') or event.get('before') or event.get('step')) for event in self.events()]
        self.assertEqual(events[-3:], [('stop-asked', 'reconcile-legacy'), ('finished', 'reconcile-legacy'),
                                       ('stopped', 'prepare-caddy-offline')])
        # Nothing failed, so the same journal goes on.
        self.stop.asked, self.during = None, {}
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 0)
        self.assertEqual(self.names(), ORDER)

    def test_a_hangup_is_ignored_and_an_interrupt_only_asks(self):
        previous = {number: signal.getsignal(number) for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)}
        self.addCleanup(lambda: [signal.signal(number, handler) for number, handler in previous.items()])
        stop = driver.Stop()
        stop.install()
        os.kill(os.getpid(), signal.SIGHUP)
        self.assertIsNone(stop.asked)
        os.kill(os.getpid(), signal.SIGINT)
        self.assertEqual(stop.asked, 'SIGINT')

    def test_only_a_read_only_step_is_ended_at_its_limit(self):
        self.polls = {'preflight': 3000, 'reconcile-legacy': 3000}
        with patch.object(driver, 'end') as end:
            self.assertEqual(self.drive(last=1), 0)
        self.assertEqual(end.call_count, 1)
        overdue = [(event['step'], event['ended']) for event in self.events() if event['event'] == 'overdue']
        self.assertEqual(overdue, [('preflight', True), ('reconcile-legacy', False)])

    def test_a_real_step_has_its_own_session_a_closed_input_and_only_the_given_environment(self):
        probe = ('import json, os, sys; print(json.dumps({"session": os.getsid(0), "input": sys.stdin.read(), '
                 '"environment": dict(os.environ)}))')
        step = driver.Step('probe', 0, 'fixture', [sys.executable, '-c', probe], changes=False, limit=60)
        self.journal.mkdir()
        self.assertEqual(driver.execute(step, driver.Journal(self.journal), {'ONLY': 'this'}, self.stop), 0)
        seen = json.loads((self.journal / 'probe.stdout').read_text())
        self.assertNotEqual(seen['session'], os.getsid(0))
        self.assertEqual(seen['input'], '')
        self.assertEqual({key: value for key, value in seen['environment'].items() if not key.startswith('__CF')
                          and key != 'LC_CTYPE'}, {'ONLY': 'this'})

    # Status and recovery -------------------------------------------------------------------------------------------

    def test_the_situation_names_one_action_or_none(self):
        pending = dict(OPEN, pending=True, token='0' * 32)
        cases = (
            ([], None, OPEN, 'open', None),
            (ORDER[:2], ('failed', 'reconcile-legacy'), OPEN, 'open', None),
            (ORDER[:4], None, OPEN, 'closed', 'abandon-caddy-offline'),
            (ORDER[:3], ('failed', 'prepare-caddy-offline'), OPEN, 'closed', 'abandon-caddy-offline'),
            (ORDER[:4], ('failed', 'legacy-offline-update'), OPEN, 'closed', 'abandon-caddy-offline'),
            (ORDER[:4], ('unknown', 'legacy-offline-update'), dict(pending, armed=True), 'armed', 'recover-legacy'),
            (ORDER[:4], ('failed', 'legacy-offline-update'), dict(pending, armed=True, forward_write=True), 'forward', None),
            (ORDER[:4], ('failed', 'legacy-offline-update'), pending, 'unarmed', 'return-unarmed-update'),
            # recover-caddy-proxy may have been used: that order is unrehearsed, so nothing is named.
            (ORDER[:4], ('failed', 'legacy-offline-update'), dict(pending, proxy_running=True), 'started', None),
            (ORDER[:4], ('failed', 'legacy-offline-update'), dict(pending, proxy_running=None), 'started', None),
            (ORDER[:4] + ['recover-legacy'], ('failed', 'reconcile-legacy-after-recovery'), dict(pending, armed=True), 'half', None),
            (ORDER[:5], None, OPEN, 'done', None),
            (ORDER[:4] + ['abandon-caddy-offline'], ('recovered', 'abandon-caddy-offline'), OPEN, 'recovered', None),
        )
        for passed, ended, found, where, action in cases:
            with self.subTest(where=where, ended=ended):
                self.assertEqual(driver.situation(passed, ended, found), where)
                self.assertEqual(driver.ADVICE[where][0], action)
        self.assertEqual({action for action, _ in driver.ADVICE.values()} - {None}, set(driver.RECOVERIES))

    def test_recovery_runs_only_the_action_that_fits_and_only_when_named(self):
        self.assertEqual(self.drive(), 4)
        with self.assertRaisesRegex(driver.Refused, 'recover-legacy is not the action that fits; status names: abandon-caddy-offline'):
            driver.recover(self.plan, self.journal, 'recover-legacy', self.stop, self.tools)
        self.assertEqual(self.names(), ORDER[:4])
        self.assertEqual(driver.recover(self.plan, self.journal, 'abandon-caddy-offline', self.stop, self.tools), 0)
        self.assertEqual(self.started[-1][1], ['bash', '/srv/window/source/scripts/hosted-deploy.sh', 'abandon-caddy-offline'])
        self.assertEqual(self.started[-1][2]['stdin'].name, os.devnull)
        self.assertEqual(self.status()['situation'], 'recovered')
        with self.assertRaisesRegex(driver.Refused, r'ended at abandon-caddy-offline \(recovered\)'):
            self.drive(checkpoint=CHECKPOINT)
        with self.assertRaisesRegex(driver.Refused, 'not the action that fits'):
            driver.recover(self.plan, self.journal, 'abandon-caddy-offline', self.stop, self.tools)

    def test_an_unarmed_update_is_returned_and_then_the_proxy_is_brought_back(self):
        self.exits['legacy-offline-update'] = 1
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 3)
        self.markers = dict(OPEN, pending=True, token='0' * 32)
        self.assertEqual(self.status()['recovery_action'], 'return-unarmed-update')
        self.assertEqual(driver.recover(self.plan, self.journal, 'return-unarmed-update', self.stop, self.tools), 0)
        self.assertEqual([argv for _, argv, _ in self.started[-2:]], [
            ['python3', '/srv/window/source/scripts/hosted-deploy/legacy_update_return.py', 'return-unarmed-update'],
            ['bash', '/srv/window/source/scripts/hosted-deploy.sh', 'abandon-caddy-offline']])
        # The pinned source is checked before anything is written, and again before each of the two steps.
        steps = len(self.started)
        self.assertEqual(self.source_checks[-3:], [steps - 2, steps - 2, steps - 1])
        self.assertEqual(json.loads((self.journal / 'return-request.json').read_text()), {
            'deploy_dir': '/opt/dollhousemcp', 'instance': 'site', 'data_volume': 'site_caddy_data_v2',
            'config_volume': 'site_caddy_config_v2'})
        self.assertEqual(self.started[-2][2]['stdin'].name, str(self.journal / 'return-request.json'))

    def test_a_source_that_changed_during_a_recovery_step_stops_the_next_one(self):
        self.exits['legacy-offline-update'] = 1
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 3)
        self.markers = dict(OPEN, pending=True, token='0' * 32)
        self.during['return-unarmed-update'] = lambda: setattr(self, 'dirty', True)
        with self.assertRaisesRegex(driver.Refused, 'not clean'):
            driver.recover(self.plan, self.journal, 'return-unarmed-update', self.stop, self.tools)
        self.assertEqual(self.names()[-1], 'return-unarmed-update')
        last = self.events()[-2:]
        self.assertEqual([(record['event'], record.get('step'), record.get('before')) for record in last],
                         [('finished', 'return-unarmed-update', None), ('source-refused', None, 'abandon-caddy-offline')])
        # The return passed and the proxy is still stopped: with nothing pending, the journal names the rest.
        self.dirty, self.markers = False, dict(OPEN)
        self.assertEqual(self.status()['recovery_action'], 'abandon-caddy-offline')
        self.assertEqual(driver.recover(self.plan, self.journal, 'abandon-caddy-offline', self.stop, self.tools), 0)

    def test_the_plan_and_the_journal_are_named_by_absolute_paths_as_written(self):
        for path in ('plan.json', str(self.folder) + '/../plan.json', str(self.folder) + '/./plan.json', str(self.plan) + '/'):
            with self.subTest(path), self.assertRaisesRegex(driver.Refused, 'the plan must be an absolute path as written'):
                driver.load_plan(path)
        for path in ('journal', str(self.folder) + '/../journal', str(self.folder) + '/journal/', str(self.folder) + '//journal'):
            with self.subTest(path), self.assertRaisesRegex(driver.Refused, 'the journal must be an absolute path as written'):
                driver.run(self.plan, path, stop=self.stop, tools=self.tools)
        self.assertEqual(self.started, [])
        for arguments in (['plan', 'plan.json'], ['status', str(self.plan), 'journal'], ['run', str(self.plan), str(self.folder) + '/../j']):
            done = subprocess.run([sys.executable, '-B', str(SCRIPT), *arguments], capture_output=True)
            self.assertEqual((done.returncode, done.stdout.decode().startswith('refused: ')), (3, True))
            self.assertIn('absolute path as written', done.stdout.decode())

    def test_one_path_rule_holds_from_the_first_step_to_the_read_back(self):
        # The read-back runs after the upgrade. It must not refuse a path that the driver accepted before the first step.
        own = importlib.util.spec_from_file_location('read_back', SCRIPT.with_name('read_back.py'))
        read_back = importlib.util.module_from_spec(own)
        own.loader.exec_module(read_back)
        self.assertEqual(read_back.LOCATION.pattern, driver.LOCATION.pattern)
        accepted = ('/root/.checkpoints/fresh', '/srv/window/check point', '/srv/...', '/a')
        refused = ('relative', '/srv/window/', '/srv//window', '/srv/./window', '/srv/window/..', '/', '', '/srv/win\0dow', None, 7)
        self.assertEqual([path for path in accepted if not driver.absolute(path)], [])
        self.assertEqual([path for path in refused if driver.absolute(path)], [])
        # A checkpoint in a hidden folder is taken to the end, and one with a way out is refused before any step.
        self.assertEqual(self.drive(checkpoint='/root/.checkpoints/fresh'), 0)
        self.assertEqual(self.started[-1][1][-1], '/root/.checkpoints/fresh')
        self.assertEqual(self.names(), ORDER)

    def test_a_checkpoint_path_with_a_way_out_is_refused_before_any_step(self):
        for path in ('checkpoint', CHECKPOINT + '/../other', CHECKPOINT + '/'):
            with self.subTest(path), self.assertRaisesRegex(driver.Refused, 'the checkpoint folder must be an absolute path as written'):
                self.drive(checkpoint=path)
        self.assertEqual(self.started, [])
        self.assertFalse(self.journal.exists())

    def test_a_running_proxy_beside_an_unarmed_update_names_no_action(self):
        self.exits['legacy-offline-update'] = 1
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 3)
        self.markers = dict(OPEN, pending=True, token='0' * 32, proxy_running=True)
        report = self.status()
        self.assertEqual((report['situation'], report['recovery_action']), ('started', None))
        self.assertIn('unrehearsed order', report['reason'])
        for action in driver.RECOVERIES:
            with self.assertRaisesRegex(driver.Refused, 'not the action that fits'):
                driver.recover(self.plan, self.journal, action, self.stop, self.tools)
        self.assertEqual(self.names()[-1], 'legacy-offline-update')

    def test_the_proxy_state_is_unknown_unless_docker_says_true_or_false(self):
        plan = driver.load_plan(self.plan)
        for output, code, expected in ((b'true\n', 0, True), (b'false\n', 0, False), (b'', 1, None), (b'other', 0, None)):
            done = subprocess.CompletedProcess([], code, output, b'')
            self.assertIs(driver.proxy_running(plan, lambda argv, **kwargs: done), expected)

        def absent(argv, **kwargs):
            raise FileNotFoundError(argv[0])
        self.assertIsNone(driver.proxy_running(plan, absent))
        seen = []
        driver.proxy_running(plan, lambda argv, **kwargs: seen.append(argv) or subprocess.CompletedProcess([], 0, b'true', b''))
        self.assertEqual(seen, [['docker', 'inspect', '--format', '{{.State.Running}}', 'site-caddy']])

    def test_a_failed_abandon_can_be_named_again(self):
        self.assertEqual(self.drive(), 4)
        self.exits['abandon-caddy-offline'] = 1
        self.assertEqual(driver.recover(self.plan, self.journal, 'abandon-caddy-offline', self.stop, self.tools), 3)
        self.exits.clear()
        self.assertEqual(driver.recover(self.plan, self.journal, 'abandon-caddy-offline', self.stop, self.tools), 0)
        self.assertEqual(sorted(path.name for path in self.journal.glob('abandon-caddy-offline*.stdout')),
                         ['abandon-caddy-offline-2.stdout', 'abandon-caddy-offline.stdout'])

    def test_legacy_recovery_takes_the_armed_request_and_then_reconciles_without_manual_evidence(self):
        deploy = self.folder / 'deploy'
        window = deploy / '.legacy-recovery' / ('window-' + '0' * 32)
        window.mkdir(parents=True)
        request = {'deploy_dir': str(deploy), 'instance': 'site', 'token': '0' * 32, 'checkpoint_dir': CHECKPOINT}
        (window / 'armed.json').write_text(json.dumps({'request': request, 'other': 'kept out'}))
        self.write_plan(dict(self.base, deploy_dir=str(deploy)))
        self.exits['legacy-offline-update'] = 1
        self.assertEqual(self.drive(checkpoint=CHECKPOINT), 3)
        self.markers = dict(OPEN, pending=True, token='0' * 32, armed=True)
        self.assertEqual(driver.recover(self.plan, self.journal, 'recover-legacy', self.stop, self.tools), 0)
        self.assertEqual(self.names()[-2:], ['recover-legacy', 'reconcile-legacy-after-recovery'])
        tooling = '/srv/window/source/scripts/hosted-deploy/'
        self.assertEqual([argv for _, argv, _ in self.started[-2:]], [
            ['python3', tooling + 'legacy_recovery_action.py', 'recover-legacy'],
            ['python3', tooling + 'legacy_reconcile_action.py', 'reconcile-legacy']])
        self.assertEqual(json.loads((self.journal / 'armed-request.json').read_text()), request)
        self.assertEqual(json.loads((self.journal / 'reconcile-after-recovery.json').read_text()),
                         dict(request, manual_evidence_dir=None))
        self.assertEqual((self.journal / 'armed-request.json').stat().st_mode & 0o777, 0o600)

    # The runbook ---------------------------------------------------------------------------------------------------

    def test_the_runbook_is_the_step_list_and_a_change_to_it_is_a_visible_difference(self):
        self.write_plan(PLAN)
        plan = driver.load_plan(self.plan)
        text = driver.runbook(plan)
        self.assertEqual(text, GOLDEN.read_text(encoding='utf-8'))
        position = 0
        for step in driver.steps(plan, '<journal>'):
            if step.argv:
                position = text.index(' '.join(driver.shlex.quote(word) for word in step.argv), position)
        done = subprocess.run([sys.executable, '-B', str(SCRIPT), 'plan', str(self.plan)], capture_output=True, check=True)
        self.assertEqual(done.stdout.decode('utf-8'), text)

    def test_the_command_refuses_with_status_three(self):
        self.write_plan(dict(PLAN, extra=1))
        done = subprocess.run([sys.executable, '-B', str(SCRIPT), 'run', str(self.plan), str(self.journal)], capture_output=True)
        self.assertEqual((done.returncode, done.stdout.decode().startswith('refused: the plan must hold exactly')), (3, True))
        self.assertFalse(self.journal.exists())


if __name__ == '__main__':
    unittest.main()
