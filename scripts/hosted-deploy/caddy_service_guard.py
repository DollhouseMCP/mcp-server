"""Require unambiguous Compose proxy ownership before Caddy operations."""
import re

from caddy_volume_migration import inspect_one

ID = re.compile(r'[0-9a-f]{64}\Z')
INSTANCE = re.compile(r'[a-z0-9][a-z0-9_-]{0,62}\Z')


def unique_proxy(run, instance, required=True):
    if not isinstance(instance, str) or not INSTANCE.fullmatch(instance):
        raise ValueError('invalid Compose instance')
    raw = run(['docker', 'ps', '--all', '--no-trunc', '--filter',
               'label=com.docker.compose.project=' + instance, '--filter',
               'label=com.docker.compose.service=caddy', '--format', '{{.ID}}'], 15, 1024 * 1024)
    identifiers = raw.decode('ascii').splitlines()
    if len(identifiers) > 1 or len(set(identifiers)) != len(identifiers) or any(not ID.fullmatch(item) for item in identifiers):
        raise ValueError('Caddy Compose service identity is ambiguous')
    if not identifiers:
        if required:
            raise ValueError('Caddy Compose service is missing')
        return None
    container = inspect_one(run, 'container', identifiers[0])
    config = container.get('Config')
    if container.get('Id') != identifiers[0] or container.get('Name') != '/' + instance + '-caddy' or not isinstance(config, dict):
        raise ValueError('Caddy Compose service identity differs from the expected container')
    labels = config.get('Labels')
    if not isinstance(labels, dict) or labels.get('com.docker.compose.project') != instance or labels.get('com.docker.compose.service') != 'caddy':
        raise ValueError('Caddy Compose labels differ from the selected instance')
    return identifiers[0]
