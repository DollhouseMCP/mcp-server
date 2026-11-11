"""Read-only contract and redaction of the hosted live inventory.

The source checks hold the script to its contract: GET-only Docker access, a
fixed pair of version commands and no call that can change a host. The
behaviour checks use a temporary host tree and a fake Engine. When a local
Docker Engine socket is reachable, the script also runs against the real one.
"""
import ast
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
import live_inventory as inventory

SOURCE = SCRIPTS / 'hosted-deploy' / 'live_inventory.py'
PRIVATE = 'Zq7-SENTINEL-value'
# A plain word passes the public-value patterns, so it must be withheld by position alone.
PLAIN = 'sentinelplainword'
CONTAINER = 'c' * 64
IMAGE = 'sha256:' + 'd' * 64
NETWORK = 'e' * 64
MUTATING = {
    'chmod', 'chown', 'copy', 'copyfile', 'copytree', 'flock', 'ftruncate', 'kill', 'lchown', 'link', 'lockf',
    'makedirs', 'mkdir', 'mkfifo', 'mknod', 'move', 'popen', 'Popen', 'putrequest', 'remove', 'removedirs',
    'rename', 'renames', 'replace_file', 'rmdir', 'rmtree', 'sendall', 'symlink', 'system', 'touch', 'truncate',
    'unlink', 'utime', 'write', 'write_bytes', 'write_text', 'writelines', 'call', 'check_call', 'check_output',
    'execv', 'execve', 'fork', 'spawn', 'urlopen', 'create_connection',
}
IMPORTS = {'argparse', 'datetime', 'hashlib', 'http.client', 'ipaddress', 'json', 'os', 'platform', 're', 'shutil',
           'socket', 'stat', 'subprocess', 'sys', 'time'}


def called_name(node):
    return node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, 'id', None)


def calls(tree, name):
    return [node for node in ast.walk(tree) if isinstance(node, ast.Call) and called_name(node) == name]


def enclosing_functions(tree, name):
    return {node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and calls(node, name)}


class SourceContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tree = ast.parse(SOURCE.read_text())

    def test_imports_are_the_reviewed_standard_library_set(self):
        imported = set()
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            self.assertNotIsInstance(node, ast.ImportFrom)
        self.assertEqual(imported, IMPORTS)

    def test_no_call_can_change_the_host(self):
        names = {called_name(node) for node in ast.walk(self.tree) if isinstance(node, ast.Call)}
        self.assertEqual(names & MUTATING, set())
        self.assertNotIn('open', {node.func.id for node in ast.walk(self.tree)
                                  if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)})

    def test_files_open_read_only_through_one_function(self):
        self.assertEqual(enclosing_functions(self.tree, 'open'), {'open_read'})
        flags = {node.attr for node in ast.walk(self.tree) if isinstance(node, ast.Attribute) and node.attr.startswith('O_')}
        self.assertEqual(flags, {'O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_CLOEXEC', 'O_DIRECTORY'})

    def test_docker_is_reached_only_by_get(self):
        requests = calls(self.tree, 'request')
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].args[0].value, 'GET')
        self.assertEqual(enclosing_functions(self.tree, 'request'), {'engine', 'get'})
        self.assertEqual(len(calls(self.tree, 'socket')), 1)
        self.assertEqual(calls(self.tree, 'socket')[0].args[0].attr, 'AF_UNIX')

    def test_engine_allowlist_refuses_everything_but_inspection(self):
        get = inventory.engine('/nonexistent/docker.sock')
        for path in ('/containers/%s/logs' % CONTAINER, '/containers/%s/export' % CONTAINER,
                     '/containers/%s/archive?path=/' % CONTAINER, '/containers/%s/json?size=true' % CONTAINER,
                     '/events', '/images/%s/get' % IMAGE, '/containers/json', '/containers/json?all=true&size=1',
                     '/v1.44/info', '/info/../events', '/info\n'):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'allowlist'):
                get(path)

    def test_child_processes_are_two_local_version_commands(self):
        self.assertEqual(enclosing_functions(self.tree, 'run'), {'tool_version'})
        self.assertEqual(len(calls(self.tree, 'run')), 1)
        self.assertEqual(inventory.TOOL_VERSIONS, {'docker': ('/usr/bin/docker', '--version'),
                                                   'compose': ('/usr/bin/docker', 'compose', 'version', '--short')})
        with self.assertRaisesRegex(ValueError, 'allowlist'):
            inventory.tool_version(('/usr/bin/docker', 'ps'))


def fake_engine(volume, bind, missing=()):
    container = {
        'Id': CONTAINER, 'Name': '/dollhousemcp-caddy', 'Image': IMAGE, 'RestartCount': 0, 'Path': 'caddy',
        'Args': ['run', '--config', '/etc/caddy/Caddyfile', '--password', PLAIN, '--token=' + PLAIN],
        'State': {'Status': 'running', 'Running': True, 'StartedAt': '2026-01-01T00:00:00Z',
                  'Health': {'Status': 'healthy', 'Log': [{'Output': PRIVATE}]}},
        'Config': {'Image': 'caddy:2', 'Env': ['CADDY_VERSION=v2.8.4', 'DATABASE_URL=postgres://u:%s@db/x' % PRIVATE,
                                               'ADMIN_PIN=' + PLAIN],
                   'Cmd': ['sh', '-c', 'curl https://user:%s@example.invalid' % PRIVATE],
                   'Labels': {'com.docker.compose.project': 'dollhousemcp',
                              'com.docker.compose.project.config_files': str(bind / 'compose.yml'),
                              'vendor.note': PLAIN},
                   'Healthcheck': {'Test': ['CMD-SHELL', 'wget -q localhost:2019'], 'Retries': 3}},
        'HostConfig': {'NetworkMode': 'dollhousemcp_default', 'MaskedPaths': ['/proc/kcore'],
                       'PortBindings': {'443/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '443'}]}},
        'Mounts': [{'Type': 'volume', 'Name': 'dollhousemcp_caddy_data', 'Source': str(volume), 'Destination': '/data'},
                   {'Type': 'bind', 'Source': str(bind / 'Caddyfile'), 'Destination': '/etc/caddy/Caddyfile'}],
        'NetworkSettings': {'Networks': {'dollhousemcp_default': {'Aliases': ['caddy'], 'IPAddress': '172.18.0.2'}},
                            'Ports': {'443/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '443'}]}},
    }
    responses = {
        '/version': {'Version': '29.0.0', 'ApiVersion': '1.50', 'Components': [{'Name': 'Engine', 'Version': '29.0.0'}]},
        '/info': {'ServerVersion': '29.0.0', 'Driver': 'overlayfs', 'HttpProxy': 'http://u:%s@proxy' % PRIVATE},
        '/containers/json?all=true': [{'Id': CONTAINER}, {'Id': 'f' * 64}],
        '/containers/%s/json' % CONTAINER: container,
        '/images/json': [{'Id': IMAGE}],
        '/images/%s/json' % IMAGE: {'Id': IMAGE, 'RepoTags': ['caddy:2'], 'Architecture': 'amd64', 'Os': 'linux',
                                     'Config': {'Env': ['CADDY_VERSION=v2.8.4', 'BUILD_SECRET=' + PLAIN]},
                                     'RootFS': {'Type': 'layers', 'Layers': ['sha256:' + '1' * 64]}},
        '/networks': [{'Id': NETWORK}],
        '/networks/' + NETWORK: {'Id': NETWORK, 'Name': 'dollhousemcp_default', 'Driver': 'bridge',
                                 'IPAM': {'Config': [{'Subnet': '172.18.0.0/16'}]},
                                 'Containers': {CONTAINER: {'Name': 'dollhousemcp-caddy', 'IPv4Address': '172.18.0.2/16'}}},
        '/volumes': {'Volumes': [{'Name': 'dollhousemcp_caddy_data', 'Driver': 'local', 'Mountpoint': str(volume),
                                  'Options': {'o': 'username=x,password=' + PLAIN}},
                                 {'Name': 'dollhousemcp_pgdata', 'Driver': 'local', 'Mountpoint': str(bind / 'pgdata')}]},
    }

    def get(path):
        if path in missing or path not in responses:
            raise ValueError('Docker GET %s returned HTTP 404' % path)
        return responses[path]
    return get


def write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def host_tree(base):
    """A synthetic host with the shapes that fixtures lacked: sticky modes, markers, symlinks and leftovers."""
    root = base / 'host'
    deploy = base / 'deploy'
    volume = base / 'volume'
    # Ubuntu ships /etc/os-release as a symlink. The first run on a real host failed on exactly this.
    write(root / 'usr/lib/os-release', 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n')
    (root / 'etc').mkdir()
    (root / 'etc/os-release').symlink_to('../usr/lib/os-release')
    write(root / 'etc/machine-id', 'abcdef\n')
    write(root / 'etc/docker/daemon.json', json.dumps({'live-restore': False, 'registry-secret': PLAIN}))
    write(root / 'proc/stat', 'cpu 1 2 3\nbtime 1767225600\n')
    write(root / 'proc/self/status', 'Name:\tpython3\nUmask:\t0022\n')
    write(root / 'proc/net/tcp', 'sl local rem st tx tr retr uid\n'
          '0: 00000000:01BB 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1 1\n'
          '1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 2 1\n'
          '2: 0100007F:9999 0200007F:0050 01 00000000:00000000 00:00000000 00000000 0 0 3 1\n')
    write(root / 'proc/net/tcp6', 'sl local rem st tx tr retr uid\n'
          '0: 00000000000000000000000001000000:0050 00000000000000000000000000000000:0000 0A 0:0 0:0 0 0 0 4 1\n')
    write(root / 'proc/4242/cmdline', 'bash\0/root/x/scripts/hosted-deploy.sh\0--password\0%s\0' % PLAIN)
    write(root / 'proc/7/cmdline', 'sleep\0600\0')
    write(root / 'proc/locks', '')
    write(root / 'opt/dollhousemcp-other/Caddyfile', PLAIN)
    write(root / 'root/dollhousemcp-evidence/receipt.json', PRIVATE)
    write(root / 'root/unrelated/file', PRIVATE)

    write(deploy / '.env', 'POSTGRES_PASSWORD=%s\nexport EMPTY=\n# COMMENT=1\nPORT=3000\nPLAIN_NAME=%s\n' % (PRIVATE, PLAIN))
    write(deploy / '.env.production', 'SESSION_SECRET=%s\n' % PRIVATE)
    write(deploy / 'compose.yml', 'services:\n  app:\n    environment:\n      KEY: %s\n' % PLAIN)
    write(deploy / 'Caddyfile', 'mcp.example.invalid {\n\treverse_proxy dollhousemcp:3000\n}\n', 0o644)
    write(deploy / 'DEPLOYED_REVISION', 'a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5\n')
    write(deploy / '.caddy-deploy.lock', '')
    write(deploy / 'server/package.json', json.dumps({'name': 'mcp-server', 'version': '2.1.0-beta.3', 'x': PLAIN}))
    write(deploy / 'pgdata/PG_VERSION', '17\n')
    write(deploy / 'portfolio/personas/private.md', PLAIN)
    token = 'ab' * 16
    write(deploy / '.caddy-state/state.json', json.dumps({
        'pending': {'kind': 'update', 'token': token, 'phase': 'staged', 'previous': '/opt/dollhousemcp/server.prev-' + token,
                    'image': 'ghcr.io/dollhousemcp/caddy-proxy@sha256:' + '8' * 64,
                    'control': {'public_origin': 'https://mcp.example.invalid', 'proxy': {'pid': 7, 'api_key': PLAIN}},
                    'profile': {'env': ['CADDY_VERSION=v2.8.4', 'UPSTREAM_PASSWORD=' + PLAIN], 'note': 'Free text ' + PRIVATE}},
        'completed': None}))
    write(deploy / '.caddy-recovery' / ('proxy-' + token) / 'Caddyfile', PRIVATE + '\n')
    write(deploy / '.legacy-handoff/issued.json', '{not json ' + PRIVATE)
    (deploy / '.legacy-handoff/link').symlink_to(deploy / '.env')
    (deploy / 'current').symlink_to(deploy / 'server')

    write(volume / 'caddy/certificates/site/site.key', PLAIN)
    (volume / 'caddy').chmod(0o1777)
    return root, deploy, volume


class InventoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root, self.deploy, self.volume = host_tree(self.base)
        self.result = inventory.collect(str(self.deploy), fake_engine(self.volume, self.deploy), str(self.root))
        self.text = json.dumps(self.result, sort_keys=True)

    def entry(self, name):
        return next(item for item in self.result['deployment']['entries'] if item['name'] == name)

    def test_no_private_value_reaches_the_inventory(self):
        self.assertNotIn(PRIVATE, self.text)
        self.assertNotIn(PLAIN, self.text)

    def test_every_section_completes(self):
        self.assertEqual([item['section'] for item in self.result['errors']], [])
        self.assertEqual(self.result['schema'], inventory.SCHEMA)

    def test_live_modes_are_recorded_as_found(self):
        volume = self.result['volumes'][0]
        rows = {row['path']: row for row in volume['tree']['entries']}
        self.assertEqual(rows['caddy']['mode'], '1777')
        self.assertEqual(rows['caddy/certificates/site/site.key']['mode'], '0600')
        self.assertNotIn('sha256', rows['caddy/certificates/site/site.key'])
        self.assertEqual(self.entry('Caddyfile')['mode'], '0644')
        self.assertEqual(self.entry('Caddyfile')['lines'], 3)

    def test_only_caddy_storage_is_walked(self):
        database = self.result['volumes'][1]
        self.assertEqual(database['postgres_version'], '17')
        self.assertNotIn('tree', database)
        self.assertEqual(self.entry('pgdata')['postgres_version'], '17')
        self.assertNotIn('personas', self.text)

    def test_environment_files_give_names_and_never_values(self):
        env = self.entry('.env')
        self.assertEqual(env['env'], {'names': ['EMPTY', 'PLAIN_NAME', 'PORT', 'POSTGRES_PASSWORD'], 'empty': ['EMPTY'], 'assignments': 4})
        self.assertRegex(env['sha256'], r'\A[0-9a-f]{64}\Z')
        self.assertEqual(self.entry('.env.production')['env']['names'], ['SESSION_SECRET'])
        self.assertEqual(set(self.entry('compose.yml')) & {'env', 'json', 'text'}, set())

    def test_container_keeps_structure_and_drops_credentials(self):
        container, missing = self.result['containers']
        self.assertEqual(container['config']['env'], {'names': ['ADMIN_PIN', 'CADDY_VERSION', 'DATABASE_URL'],
                                                      'public': {'CADDY_VERSION': 'v2.8.4'}})
        self.assertEqual(container['args'][:4], ['run', '--config', '/etc/caddy/Caddyfile', {'redacted': 'str', 'length': 10}])
        self.assertEqual({type(value) for value in container['args'][3:]}, {dict})
        self.assertEqual(container['config']['cmd'][:2], ['sh', '-c'])
        self.assertIsInstance(container['config']['cmd'][2], dict)
        self.assertEqual(container['config']['labels']['com.docker.compose.project'], 'dollhousemcp')
        self.assertIsInstance(container['config']['labels']['vendor.note'], dict)
        self.assertEqual(container['health'], 'healthy')
        self.assertEqual(container['host_config']['MaskedPaths'], ['/proc/kcore'])
        self.assertEqual(container['mounts'][1]['Destination'], '/etc/caddy/Caddyfile')
        self.assertEqual(missing['id'], 'f' * 64)
        self.assertIn('HTTP 404', missing['inventory_error'])
        self.assertIn({'at': '/containers/1', 'error': missing['inventory_error']}, self.result['partial'])
        self.assertEqual(self.result['images'][0]['config']['env']['public'], {'CADDY_VERSION': 'v2.8.4'})
        self.assertNotIn('HttpProxy', self.result['engine_info'])
        self.assertEqual(self.result['engine_version']['Version'], '29.0.0')

    def test_markers_keep_identities_and_structure(self):
        markers = self.result['deployment']['markers']
        self.assertEqual(set(markers), {'.caddy-state', '.caddy-recovery', '.legacy-handoff'})
        state = markers['.caddy-state']['entries'][0]['json']['pending']
        self.assertEqual(state['token'], 'ab' * 16)
        self.assertEqual(state['phase'], 'staged')
        self.assertEqual(state['image'], 'ghcr.io/dollhousemcp/caddy-proxy@sha256:' + '8' * 64)
        self.assertEqual(state['control']['public_origin'], 'https://mcp.example.invalid')
        self.assertEqual(state['control']['proxy'], {'pid': 7, 'api_key': {'redacted': 'str', 'length': len(PLAIN)}})
        self.assertEqual(state['profile']['env'][0], 'CADDY_VERSION=v2.8.4')
        self.assertIsInstance(state['profile']['env'][1], dict)
        self.assertIsInstance(state['profile']['note'], dict)
        recovery = {row['path']: row for row in markers['.caddy-recovery']['entries']}
        self.assertEqual(recovery['proxy-%s/Caddyfile' % ('ab' * 16)]['lines'], 1)
        handoff = {row['path']: row for row in markers['.legacy-handoff']['entries']}
        self.assertEqual(handoff['issued.json']['json'], {'inventory_error': 'invalid JSON'})
        self.assertEqual(handoff['link']['type'], 'symlink')
        self.assertNotIn('sha256', handoff['link'])
        self.assertEqual(self.result['tools']['daemon_config']['json'],
                         {'live-restore': False, 'registry-secret': {'redacted': 'str', 'length': len(PLAIN)}})

    def test_deployment_layout_lock_and_bundles(self):
        deployment = self.result['deployment']
        self.assertEqual(self.entry('current')['type'], 'symlink')
        self.assertEqual(self.entry('DEPLOYED_REVISION')['text'], 'a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5')
        self.assertEqual(deployment['bundles'], {'server': {'name': 'mcp-server', 'version': '2.1.0-beta.3'}})
        self.assertEqual(deployment['lock'], {'present': True, 'holders': []})
        referenced = self.result['referenced_files']
        self.assertEqual(set(referenced), {str(self.deploy / 'Caddyfile'), str(self.deploy / 'compose.yml')})
        self.assertEqual(referenced[str(self.deploy / 'Caddyfile')]['sha256'], self.entry('Caddyfile')['sha256'])

    def test_host_listeners_processes_and_neighbours(self):
        self.assertEqual(self.result['host']['os_release']['PRETTY_NAME'], 'Ubuntu 24.04 LTS')
        self.assertEqual(self.result['host']['umask'], '0022')
        self.assertEqual(self.result['host']['boot_utc'], '2026-01-01T00:00:00+00:00')
        self.assertEqual(self.result['listeners'], [
            {'protocol': 'tcp', 'address': '::1', 'port': 80, 'uid': 0},
            {'protocol': 'tcp', 'address': '0.0.0.0', 'port': 443, 'uid': 0},
            {'protocol': 'tcp', 'address': '127.0.0.1', 'port': 8080, 'uid': 0}])
        self.assertEqual(self.result['deploy_processes'], [{'pid': 4242, 'scripts': ['hosted-deploy.sh']}])
        neighbours = self.result['neighbours']
        self.assertEqual(set(neighbours), {'/opt/dollhousemcp-other', '/root/dollhousemcp-evidence'})
        self.assertEqual([item['name'] for item in neighbours['/root/dollhousemcp-evidence']['entries']], ['receipt.json'])
        self.assertNotIn('sha256', neighbours['/opt/dollhousemcp-other']['entries'][0])

    def test_held_lock_is_read_from_proc_and_never_requested(self):
        info = os.lstat(self.deploy / '.caddy-deploy.lock')
        line = '1: FLOCK  ADVISORY  WRITE 99 %02x:%02x:%d 0 EOF\n' % (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino)
        write(self.root / 'proc/locks', '2: POSIX  ADVISORY  READ 5 00:01:1 0 EOF\n' + line)
        result = inventory.collect(str(self.deploy), fake_engine(self.volume, self.deploy), str(self.root))
        self.assertEqual(result['deployment']['lock'], {'present': True, 'holders': [['FLOCK', 'ADVISORY', 'WRITE']]})

    def test_a_failed_section_is_recorded_and_the_rest_still_run(self):
        get = fake_engine(self.volume, self.deploy, missing=('/volumes', '/info'))
        result = inventory.collect(str(self.base / 'absent'), get, str(self.root))
        self.assertEqual([item['section'] for item in result['errors']], ['engine_info', 'volumes', 'deployment'])
        self.assertIsNone(result['volumes'])
        self.assertEqual(len(result['containers']), 2)
        self.assertEqual(result['listeners'][0]['port'], 80)

    def test_objects_beyond_the_limit_are_reported_and_never_silently_dropped(self):
        listed, omitted = inventory.capped([{'Id': 'a'}] * (inventory.MAX_ITEMS + 2))
        self.assertEqual(len(listed), inventory.MAX_ITEMS)
        self.assertEqual(omitted, [{'inventory_error': '2 entries beyond the limit were omitted'}])
        self.assertEqual(inventory.capped(None), ([], []))
        self.assertEqual(inventory.public_argv(['x'] * 66)[-1], {'inventory_error': '2 entries beyond the limit were omitted'})
        self.assertEqual(inventory.public_json(list(range(inventory.MAX_ITEMS + 1)))[-1],
                         {'inventory_error': '1 entries beyond the limit were omitted'})

    def test_a_truncated_listing_or_tree_makes_the_inventory_partial(self):
        with patch.object(inventory, 'MAX_ENTRIES', 2):
            result = inventory.collect(str(self.deploy), fake_engine(self.volume, self.deploy), str(self.root))
        tree = result['volumes'][0]['tree']
        self.assertEqual((len(tree['entries']), tree['truncated']), (2, True))
        self.assertIn('/volumes/0/tree', {item['at'] for item in result['partial']})
        with patch.object(inventory, 'MAX_DEPTH', 1):
            result = inventory.collect(str(self.deploy), fake_engine(self.volume, self.deploy), str(self.root))
        self.assertIn('/volumes/0/tree/entries/1', {item['at'] for item in result['partial']})
        with patch.object(inventory, 'MAX_ITEMS', 3):
            result = inventory.collect(str(self.deploy), fake_engine(self.volume, self.deploy), str(self.root))
        self.assertIs(result['deployment']['truncated'], True)
        self.assertIn('/deployment', {item['at'] for item in result['partial']})

    def test_exit_status_reports_an_incomplete_inventory(self):
        complete = {'errors': [], 'partial': []}
        for result, status in ((complete, 0), ({'errors': [{}], 'partial': []}, 3), ({'errors': [], 'partial': [{}]}, 3)):
            with patch.object(inventory, 'collect', return_value=result), patch('builtins.print'):
                self.assertEqual(inventory.main(['--deploy-dir', '/fixture']), status)

    def test_credentials_behind_short_flags_and_numeric_secrets_are_withheld(self):
        self.assertEqual(inventory.public_argv(['curl', '-u', 'alice:' + PLAIN, 'http://localhost/health']),
                         ['curl', {'redacted': 'str', 'length': 2}, {'redacted': 'str', 'length': 6 + len(PLAIN)},
                          'http://localhost/health'])
        for argv in (['mysql', '-p' + PLAIN], ['redis-cli', '-a', PLAIN], ['CMD-SHELL', 'curl -u a:%s http://x' % PLAIN],
                     ['curl', '--user', 'a:' + PLAIN], ['tool', '-P', PLAIN]):
            with self.subTest(argv=argv):
                self.assertNotIn(PLAIN, json.dumps(inventory.public_argv(argv)))
        self.assertEqual(inventory.public_argv(['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']),
                         ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
        self.assertEqual(inventory.public_argv(['CMD-SHELL', 'pg_isready -U fixture -d fixture']),
                         ['CMD-SHELL', 'pg_isready -U fixture -d fixture'])
        self.assertEqual(inventory.public_json({'api_key': 42, 'secret': True, 'password': None, 'pid': 7}),
                         {'api_key': {'redacted': 'int'}, 'secret': {'redacted': 'bool'}, 'password': None, 'pid': 7})

    def test_one_unreadable_fact_never_hides_the_others(self):
        (self.root / 'etc/machine-id').unlink()
        (self.root / 'root').rename(self.root / 'moved')
        result = inventory.collect(str(self.deploy), fake_engine(self.volume, self.deploy), str(self.root))
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['host']['os_release']['ID'], 'ubuntu')
        self.assertEqual(set(result['neighbours']), {'/opt/dollhousemcp-other', '/root'})
        places = {item['at'] for item in result['partial']}
        self.assertLessEqual({'/host/machine_id_sha256', '/neighbours//root', '/containers/1'}, places)

    def test_inventory_changes_nothing(self):
        def snapshot():
            rows = []
            for base, directories, files in os.walk(self.base):
                for name in directories + files:
                    info = os.lstat(os.path.join(base, name))
                    rows.append((os.path.join(base, name), info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns))
            return sorted(rows)
        before = snapshot()
        inventory.collect(str(self.deploy), fake_engine(self.volume, self.deploy), str(self.root))
        self.assertEqual(snapshot(), before)


def reachable(path):
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.settimeout(2)
        probe.connect(path)
        return True
    except OSError:
        return False
    finally:
        probe.close()


class RealEngineTests(unittest.TestCase):
    """The controller command, unchanged, against a real Engine when one is present."""
    SOCKET = os.environ.get('HOSTED_INVENTORY_TEST_SOCKET', inventory.SOCKET)

    @unittest.skipUnless(sys.platform.startswith('linux') and reachable(SOCKET), 'needs Linux and a reachable Engine socket')
    def test_script_from_standard_input_inventories_a_real_engine(self):
        with tempfile.TemporaryDirectory() as temporary:
            deploy = Path(temporary) / 'deploy'
            write(deploy / '.env', 'NAME=%s\n' % PRIVATE)
            done = subprocess.run([sys.executable, '-I', '-', '--deploy-dir', str(deploy), '--socket', self.SOCKET],
                                  input=SOURCE.read_bytes(), capture_output=True, timeout=120, check=False)
        self.assertIn(done.returncode, (0, 3), done.stderr.decode(errors='replace'))
        result = json.loads(done.stdout)
        failed = {item['section'] for item in result['errors']}
        self.assertEqual(failed, set(), result['errors'])
        self.assertTrue(result['engine_version']['Version'])
        self.assertIsInstance(result['host']['os_release'], dict)
        self.assertIsInstance(result['containers'], list)
        self.assertEqual(result['deployment']['entries'][0]['env']['names'], ['NAME'])
        self.assertNotIn(PRIVATE.encode(), done.stdout)


if __name__ == '__main__':
    unittest.main()
