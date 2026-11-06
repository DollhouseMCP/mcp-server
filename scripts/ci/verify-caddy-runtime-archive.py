"""Prove the exported Caddy image contains only its closed runtime filesystem."""

import json
import sys
import tarfile
from pathlib import PurePosixPath

CADDY = "usr/bin/caddy"
FILES = {
    CADDY,
    "etc/caddy/Caddyfile",
    "etc/group",
    "etc/mime.types",
    "etc/passwd",
    "etc/ssl/certs/ca-certificates.crt",
    "usr/share/caddy/dollhouse-build-info.txt",
    "usr/share/caddy/index.html",
}
STORAGE = {"config", "config/caddy", "data", "data/caddy"}
DIRECTORIES = STORAGE | {"srv", "tmp"} | {
    str(parent) for name in FILES for parent in PurePosixPath(name).parents
}
NET_BIND_SERVICE = bytes.fromhex("0100000200040000000000000000000000000000")


DIRECTORY_METADATA = dict.fromkeys(DIRECTORIES, (0, 0, 0o755))
DIRECTORY_METADATA.update(dict.fromkeys(STORAGE, (1001, 1001, 0o750)))
DIRECTORY_METADATA["tmp"] = (0, 0, 0o1777)
FILE_METADATA = dict.fromkeys(FILES, (0, 0, 0o644))
FILE_METADATA[CADDY] = (0, 0, 0o755)


def verify_member(member, name):
    expected = None
    if member.isdir():
        expected = DIRECTORY_METADATA.get(name)
    elif member.isfile():
        expected = FILE_METADATA.get(name)
    metadata = (member.uid, member.gid, member.mode)
    capability = member.pax_headers.get("SCHILY.xattr.security.capability", "")
    expected_capability = NET_BIND_SERVICE if name == CADDY else b""
    if metadata != expected or capability.encode("utf-8", "surrogateescape") != expected_capability:
        raise ValueError(f"unexpected Caddy layer entry or metadata: {name}")


def verify(stream):
    seen = set()
    with tarfile.open(fileobj=stream, mode="r:") as archive:
        (manifest,) = json.load(archive.extractfile("manifest.json"))
        for layer_name in manifest["Layers"]:
            with tarfile.open(fileobj=archive.extractfile(layer_name), mode="r|*") as layer:
                for member in layer:
                    name = member.name.removeprefix("./")
                    if name in seen:
                        raise ValueError(f"duplicate Caddy layer entry: {name}")
                    verify_member(member, name)
                    seen.add(name)
    missing = (FILES | STORAGE | {"srv", "tmp"}) - seen
    if missing:
        raise ValueError(f"Caddy layer entries missing: {sorted(missing)}")
    print("Verified the Caddy-only runtime layers and sole file capability")


if __name__ == "__main__":
    verify(sys.stdin.buffer)
