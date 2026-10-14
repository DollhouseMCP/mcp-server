#!/usr/bin/env python3
"""Dedicated test capsule only: retain adopted zombies until Jest finishes."""
import ctypes
import json
import os
import subprocess
import sys
import time

if sys.platform != 'linux':
    raise SystemExit('Linux subreaper control requires Linux')
libc = ctypes.CDLL(None, use_errno=True)
libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
libc.prctl.restype = ctypes.c_int
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise OSError(ctypes.get_errno(), 'Cannot establish dedicated fixture subreaper')
observed = ctypes.c_int()
if libc.prctl(37, ctypes.addressof(observed), 0, 0, 0) != 0 or observed.value != 1:
    raise RuntimeError('Subreaper setup was not verified')
started = time.monotonic()
env = dict(os.environ, OWNED_FIXTURE_REQUIRE_ZOMBIE='1')
env['NODE_OPTIONS'] = '--experimental-vm-modules --no-warnings'
child = subprocess.Popen(['node', 'node_modules/jest/bin/jest.js', '--config', 'tests/jest.config.cjs',
                          '--runInBand', '--no-coverage', 'tests/unit/scripts/ownedFixtureProcess.test.ts'], env=env)
code = 1
reaped = []
try:
    code = child.wait(timeout=45)
finally:
    if child.poll() is None:
        child.kill()  # Only the exact child handle; capsule removal owns any failure leftovers.
        child.wait(timeout=2)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid:
            reaped.append({'pid': pid, 'status': status})
        else:
            time.sleep(.01)
    else:
        raise RuntimeError('Dedicated fixture subreaper still has nonsettled children')
print('OWNED_ZOMBIE_CONTROL ' + json.dumps({'subreaper': True, 'jestCode': code, 'reaped': reaped,
      'elapsedSeconds': round(time.monotonic() - started, 3)}), flush=True)
if not reaped:
    raise RuntimeError('Control did not retain and reap an adopted fixture zombie')
raise SystemExit(code)
