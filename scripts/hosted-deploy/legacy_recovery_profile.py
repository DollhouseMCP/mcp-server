"""Full recovery identities; canonical ordering never drops a mount field."""
import hashlib
import itertools
import json

# A Docker daemon restart rewrites these three HostConfig lists, when empty, from null to []. A container
# that the daemon has reloaded is still the same container. Nothing else in a profile may differ.
RELOADED_EMPTY = ('Dns', 'DnsOptions', 'DnsSearch')


def canonical_mounts(mounts):
    if not isinstance(mounts, list) or any(not isinstance(item, dict) for item in mounts):
        raise ValueError('recovery mount inventory is unavailable')
    destinations = []
    for item in mounts:
        if (not isinstance(item.get('Destination'), str) or not item['Destination'].startswith('/')
                or item.get('Type') not in ('bind', 'volume', 'tmpfs')):
            raise ValueError('recovery mount identity is incomplete')
        destinations.append(item['Destination'])
    if len(destinations) != len(set(destinations)):
        raise ValueError('duplicate recovery mount destination')
    return sorted(mounts, key=lambda item: (item['Destination'], item['Type'],
                                           item.get('Source') or item.get('Name') or ''))


def profile(container):
    fields = ('Id', 'Image', 'Config', 'HostConfig', 'Mounts')
    if any(key not in container for key in fields):
        raise ValueError('recovery container profile is incomplete')
    result = {key: container[key] for key in fields}
    result['Mounts'] = canonical_mounts(result['Mounts'])
    return result


def comparable(value):
    """A full profile with its reloaded-empty lists in one form. For comparison only; never recorded."""
    host = value.get('HostConfig') if isinstance(value, dict) else None
    if not isinstance(host, dict):
        return value
    return {**value, 'HostConfig': {key: [] if key in RELOADED_EMPTY and item is None else item
                                    for key, item in host.items()}}


def same_profile(left, right):
    """Equal in every field, where null and [] are the same for the three lists a daemon restart rewrites."""
    return comparable(left) == comparable(right)


def profile_hashes(container):
    """The hash of the full profile in every form its reloaded-empty lists can take, for a hash recorded earlier."""
    full = profile(container)
    host = full['HostConfig']
    empty = [key for key in RELOADED_EMPTY if isinstance(host, dict) and key in host and host[key] in (None, [])]
    return {hashlib.sha256(json.dumps({**full, 'HostConfig': {**host, **dict(zip(empty, forms))}}, sort_keys=True,
                                      separators=(',', ':'), allow_nan=False).encode()).hexdigest()
            for forms in itertools.product((None, []), repeat=len(empty))} if empty else {profile_hash(container)}


def profile_hash(container):
    return hashlib.sha256(json.dumps(profile(container), sort_keys=True,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()
