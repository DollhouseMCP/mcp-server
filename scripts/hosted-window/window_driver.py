#!/usr/bin/env python3
"""Drive one legacy upgrade window from one plan file.

Every earlier window was run from handwritten shell: exports typed into a
session, requests written by hand, one script per window. This driver replaces
that. It reads one private plan file, runs the same qualified actions in a
fixed order and writes a journal. `plan` prints the runbook, so the runbook is
the driver's own output and cannot drift from what `run` does.

    window_driver.py plan PLAN
    window_driver.py run PLAN JOURNAL [--first N] [--last N] [--checkpoint DIR]
    window_driver.py status PLAN JOURNAL
    window_driver.py recover PLAN JOURNAL ACTION

Phases: 0 source check and read-only preflight, 1 legacy reconciliation,
2 offline Caddy preparation (ingress closes), 3 the fresh checkpoint, 4 the
update, 5 verification and read-back.

What it guarantees about each step:
- One child process from an argument list. No shell builds a command.
- A fixed environment built from the plan. Nothing but HOME is inherited, so a
  variable left in the operator's session cannot reach an action.
- Standard input is closed, or is the one request file the action reads.
- No bytecode cache: the tooling's identity is a hash of its folder.
- The pinned source is checked by commit and tree, and must be clean, before
  the first step and again before every step that changes the host.
- Its own session. A dropped terminal reaches neither the driver nor the step.
  SIGINT and SIGTERM stop the run between steps, never inside one.
- A record in the journal before it starts and after it ends. A step that
  started and never reported is an unknown outcome, and nothing runs after it.

It stops at the first failure and never retries. It never recovers by itself:
`status` names the one recovery action that fits, and `recover` runs that
action only when the operator names the same one.

Phase 3 is a hand-over. The checkpoint is made outside this program, with the
procedure the operator owns. `run` stops after phase 2 and waits. Run it again
with `--checkpoint DIR`; the tooling's own checkpoint check must accept that
folder before phase 4 starts.

A plan may hold a `replica` section for a rehearsal. It is accepted only on a
host that carries the replica declaration (see build_replica.py) and is
refused everywhere else, so a live plan can never hold one.

Exit status: 0 the requested phases passed, 3 refused or a step failed,
4 waiting at the hand-over, 5 stopped by a signal between steps.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time

# The tooling's identity is a hash of its folder. A bytecode cache written there would change it.
sys.dont_write_bytecode = True

SCHEMA = 'hosted-window-plan-v1'
PLAN_KEYS = {'schema', 'source', 'deploy_dir', 'instance', 'hostname', 'public_base_url', 'images', 'caddy_volumes',
             'reconciliation_input', 'docker_config', 'versions'}
REPLICA_KEYS = {'pins_dir', 'path_prefix'}
SEARCH_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
HEX40 = re.compile(r'[0-9a-f]{40}\Z')
IMAGE = re.compile(r'[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}\Z')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
VERSION = re.compile(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\Z', re.ASCII)
HOST = re.compile(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\Z')
# Every path the driver takes, on the command line or in the plan: absolute, as written, without a "." or ".." part.
# read_back.py holds the same pattern, so that it cannot refuse a path this driver accepted.
LOCATION = re.compile(r'(?:/(?!\.{1,2}(?:/|\Z))[^/\0]+)+\Z')
LOCATION_FAULT = '%s must be an absolute path as written, without a "." or ".." part'
PHASES = ('source check and read-only preflight', 'legacy reconciliation', 'offline Caddy preparation',
          'fresh checkpoint (hand-over)', 'update', 'verification and read-back')
CLOSING = 2   # ingress closes in this phase
CHECKPOINT = '<checkpoint folder>'
ABANDON, RECOVER, RETURN = 'abandon-caddy-offline', 'recover-legacy', 'return-unarmed-update'
REQUEST, RECONCILE, PREPARE, UPDATE = 'prepare-legacy-reconciliation', 'reconcile-legacy', 'prepare-caddy-offline', 'legacy-offline-update'
RECONCILE_SCRIPT, TOOLING, PYTHON = 'legacy_reconcile_action.py', 'hosted-deploy', 'python3'
PLAN_COPY, ACCEPTED, STDOUT, UTF8 = 'plan.json', 'checkpoint-accepted', '.stdout', 'utf-8'
REPLICA_FAULT = 'replica must hold pins_dir and at most path_prefix, as absolute paths'
RECOVERIES = (ABANDON, RECOVER, RETURN)
POLL = 0.5
GRACE = 30


class Refused(Exception):
    pass


def absolute(value):
    return isinstance(value, str) and LOCATION.fullmatch(value) is not None


def exact(value, keys, what):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise Refused('%s must hold exactly: %s' % (what, ', '.join(sorted(keys))))
    return value


def strings(values, pattern):
    return all(isinstance(item, str) and pattern.match(item) for item in values)


def plan_faults(plan):
    """The name of every field that is not acceptable."""
    source = exact(plan['source'], ('dir', 'commit', 'tree'), 'source')
    images = exact(plan['images'], ('runtime', 'migration', 'caddy'), 'images')
    volumes = exact(plan['caddy_volumes'], ('data', 'config'), 'caddy_volumes')
    versions = exact(plan['versions'], ('legacy', 'upgraded'), 'versions')
    checks = (
        (plan['schema'] == SCHEMA, 'schema'),
        (absolute(source['dir']), 'source.dir'),
        (strings((source['commit'], source['tree']), HEX40), 'source.commit and source.tree'),
        (absolute(plan['deploy_dir']), 'deploy_dir'),
        (strings((plan['instance'],), NAME), 'instance'),
        (strings((plan['hostname'],), HOST), 'hostname'),
        (plan['public_base_url'] == 'https://%s' % plan['hostname'], 'public_base_url (https:// and the hostname)'),
        (strings(images.values(), IMAGE), 'images (each by digest)'),
        (strings(volumes.values(), NAME), 'caddy_volumes'),
        (volumes['data'] != volumes['config'], 'caddy_volumes (two different volumes)'),
        (absolute(plan['reconciliation_input']), 'reconciliation_input'),
        (plan['docker_config'] is None or absolute(plan['docker_config']), 'docker_config (a folder or null)'),
        (strings(versions.values(), VERSION), 'versions'),
        (versions['legacy'] != versions['upgraded'], 'versions (two different versions)'),
    )
    return [name for passed, name in checks if not passed]


def replica_section(replica, declared):
    """A rehearsal's differences. Never on a live host: only a declared replica may hold the section."""
    if replica is None:
        return None
    (declared or declared_replica)()
    if not isinstance(replica, dict) or not set(replica) <= REPLICA_KEYS or 'pins_dir' not in replica:
        raise Refused(REPLICA_FAULT)
    if not all(absolute(item) for item in replica.values()):
        raise Refused(REPLICA_FAULT)
    return replica


def plan_bytes(path):
    """The plan file as it is on disk."""
    if not LOCATION.fullmatch(str(path)):
        raise Refused(LOCATION_FAULT % 'the plan')
    return Path(path).read_bytes()


def load_plan(path, declared=None):
    """The plan, or a refusal that names what is wrong. Unknown fields are refused, never ignored."""
    try:
        plan = json.loads(plan_bytes(path))
    except (OSError, ValueError) as error:
        raise Refused('the plan cannot be read: %s' % type(error).__name__) from None
    replica = plan.pop('replica', None) if isinstance(plan, dict) else None
    exact(plan, PLAN_KEYS, 'the plan')
    faults = plan_faults(plan)
    if faults:
        raise Refused('the plan field is not acceptable: ' + faults[0])
    plan['replica'] = replica_section(replica, declared)
    return plan


def declared_replica():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'hosted-replica'))
    import build_replica
    try:
        return build_replica.declared_replica()
    except build_replica.Refused as error:
        raise Refused('the plan has a replica section and %s' % error) from None


def environment(plan, checkpoint=None):
    """The whole environment of every step. Only HOME comes from the operator's session."""
    replica = plan['replica'] or {}
    env = {
        'PATH': ':'.join(filter(None, (replica.get('path_prefix'), SEARCH_PATH))),
        'HOME': os.environ.get('HOME', '/root'), 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1',
        'DOLLHOUSE_HOSTED_SOURCE_DIR': plan['source']['dir'], 'DOLLHOUSE_HOSTED_GIT_REF': plan['source']['commit'],
        'DOLLHOUSE_HOSTED_DEPLOY_DIR': plan['deploy_dir'], 'DOLLHOUSE_HOSTED_INSTANCE_NAME': plan['instance'],
        'DOLLHOUSE_HOSTED_HOSTNAME': plan['hostname'], 'DOLLHOUSE_PUBLIC_BASE_URL': plan['public_base_url'],
        'DOLLHOUSE_HOSTED_IMAGE_MODE': 'registry', 'DOLLHOUSE_HOSTED_RUNTIME_IMAGE': plan['images']['runtime'],
        'DOLLHOUSE_HOSTED_MIGRATION_IMAGE': plan['images']['migration'], 'DOLLHOUSE_HOSTED_CADDY_IMAGE': plan['images']['caddy'],
        'DOLLHOUSE_HOSTED_CADDY_DATA_VOLUME': plan['caddy_volumes']['data'],
        'DOLLHOUSE_HOSTED_CADDY_CONFIG_VOLUME': plan['caddy_volumes']['config'],
    }
    if plan['docker_config']:
        env['DOCKER_CONFIG'] = plan['docker_config']
    if checkpoint:
        env['DOLLHOUSE_HOSTED_LEGACY_CHECKPOINT'] = checkpoint
    return env


class Step:
    """One step. `argv` is None for the hand-over, which the operator performs."""

    def __init__(self, name, phase, title, argv, stdin=None, changes=True, limit=900, cwd=None, needs_checkpoint=False):
        self.name, self.phase, self.title, self.argv, self.stdin = name, phase, title, argv, stdin
        self.changes, self.limit, self.cwd, self.needs_checkpoint = changes, limit, cwd, needs_checkpoint


def tooling(plan, script):
    return str(Path(plan['source']['dir']) / 'scripts' / TOOLING / script)


def deploy(plan, action):
    return ['bash', str(Path(plan['source']['dir']) / 'scripts' / 'hosted-deploy.sh'), action]


def reconciliation(plan, script, action):
    """One reconciliation action. On a declared replica the pin launcher runs the same action with the replica's evidence."""
    if plan['replica']:
        launcher = Path(plan['source']['dir']) / 'scripts' / 'hosted-replica' / 'run_with_replica_pins.py'
        return [PYTHON, str(launcher), action], plan['replica']['pins_dir']
    return [PYTHON, tooling(plan, script), action], None


def steps(plan, journal, checkpoint=None):
    """Every step of the window, in order. `plan` prints this list and `run` executes it: there is no other list."""
    journal = Path(journal)
    request = str(journal / 'reconcile-request.json')
    preflight, cwd = reconciliation(plan, 'legacy_reconcile_preflight.py', 'preflight-legacy-reconciliation')
    prepare, _ = reconciliation(plan, RECONCILE_SCRIPT, REQUEST)
    reconcile, _ = reconciliation(plan, RECONCILE_SCRIPT, RECONCILE)
    read_back = [PYTHON, str(Path(plan['source']['dir']) / 'scripts' / 'hosted-window' / 'read_back.py'),
                 str(journal / PLAN_COPY), checkpoint or CHECKPOINT]
    return [
        Step('preflight', 0, 'every read-only control of reconciliation', preflight, plan['reconciliation_input'], False, 600, cwd),
        Step(REQUEST, 1, 'write the reconciliation request', prepare, plan['reconciliation_input'], False, 300, cwd),
        Step(RECONCILE, 1, 'reconcile the retained failed transition', reconcile, request, True, 900, cwd),
        Step(PREPARE, 2, 'stop the serving proxy and clone its volumes; ingress closes',
             deploy(plan, PREPARE)),
        Step('checkpoint', 3, 'the operator makes the fresh checkpoint; the tooling must accept it', None, changes=False),
        Step(UPDATE, 4, 'new proxy, clean legacy stop, migrations, grants, start, release',
             deploy(plan, UPDATE), limit=3600, needs_checkpoint=True),
        Step('verify', 5, 'the deployment verifies itself', deploy(plan, 'verify'), changes=False, limit=600),
        Step('read-back', 5, 'what serves now, against the plan and the checkpoint', read_back, changes=False, limit=300,
             needs_checkpoint=True),
    ]


def recovery_steps(plan, journal, action):
    journal = Path(journal)
    if action == ABANDON:
        return [Step(ABANDON, CLOSING, 'start the same proxy again and prove the legacy service',
                     deploy(plan, ABANDON))]
    if action == RETURN:
        return [Step(RETURN, 4, 'return the update transition that began and was never armed',
                     [PYTHON, tooling(plan, 'legacy_update_return.py'), RETURN],
                     str(journal / 'return-request.json')),
                Step(ABANDON, CLOSING, 'start the same proxy again and prove the legacy service',
                     deploy(plan, ABANDON))]
    return [
        Step(RECOVER, 4, 'bring the legacy service back from the armed baseline',
             [PYTHON, tooling(plan, 'legacy_recovery_action.py'), RECOVER], str(journal / 'armed-request.json')),
        Step('reconcile-legacy-after-recovery', 4, 'reconcile the recovered transition, so that a second attempt can start',
             [PYTHON, tooling(plan, RECONCILE_SCRIPT), RECONCILE],
             str(journal / 'reconcile-after-recovery.json')),
    ]


# Journal ----------------------------------------------------------------------------------------------------------

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_private(path, raw):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as handle:
        handle.write(raw)


class Journal:
    """An append-only record. Each line is on disk before the driver goes on."""

    def __init__(self, path):
        if not LOCATION.fullmatch(str(path)):
            raise Refused(LOCATION_FAULT % 'the journal')
        self.path = Path(path)
        self.log = self.path / 'journal.jsonl'

    def open(self, plan_path, first):
        """Create the journal, or continue one that was written for this exact plan."""
        raw = plan_bytes(plan_path)
        if not self.path.exists():
            self.path.mkdir(mode=0o700)
            write_private(self.path / PLAN_COPY, raw)
            self.write({'event': 'opened', 'plan_sha256': hashlib.sha256(raw).hexdigest(), 'first': first or 0})
        return self.records(plan_path)

    def write(self, record):
        line = json.dumps({'at': now(), **record}, sort_keys=True) + '\n'
        descriptor = os.open(self.log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(descriptor, line.encode(UTF8))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def records(self, plan_path):
        try:
            if file_hash(self.path / PLAN_COPY) != hashlib.sha256(plan_bytes(plan_path)).hexdigest():
                raise Refused('this journal belongs to another plan; a changed plan needs a new journal')
            return [json.loads(line) for line in self.log.read_text(encoding=UTF8).splitlines() if line]
        except OSError:
            raise Refused('this folder is not a journal that can be read') from None

    def free(self, name):
        """A name for one step's output files that no earlier run of the step took."""
        for candidate in [name] + ['%s-%d' % (name, number) for number in range(2, 100)]:
            if not (self.path / (candidate + STDOUT)).exists():
                return candidate
        raise Refused('too many runs of one step in this journal')


def progress(records):
    """What the journal proves: steps that passed, and how it ended, if it did: (failed|unknown|recovered, step)."""
    passed, started, ended = [], None, None
    for record in records:
        event = record['event']
        if event == 'started':
            started = record['step']
        elif event == 'finished':
            started = None
            if record['exit'] == 0:
                passed.append(record['step'])
            else:
                ended = ('failed', record['step'])
        elif event == ACCEPTED:
            passed.append('checkpoint')
        elif event == 'recovered':
            ended = ('recovered', record['step'])
    return passed, ('unknown', started) if started else ended


def accepted_checkpoint(records):
    found = [record['checkpoint_dir'] for record in records if record['event'] == ACCEPTED]
    return found[-1] if found else None


# Running ----------------------------------------------------------------------------------------------------------

class Stop:
    """SIGINT and SIGTERM ask for a stop. It is honoured between steps. SIGHUP is ignored."""

    def __init__(self):
        self.asked = None

    def ask(self, received, _frame):
        self.asked = signal.Signals(received).name

    def install(self):
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        signal.signal(signal.SIGINT, self.ask)
        signal.signal(signal.SIGTERM, self.ask)


def say(text):
    """Progress for a terminal that may be gone. The journal is the record."""
    try:
        print(text, flush=True)
    except OSError:
        pass


def check_source(plan, env, run=subprocess.run):
    """The pinned source is the planned commit and tree, with no file added: not even an ignored bytecode cache."""
    source = plan['source']

    def git(*words):
        done = run(['git', '-C', source['dir'], *words], stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=60)
        if done.returncode != 0:
            raise Refused('the pinned source cannot be read by git')
        return done.stdout.decode(UTF8, 'replace').strip()

    if git('rev-parse', 'HEAD') != source['commit'] or git('rev-parse', 'HEAD^{tree}') != source['tree']:
        raise Refused('the pinned source is not the planned commit and tree')
    if git('status', '--porcelain', '--ignored'):
        raise Refused('the pinned source is not clean: a changed, added or cached file is in it')
    if Path(__file__).resolve() != Path(source['dir']).resolve() / 'scripts' / 'hosted-window' / 'window_driver.py':
        raise Refused('this driver is not the pinned source\'s own copy; run the one in the planned source folder')


def check_checkpoint(plan, directory):
    """The tooling's own acceptance of the fresh checkpoint. Returns the hash of its header."""
    sys.path.insert(0, str(Path(plan['source']['dir']) / 'scripts' / TOOLING))
    import legacy_handoff
    try:
        return legacy_handoff.checkpoint(directory)[1]
    except (OSError, ValueError) as error:
        raise Refused('the tooling does not accept the checkpoint: %s' % error) from None


def end(process, sleep):
    """End a read-only step that ran past its limit. A step that changes the host is never ended."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
        for _ in range(int(GRACE / POLL)):
            if process.poll() is not None:
                return
            sleep(POLL)
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def wait(process, step, journal, stop, begun, clock, sleep):
    """Wait for a step however long it takes. Only a read-only step is ended at its limit."""
    overdue = noted = False
    while process.poll() is None:
        if stop.asked and not noted:
            noted = True
            journal.write({'event': 'stop-asked', 'signal': stop.asked, 'during': step.name})
        if not overdue and clock() - begun > step.limit:
            overdue = True
            journal.write({'event': 'overdue', 'step': step.name, 'limit_seconds': step.limit, 'ended': not step.changes})
            if not step.changes:
                end(process, sleep)
        sleep(POLL)
    return process.returncode


def execute(step, journal, env, stop, popen=subprocess.Popen, clock=time.monotonic, sleep=time.sleep):
    """Run one step to its end, with a record before it starts and after it ends."""
    try:
        stdin = open(step.stdin or os.devnull, 'rb')
    except OSError:
        raise Refused('%s cannot read its input file; nothing was started' % step.name) from None
    output = journal.free(step.name)
    out, err = journal.path / (output + STDOUT), journal.path / (output + '.stderr')
    with stdin, open(out, 'xb') as stdout, open(err, 'xb') as stderr:
        journal.write({'event': 'started', 'step': step.name, 'phase': step.phase, 'argv': step.argv, 'stdin': step.stdin,
                       'cwd': step.cwd, 'environment': env, 'output': output})
        begun = clock()
        try:
            process = popen(step.argv, stdin=stdin, stdout=stdout, stderr=stderr, env=env, cwd=step.cwd,
                            start_new_session=True, close_fds=True)
            code = wait(process, step, journal, stop, begun, clock, sleep)
        except OSError as error:
            # Nothing ran: the command could not be started at all.
            stderr.write(('the step could not be started: %s\n' % type(error).__name__).encode(UTF8))
            code = 127
    journal.write({'event': 'finished', 'step': step.name, 'exit': code, 'seconds': round(clock() - begun, 3),
                   'stdout_sha256': file_hash(out), 'stderr_sha256': file_hash(err), 'output': output})
    if code != 0:
        text = err.read_text(encoding=UTF8, errors='replace').strip().splitlines()
        say('FAILED  %s exit=%d\n%s' % (step.name, code, '\n'.join('    ' + line[:300] for line in text[-3:])))
    return code


class Window:
    """One invocation of run: the plan, the journal and the tools, and what to do with each step."""

    def __init__(self, plan, journal, checkpoint, stop, tools):
        self.plan, self.journal, self.checkpoint, self.stop, self.tools = plan, journal, checkpoint, stop, tools

    def source(self):
        try:
            self.tools.get('check_source', check_source)(self.plan, environment(self.plan))
        except Refused as error:
            # No step ran. The operator corrects the source and runs the same command again.
            self.journal.write({'event': 'source-refused', 'reason': str(error)})
            raise

    def hand_over(self):
        """Phase 3. Without a checkpoint the run waits here; with one, the tooling must accept it."""
        if not self.checkpoint:
            self.journal.write({'event': 'hand-over'})
            say('HAND-OVER. Ingress is closed. Make the fresh checkpoint now, then run again with --checkpoint DIR.\n'
                'To give the window up instead: status, then recover with abandon-caddy-offline.')
            return 4
        try:
            accepted = self.tools.get('check_checkpoint', check_checkpoint)(self.plan, self.checkpoint)
        except Refused as error:
            self.journal.write({'event': 'checkpoint-refused', 'checkpoint_dir': self.checkpoint, 'reason': str(error)})
            raise
        self.journal.write({'event': ACCEPTED, 'checkpoint_dir': self.checkpoint, 'header_sha256': accepted})
        return 0

    def take(self, step):
        """Run one step. Returns its exit status; anything but 0 ends this invocation."""
        if self.stop.asked:
            self.journal.write({'event': 'stopped', 'signal': self.stop.asked, 'before': step.name})
            say('stopped by %s before %s' % (self.stop.asked, step.name))
            return 5
        say('phase %d  %s: %s' % (step.phase, step.name, step.title))
        if step.argv is None:
            return self.hand_over()
        if step.needs_checkpoint and not self.checkpoint:
            raise Refused('%s needs the accepted checkpoint: give --checkpoint DIR' % step.name)
        if step.changes:
            self.source()
        env = environment(self.plan, self.checkpoint if step.name == UPDATE else None)
        code = execute(step, self.journal, env, self.stop, **self.tools.get('process', {}))
        if code == 0 and step.name == REQUEST:
            output = self.journal.path / (step.name + STDOUT)
            write_private(self.journal.path / 'reconcile-request.json', output.read_bytes())
        return 3 if code else 0


def first_phase(records, asked):
    """The phase a journal starts at is fixed when it is opened. A later run cannot reach back before it."""
    opened = records[0].get('first', 0)
    if asked is not None and asked != opened:
        raise Refused('this journal was opened to start at phase %d; --first cannot change that later' % opened)
    return opened


def resume_point(journal, plan_path, first, checkpoint):
    """Where a run goes on: the first phase the journal keeps, the steps it passed, and the checkpoint it uses."""
    records = journal.open(plan_path, first)
    passed, ended = progress(records)
    if ended:
        raise Refused('this journal ended at %s (%s); run status, and start a new attempt in a new journal' % (ended[1], ended[0]))
    recorded = accepted_checkpoint(records)
    if recorded and checkpoint and checkpoint != recorded:
        raise Refused('this journal already accepted another checkpoint folder')
    return first_phase(records, first), passed, checkpoint or recorded


def run(plan_path, journal_path, first=None, last=5, checkpoint=None, stop=None, tools=None):
    tools = tools or {}
    plan = load_plan(plan_path, tools.get('declared'))
    if checkpoint is not None and not absolute(checkpoint):
        raise Refused(LOCATION_FAULT % 'the checkpoint folder')
    journal = Journal(journal_path)
    first, passed, checkpoint = resume_point(journal, plan_path, first, checkpoint)
    window = Window(plan, journal, checkpoint, stop or Stop(), tools)
    window.source()
    for step in steps(plan, journal.path, window.checkpoint):
        if step.name in passed or not first <= step.phase <= last:
            continue
        code = window.take(step)
        if code:
            if code == 3:
                say('Nothing else was run. Next: window_driver.py status PLAN JOURNAL')
            return code
    journal.write({'event': 'phases-passed', 'first': first, 'last': last})
    say('phases %d to %d passed' % (first, last))
    return 0


# Status and recovery ------------------------------------------------------------------------------------------------

def markers(plan):
    """What the tooling's own records say, read with the tooling's own rule for a resolved transition."""
    sys.path.insert(0, str(Path(plan['source']['dir']) / 'scripts' / TOOLING))
    from legacy_control_resolution import unresolved_pending
    root = Path(plan['deploy_dir'])
    state = json.loads((root / '.caddy-state' / 'state.json').read_bytes())
    pending = unresolved_pending(root, state)
    window = root / '.legacy-recovery' / ('window-%s' % pending['token']) if pending else None
    return {'pending': pending is not None, 'token': pending['token'] if pending else None,
            'armed': bool(window and (window / 'armed.json').is_file()),
            'forward_write': bool(window and (window / 'forward-write-issued.json').is_file()),
            'proxy_running': proxy_running(plan)}


def proxy_running(plan, run=subprocess.run):
    """Whether the serving proxy runs: True, False, or None when Docker does not say."""
    try:
        done = run(['docker', 'inspect', '--format', '{{.State.Running}}', plan['instance'] + '-caddy'], stdin=subprocess.DEVNULL,
                   capture_output=True, env=environment(plan), timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return {'true': True, 'false': False}.get(done.stdout.decode(UTF8, 'replace').strip()) if done.returncode == 0 else None


ADVICE = {
    'forward': (None, 'The update wrote forward: migrations may have run. No tooling action undoes that yet. '
                      'Follow the checkpoint restore runbook; ingress stays closed until it is done.'),
    'half': (None, 'recover-legacy passed and its reconciliation did not. Review the reconciliation refusal; '
                   'the legacy service is back, and a second attempt cannot start until reconciliation passes.'),
    'armed': (RECOVER, 'The update stopped before its forward write. recover-legacy brings the legacy service back '
                                'from the armed baseline, then reconciliation makes a second attempt possible.'),
    'unarmed': (RETURN, 'The update began its transition and stopped before a recovery baseline was armed. '
                                         'return-unarmed-update proves the transition was never used and returns it, then '
                                         'abandon-caddy-offline starts the same proxy again and proves the legacy service.'),
    'started': (None, 'A transition is pending with no recovery baseline, and the proxy is running or its state is unknown: '
                      'recover-caddy-proxy may have been used. Returning the transition after that is an unrehearsed order. '
                      'Stop here and review.'),
    'done': (None, 'The update passed. Nothing is to be recovered.'),
    'recovered': (None, 'A recovery ran in this journal. A second attempt needs a new journal, a plan with new Caddy '
                        'volume names, and --first 2.'),
    'closed': (ABANDON, 'The serving proxy was stopped and no update is pending. abandon-caddy-offline verifies '
                                        'that proxy, starts it again and proves the legacy service. It refuses if the proxy '
                                        'never stopped.'),
    'open': (None, 'No step that stops the service has run. Nothing is to be recovered.'),
}


def pending_situation(passed, found):
    """Where an update that is still pending stands."""
    if found['forward_write']:
        return 'forward'
    if RECOVER in passed:
        return 'half'
    if found['armed']:
        return 'armed'
    # Only a proxy that is known to be stopped is in the rehearsed order.
    return 'unarmed' if found['proxy_running'] is False else 'started'


def situation(passed, ended, found):
    """Where the window stands. A pure function of the journal and the tooling's markers."""
    if found['pending']:
        return pending_situation(passed, found)
    if UPDATE in passed:
        return 'done'
    if ended and ended[0] == 'recovered':
        return 'recovered'
    stopped = PREPARE in passed or (ended and ended[1] in (PREPARE, UPDATE))
    return 'closed' if stopped else 'open'


def status(plan_path, journal_path, tools=None):
    tools = tools or {}
    plan = load_plan(plan_path, tools.get('declared'))
    passed, ended = progress(Journal(journal_path).records(plan_path))
    found = tools.get('markers', markers)(plan)
    where = situation(passed, ended, found)
    return {'passed': passed, 'ended': list(ended) if ended else None, 'markers': found, 'situation': where,
            'recovery_action': ADVICE[where][0], 'reason': ADVICE[where][1]}


def recover(plan_path, journal_path, action, stop=None, tools=None):
    """Run the named recovery action, only if it is the one that fits."""
    tools = tools or {}
    report = status(plan_path, journal_path, tools)
    if action not in RECOVERIES or action != report['recovery_action']:
        raise Refused('%s is not the action that fits; status names: %s' % (action, report['recovery_action']))
    plan, journal = load_plan(plan_path, tools.get('declared')), Journal(journal_path)
    env, verify = environment(plan), tools.get('check_source', check_source)
    verify(plan, env)
    if action == RECOVER:
        armed = Path(plan['deploy_dir']) / '.legacy-recovery' / ('window-%s' % report['markers']['token']) / 'armed.json'
        request = json.loads(armed.read_bytes())['request']
        write_private(journal.path / 'armed-request.json', json.dumps(request).encode(UTF8))
        write_private(journal.path / 'reconcile-after-recovery.json',
                      json.dumps({**request, 'manual_evidence_dir': None}).encode(UTF8))
    if action == RETURN:
        request = {'deploy_dir': plan['deploy_dir'], 'instance': plan['instance'], 'data_volume': plan['caddy_volumes']['data'],
                   'config_volume': plan['caddy_volumes']['config']}
        write_private(journal.path / 'return-request.json', json.dumps(request).encode(UTF8))
    journal.write({'event': 'recovery', 'action': action})
    stop = stop or Stop()
    for step in recovery_steps(plan, journal.path, action):
        try:
            # Every recovery step changes the host, and the step before it ran from this source.
            verify(plan, env)
        except Refused as error:
            journal.write({'event': 'source-refused', 'before': step.name, 'reason': str(error)})
            raise
        say('recovery  %s: %s' % (step.name, step.title))
        if execute(step, journal, env, stop, **tools.get('process', {})) != 0:
            return 3
    journal.write({'event': 'recovered', 'step': action})
    say('recovered with %s. A second attempt needs a new journal and a plan with new Caddy volume names.' % action)
    return 0


# The runbook --------------------------------------------------------------------------------------------------------

def step_lines(step):
    lines = ['- `%s`: %s. %s' % (step.name, step.title, 'Changes the host.' if step.changes else 'Read-only.'), '',
             '      ' + ' '.join(shlex.quote(word) for word in step.argv)
             + (' < ' + shlex.quote(step.stdin) if step.stdin else ' < /dev/null')]
    if step.cwd:
        lines += ['      (in %s)' % step.cwd]
    return lines + ['']


PHASE_NOTES = {
    0: ['- `source`: the pinned source is the planned commit and tree and holds no other file. '
        'Checked again before every step that changes the host.'],
    3: ['- The driver stops here with exit status 4. Ingress is closed.',
        '- The operator makes the fresh checkpoint: capture, off-host copy, read-back, restore proof.',
        '- `run` again with `--checkpoint DIR`. The tooling must accept the folder before phase 4 starts.',
        '- To give the window up here: `recover` with `%s`.' % ABANDON],
}
FAILURE_NOTES = [
    '## If a step fails', '', 'The driver stops. It runs nothing else and recovers nothing by itself.',
    '`status` reads the journal and the tooling\'s records and names the one action that fits:', '',
    '| Where it stopped | Action |', '|---|---|',
    '| Before phase 2 | none: nothing that serves was stopped |',
    '| After phase 2, and no update is pending | `%s` |' % ABANDON,
    '| In phase 4, before the forward write | `%s`, then reconciliation |' % RECOVER,
    '| In phase 4, after the forward write | none yet: the checkpoint restore runbook |',
    '| In phase 4, before a recovery baseline was armed, proxy still stopped | `%s`, then `%s` |' % (RETURN, ABANDON),
    '| The same, but the proxy is running or its state is unknown | none: an unrehearsed order, review first |', '',
    '`recover PLAN JOURNAL ACTION` runs that action only when ACTION is the one `status` names.',
    'A second attempt needs a new journal, a plan with new Caddy volume names, and `--first 2`.']


def runbook(plan):
    """The window as text. It is built from the same step list that run executes."""
    env = environment(plan)
    lines = ['# Legacy upgrade window', '',
             'Pinned source: commit `%s`, tree `%s`.' % (plan['source']['commit'], plan['source']['tree']),
             'Upgrade: %s to %s on `%s`.' % (plan['versions']['legacy'], plan['versions']['upgraded'], plan['hostname']), '',
             '## Environment of every step', '', 'Nothing else is set. Only HOME is inherited.', '']
    lines += ['    %s=%s' % (name, shlex.quote(value)) for name, value in sorted(env.items()) if name != 'HOME']
    lines += ['', '`%s` alone also gets `DOLLHOUSE_HOSTED_LEGACY_CHECKPOINT`: the accepted checkpoint folder.' % UPDATE]
    listed = steps(plan, '<journal>')
    for phase, title in enumerate(PHASES):
        lines += ['', '## Phase %d: %s' % (phase, title), ''] + PHASE_NOTES.get(phase, [])
        for step in listed:
            if step.phase == phase and step.argv:
                lines += step_lines(step)
    lines += FAILURE_NOTES
    replica = plan['replica'] or {}
    if replica:
        lines += ['', '## Rehearsal differences', '', '- Reconciliation runs through the replica pin launcher, in `%s`.' % replica['pins_dir']]
    if replica.get('path_prefix'):
        lines += ['- `%s` is searched for commands first.' % replica['path_prefix']]
    return '\n'.join(lines) + '\n'


def parsed(argv):
    parser = argparse.ArgumentParser(prog='window_driver.py')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('plan', 'run', 'status', 'recover'):
        command = commands.add_parser(name)
        command.add_argument('plan')
        if name != 'plan':
            command.add_argument('journal')
        if name == 'run':
            command.add_argument('--first', type=int, choices=range(6))
            command.add_argument('--last', type=int, choices=range(6), default=5)
            command.add_argument('--checkpoint')
        if name == 'recover':
            command.add_argument('action', choices=RECOVERIES)
    return parser.parse_args(argv[1:])


def main(argv):
    arguments = parsed(argv)
    try:
        if not LOCATION.fullmatch(arguments.plan):
            raise Refused(LOCATION_FAULT % 'PLAN')
        if arguments.command != 'plan' and not LOCATION.fullmatch(arguments.journal):
            raise Refused(LOCATION_FAULT % 'JOURNAL')
        if arguments.command == 'plan':
            sys.stdout.write(runbook(load_plan(arguments.plan)))
            return 0
        if arguments.command == 'status':
            print(json.dumps(status(arguments.plan, arguments.journal), indent=1, sort_keys=True))
            return 0
        stop = Stop()
        stop.install()
        if arguments.command == 'run':
            return run(arguments.plan, arguments.journal, arguments.first, arguments.last, arguments.checkpoint, stop)
        return recover(arguments.plan, arguments.journal, arguments.action, stop)
    except Refused as error:
        say('refused: %s' % error)
        return 3


if __name__ == '__main__':
    sys.exit(main(sys.argv))
