"""One-shot pre-migration legacy recovery, with exposure-only continuation.

No forward state, handoff marker, source, environment or volume is changed.
The failed replacement is stopped and retained, never removed or retried.
"""
import json
import os
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from caddy_active_config import CURL, bounded_input, system_docker, validate_system
from caddy_clone_action import acquire_lock, validate_request
from caddy_image_admission import qualify
from caddy_recover_action import named_containers, old_proxy_args, verify_recovered
from caddy_recovery_receipt import MAX_RECORD, read_caddy_snapshot
from caddy_release_action import public_response
from caddy_volume_migration import inspect_one
from image_scan_intake import unique_object
import legacy_handoff as handoff
import legacy_recovery_boundary as boundary
import legacy_recovery_checks as checks
from legacy_recovery_guards import exact_container, ingress_available, lifecycle, serving_dns
from legacy_recovery_journal import Journal

LEGACY_VERSION = "2.1.0-beta.2"


def command(journal, name, run, argv, timeout, maximum=65536):
    journal.absent(name + '-issued')
    journal.write(name + '-issued', {'operation': argv[1]})
    started = time.monotonic()
    try:
        result = run(argv, timeout, maximum)
    except BaseException as error:
        journal.write(name + '-failed', {'elapsed_seconds': time.monotonic() - started,
                                        'error': str(error), 'outcome': 'UNKNOWN or refused; no retry'})
        raise
    journal.write(name + '-acknowledged', {'elapsed_seconds': time.monotonic() - started,
                                         'stdout_sha256': handoff.digest(result), 'exit_code': 0})
    return result


def same_id(raw, identifier):
    if raw != (identifier + '\n').encode('ascii'):
        raise ValueError('Docker command did not acknowledge the exact immutable container ID')


def stop_forward_proxy(root, value, armed, baseline, journal, run):
    checks.forward_state(root, value, armed, baseline['forward_state'])
    current = exact_container(run, baseline['current_id'], baseline['proxy_profile'], value['instance'] + '-caddy',
                              baseline['proxy_running'], baseline['proxy_boot'])
    checks.database(value, armed, run)
    if baseline['proxy_running']:
        raw = command(journal, 'offline-fence', run,
                      ['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', baseline['current_id']], 60)
        same_id(raw, baseline['current_id'])
    else:
        from caddy_native_replacement import verify_failed_start_fence
        verify_failed_start_fence(root, value['token'], current)
    checks.behind_offline_fence(root, value, armed, baseline, run)
    journal.write('offline-fence-confirmed', {'id': baseline['current_id'], 'boot': baseline['proxy_boot']})


def wait_healthy(root, value, armed, baseline, boot, run):
    checks.behind_offline_fence(root, value, armed, baseline, run)
    deadline = time.monotonic() + 120

    def observed(argv, timeout, maximum):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('legacy configured health exceeded its 120-second observation deadline')
        return run(argv, min(timeout, remaining), maximum)

    while True:
        exact_container(observed, baseline['current_id'], baseline['proxy_profile'], value['instance'] + '-caddy',
                        False, baseline['proxy_boot'])
        app = exact_container(observed, value['app_id'], armed['profiles']['app'], value['instance'], True, boot)
        health = app['State'].get('Health', {}).get('Status')
        if health == 'healthy':
            return
        if health != 'starting' or time.monotonic() >= deadline:
            raise ValueError('legacy configured health failed or exceeded its 120-second observation deadline')
        time.sleep(min(1, max(0, deadline - time.monotonic())))


def app_acceptance(value, run):
    script = """Promise.all(['/healthz','/readyz','/mcp'].map(async p=>{
      const r=await fetch('http://127.0.0.1:'+(process.env.DOLLHOUSE_HTTP_PORT||3000)+p,
        {signal:AbortSignal.timeout(5000)});
      await r.arrayBuffer(); if(r.status!==(p==='/mcp'?401:200))throw Error('legacy status '+p);
    })).then(()=>{if(require('/app/package.json').version!==process.argv[1])throw Error('legacy version');
      console.log('legacy-200-200-401-beta2')}).catch(e=>{console.error(e.message);process.exit(1)})"""
    if run(['docker', 'exec', value['app_id'], 'node', '-e', script, LEGACY_VERSION], 20, 65536) != b'legacy-200-200-401-beta2\n':
        raise ValueError('legacy application acceptance did not acknowledge all required checks')


def restore_app(root, value, armed, baseline, journal, run):
    journal.read('offline-fence-confirmed')
    checks.behind_offline_fence(root, value, armed, baseline, run)
    status = baseline['app']
    if status['mode'] in ('stopped', 'stop-acknowledged'):
        # Revalidate the full handoff or separate known command ACK after the
        # independently confirmed proxy stop. Never synthesize a completion.
        pending = baseline['forward_state']['pending']
        if checks.handoff_state(root, value, armed, pending, run) != status:
            raise ValueError('clean-stop handoff changed before legacy restart')
        exact_container(run, value['app_id'], armed['profiles']['app'], value['instance'], False, status['app_boot'])
        same_id(command(journal, 'app-start', run, ['docker', 'start', value['app_id']], 30), value['app_id'])
        app = exact_container(run, value['app_id'], armed['profiles']['app'], value['instance'], True)
        boot = lifecycle(app, True)
        if boot['started_at'] == status['app_boot']['started_at'] or boot['restart_count'] != status['app_boot']['restart_count']:
            raise ValueError('legacy start did not produce the expected single new boot')
    else:
        boot = status['app_boot']
        exact_container(run, value['app_id'], armed['profiles']['app'], value['instance'], True, boot)
    # Persist known acknowledgement/boot before any health observation. Exposure
    # continuation requires this record and never issues another app start.
    journal.write('app-started', {'boot': boot, 'mode': status['mode']})
    wait_healthy(root, value, armed, baseline, boot, run)
    app_acceptance(value, run)
    serving_dns(run, value['instance'], value['app_id'])
    journal.write('app-ready', {'boot': boot, 'version': LEGACY_VERSION})


def ready(root, value, armed, baseline, journal, run):
    started, accepted = journal.read('app-started'), journal.read('app-ready')
    if started['boot'] != accepted['boot'] or accepted['version'] != LEGACY_VERSION:
        raise ValueError('legacy readiness is not bound to the acknowledged boot')
    checks.behind_offline_fence(root, value, armed, baseline, run)
    exact_container(run, value['app_id'], armed['profiles']['app'], value['instance'], True, started['boot'])
    app_acceptance(value, run)
    serving_dns(run, value['instance'], value['app_id'])
    return started['boot']


def public_acceptance(origin):
    results = []
    for path, expected in (('/healthz', b'200'), ('/readyz', b'200'), ('/mcp', b'401')):
        raw = bounded_input([CURL, '--disable', '--noproxy', '*', '--proto', '=http,https', '--http1.1',
                             '--silent', '--show-error', '--max-time', '15', '--include', '--write-out',
                             '\n%{http_code}', origin + path], timeout=20,
                            context={'operation': 'legacy-public-acceptance', 'path': path})
        body, code, markers = public_response(raw)
        if code != expected or markers:
            raise ValueError('legacy public acceptance refused; ingress must be fenced')
        version = None
        if path != '/mcp':
            payload = json.loads(body, object_pairs_hook=unique_object)
            if not isinstance(payload, dict) or payload.get('version') != LEGACY_VERSION:
                raise ValueError('public legacy version differs; ingress must be fenced')
            version = payload['version']
        results.append({'path': path, 'status': int(code), 'version': version, 'body_sha256': handoff.digest(body)})
    return results


def fence_failed_exposure(run, identifier, plan, value, journal, caddyfile, admit):
    current = inspect_one(run, 'container', identifier)
    running = current.get('State', {}).get('Running')
    if type(running) is not bool:
        raise ValueError('failed exposure state is UNKNOWN; independent fencing required')
    verify_recovered(run, identifier, plan, value['instance'], journal.operation, running, caddyfile, admit)
    if running:
        same_id(command(journal, 'failed-exposure-stop', run,
                        ['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', identifier], 60), identifier)
        stopped = verify_recovered(run, identifier, plan, value['instance'], journal.operation, False, caddyfile, admit)
        lifecycle(stopped, False)
    journal.write('exposure-refused', {'id': identifier, 'stopped': True, 'no_retry': True})


def expose(root, value, armed, journal, run, admit, public=public_acceptance):
    journal.absent('exposure-issued')
    baseline = journal.read('baseline')
    boot = ready(root, value, armed, baseline, journal, run)
    record, receipt_path = checks.original_proxy(root, armed, run, admit)
    plan = {'record': record}
    ingress_available(run, record['profile']['ports'])
    # Original receipt snapshot is already private, readable by the old root
    # proxy, and hash-bound. Never loosen its mode or replace root/Caddyfile.
    caddyfile = receipt_path / 'Caddyfile'
    read_caddy_snapshot(receipt_path, record['caddyfile_sha256'])
    journal.write('exposure-issued', {'app_boot': boot, 'original_receipt': str(receipt_path)})
    retained = value['instance'] + '-caddy-aborted-' + journal.operation
    raw = command(journal, 'retain-proxy', run,
                  ['docker', 'rename', baseline['current_id'], retained], 15)
    if raw:
        raise ValueError('Docker rename returned unexpected output')
    exact_container(run, baseline['current_id'], baseline['proxy_profile'], retained, False, baseline['proxy_boot'])
    if named_containers(run, value['instance']):
        raise ValueError('original proxy name is not free after retention')
    checks.forward_state(root, value, armed, baseline['forward_state'])
    checks.database(value, armed, run)
    app_acceptance(value, run)
    serving_dns(run, value['instance'], value['app_id'])
    ingress_available(run, record['profile']['ports'])
    raw = command(journal, 'proxy-create', run,
                  old_proxy_args(plan, value['instance'], journal.operation, caddyfile), 30)
    identifier = raw.decode('ascii').strip()
    if not handoff.SHA.fullmatch(identifier) or raw != (identifier + '\n').encode():
        raise ValueError('created recovery proxy identity is UNKNOWN')
    verify_recovered(run, identifier, plan, value['instance'], journal.operation, False, caddyfile, admit)
    journal.write('proxy-created', {'id': identifier})
    checks.database(value, armed, run)
    exact_container(run, value['app_id'], armed['profiles']['app'], value['instance'], True, boot)
    app_acceptance(value, run)
    serving_dns(run, value['instance'], value['app_id'])
    ingress_available(run, record['profile']['ports'])
    try:
        same_id(command(journal, 'proxy-start', run, ['docker', 'start', identifier], 30), identifier)
        recovered = verify_recovered(run, identifier, plan, value['instance'], journal.operation, True, caddyfile, admit)
        proxy_boot = lifecycle(recovered, True)
        checks.serving_config(identifier, receipt_path, record, proxy_boot)
        results = public(baseline['forward_state']['pending']['control']['public_origin'])
        checks.forward_state(root, value, armed, baseline['forward_state'])
        checks.database(value, armed, run)
        exact_container(run, value['app_id'], armed['profiles']['app'], value['instance'], True, boot)
        app_acceptance(value, run)
        serving_dns(run, value['instance'], value['app_id'])
        verify_recovered(run, identifier, plan, value['instance'], journal.operation, True, caddyfile, admit)
        checks.serving_config(identifier, receipt_path, record, proxy_boot)
        journal.write('RECOVERED', {'version': LEGACY_VERSION, 'app_id': value['app_id'], 'app_boot': boot,
                                   'proxy_id': identifier, 'proxy_boot': proxy_boot, 'retained_id': baseline['current_id'],
                                   'retained_name': retained, 'public': results, 'forward_state_unchanged': True})
    except BaseException:
        # One non-forcing compensation, only after exact immutable ownership is
        # independently confirmed. Never retry an unknown stop or start.
        fence_failed_exposure(run, identifier, plan, value, journal, caddyfile, admit)
        raise


def recover(root, value, run=system_docker, admit=qualify, exposure_only=False, public=public_acceptance):
    armed, armed_sha = boundary.read_window(root, value['token'])
    if armed['request'] != value:
        raise ValueError('legacy recovery request differs from the armed window')
    boundary.refuse_forward_write(root, value['token'])
    if exposure_only:
        journal = Journal(root, value['token'], armed_sha)
    else:
        _, baseline = checks.preconditions(root, value, armed, run, admit)
        journal = Journal(root, value['token'], armed_sha, create=True)
        journal.write('baseline', baseline)
    try:
        if not exposure_only:
            stop_forward_proxy(root, value, armed, baseline, journal, run)
            restore_app(root, value, armed, baseline, journal, run)
        expose(root, value, armed, journal, run, admit, public)
        return {'outcome': 'RECOVERED', 'receipt': str(journal.path / 'RECOVERED.json')}
    finally:
        journal.close()


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('recover-legacy', 'expose-legacy'):
        raise ValueError('explicit recover-legacy or exposure-only expose-legacy action required')
    raw = sys.stdin.buffer.read(MAX_RECORD + 1)
    if len(raw) > MAX_RECORD:
        raise ValueError('legacy recovery request exceeds its bound')
    value = json.loads(raw, object_pairs_hook=unique_object)
    if (not isinstance(value, dict) or set(value) != boundary.KEYS
            or any(not isinstance(v, str) for v in value.values())
            or not boundary.TOKEN.fullmatch(value['token'])
            or any(not handoff.SHA.fullmatch(value[k]) for k in ('app_id', 'postgres_id'))):
        raise ValueError('invalid legacy recovery request')
    root = validate_request({k: value[k] for k in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    validate_system()
    if os.uname().machine != 'x86_64':
        raise ValueError('legacy recovery requires the qualified native AMD64 host')
    lock = acquire_lock(root, allow_control=True)
    try:
        print(json.dumps(recover(root, value, exposure_only=sys.argv[1] == 'expose-legacy')))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Legacy recovery refused; preserve all controls and inspect private recovery receipts: ' + str(error), file=sys.stderr)
        sys.exit(1)
