"""Full recovery identities; canonical ordering never drops a mount field."""
import hashlib
import json


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


def profile_hash(container):
    return hashlib.sha256(json.dumps(profile(container), sort_keys=True,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()
