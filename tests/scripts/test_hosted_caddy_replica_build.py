"""The replica builder replays an inventory, only on a declared replica, and reports every substitution.

A fake Engine and a temporary host tree stand in for Docker. Values are synthetic.
"""
import base64
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-replica'))
import build_replica as build
import prepare_inputs as prepare

IDENTITY = 'a' * 64
IMAGE = 'sha256:' + 'b' * 64
LIVE_DATABASE = 'c' * 64
PRIVATE = 'Zq7-SENTINEL-password'


class FakeEngine:
    """Answers the Engine calls the builder makes and remembers every one."""

    def __init__(self, root, states=None, existing=()):
        self.root, self.calls, self.created, self.existing = Path(root), [], [], list(existing)
        self.states = states or {}
        self.image = {'Id': IMAGE, 'Config': {'Env': ['PATH=/usr/bin', 'FROM_IMAGE=inherited'], 'Labels': {'baked': 'yes'}}}

    def call(self, method, path, body=None, expect=(200, 201, 204)):
        self.calls.append((method, path.split('?')[0], body))
        if (method, path) == ('GET', '/containers/json?all=1'):
            return [{'Names': [name]} for name in self.existing]
        if (method, path) == ('GET', '/volumes'):
            return {'Volumes': None}
        if (method, path) == ('GET', '/networks'):
            return [{'Name': 'bridge'}]
        if method == 'GET' and path.startswith('/images/'):
            return None if 'missing' in path else self.image
        if (method, path) == ('POST', '/volumes/create'):
            mountpoint = self.root / 'volumes' / body['Name']
            mountpoint.mkdir(parents=True)
            return {'Mountpoint': str(mountpoint)}
        if method == 'POST' and path.startswith('/containers/create'):
            self.created.append(body)
            return {'Id': 'id-' + path.split('name=')[1]}
        if method == 'GET' and path.startswith('/containers/'):
            sequence = self.states[path.split('/')[2]]
            return {'State': sequence.pop(0) if len(sequence) > 1 else sequence[0]}
        return None


def running(health=None):
    state = {'Status': 'running', 'Running': True, 'ExitCode': 0}
    return dict(state, Health={'Status': health}) if health else state


def exited(code):
    return {'Status': 'exited', 'Running': False, 'ExitCode': code}


def record(name, **changes):
    base = {
        'name': name, 'id': LIVE_DATABASE if name == '/database' else 'd' * 64, 'created': '2026-01-01T00:00:00Z',
        'image_id': IMAGE, 'image_reference': 'example:1', 'health': None, 'state': running(),
        'config': {'cmd': ['serve'], 'entrypoint': ['entry.sh'], 'user': 'app', 'working_dir': '/srv', 'volumes': ['/data'],
                   'exposed_ports': ['3000/tcp'], 'stop_signal': 'SIGINT',
                   'healthcheck': {'test': ['CMD', 'true'], 'Interval': 5, 'Retries': 3, 'StartPeriod': None},
                   'env': {'names': ['OWN', 'PUBLIC', 'SHARED', 'FROM_IMAGE', 'UNKNOWN', 'MAIL_HOST', 'MAIL_PORT'],
                           'public': {'PUBLIC': 'seen'}},
                   'labels': {'plain': 'kept', 'baked': {'length': 3, 'redacted': 'str'},
                              'token': {'length': 32, 'redacted': 'str'}, 'given': {'length': 5, 'redacted': 'str'}}},
        'host_config': {'Binds': ['/host/bound:/bound:ro'], 'Memory': 512, 'CapDrop': ['ALL'], 'Dns': None,
                        'NetworkMode': 'app_default', 'RestartPolicy': {'Name': 'no'}, 'log_driver': 'json-file',
                        'MaskedPaths': ['/proc/kcore']},
        'mounts': [{'Type': 'bind', 'Source': '/host/bound', 'Destination': '/bound', 'RW': False, 'Propagation': 'rprivate'},
                   {'Type': 'volume', 'Name': 'data', 'Source': '/var/lib/x', 'Destination': '/data', 'RW': True, 'Propagation': ''},
                   {'Type': 'bind', 'Source': '/host/file', 'Destination': '/file', 'RW': False, 'Propagation': 'rprivate'}],
        'networks': {'app_default': {'Aliases': ['app', 'web', 'app']}}}
    base.update(changes)
    return base


def inputs(**changes):
    value = {key: {} for key in ('environment', 'container_environment', 'labels', 'files', 'images', 'commands',
                                 'skip', 'database', 'trees', 'overrides')}
    value['package_name'] = None
    value.update(changes)
    return value


class Notes(list):
    def __call__(self, kind, subject, what):
        self.append((kind, subject, what))


class CreationTests(unittest.TestCase):
    def body(self, item, given, created=None):
        self.notes = Notes()
        with tempfile.TemporaryDirectory() as directory:
            self.engine = FakeEngine(directory)
            return build.creation(item, given, self.notes, self.engine, created or {})

    def test_container_is_created_as_recorded(self):
        body = self.body(record('/app'), inputs())
        self.assertEqual((body['Image'], body['Cmd'], body['Entrypoint'], body['User'], body['WorkingDir']),
                         ('example:1', ['serve'], ['entry.sh'], 'app', '/srv'))
        self.assertEqual((body['ExposedPorts'], body['Volumes'], body['StopSignal']), ({'3000/tcp': {}}, {'/data': {}}, 'SIGINT'))
        self.assertEqual(body['Healthcheck'], {'Test': ['CMD', 'true'], 'Interval': 5, 'Retries': 3})
        self.assertEqual(body['NetworkingConfig'], {'EndpointsConfig': {'app_default': {'Aliases': ['app', 'web']}}})
        host = body['HostConfig']
        self.assertEqual({key: host[key] for key in ('Binds', 'Memory', 'CapDrop', 'NetworkMode', 'LogConfig')}, {
            'Binds': ['/host/bound:/bound:ro'], 'Memory': 512, 'CapDrop': ['ALL'], 'NetworkMode': 'app_default',
            'LogConfig': {'Type': 'json-file'}})
        self.assertNotIn('Dns', host)
        self.assertNotIn('MaskedPaths', host)
        self.assertEqual(host['Mounts'], [
            {'Type': 'volume', 'Target': '/data', 'ReadOnly': False, 'Source': 'data'},
            {'Type': 'bind', 'Target': '/file', 'ReadOnly': True, 'Source': '/host/file', 'BindOptions': {'Propagation': 'rprivate'}}])

    def test_environment_values_come_from_the_most_specific_source(self):
        given = inputs(environment={'SHARED': 'common', 'OWN': 'not this'}, container_environment={'/app': {'OWN': 'mine'}},
                       overrides={'MAIL_HOST': {'value': '', 'reason': 'no mail'}, 'MAIL_PORT': {'value': None, 'reason': 'no mail'}})
        body = self.body(record('/app'), given)
        self.assertEqual(body['Env'], ['OWN=mine', 'PUBLIC=seen', 'SHARED=common', 'FROM_IMAGE=inherited',
                                       'UNKNOWN=replica-unknown', 'MAIL_HOST='])
        self.assertIn(('environment', '/app UNKNOWN', 'synthetic'), self.notes)
        self.assertEqual([note for note in self.notes if note[0] == 'override'],
                         [('override', 'MAIL_HOST', 'no mail'), ('override', 'MAIL_PORT', 'no mail')])

    def test_redacted_labels_are_inherited_supplied_or_stable_identifiers(self):
        first = self.body(record('/app'), inputs(labels={'given': 'value'}))['Labels']
        again = self.body(record('/app'), inputs(labels={'given': 'value'}))['Labels']
        other = self.body(record('/other'), inputs(labels={'given': 'value'}))['Labels']
        self.assertEqual((first['plain'], first['given'], 'baked' in first), ('kept', 'value', False))
        self.assertRegex(first['token'], r'\A[0-9a-f]{32}\Z')
        self.assertEqual(first['token'], again['token'])
        self.assertNotEqual(first['token'], other['token'])
        self.assertEqual([note for note in self.notes if note[0] == 'label'],
                         [('label', '/other token', 'synthetic'), ('label', '/other given', 'supplied')])

    def test_stand_ins_are_used_and_named(self):
        standin = 'sha256:' + 'e' * 64
        given = inputs(images={IMAGE: {'image': standin, 'reason': 'image only on live'}},
                       commands={'/app': {'cmd': ['stub'], 'reason': 'settings unknown'}})
        body = self.body(record('/app'), given)
        self.assertEqual((body['Image'], body['Cmd']), (standin, ['stub']))
        self.assertEqual(self.notes[:2], [('image', '/app', 'image only on live'), ('command', '/app', 'settings unknown')])

    def test_image_is_named_by_id_when_the_reference_is_not_local(self):
        self.assertEqual(self.body(record('/app', image_reference='missing:1'), inputs())['Image'], IMAGE)

    def test_a_joined_network_points_at_the_replica_container(self):
        item = record('/app')
        item['host_config']['NetworkMode'] = 'container:' + LIVE_DATABASE
        body = self.body(item, inputs(), {LIVE_DATABASE: 'replica-database-id'})
        self.assertEqual(body['HostConfig']['NetworkMode'], 'container:replica-database-id')
        self.assertNotIn('ExposedPorts', body)
        self.assertNotIn('NetworkingConfig', body)


class SettleTests(unittest.TestCase):
    def settle(self, item, states):
        notes = Notes()
        with tempfile.TemporaryDirectory() as directory, patch.object(build.time, 'sleep'):
            engine = FakeEngine(directory, {'one': states})
            reached = build.settle(engine, 'one', item, notes)
        return reached, [call[:2] for call in engine.calls if call[0] == 'POST'], notes

    def test_waits_for_recorded_health(self):
        reached, posts, _ = self.settle(record('/app', health='healthy'), [running('starting'), running('starting'), running('healthy')])
        self.assertEqual((reached, posts), ('running', [('POST', '/containers/one/start')]))

    def test_running_without_health_is_enough_when_none_was_recorded(self):
        self.assertEqual(self.settle(record('/app'), [running('starting')])[0], 'running')

    def test_exit_code_is_reported_for_a_finished_container(self):
        reached, _, _ = self.settle(record('/job', state=exited(0)), [running(), exited(2)])
        self.assertEqual(reached, 'exited 2')
        self.assertEqual((build.described(exited(0)), build.described(running()),
                          build.described({'Status': 'created', 'Running': False, 'ExitCode': 0})),
                         ('exited 0', 'running', 'created'))

    def test_a_retained_server_is_stopped_and_the_stop_is_noted(self):
        with patch.object(build, 'EXIT_WAIT', -1):
            reached, posts, notes = self.settle(record('/proxy', state=exited(0)), [running(), exited(0)])
        self.assertEqual((reached, posts), ('exited 0', [('POST', '/containers/one/start'), ('POST', '/containers/one/stop')]))
        self.assertEqual(notes, [('container', '/proxy', 'stopped by the builder after it kept running')])

    def test_a_container_that_dies_is_not_reported_as_built(self):
        self.assertEqual(self.settle(record('/app'), [dict(exited(1), Restarting=False)])[0], 'exited 1 (not the recorded state)')

    def test_created_only_containers_are_not_started(self):
        reached, posts, _ = self.settle(record('/idle', state={'Status': 'created', 'Running': False, 'ExitCode': 0}), [running()])
        self.assertEqual((reached, posts), ('created', []))


class DatabaseTests(unittest.TestCase):
    SPEC = {'superuser': 'admin_role', 'name': 'appdb', 'globals': os.devnull, 'dump': os.devnull,
            'urls': ['postgres://app_role:%s@database:5432/appdb' % PRIVATE]}

    def test_dump_is_restored_and_passwords_never_reach_a_command_line(self):
        seen = []

        def run(command, **options):
            seen.append((command, options.get('input')))
            return type('Done', (), {'returncode': 0})()
        with patch.object(build.subprocess, 'run', side_effect=run):
            result = build.restore_database('container-id', self.SPEC)
        self.assertEqual(result, {'drop': 0, 'globals': 0, 'restore': 0, 'passwords': [0]})
        self.assertEqual([command[4] for command, _ in seen], ['psql', 'psql', 'pg_restore', 'psql'])
        self.assertTrue(all(command[:4] == ['/usr/bin/docker', 'exec', '--interactive', 'container-id'] for command, _ in seen))
        self.assertEqual(seen[2][0][-2:], ['--exit-on-error', '--create'])
        self.assertNotIn(PRIVATE, json.dumps([command for command, _ in seen]))
        self.assertIn(b'ALTER ROLE "app_role" PASSWORD \'%s\';' % PRIVATE.encode(), seen[3][1])

    def test_unsafe_names_and_passwords_are_refused(self):
        with patch.object(build.subprocess, 'run') as run:
            run.return_value.returncode = 0
            with self.assertRaises(ValueError):
                build.restore_database('id', dict(self.SPEC, name='app"db'))
            with self.assertRaises(ValueError):
                build.restore_database('id', dict(self.SPEC, urls=["postgres://app_role:it's@database/appdb"]))


class BuildTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.deploy = self.root / 'deploy'
        self.declaration = self.root / 'declaration'
        self.declaration.write_text(IDENTITY + '\n', encoding='ascii')
        (self.root / 'supplied').write_text('real content', encoding='utf-8')
        self.inventory = {
            'host': {'hostname': 'live-host', 'machine_id_sha256': 'f' * 64},
            'networks': [{'name': 'bridge'}, {
                'name': 'app_default', 'Driver': 'bridge', 'Internal': False, 'Attachable': False, 'EnableIPv6': False,
                'ipam': {'driver': 'default', 'config': [{'Subnet': '172.30.0.0/16', 'Gateway': '172.30.0.1', 'IPRange': None}]},
                'options': {}, 'labels': {'project': 'app'}}],
            'volumes': [{'Name': 'data', 'Driver': 'local', 'options': {}, 'labels': {},
                         'root': {'uid': 0, 'gid': 0, 'mode': '0755'},
                         'tree': {'entries': [{'path': 'caddy', 'type': 'dir', 'mode': '1777', 'uid': 0, 'gid': 0},
                                              {'path': 'caddy/state.json', 'type': 'file', 'mode': '0600', 'uid': 0, 'gid': 0, 'size': 9}]}}],
            'deployment': {
                'path': str(self.deploy), 'root': {'uid': 0, 'gid': 0, 'mode': '0750'},
                'entries': [{'name': 'compose.yml', 'type': 'file', 'mode': '0600', 'uid': 0, 'gid': 0, 'size': 3},
                            {'name': 'blob', 'type': 'file', 'mode': '0644', 'uid': 0, 'gid': 0, 'size': 4},
                            {'name': '.env', 'type': 'file', 'mode': '0600', 'uid': 0, 'gid': 0,
                             'env': {'names': ['A', 'B'], 'empty': ['B']}},
                            {'name': 'server', 'type': 'dir', 'mode': '0755', 'uid': 0, 'gid': 0},
                            {'name': '.state', 'type': 'dir', 'mode': '0700', 'uid': 0, 'gid': 0},
                            {'name': 'socket', 'type': 'socket', 'mode': '0600', 'uid': 0, 'gid': 0}],
                'bundles': {'server': {'name': {'length': 7, 'redacted': 'str'}, 'version': '1.2.3'}},
                'markers': {'.state': {'entries': [{'path': 'state.json', 'type': 'file', 'mode': '0600', 'uid': 0, 'gid': 0, 'size': 2}]}}},
            'neighbours': {str(self.root / 'next-door'): {'mode': '0700', 'uid': 0, 'gid': 0, 'entries': [
                {'name': 'note', 'type': 'file', 'mode': '0600', 'uid': 0, 'gid': 0, 'size': 1}]}},
            'referenced_files': {str(self.root / 'deep' / 'er' / 'script.mjs'): {'type': 'file', 'mode': '0644', 'uid': 0, 'gid': 0, 'size': 5}},
            'containers': [record('/app', created='2026-01-02T00:00:00Z'), record('/database', health='healthy')]}
        self.inputs = {'files': {str(self.deploy / 'compose.yml'): str(self.root / 'supplied')}, 'package_name': 'example'}
        self.state = None
        self.engine = FakeEngine(self.root, {'id-app': [running()], 'id-database': [running('healthy')]})
        for target, value in ((build, 'DECLARATION'), ):
            patcher = patch.object(target, value, str(self.declaration))
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, replacement in (('machine_identity', lambda: IDENTITY), ('Engine', lambda: self.engine)):
            patcher = patch.object(build, name, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(build.os, 'chown')
        self.chown = patcher.start()
        self.addCleanup(patcher.stop)

    def run_build(self):
        report = build.build(self.inventory, self.inputs, self.state)
        self.state = report['state']
        return report

    def test_inventory_is_replayed_and_every_filler_is_listed(self):
        report = self.run_build()
        self.assertEqual(report['containers'], {'/database': {'recorded': 'running', 'reached': 'running'},
                                                '/app': {'recorded': 'running', 'reached': 'running'}})
        self.assertEqual((report['complete'], report['failed']), (True, None))
        network = next(body for method, path, body in self.engine.calls if path == '/networks/create')
        self.assertEqual((network['Name'], network['IPAM']['Config'], network['Labels']),
                         ('app_default', [{'Subnet': '172.30.0.0/16', 'Gateway': '172.30.0.1'}], {'project': 'app'}))
        self.assertEqual((self.deploy / 'compose.yml').read_text(encoding='utf-8'), 'real content')
        self.assertEqual((self.deploy / 'blob').read_bytes(), b'\0' * 4)
        self.assertEqual((self.deploy / '.env').read_text(encoding='utf-8'), 'A=replica\nB=\n')
        self.assertEqual((self.deploy / '.state' / 'state.json').read_bytes(), b'{}')
        self.assertEqual(json.loads((self.deploy / 'server' / 'package.json').read_text(encoding='utf-8')),
                         {'name': 'example', 'version': '1.2.3'})
        self.assertFalse((self.deploy / 'socket').exists())
        self.assertEqual((self.root / 'deep' / 'er' / 'script.mjs').stat().st_size, 5)
        self.assertEqual((self.root / 'next-door' / 'note').stat().st_mode & 0o777, 0o600)
        volume = self.root / 'volumes' / 'data' / 'caddy'
        self.assertEqual((volume.stat().st_mode & 0o7777, (volume / 'state.json').stat().st_mode & 0o777), (0o1777, 0o600))
        self.assertEqual((self.deploy.stat().st_mode & 0o777, (self.deploy / 'compose.yml').stat().st_mode & 0o777), (0o750, 0o600))
        fillers = sorted(item['subject'] for item in report['substitutions'] if item['kind'] == 'file')
        self.assertNotIn(str(self.deploy / 'compose.yml'), fillers)
        self.assertIn(str(self.deploy / 'blob'), fillers)
        state = report['state']
        self.assertEqual((state['containers'], state['volumes'], state['networks']),
                         ({'/database': 'id-database', '/app': 'id-app'}, ['data'], ['app_default']))
        self.assertEqual(sorted(state['files']), sorted(str(self.root / name) for name in ('deploy', 'next-door', 'deep')))

    def test_second_run_creates_nothing_again(self):
        self.run_build()
        before = len([call for call in self.engine.calls if 'create' in call[1]])
        self.engine.existing = ['/app', '/database']
        self.run_build()
        self.assertEqual(len([call for call in self.engine.calls if 'create' in call[1]]), before)

    def test_destroy_removes_only_what_the_build_created(self):
        self.run_build()
        keep = self.root / 'unrelated'
        keep.mkdir()
        emptied = build.destroy(self.state)
        self.assertEqual(emptied['state'], build.EMPTY)
        deleted = sorted(path for method, path, _ in self.engine.calls if method == 'DELETE')
        self.assertEqual(deleted, ['/containers/id-app', '/containers/id-database', '/networks/app_default', '/volumes/data'])
        self.assertEqual((self.deploy.exists(), (self.root / 'next-door').exists(), (self.root / 'deep').exists(), keep.exists()),
                         (False, False, False, True))

    def test_skipped_and_failed_containers_are_reported(self):
        self.inputs['skip'] = {'/app': 'not needed'}
        self.engine.states['id-database'] = [dict(exited(1), Restarting=False)]
        report = self.run_build()
        self.assertEqual(report['containers'], {'/database': {'recorded': 'running', 'reached': 'exited 1 (not the recorded state)'}})
        self.assertFalse(report['complete'])
        self.assertIn({'kind': 'container', 'subject': '/app', 'what': 'skipped: not needed'}, report['substitutions'])

    def refusal(self):
        with self.assertRaises(build.Refused) as caught:
            self.run_build()
        self.assertEqual([call for call in self.engine.calls if call[0] != 'GET'], [])
        self.assertFalse(self.deploy.exists())
        return str(caught.exception)

    def test_refuses_a_host_that_is_not_declared(self):
        self.declaration.unlink()
        self.assertIn('not declared', self.refusal())

    def test_refuses_a_declaration_for_another_host(self):
        self.declaration.write_text('9' * 64, encoding='ascii')
        self.assertIn('names another host', self.refusal())

    def test_refuses_to_build_on_the_inventory_s_own_host(self):
        self.inventory['host']['machine_id_sha256'] = IDENTITY
        self.assertIn('describes this host', self.refusal())
        self.inventory['host'] = {'hostname': build.socket.gethostname(), 'machine_id_sha256': 'f' * 64}
        self.assertIn('describes this host', self.refusal())

    def test_refuses_an_engine_that_holds_other_objects(self):
        self.engine.existing = ['/someone-elses']
        self.assertIn('did not create', self.refusal())

    def test_a_folder_it_did_not_create_stops_the_build_and_the_state_survives(self):
        self.deploy.mkdir()
        report = self.run_build()
        self.assertEqual(list(self.deploy.iterdir()), [])
        self.assertEqual((report['failed'], report['complete'], report['containers']),
                         ('Refused: a folder this build must create already exists', False, {}))
        self.assertEqual((report['state']['networks'], report['state']['volumes'], report['state']['files']),
                         (['app_default'], ['data'], []))

    def test_a_failed_engine_call_is_reported_with_the_state(self):
        original = self.engine.call

        def call(method, path, body=None, expect=(200, 201, 204)):
            if method == 'POST' and path.startswith('/containers/create'):
                raise RuntimeError('Engine POST /containers/create answered 500: synthetic')
            return original(method, path, body, expect)
        self.engine.call = call
        report = self.run_build()
        self.assertEqual(report['failed'], 'RuntimeError: Engine POST /containers/create answered 500: synthetic')
        self.assertEqual((report['state']['containers'], report['state']['volumes']), ({}, ['data']))

    def test_destroy_is_refused_on_an_undeclared_host(self):
        self.run_build()
        self.declaration.unlink()
        with self.assertRaises(build.Refused):
            build.destroy(self.state)
        self.assertEqual([call for call in self.engine.calls if call[0] == 'DELETE'], [])
        self.assertTrue(self.deploy.exists())

    def test_a_created_only_container_counts_as_built(self):
        self.inventory['containers'][0]['state'] = {'Status': 'created', 'Running': False, 'ExitCode': 0}
        report = self.run_build()
        self.assertEqual(report['containers']['/app'], {'recorded': 'created', 'reached': 'created'})
        self.assertTrue(report['complete'])

    def main(self, action, *documents):
        text = '\n'.join(json.dumps(document, indent=1) for document in documents)
        with patch.object(build.sys, 'stdin', io.StringIO(text)), patch('builtins.print') as printed:
            status = build.main(['build_replica.py', action])
        return status, json.loads(printed.call_args[0][0])

    def test_main_builds_from_documents_on_standard_input_and_destroys_from_the_result(self):
        status, result = self.main('build', self.inventory, self.inputs)
        self.assertEqual((status, result['complete'], sorted(result['state']['containers'])), (0, True, ['/app', '/database']))
        self.engine.existing = ['/app', '/database']
        again, second = self.main('build', self.inventory, self.inputs, result)
        self.assertEqual((again, second['state']), (0, result['state']))
        status, emptied = self.main('destroy', second)
        self.assertEqual((status, emptied['state'], self.deploy.exists()), (0, build.EMPTY, False))

    def test_main_reports_a_refusal_with_exit_3(self):
        self.declaration.unlink()
        self.assertEqual(self.main('build', self.inventory, self.inputs),
                         (3, {'refused': 'this host is not declared as a replica'}))

    def test_main_reports_an_incomplete_or_failed_build(self):
        self.engine.states['id-database'] = [dict(exited(1), Restarting=False)]
        self.assertEqual(self.main('build', self.inventory, self.inputs)[0], 3)

    def test_main_reports_a_failed_step_with_exit_1(self):
        self.deploy.mkdir()
        status, result = self.main('build', self.inventory, self.inputs)
        self.assertEqual((status, result['failed'][:8], result['state']['volumes']), (1, 'Refused:', ['data']))

    def test_main_needs_its_documents(self):
        with patch.object(build.sys, 'stdin', io.StringIO(json.dumps(self.inventory))):
            with self.assertRaises(ValueError):
                build.main(['build_replica.py', 'build'])


class PrepareTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.control, self.output = Path(temporary.name) / 'control-files', Path(temporary.name) / 'prepared'
        files = {
            '.env.production': ('0600', 'PORT=3000\nTOKEN_SECRET=__DOLLHOUSE_REPLICA_TOKEN_SECRET__\n'
                                        'MASTER_KEY="__DOLLHOUSE_REPLICA_MASTER_KEY__"\nVOLUME=__DOLLHOUSE_REPLICA_VOLUME__\n'
                                        'URL=postgres://app:__DOLLHOUSE_REPLICA_TOKEN_SECRET__@database/app\n# note\n'),
            'compose.yml': ('0600', 'services: {}\n'),
            'staging/overlay.json': ('0600', json.dumps({'services': {'web': {'environment': {
                'TOKEN_SECRET': '__DOLLHOUSE_REPLICA_TOKEN_SECRET__', 'COUNT': 2}}}})),
            'Caddyfile': ('0644', 'example.invalid {\n}\n')}
        for name, (mode, text) in files.items():
            (self.control / name).parent.mkdir(parents=True, exist_ok=True)
            (self.control / name).write_text(text, encoding='utf-8')
        (self.control / 'MANIFEST.json').write_text(json.dumps({'files': [
            {'path': name, 'mode': mode} for name, (mode, _) in files.items()]}), encoding='utf-8')
        labels = {'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web',
                  'com.docker.compose.project.environment_file': '/opt/app/.env.production',
                  'com.docker.compose.project.config_files': '/opt/app/compose.yml,/opt/app/staging/overlay.json'}
        self.inventory = {'deployment': {'path': '/opt/app'}, 'containers': [
            {'name': '/web', 'config': {'labels': labels}},
            {'name': '/old', 'config': {'labels': dict(labels, **{
                'com.docker.compose.project.config_files': '/opt/app/gone.yml,/opt/app/staging/overlay.json'})}},
            {'name': '/other', 'config': {'labels': {}}}]}
        self.commands = []

    def prepared(self, model=None):
        def run(command, **options):
            self.commands.append(command)
            done = type('Done', (), {'returncode': 0 if model is not None else 1, 'stdout': json.dumps(model).encode()})
            return done()
        with patch.object(prepare.subprocess, 'run', side_effect=run):
            report = prepare.prepare(self.inventory, self.control, self.output, {'VOLUME': 'data_volume'})
        return report, json.loads((self.output / 'inputs.json').read_text(encoding='utf-8'))

    def test_placeholders_become_known_values_or_fresh_keys_of_the_required_form(self):
        report, inputs_file = self.prepared()
        environment = inputs_file['environment']
        self.assertEqual((environment['PORT'], environment['VOLUME']), ('3000', 'data_volume'))
        self.assertRegex(environment['TOKEN_SECRET'], r'\A[0-9a-f]{64}\Z')
        self.assertEqual(len(base64.b64decode(environment['MASTER_KEY'], validate=True)), 32)
        self.assertEqual(environment['URL'], 'postgres://app:%s@database/app' % environment['TOKEN_SECRET'])
        self.assertEqual(inputs_file['files']['/opt/app/Caddyfile'], str(self.output / 'files' / 'Caddyfile'))
        self.assertNotIn('/opt/app/MANIFEST.json', inputs_file['files'])
        self.assertEqual((report['placeholders_known'], report['placeholders_random']), (['VOLUME'], 2))
        self.assertNotIn(environment['TOKEN_SECRET'], json.dumps(report))

    def test_service_environment_is_what_compose_resolves_from_the_completed_files(self):
        model = {'services': {'web': {'environment': {'FROM_BASE': 'postgres://resolved', 'COUNT': 2, 'UNSET': None}}}}
        report, inputs_file = self.prepared(model)
        self.assertEqual(inputs_file['container_environment']['/web'], {'FROM_BASE': 'postgres://resolved', 'COUNT': '2'})
        files = self.output / 'files'
        self.assertEqual(self.commands, [[
            '/usr/bin/docker', 'compose', '--project-name', 'app', '--project-directory', str(files),
            '--env-file', str(files / '.env.production'), '-f', str(files / 'compose.yml'),
            '-f', str(files / 'staging' / 'overlay.json'), 'config', '--format', 'json']])
        self.assertEqual(report['service_environments'], {'/old': 'overlay', '/web': 'compose'})

    def test_overlays_alone_are_the_fallback_and_the_report_says_so(self):
        report, inputs_file = self.prepared()
        secret = inputs_file['environment']['TOKEN_SECRET']
        self.assertEqual(inputs_file['container_environment'], {
            '/web': {'TOKEN_SECRET': secret, 'COUNT': '2'}, '/old': {'TOKEN_SECRET': secret, 'COUNT': '2'}})
        self.assertEqual(report['service_environments'], {'/old': 'overlay', '/web': 'overlay'})

    def test_second_run_keeps_the_same_secrets_and_everything_is_private(self):
        first = self.prepared()[1]
        second = self.prepared()[1]
        self.assertEqual(first, second)
        modes = {path.name: path.stat().st_mode & 0o777 for path in (
            self.output / 'secrets.json', self.output / 'inputs.json', self.output / 'files' / '.env.production',
            self.output / 'files' / 'Caddyfile')}
        self.assertEqual(modes, {'secrets.json': 0o600, 'inputs.json': 0o600, '.env.production': 0o600, 'Caddyfile': 0o644})
        self.assertNotIn('__DOLLHOUSE_REPLICA_', (self.output / 'files' / '.env.production').read_text(encoding='utf-8'))

    def test_command_works_in_the_current_folder_and_takes_no_argument(self):
        with self.assertRaises(ValueError):
            prepare.main(['prepare_inputs.py', 'somewhere'])
        (self.control.parent / 'inventory.json').write_text(json.dumps(self.inventory), encoding='utf-8')
        done = subprocess.run([sys.executable, str(SCRIPTS / 'hosted-replica' / 'prepare_inputs.py')],
                              cwd=self.control.parent, capture_output=True, check=True,
                              env=dict(os.environ, PATH='/nonexistent'))
        self.assertEqual(json.loads(done.stdout)['files'], 4)
        self.assertTrue((self.output / 'inputs.json').exists())


if __name__ == '__main__':
    unittest.main()
