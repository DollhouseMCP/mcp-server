"""Read final exported filesystem data; never extract or execute image paths."""
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import time

GIB = 1024 ** 3
MAX_REPORT = 32 * 1024 ** 2
MAX_OBJECT = 128 * 1024 ** 2
MAX_OBJECTS = 256 * 1024 ** 2
PACKAGES = re.compile(r'(?:zlib1g|perl-base|ncurses-bin|ncurses-base|libtinfo6|util-linux|bsdutils|mount|login|libmount1|libblkid1|libuuid1|libsmartcols1|liblastlog2-2|gcc-14-base|libgcc-s1|libstdc\+\+6|libc6|libc-bin|libacl1)(?::[^/.]+)?\.(?:list|md5sums)$')


def canonical(name):
    name = name.removeprefix('./').removesuffix('/')
    if name in ('', '.'):
        return ''
    if (PurePosixPath(name).is_absolute() or PurePosixPath(name).as_posix() != name or
            '..' in PurePosixPath(name).parts or len(name.encode()) > 4096 or
            any(ord(c) < 32 or ord(c) == 127 for c in name)):
        raise ValueError('Unsafe/noncanonical exported path')
    return name


def selected_text(path):
    return (path in ('var/lib/dpkg/status', 'etc/fstab') or
            (path.startswith('var/lib/dpkg/info/') and PACKAGES.fullmatch(path.split('/')[-1])) or
            re.search(r'(?:^|/)Pod/Text(?:/(?:Color|Overstrike|Termcap))?\.pm(?:c)?$', path) or
            re.search(r'(?:^|/)Archive/Tar\.pm(?:c)?$', path))


def kind(data):
    if data.startswith(b'\x7fELF'): return 'elf'
    if data.startswith(b'\x1f\x8b'): return 'gzip-archive-candidate'
    if data.startswith(b'PK\x03\x04'): return 'zip-archive-candidate'
    if data.startswith(b'\xfd7zXZ\x00'): return 'xz-archive-candidate'
    if data.startswith(b'BZh'): return 'bzip-archive-candidate'
    if data[257:262] == b'ustar': return 'tar-archive-candidate'
    return 'other'


def preflight_tar(path, check):
    """Bound PAX/long-name processing BEFORE tarfile consumes extended headers."""
    size = path.stat().st_size
    if not 1024 <= size <= GIB + 128 * 1024 ** 2:
        raise ValueError('Export archive size exceeds bound or lacks trailer')
    headers = 0
    with path.open('rb') as source:
        while True:
            check(); block = source.read(512)
            if len(block) != 512: raise ValueError('Truncated export tar header')
            if block == bytes(512):
                if source.read(512) != bytes(512): raise ValueError('Invalid tar trailer')
                while chunk := source.read(65536):
                    check()
                    if any(chunk): raise ValueError('Unexpected data after tar trailer')
                return
            member = tarfile.TarInfo.frombuf(block, 'utf-8', 'surrogateescape')
            headers += 1
            if headers > 100000 or member.size < 0 or member.size > GIB:
                raise ValueError('Tar entry count/payload bound exceeded')
            if member.type == tarfile.GNUTYPE_SPARSE:
                raise ValueError('Sparse export data is unsupported')
            if member.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK) and member.size > 65536:
                raise ValueError('Extended tar metadata exceeds bound')
            skip = ((member.size + 511) // 512) * 512
            if source.tell() + skip > size: raise ValueError('Truncated export payload')
            source.seek(skip, 1)


def inventory_export(path, scratch, deadline=None):
    deadline = min(deadline or float("inf"), time.monotonic() + 60)
    def check():
        if time.monotonic() > deadline: raise ValueError('Export inventory deadline exceeded')
    preflight_tar(path, check)
    scratch.mkdir(mode=0o700, parents=True, exist_ok=False)
    records = {}; total = 0; saved = 0
    with tarfile.open(path, 'r|', encoding='utf-8', errors='surrogateescape') as bundle:
        for member in bundle:
            check(); name = canonical(member.name)
            if not name:
                if not member.isdir(): raise ValueError('Root entry is not a directory')
                continue
            if name in records or len(records) >= 100000 or member.sparse or any('sparse' in key.lower() for key in member.pax_headers):
                raise ValueError('Duplicate/oversized/sparse exported inventory')
            if any(part.startswith('.wh.') for part in name.split('/')):
                raise ValueError('Export is not a fully merged filesystem')
            cap = member.pax_headers.get('SCHILY.xattr.security.capability')
            if cap is not None and len(cap.encode('utf-8', 'surrogateescape')) > 64:
                raise ValueError('Capability metadata exceeds bound')
            record = {'path': '/' + name, 'type': member.type.decode('ascii', 'replace'),
                      'mode': member.mode, 'uid': member.uid, 'gid': member.gid, 'size': member.size,
                      'link_target': member.linkname if member.issym() or member.islnk() else None,
                      'devmajor': member.devmajor if member.isdev() else None,
                      'devminor': member.devminor if member.isdev() else None,
                      'capability_state': 'positive-export-header' if cap is not None else 'UNKNOWN-export-can-ignore-xattr-read-errors',
                      'acl_state': 'UNKNOWN-export-does-not-attest-full-ACLs',
                      'capability_base64': base64.b64encode(cap.encode('utf-8', 'surrogateescape')).decode() if cap is not None else None}
            if min(member.uid, member.gid, member.mode, member.size) < 0 or max(member.uid, member.gid) > 4294967295 or member.mode > 0o7777:
                raise ValueError('Negative export metadata')
            if member.isfile():
                if member.size > GIB - total: raise ValueError('Export payload exceeds 1 GiB')
                total += member.size
                with bundle.extractfile(member) as source:
                    first = source.read(min(512, member.size)); classification = kind(first)
                    keep = classification == 'elf' or selected_text(name)
                    if keep and (member.size > MAX_OBJECT or saved + member.size > MAX_OBJECTS):
                        raise ValueError('Selected raw-data scratch limit exceeded')
                    destination = scratch / str(len(records))
                    output = destination.open('xb') if keep else None
                    if output: destination.chmod(0o600)
                    digest = hashlib.sha256(); count = 0
                    try:
                        chunk = first
                        while chunk:
                            check(); count += len(chunk); digest.update(chunk)
                            if count > member.size: raise ValueError('Export file size mismatch')
                            if output: output.write(chunk)
                            chunk = source.read(65536)
                    finally:
                        if output: output.close()
                    if count != member.size: raise ValueError('Truncated exported file')
                    record.update(sha256=digest.hexdigest(), format=classification)
                    if keep:
                        final = scratch / (digest.hexdigest() + '.data')
                        if final.exists(): destination.unlink()
                        else: destination.rename(final)
                        record['scratch_data'] = str(final); saved += member.size
            elif member.issym() or member.islnk():
                if member.size != 0: raise ValueError('Link with a payload is unsupported')
            elif not (member.isdir() or member.ischr() or member.isblk() or member.isfifo()):
                raise ValueError('Unsupported exported file type')
            records[name] = record
    if len(json.dumps(records).encode()) > MAX_REPORT:
        raise ValueError('Inventory report exceeds bound')
    aliases = []
    for name, record in records.items():
        if record['link_target'] is not None:
            try:
                resolved = resolve_alias(name, records)
                aliases.append({'path': '/' + name, 'resolved_path': '/' + resolved,
                                'sha256': records[resolved].get('sha256'), 'status': 'resolved'})
            except ValueError as error:
                aliases.append({'path': '/' + name, 'status': 'UNKNOWN', 'error': str(error)})
    return {'schema': 'final-image-inventory-v1', 'regular_payload_bytes': total,
            'selected_scratch_bytes': saved, 'entries': list(records.values()), 'aliases': aliases,
            'limits': {'payload_bytes': GIB, 'entry_count': 100000, 'seconds': 60},
            'boundaries': ['No finding closed by capture', 'Missing capability header is UNKNOWN',
                           'Nested archives and modified/compiled renamed code are unresolved',
                           'Symbol absence and package names alone do not prove code absence']}


def resolve_alias(name, records):
    seen = set()
    # Resolve every path component in the virtual image only; never host symlinks.
    parts = name.split('/')
    for _ in range(32):
        current = []
        for index, part in enumerate(parts):
            if part in ('', '.'): continue
            if part == '..':
                if not current: raise ValueError('Alias escapes virtual image root')
                current.pop(); continue
            current.append(part); key = '/'.join(current)
            record = records.get(key)
            if record is None: raise ValueError('Alias target/parent is absent')
            if record.get('link_target') is not None:
                state = (key, tuple(parts[index + 1:]))
                if state in seen: raise ValueError('Alias cycle')
                seen.add(state); target = record['link_target']
                prefix = [] if target.startswith('/') or record['type'] == '1' else current[:-1]
                parts = prefix + target.split('/') + parts[index + 1:]
                break
        else:
            return '/'.join(current)
    raise ValueError('Alias depth exceeds bound')


def validate_never_started(value, graph):
    state, config, host = value['State'], value['Config'], value['HostConfig']
    descriptor = graph.get('manifest_descriptor')
    if (value['Image'] != graph['store_id'] or config['Image'] != graph['store_id'] or
            config['Entrypoint'] != ['/bin/false'] or config['Cmd'] != ['capture-not-executed'] or
            config['User'] != '65532:65532' or config.get('Healthcheck', {}).get('Test') != ['NONE'] or
            state['Status'] != 'created' or state['Running'] is not False or state['Pid'] != 0 or
            any(state.get(key, False) for key in ['Paused', 'Restarting', 'Dead', 'OOMKilled']) or
            not state['StartedAt'].startswith('0001-01-01T00:00:00') or value.get('RestartCount', 0) != 0 or
            host['NetworkMode'] != 'none' or host['ReadonlyRootfs'] is not True or host.get('Privileged') or
            host.get('CapDrop') != ['ALL'] or 'no-new-privileges=true' not in host.get('SecurityOpt', []) or
            value.get('Mounts') or config.get('Volumes') or host.get('Binds') or host.get('Mounts') or
            host.get('VolumesFrom') or host.get('Devices') or host.get('DeviceRequests') or host.get('CapAdd') or host.get('PidMode')):
        raise ValueError('Container is not the exact never-started capture plan')
    if descriptor and any(value.get('ImageManifestDescriptor', {}).get(k) != descriptor.get(k) for k in ['digest', 'size', 'mediaType']):
        raise ValueError('Container selected manifest differs from typed target')
    return {'container_id': value['Id'], 'image': value['Image'], 'selected_manifest': value.get('ImageManifestDescriptor'),
            'status': state['Status'], 'pid': state['Pid'], 'started_at': state['StartedAt'],
            'config_image': config['Image'], 'capture_user': config['User'], 'mounts': value.get('Mounts', [])}
