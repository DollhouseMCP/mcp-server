#!/usr/bin/env python3
"""Scrub the original configuration files held in a recovery evidence archive.

Legacy reconciliation puts the configuration files of before the failed window
back in place. They are in the filesystem archive of the accepted manual
recovery evidence, with their secrets. A replica needs them without the
secrets, as it needs the current files that export_control_files.py exports.

This script reads that archive from standard input, entirely in memory, takes
the configuration files reconciliation reads, and passes them through the same
classification, replacement and final search as the live export. It writes one
tar archive in the format of export_control_files.py to standard output, or
nothing if a secret survived. Nothing is written to disk and no value is
printed. Run it where the evidence archive already is:

    export_archived_originals.py < filesystem.tar > original-control-files.tar

Exit status is 0 when the archive was written and 3 when it was refused.
"""
import io
from pathlib import Path
import sys
import tarfile
import types

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_control_files as export

OVERLAYS = ('candidate-overlay.json', 'caddy-rebind-overlay.json')
MAX_ARCHIVE = 256 * 1024 * 1024


def wanted(relative):
    return (relative in export.ENVIRONMENTS or relative in export.FILES
            or export.OVERLAY.match(relative) is not None and relative.rsplit('/', 1)[-1] in OVERLAYS)


def members(raw, root):
    """The configuration files in the archive, as export_control_files.collect returns files read from disk."""
    prefix, sources = root.strip('/') + '/', {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        for item in archive:
            relative = item.name[len(prefix):] if item.name.startswith(prefix) else ''
            if wanted(relative) and item.isreg() and relative not in sources and item.size <= export.MAX_FILE:
                info = types.SimpleNamespace(st_mode=0o100000 | item.mode, st_uid=item.uid, st_gid=item.gid, st_size=item.size)
                sources[relative] = (archive.extractfile(item).read(), info)
    skipped = {name: 'absent' for name in export.ENVIRONMENTS + export.FILES if name not in sources}
    return sources, skipped


def main(argv):
    if len(argv) != 1:
        raise ValueError('usage: export_archived_originals.py < filesystem.tar > original-control-files.tar')
    raw = sys.stdin.buffer.read(MAX_ARCHIVE + 1)
    if len(raw) > MAX_ARCHIVE:
        raise ValueError('the evidence archive exceeds its bound')
    try:
        data = export.archive(*export.scrub(*members(raw, export.DEPLOY_DIR), export.DEPLOY_DIR))
    except export.Refused as error:
        print('export refused: %s' % error, file=sys.stderr)
        return 3
    sys.stdout.buffer.write(data)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
