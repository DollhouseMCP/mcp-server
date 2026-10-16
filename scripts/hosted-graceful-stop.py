import json
import re
import secrets
import shutil
import subprocess
import sys
import time

# At most ten post-TERM observations per second of the requested budget,
# plus one boundary observation; never extend the absolute deadline.
CLOSURE_POLLS_PER_SECOND = 10
CONTROL_DIR = '/app/.memory-upgrade-control'
CLIENT = '/app/dist/lifecycle/requestMemoryDrain.js'
STATE_FORMAT = ('{"id":{{json .Id}},"running":{{json .State.Running}},'
                '"exitCode":{{json .State.ExitCode}},"oomKilled":{{json .State.OOMKilled}},'
                '"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}},'
                '"restarting":{{json .State.Restarting}},"readonly":{{json .HostConfig.ReadonlyRootfs}},'
                '"mounts":{{json .Mounts}},"enabled":"{{range .Config.Env}}'
                '{{if eq (index (split . "=") 0) "DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR"}}'
                '{{if eq . "DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR=/app/.memory-upgrade-control"}}enabled{{else}}invalid{{end}}{{end}}{{end}}",'
                '"capability":{{json (index .Config.Labels "org.dollhousemcp.memory-upgrade-drain")}}}')
container = sys.argv[1] if len(sys.argv) > 1 else ''
seconds = sys.argv[2] if len(sys.argv) > 2 else '60'
if not re.fullmatch(r'[a-f0-9]{64}', container) or not re.fullmatch(r'\d+', seconds, flags=re.ASCII) or not 1 <= int(seconds) <= 3600:
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
    if len(result.stdout.encode('utf-8')) > 16384:
        raise RuntimeError('Docker response exceeded metadata bound; replacement refused')
    return result.stdout.strip()


def state():
    observed = json.loads(command(['inspect', '--format', STATE_FORMAT, container]))
    if not isinstance(observed, dict) or observed.get('id') != container:
        raise RuntimeError('Container identity or state changed; replacement refused')
    for name in ('running', 'oomKilled', 'restarting', 'readonly'):
        if type(observed.get(name)) is not bool:
            raise RuntimeError('Container state unavailable; replacement refused')
    if type(observed.get('exitCode')) is not int or type(observed.get('restartCount')) is not int or observed['restartCount'] < 0:
        raise RuntimeError('Container state unavailable; replacement refused')
    if not isinstance(observed.get('startedAt'), str) or not observed['startedAt']:
        raise RuntimeError('Container boot identity unavailable; replacement refused')
    return observed


def require_supported_profile(observed):
    if observed.get('capability') != 'v2' or observed.get('enabled') != 'enabled' or observed['readonly']:
        raise RuntimeError('Image or profile does not support verified memory drain; replacement refused')
    mounts = observed.get('mounts')
    if not isinstance(mounts, list):
        raise RuntimeError('Container storage identity unavailable; replacement refused')
    for mount in mounts:
        destination = mount.get('Destination') if isinstance(mount, dict) else None
        if not isinstance(destination, str) or not destination.startswith('/'):
            raise RuntimeError('Container storage identity unavailable; replacement refused')
        parent = destination.rstrip('/')
        if not parent or CONTROL_DIR == parent or CONTROL_DIR.startswith(parent + '/'):
            raise RuntimeError('Drain hold must use the private container layer; replacement refused')


def require_drain_ack(text, nonce):
    if len(text.encode('utf-8')) > 1024:
        raise RuntimeError('Drain acknowledgement exceeded bound; replacement refused')
    ack = json.loads(text)
    keys = {'protocol', 'phase', 'containerId', 'nonce', 'bootId', 'generation', 'sourceBootId',
            'mode', 'admitted', 'writes', 'failedWrites', 'retainedOwners'}
    if not isinstance(ack, dict) or set(ack) != keys:
        raise RuntimeError('Drain acknowledgement unavailable; replacement refused')
    if type(ack['protocol']) is not int or ack['protocol'] != 2 or ack['phase'] != 'drained' or ack['containerId'] != container or ack['nonce'] != nonce:
        raise RuntimeError('Drain acknowledgement identity changed; replacement refused')
    require_boot_binding(ack)
    require_zero_obligations(ack)


def require_zero_obligations(ack):
    for name in ('admitted', 'writes', 'failedWrites', 'retainedOwners'):
        if type(ack[name]) is not int or ack[name] != 0:
            raise RuntimeError('Memory obligations remain; replacement refused')


def require_boot_binding(ack):
    for name in ('bootId', 'generation', 'sourceBootId'):
        if not isinstance(ack[name], str) or not re.fullmatch(r'[a-f0-9]{64}', ack[name]):
            raise RuntimeError('Drain acknowledgement identity changed; replacement refused')
    same_boot = ack['bootId'] == ack['sourceBootId']
    if ack['mode'] == 'same-boot' and same_boot:
        return
    if ack['mode'] == 'drained-successor' and not same_boot:
        return
    raise RuntimeError('Drain boot binding unavailable; replacement refused')


def drain_before_term(before):
    nonce = secrets.token_hex(32)
    remaining_ms = int((deadline - time.monotonic()) * 1000)
    if remaining_ms <= 0:
        raise RuntimeError('Graceful stop deadline reached; replacement refused')
    ack = command(['exec', '--user', '1001:1001', '--workdir', '/app', container,
                   'node', CLIENT, container, nonce, str(remaining_ms)])
    require_drain_ack(ack, nonce)
    current = state()
    require_supported_profile(current)
    if not current['running'] or current['restarting'] or current['startedAt'] != before['startedAt'] or current['restartCount'] != before['restartCount']:
        raise RuntimeError('Container boot changed during drain; replacement refused')
    # The durable admission hold also fences a successor after this readback.
    # Docker's manual-stop state is committed only after known drained authority.
    command(['kill', '--signal=TERM', container])


try:
    observed = state()
    require_supported_profile(observed)
    if observed['restarting']:
        raise RuntimeError('Container is restarting; replacement refused')
    if not observed['running']:
        raise RuntimeError('Stopped container has no live drain acknowledgement; replacement refused')
    drain_before_term(observed)
    polls_remaining = int(seconds) * CLOSURE_POLLS_PER_SECOND + 1
    while True:
        if polls_remaining <= 0:
            raise RuntimeError('Graceful stop refused or timed out; old process retained, replacement refused')
        polls_remaining -= 1
        observed = state()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('Graceful stop refused or timed out; old process retained, replacement refused')
        if not observed['running'] and not observed['restarting']:
            if observed['exitCode'] != 0 or observed['oomKilled']:
                raise RuntimeError('Old process did not close cleanly; replacement refused')
            print('Old process closed cleanly')
            break
        time.sleep(min(1 / CLOSURE_POLLS_PER_SECOND, remaining))
except (RuntimeError, OSError, ValueError, TypeError, KeyError) as error:
    # Never print Docker metadata, environment, protocol text or arbitrary exceptions.
    print(str(error) if isinstance(error, RuntimeError) else 'Verified memory drain or clean closure unavailable; replacement refused', file=sys.stderr)
    sys.exit(1)
