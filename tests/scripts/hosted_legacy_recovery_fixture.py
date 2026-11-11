"""Inert Docker/backup records shared by recovery sequence tests, never live proof."""
import copy
import json
from pathlib import Path
from unittest.mock import patch

import caddy_release_action as release
from caddy_active_config import snapshot_files
from caddy_recovery_preflight import preflight
from caddy_volume_migration import inspect_volumes
import legacy_handoff as handoff
import legacy_recovery_boundary as boundary
import legacy_recovery_checks as checks
import test_hosted_caddy_recovery_boundary as boundary_fixture
import test_hosted_caddy_recover_action as proxy_fixture
import test_hosted_caddy_legacy_handoff as legacy_fixture


class Fixture:
    def __init__(self, owner, control_model=False):
        for name, value in (('APP', '6' * 64), ('PG', '7' * 64)):
            binding = patch.object(legacy_fixture, name, value)
            binding.start()
            owner.addCleanup(binding.stop)
        self.b = boundary_fixture.RecoveryBoundaryTests()
        self.b.setUp()
        owner.addCleanup(self.b.doCleanups)
        self.p = proxy_fixture.RecoverActionTests()
        self.p.setUp()
        owner.addCleanup(self.p.doCleanups)
        self.root = self.p.fx.root
        self.value = self.b.value
        self.value['deploy_dir'] = str(self.root)
        self.b.root = self.b.fixture.root = self.root
        self.app, self.pg = self.b.fixture.app, self.b.fixture.pg
        self.app['Mounts'][0]['Source'] = str(self.root / 'portfolio')
        (self.root / 'portfolio').mkdir()
        for item, name, aliases in ((self.app, 'site', ['site', 'dollhousemcp']),
                                    (self.pg, 'site-postgres', ['postgres'])):
            item['Name'] = '/' + name
            item['HostConfig'].update(NetworkMode='site_default', PortBindings={})
            item['NetworkSettings'] = {'Ports': {}, 'Networks': {'site_default': {'Aliases': aliases}}}
            if control_model:
                item['Config']['Env'] = ['FIXTURE_PRIVATE=literal$fixture']
                item['HostConfig'].update(RestartPolicy={'Name': 'unless-stopped'},
                                          LogConfig={'Type': 'json-file', 'Config': {'max-size': '10m'}})
        self.current = self.p.current
        self.current.update(RestartCount=0)
        self.current['State'] = {'Running': True, 'Restarting': False, 'OOMKilled': False,
                                 'StartedAt': '2026-01-01T00:00:00Z', 'Pid': 123}
        self.current['NetworkSettings']['Ports'] = copy.deepcopy(self.current['HostConfig']['PortBindings'])
        for item in self.current['Mounts']:
            if item['Type'] == 'volume':
                item['Source'] = '/fixture/volumes/' + item['Name']
        self.previous = self.p.fx.previous
        self.previous.rename(self.root / 'server')
        for name in boundary.FILES:
            path = self.root / name
            if not path.exists():
                path.write_text('original-' + name)
            path.chmod(0o600 if name in ('.env', '.env.production') else 0o644)
        self.b.pending.update(previous=str(self.previous), receipt=str(self.p.fx.receipt),
                              receipt_sha256=handoff.digest((self.p.fx.receipt / 'receipt.json').read_bytes()),
                              source=boundary.bundle_identity(self.root / 'server'))
        self.state = {'pending': self.b.pending, 'completed': None}
        self.state_patch = patch.object(release, 'read_state', return_value=self.state)
        self.state_patch.start()
        owner.addCleanup(self.state_patch.stop)
        self.b.verify_patch.stop()  # Exercise the real completed-handoff verifier below.
        self.calls = []
        self.fail_operation = None
        self.after_mutation = None
        self.other = []
        self.armed = boundary.arm(self.root, self.value, self.run)
        (self.root / 'server').rename(self.previous)
        (self.root / 'server').mkdir()
        (self.root / 'server' / 'version').write_text('new-staged-source')
        normal, verification = b'fixture-normal', b'fixture-verification'
        hashes = snapshot_files(self.root, self.value['token'], normal, verification)
        (self.root / 'Caddyfile').write_bytes(verification)
        self.control = {'phase': 'probed', **hashes, 'public_origin': 'https://fixture.example',
                        'normal_config_sha256': '1' * 64, 'verification_config_sha256': '2' * 64,
                        'proxy': {'id': self.current['Id'], 'pid': 123,
                                  'started_at': self.current['State']['StartedAt'], 'restart_count': 0}}
        self.b.pending.update(phase='staged', staged_source=boundary.bundle_identity(self.root / 'server'),
                              image=self.p.fx.reference, control=self.control, volumes=['new_data', 'new_config'])
        # Inert namespace identity only. Real production checks use /proc and
        # full profiles/volume identities from the trusted Docker daemon.
        namespace = patch.object(checks, 'namespace_identity', return_value=(9, 10))
        namespace.start()
        owner.addCleanup(namespace.stop)
        serving = patch.object(checks, 'serving_config')
        self.serving_config = serving.start()
        owner.addCleanup(serving.stop)
        plan = preflight(self.root, 'site', self.previous, self.p.fx.reference, self.run, self.p.fx.qualify)
        self.control['proxy'].update(net_device=9, net_inode=10,
                                     profile_sha256=release.object_digest(plan['current_profile']),
                                     volumes_sha256=release.object_digest(inspect_volumes(self.run, self.b.pending['volumes'])))
        self.fence = {'token': self.value['token'], 'proxy': self.control['proxy'], 'source': self.b.pending['source']}

    def complete_handoff(self):
        return handoff.handoff(self.root, self.value, self.run, verify_fence=lambda *_: self.fence)

    def inventory(self):
        rows = [self.app, self.pg, self.current, *self.other]
        if self.p.recovered:
            rows.append(self.p.recovered)
        return [item for item in rows if item['State']['Running']]

    def run(self, argv, timeout, maximum):
        self.calls.append(argv)
        if argv[1] == 'ps':
            if '--filter' not in argv:
                return '\n'.join(item['Id'] for item in self.inventory()).encode()
            joined = ' '.join(argv)
            if 'service=dollhousemcp' in joined:
                return (self.app['Id'] + '\n').encode()
            if 'service=postgres' in joined:
                return (self.pg['Id'] + '\n').encode()
            return self.p.run_docker(argv, timeout, maximum)
        if argv[1:3] == ['container', 'inspect']:
            for item in (self.app, self.pg, *self.other):
                if argv[-1] == item['Id']:
                    return json.dumps([item]).encode()
        if argv[1:3] == ['image', 'inspect'] and argv[-1] == handoff.LEGACY_IMAGE:
            return json.dumps([self.b.fixture.image]).encode()
        if argv[1] == 'exec':
            if argv[2] == self.pg['Id']:
                return self.b.run_docker(argv, timeout, maximum)
            if argv[2] == self.app['Id']:
                return b'legacy-200-200-401-beta2\n'
        if argv[1] in ('start', 'stop') and argv[-1] == self.app['Id']:
            self.app['State']['Running'] = argv[1] == 'start'
            if argv[1] == 'start':
                self.app['State']['StartedAt'] = '2026-01-01T00:01:00Z'
            else:
                self.app['State'].update(ExitCode=0, FinishedAt='2026-01-01T00:00:30Z')
            if self.fail_operation == 'app-' + argv[1]:
                raise TimeoutError('fixture acknowledgement lost')
            return (self.app['Id'] + '\n').encode()
        if argv[1] == 'stop' and argv[-1] in (self.current['Id'], self.p.new_id):
            item = self.current if argv[-1] == self.current['Id'] else self.p.recovered
            item['State'].update(Running=False, ExitCode=0, FinishedAt='2026-01-01T00:02:00Z')
            if self.fail_operation == 'proxy-stop':
                raise TimeoutError('fixture stop acknowledgement lost')
            return (item['Id'] + '\n').encode()
        result = self.p.run_docker(argv, timeout, maximum)
        if argv[1] == 'create' and '--name' in argv and argv[argv.index('--name') + 1] == 'site-caddy':
            self.p.recovered['State'].update(Restarting=False, OOMKilled=False, ExitCode=0,
                                             StartedAt='2026-01-01T00:02:00Z', FinishedAt='2026-01-01T00:02:00Z')
            self.p.recovered['RestartCount'] = 0
            self.p.recovered['NetworkSettings']['Ports'] = copy.deepcopy(self.p.recovered['HostConfig']['PortBindings'])
            for item in self.p.recovered['Mounts']:
                if item['Type'] == 'volume':
                    item['Source'] = '/fixture/volumes/' + item['Name']
        if self.after_mutation:
            self.after_mutation(argv)
        return result
