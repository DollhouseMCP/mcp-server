"""Synthetic pre-journal recovery with deliberately distinct receipt identities."""
import copy
import io
import os
import tarfile
from unittest.mock import patch

import legacy_handoff as handoff
import legacy_manual_recovery_import as manual
import legacy_recovery_boundary as boundary
from legacy_recovery_profile import profile_hash


def encoded(value):
    return handoff.encoded(value)


def private(path, raw):
    path.write_bytes(raw)
    path.chmod(0o600)


def archive(root, files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as target:
        paths = {name: name for name in files} | manual.OVERLAYS
        for name, relative in paths.items():
            raw, mode = files.get(name, (b'fixture-overlay', 0o600))
            item = tarfile.TarInfo(str(root.relative_to('/')) + '/' + relative)
            item.uid, item.gid, item.mode, item.size = os.geteuid(), os.getegid(), mode, len(raw)
            target.addfile(item, io.BytesIO(raw))
    return output.getvalue()


def final_receipt(fx, origin):
    objects = [fx.app, fx.pg, fx.current, fx.p.recovered]
    markers = {'.legacy-handoff/' + path.name: handoff.digest(path.read_bytes())
               for path in (fx.root / '.legacy-handoff').glob('*.json')}
    return {'status': 'RECOVERED LEGACY; FORWARD ABORTED', 'no_app_restart_in_this_continuation': True,
            'recovered': {'version': '2.1.0-beta.2', 'markers_preserved': True, 'app': fx.app['Id'],
                          'postgres': fx.pg['Id'], 'retained_aborted_proxy': fx.current['Id'],
                          'restored_old_profile_proxy': fx.p.recovered['Id']},
            'public_acceptance': [{'path': origin + path, 'status': code, 'body_version': version,
                                   'verification_marker_absent': True}
                                  for path, code, version in (('/healthz', '200', '2.1.0-beta.2'),
                                                             ('/readyz', '200', '2.1.0-beta.2'),
                                                             ('/mcp', '401', None))],
            'markers_unchanged': markers,
            'containers': [{'id': item['Id'], 'name': item['Name'], 'image': item['Image'],
                            'running': item['State']['Running'], 'started_at': item['State']['StartedAt'],
                            'restart_count': item['RestartCount']} for item in objects]}


class ManualPacket:
    def __init__(self, owner):
        self.owner, self.fx = owner, owner.fx
        fx = self.fx
        armed = boundary.window_path(fx.root, fx.value['token'])
        files = {name: (raw.read_bytes(), fx.armed['files'][name]['mode'])
                 for name in boundary.FILES if fx.armed['files'][name] is not None
                 for raw in [armed / name]}
        originals = copy.deepcopy([fx.app, fx.pg, fx.p.fx.fx.fake.proxy])
        owner.known_stop_recovery()
        # Preserve the fixture journal outside its production namespace: this
        # packet represents the older manual recovery which had no armed journal.
        armed.rename(fx.root / 'fixture-prior-automated-journal')
        fx.state['pending']['token'] = '0' * 32
        fx.state['pending']['admission'] = copy.deepcopy(fx.p.fx.admission)
        self.value = {**fx.value, 'token': fx.state['pending']['token']}
        self.raw_state = encoded(fx.state)
        private(owner.state_dir / 'state.json', self.raw_state)
        fx.state_patch.stop()  # Real state parser/pending_control must be exercised.
        self.evidence = fx.root / 'manual-evidence'
        self.evidence.mkdir(mode=0o700)
        archive_raw = archive(fx.root, files)
        inspect_raw = encoded(originals)
        final_raw = encoded(final_receipt(fx, fx.control['public_origin']))
        manifest_raw = encoded({'schema': 1, 'kind': 'legacy-window-filesystem-recovery',
                                'prepared_receipt': str(fx.p.fx.receipt / 'receipt.json'),
                                'prepared_receipt_sha256': fx.b.pending['receipt_sha256'],
                                'app': {'id': fx.app['Id']}, 'database_container': {'id': fx.pg['Id']},
                                'original_proxy_id': originals[2]['Id'],
                                'artifacts': {'filesystem.tar': {'bytes': len(archive_raw),
                                                                'sha256': handoff.digest(archive_raw)},
                                              'recovery.inspect.json': {'sha256': handoff.digest(inspect_raw)}}})
        records = {'filesystem.tar': archive_raw, 'recovery.inspect.json': inspect_raw,
                   'manifest.json': manifest_raw, 'FINAL-RECOVERY-RECEIPT.json': final_raw}
        for name, raw in records.items():
            private(self.evidence / name, raw)
        _, checkpoint_sha, _ = handoff.checkpoint(fx.value['checkpoint_dir'])
        accepted = {'state': handoff.digest(self.raw_state), 'checkpoint': checkpoint_sha,
                    'manual_receipt': handoff.digest(final_raw), 'filesystem_manifest': handoff.digest(manifest_raw),
                    'filesystem_archive': handoff.digest(archive_raw), 'original_inspect': handoff.digest(inspect_raw),
                    'retained_proxy_profile': profile_hash(fx.current),
                    'schema': handoff.digest(boundary.normalized_dump(fx.b.schema)),
                    'globals': handoff.digest(boundary.normalized_dump(fx.b.globals))}
        binding = patch.dict(manual.ACCEPTED, accepted)
        binding.start()
        owner.addCleanup(binding.stop)

    def generate(self):
        from legacy_reconciliation_request import generate
        return generate(self.fx.root, self.value['instance'], self.value['checkpoint_dir'],
                        str(self.evidence), self.owner.run_docker)
