"""Test-only Docker shim: insert a real restart after ACK, before final TERM."""
import json
import os
import pathlib
import subprocess
import sys
import time

real = os.environ['OWNED_REAL_DOCKER']
cid = os.environ['OWNED_ENGINE_GAP_CID']
owner = os.environ['OWNED_ENGINE_GAP_OWNER']
image = os.environ['OWNED_ENGINE_GAP_IMAGE']
deadline = float(os.environ['OWNED_ENGINE_GAP_DEADLINE'])
receipt = pathlib.Path(os.environ['OWNED_ENGINE_GAP_RECEIPT'])


def run(args):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError('Gap observation deadline')
    return subprocess.run([real, *args], capture_output=True, text=True,
                          timeout=min(remaining, 10), check=True).stdout


def state():
    current = json.loads(run(['inspect', cid]))[0]
    if current['Id'] != cid or current['Image'] != image or current['Config']['Labels'].get('org.dollhousemcp.owned-engine-proof') != owner:
        raise RuntimeError('Gap immutable identity changed')
    return current


if sys.argv[1:] == ['kill', '--signal=TERM', cid]:
    before = state()
    if not before['State']['Running']:
        raise SystemExit('Gap child not running')
    # This exact interception executes only after the actual helper validated
    # ACK and its final state readback. Never manufacture an acknowledgement.
    # Killing PID1 may interrupt this exec before it returns. A new boot with
    # the original drained hold is mandatory regardless of this return code.
    crash = subprocess.run([real, 'exec', '--user', '1001:1001', cid, 'node', '-e', "process.kill(1,'SIGUSR2')"],
        capture_output=True, text=True, timeout=max(0.01, min(10, deadline-time.monotonic())), check=False)
    while time.monotonic() < deadline:
        current = state()
        if current['State']['Running'] and current['RestartCount'] > before['RestartCount']:
            result = subprocess.run([real, 'exec', '--user', '1001:1001', cid, 'node', '-e',
                "const f=require('fs');const rows=f.readFileSync('/app/tmp/engine-observations.jsonl','utf8').trim().split('\\n').map(JSON.parse);process.stdout.write(JSON.stringify(rows));"],
                capture_output=True, text=True, timeout=min(1, max(0.01, deadline-time.monotonic())), check=False)
            if result.returncode == 0:
                rows = json.loads(result.stdout)
                if len(rows) == 2 and rows[1]['startup'] == 'drained' and rows[1]['controlOnly'] and not rows[1]['syntheticRootConstructed']:
                    if rows[0]['bootId'] == rows[1]['bootId']:
                        raise RuntimeError('Gap boot did not change')
                    receipt.write_text(json.dumps({'phase': 'ack-term-gap-restarted', 'originalBootId': rows[0]['bootId'],
                        'successorBootId': rows[1]['bootId'], 'restartCount': current['RestartCount'],
                        'intentionalCrashExecReturncode': crash.returncode,
                        'successorAdmissionClosed': True}) + '\n')
                    break
        time.sleep(0.05)
    else:
        raise SystemExit('Gap successor observation refused')

# Transparent forwarding: same original argv and real Docker endpoint.
result = subprocess.run([real, *sys.argv[1:]], capture_output=True, text=True,
                        timeout=max(0.01, min(10, deadline-time.monotonic())), check=False)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
sys.exit(result.returncode)
