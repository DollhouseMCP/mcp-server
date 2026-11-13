"""Record every child process a Python tool starts, for a replica rehearsal only.

Put this directory on PYTHONPATH and name a private log file in
DOLLHOUSE_REPLICA_COMMAND_LOG. Each tool then runs exactly as in a window,
with no wrapper and no patched function. Without the variable this does
nothing. The log holds full argument lists, so it stays on the replica.
"""
import json
import os
import sys

_LOG = os.environ.get('DOLLHOUSE_REPLICA_COMMAND_LOG')


def _record(event, arguments):
    if event != 'subprocess.Popen':
        return
    argv = arguments[1]
    if isinstance(argv, (str, bytes, os.PathLike)):
        argv = [argv]
    line = json.dumps({'tool': os.path.basename(sys.argv[0]) if sys.argv else '', 'pid': os.getpid(),
                       'argv': [os.fsdecode(item) for item in argv]}) + '\n'
    fd = os.open(_LOG, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.write(fd, line.encode('utf-8'))
    finally:
        os.close(fd)


if _LOG:
    sys.addaudithook(_record)
