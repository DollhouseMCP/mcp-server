"""Rootful, disposable CI witness for the adapt control on one real Caddy binary.

A legacy reconciliation stopped because Caddy 2.8.4 opens a file named "-"
where later releases read standard input. This runs the deployment's own
ActiveConfig.adapt against a real running container, requires the result to
equal the configuration that container serves, and records how the same binary
treats the former "-" form. It is not an operation receipt.
"""
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'hosted-deploy'))
from caddy_active_config import ADAPT_INPUT, DOCKER, LIMIT, ActiveConfig, bounded_input, system_docker, validate_system
from caddy_control_failure import ControlFailure

MISSING_DASH_FILE = 'reading input file: open -: no such file or directory'
# file_server hides its own configuration file, so its adapted form names the input path.
PATH_DEPENDENT = b':8080 {\n\tfile_server\n}\n'


def dash_form(identifier, caddyfile):
    """Control observation with the former argv: it tells the two Caddy generations apart."""
    try:
        bounded_input([DOCKER, 'exec', '--interactive', identifier, '/usr/bin/caddy',
                       'adapt', '--config', '-', '--adapter', 'caddyfile'], caddyfile)
    except ControlFailure as error:
        diagnostic = error.diagnostic
        if (diagnostic['outcome'] != 'REFUSED' or diagnostic['exit_code'] != 1
                or MISSING_DASH_FILE not in diagnostic['stderr']):
            raise
        return 'refused'
    return 'accepted'


def path_dependent_refused(session):
    try:
        session.adapt(PATH_DEPENDENT)
    except ControlFailure:
        raise
    except ValueError as error:
        if 'depends on its input path' not in str(error):
            raise
        return True
    raise ValueError('path-dependent fixture was adapted without refusal')


def witness(identifier, caddyfile):
    session = ActiveConfig(identifier, system_docker)
    try:
        adapted = session.adapt(caddyfile)
        if session.read() != adapted:
            raise ValueError('adapted fixture differs from the serving configuration')
        result = {'container': identifier, 'boot': session.identity, 'input': ADAPT_INPUT,
                  'caddyfile_sha256': hashlib.sha256(caddyfile).hexdigest(),
                  'adapted_sha256': hashlib.sha256(adapted).hexdigest(), 'serving_configuration_matches': True,
                  'dash_form': dash_form(identifier, caddyfile),
                  'path_dependent_refused': path_dependent_refused(session)}
        session.recheck()
        return result
    finally:
        session.close()


def main():
    (identifier,) = sys.argv[1:]
    # The public fixture Caddyfile arrives on standard input; no path is taken from the caller.
    caddyfile = sys.stdin.buffer.read(LIMIT + 1)
    if not caddyfile or len(caddyfile) > LIMIT:
        raise ValueError('fixture Caddyfile is missing or exceeds its limit')
    validate_system()
    print(json.dumps(witness(identifier, caddyfile)))


if __name__ == '__main__':
    main()
