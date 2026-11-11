#!/usr/bin/env python3
"""Compare a replica's inventory with the live one, both written by live_inventory.py.

A replica can never equal the live host: container IDs, boot times, addresses
and process IDs are its own. So values of those kinds are compared by kind, not
by content, and everything else must be equal. A difference that remains is
accepted only when a private allowance file names its path and gives a reason.
Anything else fails the comparison.

    compare_inventory.py LIVE.json REPLICA.json [ALLOWED.json]

ALLOWED.json is a list of {"path": regular expression, "reason": text}. The
report lists every allowed difference with its reason, every allowance that
matched nothing and every unexplained difference. Exit status is 0 only when
there is no unexplained difference and no unused allowance, and 3 otherwise.

The inventories and the allowance file hold host detail. They stay private.
"""
import json
import re
import sys

HEX = re.compile(r'(sha256:|container:)?[0-9a-f]{12,}\Z')
TIME = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})\Z')
ADDRESS = re.compile(r'\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?\Z')
# Content identities: equal bytes on both hosts, or a named difference.
EXACT = re.compile(r'(\.image_id|\.sha256|^images\[[^\]]*\]\.(id|rootfs\..*)|\.repo_(tags|digests)\[\d+\]|_commit)\Z')
# The host's own counters. They describe a moment, not a configuration.
MOMENT = re.compile(r'(^observed_utc|^elapsed_seconds|\.Pid|\.pid|\.available_bytes|\.restart_count|\.links'
                    r'|^engine_info\.(Containers|ContainersRunning|ContainersPaused|ContainersStopped|Images))\Z')
KEYS = ('name', 'Name', 'id', 'Destination', 'path')
# Lists whose order Docker does not promise. Their members are compared as a set.
UNORDERED = re.compile(r'(\.names|\.Aliases|\.DNSNames|\.exposed_ports|\.volumes|\.CapAdd|\.CapDrop|\.SecurityOptions)\Z')


def kind(value):
    """The class a host-specific string belongs to, or None for an ordinary value."""
    if not isinstance(value, str):
        return None
    if HEX.match(value):
        return 'identifier:%d' % len(value)
    if TIME.match(value):
        return 'time'
    return 'address' if ADDRESS.match(value) else None


def listener(item):
    """A listening socket's name: protocol, port and whether it is bound to every, the local or a host address."""
    address = item.get('address')
    scope = address if address in ('0.0.0.0', '::') or str(address).startswith('127.') else 'host address'
    return '%s/%s on %s' % (item.get('protocol'), item.get('port'), scope)


def keyed(items):
    """A list of named objects as a mapping, so an item is compared with its namesake."""
    if not items or not all(isinstance(item, dict) for item in items):
        return None
    if all({'protocol', 'port', 'address'} <= set(item) for item in items):
        names = [listener(item) for item in items]
        return dict(zip(names, items)) if len(set(names)) == len(names) else None
    for key in KEYS:
        names = [item.get(key) for item in items]
        if all(isinstance(name, str) for name in names) and len(set(names)) == len(names):
            return dict(zip(names, items))
    return None


def by_name(mapping):
    """A mapping keyed by container ID, such as a network's members, keyed by container name instead."""
    if mapping and all(HEX.match(key) and isinstance(value, dict) and isinstance(value.get('Name'), str)
                       for key, value in mapping.items()):
        return {value['Name']: value for value in mapping.values()}
    return mapping


def differences(live, replica, path=''):
    if MOMENT.search(path):
        return
    if isinstance(live, dict) and isinstance(replica, dict):
        live, replica = by_name(live), by_name(replica)
        for key in sorted(set(live) | set(replica)):
            where = path + '.' + key if path else key
            if key not in replica:
                yield where, 'missing on the replica'
            elif key not in live:
                yield where, 'only on the replica'
            else:
                yield from differences(live[key], replica[key], where)
        return
    if isinstance(live, list) and isinstance(replica, list):
        named = keyed(live), keyed(replica)
        if None not in named:
            for name in sorted(set(named[0]) | set(named[1])):
                where = '%s[%s]' % (path, name)
                if name not in named[1]:
                    yield where, 'missing on the replica'
                elif name not in named[0]:
                    yield where, 'only on the replica'
                else:
                    yield from differences(named[0][name], named[1][name], where)
            return
        if UNORDERED.search(path) and all(isinstance(item, str) for item in live + replica):
            ours = {kind(item) or item for item in replica}
            theirs = {kind(item) or item for item in live}
            for item in sorted(theirs - ours):
                yield '%s[%s]' % (path, item), 'missing on the replica'
            for item in sorted(ours - theirs):
                yield '%s[%s]' % (path, item), 'only on the replica'
            return
        if len(live) != len(replica):
            yield path, 'list length %d on live, %d on the replica' % (len(live), len(replica))
            return
        for index, pair in enumerate(zip(live, replica)):
            yield from differences(pair[0], pair[1], '%s[%d]' % (path, index))
        return
    if type(live) is not type(replica):
        yield path, 'type %s on live, %s on the replica' % (type(live).__name__, type(replica).__name__)
    elif live != replica and (EXACT.search(path) or kind(live) is None or kind(live) != kind(replica)):
        # Values are host detail. The report names the path and the kind of mismatch only.
        yield path, 'content differs' if EXACT.search(path) else 'value differs'


def compare(live, replica, allowed=()):
    rules = [(re.compile(item['path']), item['reason']) for item in allowed]
    used, accepted, unexplained = set(), [], []
    for path, problem in differences(live, replica):
        index = next((index for index, rule in enumerate(rules) if rule[0].fullmatch(path)), None)
        if index is None:
            unexplained.append({'path': path, 'difference': problem})
        else:
            used.add(index)
            accepted.append({'path': path, 'difference': problem, 'reason': rules[index][1]})
    unused = [allowed[index]['path'] for index in range(len(rules)) if index not in used]
    return {'schema': 1, 'accepted': accepted, 'unused_allowances': unused, 'unexplained': unexplained,
            'equivalent': not unexplained and not unused}


def load(path):
    with open(path, encoding='utf-8') as stream:
        return json.load(stream)


def main(argv):
    if len(argv) not in (3, 4):
        raise ValueError('usage: compare_inventory.py LIVE.json REPLICA.json [ALLOWED.json]')
    allowed = load(argv[3]) if len(argv) == 4 else []
    if not isinstance(allowed, list) or not all(
            isinstance(item, dict) and set(item) == {'path', 'reason'} and item['reason'] for item in allowed):
        raise ValueError('allowance file must list objects with a path and a reason')
    report = compare(load(argv[1]), load(argv[2]), allowed)
    print(json.dumps(report, indent=1))
    return 0 if report['equivalent'] else 3


if __name__ == '__main__':
    sys.exit(main(sys.argv))
