#!/usr/bin/env python3
"""Check a locally built runtime and migration image pair before it is published.

The rules are the hosted deployment tooling's own: this loads
scripts/hosted-deploy/registry_image_admission.py and applies the same profile,
platform and source-label checks a host applies before it will replace a running
deployment. Only the registry digest identity is left out, because a local image
has none yet; the publishing workflow runs the full admission after the push.

Two things the admission does not look at are checked here as well, because a
deployment depends on them:

  - both images carry the commit they were built from, not merely the same value;
  - the migrations the migration image will apply are exactly the list the
    runtime image compares the database against when it answers /readyz.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
ADMISSION = ROOT / 'scripts/hosted-deploy/registry_image_admission.py'
SOURCE = re.compile(r'[0-9a-f]{40}')
RELEASE_MIGRATIONS = '/app/dist/database/release-migrations.json'
MIGRATIONS_DIR = '/app/src/database/migrations'

# Prints the migration files as the image holds them. Runs in the image itself,
# with its own Node, since the image has no shell.
READ_MIGRATIONS = r"""
const fs = require('node:fs');
const crypto = require('node:crypto');
const [manifestPath, dir] = process.argv.slice(1);
const out = { manifest: null, journal: null };
if (fs.existsSync(manifestPath)) out.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const journalPath = dir + '/meta/_journal.json';
if (fs.existsSync(journalPath)) {
  out.journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')).entries.map(entry => ({
    tag: entry.tag,
    when: entry.when,
    hash: fs.existsSync(`${dir}/${entry.tag}.sql`)
      ? crypto.createHash('sha256').update(fs.readFileSync(`${dir}/${entry.tag}.sql`)).digest('hex')
      : null,
  }));
}
process.stdout.write(JSON.stringify(out));
"""


class PairError(Exception):
    """The pair would be refused by a host, or would not deploy correctly."""


def load_admission(path=ADMISSION):
    spec = importlib.util.spec_from_file_location('registry_image_admission', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_profiles(admission, runtime, migration, daemon, source):
    """Applies the host's admission rules that do not need a registry digest."""
    if not SOURCE.fullmatch(source):
        raise PairError('expected source must be a full 40-character commit')
    platforms, sources = [], []
    for image, role in ((runtime, 'runtime'), (migration, 'migration')):
        try:
            platforms.append(admission.native_platform(image, daemon))
            sources.append(admission.image_profile(image, role))
            admission.image_layers(image)
        except ValueError as error:
            raise PairError(f'{role} image: {error}') from error
    if sources[0] != sources[1]:
        raise PairError('image pair source labels differ')
    if sources[0] != source:
        raise PairError('image pair source label is not the commit that was built')
    return 'linux/' + platforms[0]


def check_migrations(runtime_files, migration_files):
    """The migration image applies exactly what the runtime image expects."""
    manifest = runtime_files.get('manifest')
    journal = migration_files.get('journal')
    if not isinstance(journal, list) or not journal:
        raise PairError('migration image holds no migration journal')
    missing = [entry.get('tag') for entry in journal if not entry.get('hash')]
    if missing:
        raise PairError(f'migration image is missing SQL for: {", ".join(map(str, missing))}')
    if not isinstance(manifest, list) or not manifest:
        raise PairError('runtime image holds no release migration list')
    if migration_files.get('manifest') != manifest:
        raise PairError('runtime and migration images hold different release migration lists')
    if manifest != journal:
        raise PairError('runtime release migration list does not match the migrations the migration image applies')
    return len(manifest)


def docker_json(*arguments):
    raw = subprocess.check_output(['docker', *arguments], text=True, timeout=60)
    return json.loads(raw)


def inspect(reference):
    values = docker_json('image', 'inspect', reference)
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        raise PairError(f'cannot inspect {reference}')
    return values[0]


def read_migrations(reference):
    """Runs the image's own Node, offline and read-only, to read its migration files."""
    raw = subprocess.check_output([
        'docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--user', '1001:1001',
        reference, 'node', '-e', READ_MIGRATIONS, RELEASE_MIGRATIONS, MIGRATIONS_DIR,
    ], text=True, timeout=120)
    return json.loads(raw)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--runtime', required=True, help='local runtime image reference')
    parser.add_argument('--migration', required=True, help='local migration image reference')
    parser.add_argument('--source', required=True, help='the commit both images were built from')
    arguments = parser.parse_args(argv)

    admission = load_admission()
    daemon = docker_json('info', '--format', '{{json .}}')
    platform = check_profiles(admission, inspect(arguments.runtime), inspect(arguments.migration), daemon, arguments.source)
    migrations = check_migrations(read_migrations(arguments.runtime), read_migrations(arguments.migration))
    print(json.dumps({'platform': platform, 'source': arguments.source, 'migrations': migrations},
                     sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except PairError as error:
        print(f'Hosted image pair refused: {error}', file=sys.stderr)
        sys.exit(1)
