"""Bounded, non-following identity of a local source bundle."""
import hashlib
import os
from pathlib import Path
import stat

MAX_ENTRIES = 100_000
MAX_BYTES = 1024 ** 3


def identity(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_nlink, st.st_size,
            st.st_mtime_ns, st.st_ctime_ns)


def _open_child(parent, name, before, directory):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if directory:
        flags |= os.O_DIRECTORY
    fd = os.open(name, flags, dir_fd=parent)
    if identity(os.fstat(fd)) != identity(before):
        os.close(fd)
        raise ValueError('bundle member changed while opening')
    return fd


def _same_entry(parent, name, before, fd):
    if identity(os.fstat(fd)) != identity(before) or identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity(before):
        raise ValueError('bundle member changed')


def _names(fd, count):
    names = []
    with os.scandir(fd) as entries:
        for entry in entries:
            names.append(entry.name)
            if len(names) + count > MAX_ENTRIES:
                raise ValueError('bundle entry limit exceeded')
    return sorted(names)


def _hash_file(fd, name, st, digest, counts):
    counts[1] += st.st_size
    if counts[1] > MAX_BYTES:
        raise ValueError('bundle byte limit exceeded')
    digest.update(b'f' + st.st_size.to_bytes(8, 'big'))
    child = _open_child(fd, name, st, False)
    try:
        remaining = st.st_size
        while remaining:
            data = os.read(child, min(remaining, 1024 * 1024))
            if not data:
                raise ValueError('bundle member truncated')
            digest.update(data)
            remaining -= len(data)
        if os.read(child, 1):
            raise ValueError('bundle member grew')
        _same_entry(fd, name, st, child)
    finally:
        os.close(child)


def _walk_entry(fd, name, relative, digest, counts):
    counts[0] += 1
    if counts[0] > MAX_ENTRIES:
        raise ValueError('bundle entry limit exceeded')
    st = os.stat(name, dir_fd=fd, follow_symlinks=False)
    path = relative + (b'/' if relative else b'') + os.fsencode(name)
    digest.update(len(path).to_bytes(4, 'big') + path)
    digest.update(stat.S_IMODE(st.st_mode).to_bytes(4, 'big'))
    if stat.S_ISDIR(st.st_mode):
        digest.update(b'd')
        child = _open_child(fd, name, st, True)
        try:
            _walk(child, path, digest, counts)
            _same_entry(fd, name, st, child)
        finally:
            os.close(child)
    elif stat.S_ISREG(st.st_mode) and st.st_nlink == 1:
        _hash_file(fd, name, st, digest, counts)
    else:
        raise ValueError('unsupported bundle member')


def _walk(fd, relative, digest, counts):
    before = os.fstat(fd)
    for name in _names(fd, counts[0]):
        _walk_entry(fd, name, relative, digest, counts)
    if identity(os.fstat(fd)) != identity(before):
        raise ValueError('bundle directory changed')


def bundle_identity(path):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('bundle path must be absolute')
    before = path.lstat()
    if not stat.S_ISDIR(before.st_mode):
        raise ValueError('bundle root must be a directory')
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if identity(os.fstat(fd)) != identity(before):
            raise ValueError('bundle root changed')
        digest = hashlib.sha256()
        counts = [0, 0]
        _walk(fd, b'', digest, counts)
        if identity(os.fstat(fd)) != identity(before) or identity(path.lstat()) != identity(before):
            raise ValueError('bundle root changed')
        return {'sha256': digest.hexdigest(), 'entries': counts[0], 'bytes': counts[1]}
    finally:
        os.close(fd)
