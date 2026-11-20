"""Generate a manual reconciliation request from independently bound receipts.

No operator-supplied token selects a transition or proves proxy ownership.
This is read-only; reconciliation rechecks the same bindings under its lock.
"""
from pathlib import Path

from caddy_release_action import pending_control
from caddy_transition_state import read_state
from caddy_volume_migration import inspect_one
import legacy_handoff as handoff
import legacy_manual_recovery_import as manual
from legacy_control_resolution import raw_state
from legacy_recovery_boundary import TOKEN

LABEL = 'org.dollhousemcp.proxy-recovery-token'


def identities(root, pending, proxy):
    token = proxy.get('Config', {}).get('Labels', {}).get(LABEL)
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ValueError('accepted serving proxy has no valid recovery ownership token')
    return {'transition': {'token': pending['token'], 'state_sha256': handoff.digest(raw_state(root))},
            'recovery_receipt': {'directory': pending['receipt'], 'sha256': pending['receipt_sha256']},
            'serving_proxy': {'id': proxy['Id'], 'recovery_token': token}}


def generate(root, instance, checkpoint_dir, evidence_dir, run):
    state = read_state(root)
    pending = state.get('pending')
    if not isinstance(pending, dict):
        raise ValueError('request generation requires a retained staged transition')
    state, pending, control = pending_control(root, pending['token'], 'probed')
    final, _, _, _ = manual.archive_inputs(root, evidence_dir, pending)
    recovered = manual.check_acceptance(final, control['public_origin'])
    value = {'deploy_dir': str(root), 'instance': instance, 'checkpoint_dir': checkpoint_dir,
             'data_volume': pending['volumes'][0], 'config_volume': pending['volumes'][1],
             'token': pending['token'], 'app_id': recovered['app'], 'postgres_id': recovered['postgres']}
    manual.validate_failed_state(root, value, state, pending)
    _, checkpoint_sha, _ = handoff.checkpoint(checkpoint_dir)
    if checkpoint_sha != manual.ACCEPTED['checkpoint']:
        raise ValueError('request checkpoint differs from the accepted manual recovery')
    proxy = inspect_one(run, 'container', recovered['restored_old_profile_proxy'])
    if proxy['Id'] != recovered['restored_old_profile_proxy']:
        raise ValueError('accepted serving proxy identity differs')
    manual.verify_boot(final, proxy, True)
    return {**value, 'manual_evidence_dir': str(Path(evidence_dir)),
            'receipt_identities': identities(root, pending, proxy)}
