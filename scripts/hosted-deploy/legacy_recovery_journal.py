"""Exclusive, fsynced recovery intents and acknowledgements; never forward state."""
import os
import re
import secrets

from caddy_recovery_receipt import private_directory, write_exclusive
import legacy_handoff as handoff
from legacy_recovery_boundary import window_path

RECORD_SUFFIX = '.json'


class Journal:
    def __init__(self, root, token, armed_sha, create=False):
        self.window = window_path(root, token)
        owner = private_directory(self.window)
        try:
            if create:
                operation = secrets.token_hex(16)
                os.mkdir('recover-' + operation, 0o700, dir_fd=owner)
                os.fsync(owner)
                issued = {'schema': 'legacy-recovery-issued-v1', 'operation': operation,
                          'armed_sha256': armed_sha, 'host': handoff.host_identity()}
                write_exclusive(owner, 'recovery-issued.json', handoff.encoded(issued))
                os.fsync(owner)
            issued, self.issued_sha = handoff.read_json(owner, 'recovery-issued.json')
            if (set(issued) != {'schema', 'operation', 'armed_sha256', 'host'}
                    or issued['schema'] != 'legacy-recovery-issued-v1'
                    or issued['armed_sha256'] != armed_sha or issued['host'] != handoff.host_identity()
                    or not isinstance(issued['operation'], str) or not re.fullmatch(r'[0-9a-f]{32}', issued['operation'])):
                raise ValueError('legacy recovery journal binding differs')
            self.operation = issued['operation']
            self.path = self.window / ('recover-' + self.operation)
            self.directory = private_directory(self.path)
        finally:
            os.close(owner)

    def close(self):
        os.close(self.directory)

    def write(self, name, value):
        write_exclusive(self.directory, name + RECORD_SUFFIX, handoff.encoded(
            {'issued_sha256': self.issued_sha, 'value': value}))
        os.fsync(self.directory)

    def read(self, name):
        record, _ = handoff.read_json(self.directory, name + RECORD_SUFFIX)
        if set(record) != {'issued_sha256', 'value'} or record['issued_sha256'] != self.issued_sha:
            raise ValueError('legacy recovery acknowledgement binding differs')
        return record['value']

    def absent(self, name):
        try:
            os.stat(name + RECORD_SUFFIX, dir_fd=self.directory, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise ValueError('recovery action was already issued; no retry or inferred completion')
