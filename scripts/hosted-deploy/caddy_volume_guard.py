"""Fail-closed local-daemon and volume writer observations for Caddy migration."""
import os
from pathlib import Path


def exact_capabilities(host, expected):
    """Accept only exact capabilities, including Docker's observed CAP_ spelling."""
    added = host.get('CapAdd')
    if not isinstance(added, list) or host.get('CapDrop') != ['ALL']:
        return False
    aliases = {spelling: name for name in expected for spelling in (name, 'CAP_' + name)}
    if any(not isinstance(value, str) or value not in aliases for value in added):
        return False
    canonical = [aliases[value] for value in added]
    return len(canonical) == len(expected) and set(canonical) == expected


def require_local_endpoint(endpoint, docker_host=None):
    """Only local Unix sockets support host mountpoint checks."""
    for value in (endpoint, docker_host):
        if value and (not isinstance(value, str) or not value.startswith('unix:///')):
            raise ValueError('Caddy migration requires a local Unix Docker daemon')
    if not endpoint:
        raise ValueError('Docker endpoint is unavailable')


def volume_identity(volume, expected_name):
    if not isinstance(volume, dict) or volume.get('Name') != expected_name:
        raise ValueError('Docker volume identity mismatch')
    if volume.get('Driver') != 'local' or volume.get('Scope') != 'local':
        raise ValueError('unsupported Docker volume driver')
    mountpoint, created = volume.get('Mountpoint'), volume.get('CreatedAt')
    if not isinstance(mountpoint, str) or not os.path.isabs(mountpoint) or not isinstance(created, str) or not created:
        raise ValueError('Docker volume metadata is incomplete')
    path = Path(mountpoint)
    if path.resolve(strict=True) != path:
        raise ValueError('Docker volume mountpoint is not canonical')
    st = path.stat()
    if not path.is_dir():
        raise ValueError('Docker volume mountpoint is not a directory')
    return {'name': expected_name, 'driver': 'local', 'created_at': created,
            'mountpoint': mountpoint, 'device': st.st_dev, 'inode': st.st_ino}


def overlapping(left, right):
    common = os.path.commonpath((left, right))
    return common == left or common == right


def check_writer_mount(mount, names, roots):
    if not isinstance(mount, dict) or not isinstance(mount.get('RW'), bool):
        raise ValueError('container mount is incomplete')
    if not mount['RW']:
        return
    kind = mount.get('Type')
    if kind not in ('bind', 'volume', 'tmpfs'):
        raise ValueError('unsupported running mount type')
    if kind == 'volume':
        if not isinstance(mount.get('Name'), str) or not mount['Name']:
            raise ValueError('volume mount name is unavailable')
        if mount['Name'] in names:
            raise ValueError('a running container can write a Caddy volume')
    if kind == 'bind':
        check_bind_writer(mount, roots)


def check_bind_writer(mount, roots):
    source = mount.get('Source')
    if not isinstance(source, str) or not os.path.isabs(source):
        raise ValueError('bind source is unavailable')
    resolved = os.path.realpath(source)
    if not os.path.exists(resolved):
        raise ValueError('bind source cannot be checked on this host')
    if any(overlapping(resolved, root) for root in roots):
        raise ValueError('a running bind can write a Caddy volume')


def refuse_writers(containers, volumes):
    """Reject running volume or overlapping bind writers, never read their env."""
    if not isinstance(containers, list):
        raise ValueError('container inventory is incomplete')
    names = {volume['name'] for volume in volumes}
    roots = [volume['mountpoint'] for volume in volumes]
    for container in containers:
        if not isinstance(container, dict) or not isinstance(container.get('Mounts'), list):
            raise ValueError('container mount inventory is incomplete')
        state = container.get('State')
        if not isinstance(state, dict) or not isinstance(state.get('Running'), bool):
            raise ValueError('container state is incomplete')
        if state['Running']:
            for mount in container['Mounts']:
                check_writer_mount(mount, names, roots)


def validate_volume_pair(volumes):
    if not isinstance(volumes, list) or len(volumes) != 4:
        raise ValueError('two source and two destination volumes are required')
    names = [volume['name'] for volume in volumes]
    identities = [(volume['device'], volume['inode']) for volume in volumes]
    if len(set(names)) != 4 or len(set(identities)) != 4:
        raise ValueError('source and destination volumes must be distinct')
    roots = [volume['mountpoint'] for volume in volumes]
    for index, root in enumerate(roots):
        if any(overlapping(root, other) for other in roots[index + 1:]):
            raise ValueError('volume mountpoints overlap')
