import re
import shutil
import subprocess
import sys
import time

container = sys.argv[1] if len(sys.argv) > 1 else ''
seconds = sys.argv[2] if len(sys.argv) > 2 else '60'
if not re.fullmatch(r'[a-f0-9]{64}', container) or not re.fullmatch(r'[0-9]+', seconds) or not 1 <= int(seconds) <= 3600:
    sys.exit('Invalid immutable container ID or graceful-stop deadline')
deadline = time.monotonic() + int(seconds)

def command(args):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError('Graceful stop deadline reached; replacement refused')
    try:
        executable = shutil.which('docker')
        if executable is None:
            raise RuntimeError('Docker unavailable; replacement refused')
        result = subprocess.run([executable, *args], capture_output=True, text=True,
                                timeout=min(remaining, 10), check=False)
    except subprocess.TimeoutExpired:
        # subprocess terminates only the owned Docker CLI, never the server.
        raise RuntimeError('Docker command deadline reached; replacement refused') from None
    if result.returncode:
        raise RuntimeError('Docker command failed; replacement refused')
    return result.stdout.strip()

def state():
    fields = command(['inspect', '--format', '{{.Id}}|{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}', container]).split('|')
    if len(fields) != 4 or fields[0] != container or fields[1] not in ('true', 'false'):
        raise RuntimeError('Container identity or state changed; replacement refused')
    return fields

try:
    # A clean exit from an older binary is not this new drain contract.
    capability = command(['inspect', '--format', '{{index .Config.Labels "org.dollhousemcp.memory-upgrade-drain"}}', container])
    if capability != 'v1':
        raise RuntimeError('Old image does not support verified memory drain; replacement refused')
    observed = state()
    if observed[1] == 'true':
        command(['kill', '--signal=TERM', container])
    while True:
        observed = state()
        if observed[1] == 'false':
            if observed[2:] != ['0', 'false']:
                raise RuntimeError('Old process did not close cleanly; replacement refused')
            print('Old process closed cleanly')
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('Graceful stop refused or timed out; old process retained, replacement refused')
        time.sleep(min(1, remaining))
except (RuntimeError, OSError) as error:
    # These fixed messages contain no Docker environment, credentials or logs.
    print(str(error) if isinstance(error, RuntimeError) else 'Docker unavailable; replacement refused', file=sys.stderr)
    sys.exit(1)
