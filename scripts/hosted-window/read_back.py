#!/usr/bin/env python3
"""Read back what serves after a legacy upgrade, against the window plan and the fresh checkpoint.

The last step of window_driver.py. It changes nothing that serves: it inspects
three containers, asks the database for its migration ledger, reads the
migration files out of the pinned migration image and makes three public
requests. Every check is reported, also after one has failed.

    read_back.py PLAN CHECKPOINT_DIR > read-back.json

The expected migration ledger is taken from the pinned migration image, never
from a constant: the SHA-256 of each migration file its journal lists, in the
journal's order. That is what the migration step applies and records. The
checkpoint's ledger must be the start of the database's ledger, so the report
also says how many entries the upgrade added. To read the image, one container
is created from it without a network, never started, and removed again.

Exit status: 0 when every check passed, 3 when one did not or could not be made.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

DOCKER = 'docker'
MIGRATIONS = '/app/src/database/migrations'
PUBLIC = ('/healthz', '/readyz', '/mcp')
LIMIT = 16 * 1024 * 1024
UTF8 = 'utf-8'
# A path named on the command line or in the plan: absolute, as written, without a "." or ".." part.
# The same pattern as window_driver.py, which checks every one of these paths before the first step.
LOCATION = re.compile(r'(?:/(?!\.{1,2}(?:/|\Z))[^/\0]+)+\Z')
LOCATION_FAULT = '%s must be an absolute path as written, without a "." or ".." part'
TAG = re.compile(r'\w+\Z', re.ASCII)
LEDGER_QUERY = ('exec psql --no-password --no-psqlrc --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align '
                '--username "$POSTGRES_USER" --dbname dollhousemcp '
                "--command 'BEGIN READ ONLY; SELECT json_agg(hash ORDER BY id) FROM drizzle.__drizzle_migrations; COMMIT;'")


def system(argv, timeout=60):
    done = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, check=True)
    if len(done.stdout) > LIMIT:
        raise ValueError('output exceeds its bound')
    return done.stdout


def inspect(run, name):
    return json.loads(run([DOCKER, 'inspect', name]))[0]


def image_ledger(run, image):
    """The ledger the pinned migration image would record: one hash for each migration its journal lists, in order."""
    with tempfile.TemporaryDirectory() as folder:
        container = run([DOCKER, 'create', '--network', 'none', image, 'true']).decode('ascii').strip()
        try:
            run([DOCKER, 'cp', '--quiet', container + ':' + MIGRATIONS, folder + '/migrations'])
        finally:
            run([DOCKER, 'rm', container])
        migrations = Path(folder) / 'migrations'
        journal = json.loads((migrations / 'meta' / '_journal.json').read_bytes())
        entries = sorted(journal['entries'], key=lambda entry: entry['idx'])
        if [entry['idx'] for entry in entries] != list(range(len(entries))):
            raise ValueError('the migration journal does not number its entries from zero without a gap')
        if not all(isinstance(entry['tag'], str) and TAG.match(entry['tag']) for entry in entries):
            raise ValueError('the migration journal names a file outside its own folder')
        return [hashlib.sha256((migrations / (entry['tag'] + '.sql')).read_bytes()).hexdigest() for entry in entries]


def checkpoint_facts(folder):
    """What the fresh checkpoint recorded: the database container and boot, and the ledger before the upgrade."""
    if not LOCATION.fullmatch(folder):
        raise ValueError(LOCATION_FAULT % 'the checkpoint folder')
    directory = Path(folder)
    source = json.loads((directory / 'manifest.json').read_bytes())['source_database']
    for line in (directory / 'observation.jsonl').read_text(encoding=UTF8).splitlines():
        record = json.loads(line)
        if isinstance(record.get('hashes'), list):
            return source, record['hashes']
    raise ValueError('the checkpoint holds no migration ledger')


def public_facts(run, origin):
    found = {}
    for path in PUBLIC:
        raw = run(['curl', '--silent', '--show-error', '--max-time', '10', '--write-out', '\n%{http_code}', origin + path])
        body, _, status = raw.decode(UTF8, 'replace').rpartition('\n')
        try:
            version = json.loads(body).get('version')
        except (ValueError, AttributeError):
            version = None
        found[path] = {'status': int(status), 'version': version}
    return found


def collect(plan, checkpoint, run=system):
    folder = plan['deploy_dir']
    if not LOCATION.fullmatch(folder):
        raise ValueError(LOCATION_FAULT % 'the deployment folder in the plan')
    instance, root = plan['instance'], Path(folder)
    source, before = checkpoint_facts(checkpoint)
    database = inspect(run, instance + '-postgres')
    return {
        'app': inspect(run, instance), 'proxy': inspect(run, instance + '-caddy'), 'database': database,
        'checkpoint_database': source, 'ledger_before': before,
        'ledger': json.loads(run([DOCKER, 'exec', database['Id'], 'sh', '-c', LEDGER_QUERY])),
        'image_ledger': image_ledger(run, plan['images']['migration']),
        'state': json.loads((root / '.caddy-state' / 'state.json').read_bytes()),
        'revision': (root / 'DEPLOYED_REVISION').read_text(encoding=UTF8).strip(),
        'public': public_facts(run, plan['public_base_url']),
    }


def checks(plan, facts):
    """Each check by name. A pure function of the plan and what was collected."""
    app, proxy, database, public = facts['app'], facts['proxy'], facts['database'], facts['public']
    volumes = sorted(mount.get('Name') or '' for mount in proxy['Mounts'] if mount['Type'] == 'volume')
    boot = {'id': database['Id'], 'started_at': database['State']['StartedAt'], 'restart_count': database['RestartCount']}
    before, now = facts['ledger_before'], facts['ledger']
    recorded = {key: facts['checkpoint_database'].get(key) for key in boot}
    return {
        'the app runs the pinned runtime image by digest': app['Config']['Image'] == plan['images']['runtime'],
        'the app is healthy': (app['State'].get('Health') or {}).get('Status') == 'healthy',
        'the proxy runs the pinned Caddy image by digest': proxy['Config']['Image'] == plan['images']['caddy'],
        'the proxy uses the new volumes': volumes == sorted(plan['caddy_volumes'].values()),
        'the database is the same container and boot as at the checkpoint': boot == recorded,
        'the migration ledger is the pinned migration image\'s ledger': isinstance(now, list) and now == facts['image_ledger'],
        'the checkpoint\'s ledger is the start of the migration ledger': isinstance(now, list) and now[:len(before)] == before,
        'the transition is complete and nothing is pending': (facts['state'].get('pending') is None
                                                              and facts['state'].get('completed') is not None),
        'the deployed revision is the pinned source': facts['revision'] == plan['source']['commit'],
        'the public path answers 200, 200 and 401': [public[path]['status'] for path in PUBLIC] == [200, 200, 401],
        'the public version is the upgraded version': all(public[path]['version'] == plan['versions']['upgraded']
                                                         for path in PUBLIC[:2]),
    }


def report(plan, checkpoint, run=system):
    try:
        facts = collect(plan, checkpoint, run)
    except (OSError, ValueError, KeyError, IndexError, TypeError, subprocess.SubprocessError) as error:
        return {'complete': False, 'passed': False, 'error': '%s: %s' % (type(error).__name__, str(error)[:300]), 'checks': {}}
    result = checks(plan, facts)
    return {'complete': True, 'passed': all(result.values()), 'checks': result,
            'ledger_entries_before': len(facts['ledger_before']), 'ledger_entries': len(facts['ledger']),
            'public': facts['public']}


def main(argv):
    if len(argv) != 3:
        raise ValueError('usage: read_back.py PLAN CHECKPOINT_DIR')
    plan_path, checkpoint = argv[1], argv[2]
    if not LOCATION.fullmatch(plan_path):
        raise ValueError(LOCATION_FAULT % 'PLAN')
    if not LOCATION.fullmatch(checkpoint):
        raise ValueError(LOCATION_FAULT % 'CHECKPOINT_DIR')
    result = report(json.loads(Path(plan_path).read_bytes()), checkpoint)
    print(json.dumps(result, indent=1, sort_keys=True))
    return 0 if result['passed'] else 3


if __name__ == '__main__':
    sys.exit(main(sys.argv))
