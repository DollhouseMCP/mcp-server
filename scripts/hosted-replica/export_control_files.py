#!/usr/bin/env python3
"""Read-only export of a hosted deployment's control files, with secrets replaced at the source.

A replica needs the real control files: the Compose model, the Caddyfile, the
database scripts, the environment's non-secret settings and the transition,
handoff and recovery markers. It must not receive a credential. This script
reads a fixed list of files, replaces every secret value with a named
placeholder and writes one tar archive to standard output.

Read-only contract, enforced by tests/scripts/test_hosted_caddy_replica_export.py:
- No child process, no Docker call, no network connection, no lock.
- Files are opened read-only without following a final symlink. Nothing on the
  host is created, changed or removed. The archive is built in memory.
- An environment value is a secret when its name says so (SECRET, PASSWORD,
  KEY, TOKEN, HMAC, CREDENTIAL, PRIVATE) or when it holds a long opaque word:
  20 or more letters, digits and base64 signs, with at least one digit. A value
  is searched for as written, without its quotes and without a trailing comment.
  Each is replaced with __DOLLHOUSE_REPLICA_<NAME>__ in the environment files
  and wherever the same value occurs in any other exported file. A password
  inside a URL is replaced too.
- Before anything is written, every archive member is searched again for every
  secret value. One hit aborts the export with no output.
- An environment file that exists but cannot be read as text aborts the export
  too: its secrets would be unknown to the search. So does a value that opens
  a quote and does not close it on its line: the lines that continue it would
  be exported as they are.

    ssh HOST python3 -I - < export_control_files.py > control-files.tar

MANIFEST.json, the first member, lists each file with its mode, owner, original
hash and number of replacements, each environment name with its class and no
value, and each listed file that was absent or skipped. Exit status is 0 when
the archive was written and 3 when the export was refused.
"""
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile

DEPLOY_DIR = '/opt/dollhousemcp'
ENVIRONMENTS = ('.env', '.env.production')
FILES = ('compose.yml', 'Caddyfile', 'init-db.sh', 'post-migration-grants.sql', 'apply-post-migration-grants.sh',
         'bootstrap-admin.sh', 'DEPLOYED_REVISION', 'DEPLOYED_AT')
TREES = ('.caddy-state', '.caddy-recovery', '.caddy-verification', '.legacy-handoff')
OVERLAY = re.compile(r'cutover-staging-[0-9a-z-]+/(candidate|caddy-rebind)-overlay\.json\Z')
MAX_FILE = 1024 * 1024
MAX_FILES = 400
MAX_TOTAL = 16 * 1024 * 1024
SECRET_NAME = re.compile(r'SECRET|PASSWORD|PASSWD|KEY|TOKEN|HMAC|CREDENTIAL|PRIVATE')
OPAQUE = re.compile(r'(?=.*\d)(?=.*[A-Za-z])[\w+/=-]{20,}\Z', re.ASCII)
ASSIGNMENT = re.compile(r'(?:export\s+)?([A-Za-z_]\w*)=(.*)\Z', re.ASCII)
QUOTED = re.compile(r'''(["'])(.*?)\1''')
CLOSED = re.compile(r'"(?:[^"\\]|\\.)*"' r"|'[^']*'")
URL_PASSWORD = re.compile(rb'(://[^/\s:@"\']+:)([^@/\s"\']+)(@)')
MINIMUM = 6  # shorter values cannot be searched for safely; they are replaced by name only


class Refused(Exception):
    pass


def read(directory, relative):
    """One regular file's bytes and metadata, or the reason it was skipped."""
    try:
        fd = os.open(relative, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
    except OSError as error:
        return None, 'absent' if isinstance(error, FileNotFoundError) else 'unreadable'
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return None, 'not a regular file'
        if info.st_size > MAX_FILE:
            return None, 'too large'
        raw = os.read(fd, MAX_FILE + 1)
        if len(raw) != info.st_size:
            return None, 'changed while read'
        return (raw, info), None
    finally:
        os.close(fd)


def walk(directory, tree):
    """Relative paths of the regular files under one marker directory, in order."""
    found, pending = [], [tree]
    while pending:
        current = pending.pop()
        try:
            fd = os.open(current, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        except OSError:
            continue
        try:
            for entry in sorted(os.listdir(fd)):
                info = os.stat(entry, dir_fd=fd, follow_symlinks=False)
                path = current + '/' + entry
                if stat.S_ISDIR(info.st_mode):
                    pending.append(path)
                elif stat.S_ISREG(info.st_mode):
                    found.append(path)
        finally:
            os.close(fd)
    return sorted(found)


def overlays(directory):
    found = []
    for entry in sorted(os.listdir(directory)):
        if entry.startswith('cutover-staging-'):
            found.extend(path for path in walk(directory, entry) if OVERLAY.match(path))
    return found


def forms(text):
    """Every form in which another file may hold the value of one assignment.

    The text after `=` may be bare or quoted, and a comment may follow either.
    A Compose file or a marker can hold the value without the quotes and without
    the comment, so each reading is searched for: the quoted content, or the
    text before a comment, and the first word without quotes.
    """
    text = text.strip()
    quoted = QUOTED.match(text)
    value = quoted.group(2) if quoted else text.split(' #', 1)[0].strip()
    first = text.split()[0].strip('"\'') if text.split() else ''
    # Quote marks are never part of a needle: replacing them would break the file that holds the value.
    return value, [item for item in dict.fromkeys((value, first)) if item]


def continues(text):
    """Whether a value opens a quote that its own line does not close, so that it runs on over later lines."""
    text = text.strip()
    return text.startswith(('"', "'")) and not CLOSED.match(text)


def classify(name, value, candidates):
    if not value:
        return 'empty'
    if SECRET_NAME.search(name.upper()):
        return 'secret'
    # A comment or a second word after the value must not hide an opaque word.
    return 'opaque' if any(OPAQUE.match(item) and not item.startswith('/') for item in candidates) else 'kept'


def placeholder(name):
    return '__DOLLHOUSE_REPLICA_%s__' % name


def judged(name, text):
    """The class of one assignment and the strings to search every exported file for."""
    value, candidates = forms(text)
    candidates += [word.strip('"\'') for word in text.split()]
    verdict = classify(name, value, candidates)
    if verdict == 'secret':
        return verdict, forms(text)[1]
    return verdict, [item for item in candidates if OPAQUE.match(item)] if verdict == 'opaque' else []


def environment(raw, secrets, names, short):
    """The file with secret values replaced, one line at a time. Values are never returned elsewhere."""
    lines = []
    for line in raw.decode('utf-8').split('\n'):
        match = None if line.lstrip().startswith('#') else ASSIGNMENT.match(line.strip())
        if match and continues(match.group(2)):
            # Only its first line would be replaced. The rest matches no assignment and no search.
            raise Refused('the value of %s continues over more than one line' % match.group(1))
        verdict, needles = judged(match.group(1), match.group(2)) if match else ('kept', [])
        if match:
            name = match.group(1)
            names[name] = verdict if names.get(name, verdict) == verdict else 'secret'
        if verdict not in ('secret', 'opaque'):
            lines.append(line)
            continue
        searchable = [item for item in needles if len(item) >= MINIMUM]
        secrets.update((item, name) for item in searchable)
        if not searchable:
            short.add(name)
        lines.append('%s=%s' % (name, placeholder(name)))
    return '\n'.join(lines).encode('utf-8')


def scrubbed(raw, secrets):
    count = 0
    for value in sorted(secrets, key=len, reverse=True):
        needle = value.encode('utf-8')
        hits = raw.count(needle)
        if hits:
            raw, count = raw.replace(needle, placeholder(secrets[value]).encode('ascii')), count + hits
    raw, hits = URL_PASSWORD.subn(lambda match: match.group(1) + (
        match.group(2) if match.group(2).startswith(b'__DOLLHOUSE_REPLICA_') else b'__DOLLHOUSE_REPLICA_URL_PASSWORD__'
    ) + match.group(3), raw)
    return raw, count + hits


def collect(root):
    """Read every listed file. The environment files come first, so a secret defined in one is found in all."""
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        listed = list(FILES) + overlays(directory)
        for tree in TREES:
            listed.extend(walk(directory, tree))
        sources, skipped = {}, {}
        if len(listed) > MAX_FILES:
            skipped['(after %d files)' % MAX_FILES] = '%d more files not exported' % (len(listed) - MAX_FILES)
        for relative in list(ENVIRONMENTS) + listed[:MAX_FILES]:
            result, reason = read(directory, relative)
            if result is None:
                skipped[relative] = reason
            else:
                sources[relative] = result
        return sources, skipped
    finally:
        os.close(directory)


def is_text(raw):
    try:
        raw.decode('utf-8')
    except UnicodeDecodeError:
        return False
    return True


def export(root=None):
    root = root or DEPLOY_DIR
    sources, skipped = collect(root)
    skipped.update({relative: 'not text' for relative, (raw, _) in sources.items() if not is_text(raw)})
    for relative in ENVIRONMENTS:
        # Its secrets would never be searched for, so copies in other files would be exported.
        if skipped.get(relative, 'absent') != 'absent':
            raise Refused('environment file %s is %s' % (relative, skipped[relative]))
    secrets, names, short, members, total = {}, {}, set(), [], 0
    rendered = {relative: environment(sources[relative][0], secrets, names, short)
                for relative in ENVIRONMENTS if relative in sources and relative not in skipped}
    for relative in sorted(set(sources) - set(skipped)):
        raw, info = sources[relative]
        body, count = scrubbed(rendered.get(relative, raw), secrets)
        total += len(body)
        if total > MAX_TOTAL:
            raise Refused('export too large')
        members.append((relative, body, {
            'path': relative, 'mode': '%04o' % stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid,
            'size': info.st_size, 'sha256': hashlib.sha256(raw).hexdigest(), 'replacements': count,
            'environment': relative in rendered}))
    for relative, body, _ in members:
        if any(value.encode('utf-8') in body for value in secrets):
            raise Refused('a secret value survived in ' + relative)
    manifest = {'schema': 1, 'kind': 'hosted-control-file-export', 'deploy_dir': root,
                'files': [record for _, _, record in members], 'skipped': skipped,
                'environment_names': dict(sorted(names.items())),
                'secrets_replaced_by_search': len(secrets), 'secrets_too_short_to_search': sorted(short)}
    return manifest, members


def archive(manifest, members):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.PAX_FORMAT) as tar:
        entries = [('MANIFEST.json', json.dumps(manifest, indent=1, sort_keys=True).encode('utf-8'), None)] + members
        for relative, body, record in entries:
            item = tarfile.TarInfo('control-files/' + relative)
            item.size, item.mode = len(body), int(record['mode'], 8) if record else 0o600
            item.uid, item.gid = (record['uid'], record['gid']) if record else (0, 0)
            tar.addfile(item, io.BytesIO(body))
    return stream.getvalue()


def main(argv):
    if len(argv) != 1:
        raise ValueError('usage: export_control_files.py (no arguments; the deployment folder is fixed)')
    try:
        data = archive(*export())
    except Refused as error:
        print('export refused: %s' % error, file=sys.stderr)
        return 3
    sys.stdout.buffer.write(data)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
