"""Require unambiguous Compose proxy ownership before Caddy operations."""
import re
from pathlib import Path

from caddy_volume_migration import inspect_one

ID = re.compile(r'[0-9a-f]{64}\Z')
INSTANCE = re.compile(r'[a-z0-9][a-z0-9_-]{0,62}\Z')


def proxy_startup_path(root, instance, identifier, run, require_root_copy=True):
    # Lazy import avoids a cycle through legacy checkpoint/release observers.
    from caddy_retired_proxy import startup_path
    return startup_path(Path(root), instance, identifier, run, require_root_copy)


def unique_proxy(run, instance, required=True, root=None):
    if not isinstance(instance, str) or not INSTANCE.fullmatch(instance):
        raise ValueError('invalid Compose instance')
    raw = run(['docker', 'ps', '--all', '--no-trunc', '--filter',
               'label=com.docker.compose.project=' + instance, '--filter',
               'label=com.docker.compose.service=caddy', '--format', '{{.ID}}'], 15, 1024 * 1024)
    identifiers = raw.decode('ascii').splitlines()
    if len(set(identifiers)) != len(identifiers) or any(not ID.fullmatch(item) for item in identifiers):
        raise ValueError('Caddy Compose service identity is ambiguous')
    if root is not None:
        from caddy_retired_proxy import inventory
        retired = inventory(Path(root), instance, run)
        identifiers = [identifier for identifier in identifiers if identifier not in retired]
    if len(identifiers) > 1:
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
