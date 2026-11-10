"""Private operator diagnostics for a failed control, never a retry receipt."""
import json


class ControlFailure(ValueError):
    """Keep child status separate from an unproven control outcome."""

    def __init__(self, *, exit_code, stderr, elapsed, timeout, reason, context=None):
        self.diagnostic = {
            'event': 'caddy-control-refusal', 'exit_code': exit_code,
            'stderr': stderr.decode('utf-8', errors='replace'),
            'elapsed_seconds': round(elapsed, 6), 'timeout_seconds': timeout,
            'reason': reason, 'context': context or {}, 'cleanup_confirmed': None,
            'outcome': 'REFUSED' if reason is None and type(exit_code) is int and exit_code > 0 else 'UNKNOWN',
        }
        operation = self.diagnostic['context'].get('operation')
        # Curl 22 proves an HTTP refusal. A timeout/transfer failure does not
        # prove a response, and a failed POST may still have taken effect.
        if operation == 'POST /load' or (operation == 'GET /config/' and exit_code != 22):
            self.diagnostic['outcome'] = 'UNKNOWN'
        super().__init__('private Caddy control refused')

    def unknown(self):
        self.diagnostic['outcome'] = 'UNKNOWN'

    def __str__(self):
        if any('UNKNOWN' in note for note in getattr(self, '__notes__', ())):
            self.unknown()
        return 'bounded private Caddy control: ' + json.dumps(self.diagnostic, sort_keys=True)
