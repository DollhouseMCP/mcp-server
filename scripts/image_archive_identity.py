"""Verify classic Docker or OCI/containerd saved images without extracting them."""
import gzip
import hashlib
import json
import os
import stat
from pathlib import PurePosixPath
import re
import tarfile
import time

INDEX_TYPES = {'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'}
MANIFEST_TYPES = {'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'}
LAYER_TYPES = {'application/vnd.oci.image.layer.v1.tar', 'application/vnd.docker.image.rootfs.diff.tar',
               'application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.docker.image.rootfs.diff.tar.gzip'}
DIGEST = re.compile(r'sha256:[a-f0-9]{64}')
METADATA_MAX = 10 * 1024 * 1024
SHA_PREFIX = 'sha256:'
BLOB_PREFIX = 'blobs/sha256/'
INDEX_FILE = 'index.json'
DEFAULT_PLATFORM = 'linux/amd64'
NO_INSPECTION_DESCRIPTOR = object()
RUNNER_INDEX_DIGEST = 'sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66'
RUNNER_MANIFEST_DIGEST = 'sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63'
RUNNER_CONFIG_DIGEST = 'sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f'


def sha(data):
    return SHA_PREFIX + hashlib.sha256(data).hexdigest()


class SavedImage:
    def __init__(self, path, platform=DEFAULT_PLATFORM, fileobj=None):
        if platform not in {DEFAULT_PLATFORM, "linux/arm64"}:
            raise ValueError("Unsupported target platform")
        self.platform = tuple(platform.split("/"))
        self.path = path
        self.deadline = time.monotonic() + 30
        self.tar = tarfile.open(path if fileobj is None else None, 'r:', fileobj=fileobj)
        self.members = {}
        for member in self.tar:
            self.check_time()
            if len(self.members) >= 10000:
                raise ValueError('Saved-image member count exceeds bound')
            name = member.name.removeprefix('./')
            parts = PurePosixPath(name)
            if parts.is_absolute() or '..' in parts.parts or name in self.members:
                raise ValueError('Unsafe or duplicate saved-image member')
            self.members[name] = member

    def check_time(self):
        if time.monotonic() > self.deadline:
            raise ValueError('Saved-image verification exceeded its 30 second bound')

    def close(self):
        self.tar.close()

    def member(self, name):
        member = self.members.get(name)
        if member is None or not member.isfile():
            raise ValueError('Referenced saved-image member is missing or not regular: ' + name)
        return member

    def read(self, name):
        member = self.member(name)
        if member.size > METADATA_MAX:
            raise ValueError('Saved-image metadata exceeds size bound')
        return self.tar.extractfile(member).read()

    def blob(self, descriptor):
        digest = descriptor.get('digest', '')
        if not DIGEST.fullmatch(digest) or descriptor.get('urls'):
            raise ValueError('Invalid/external OCI descriptor')
        name = BLOB_PREFIX + digest[7:]
        member = self.member(name)
        if type(descriptor.get('size')) is not int or member.size != descriptor['size']:
            raise ValueError('OCI descriptor size mismatch')
        data = self.read(name)
        if sha(data) != digest:
            raise ValueError('OCI descriptor digest mismatch')
        return data

    def candidates(self, descriptor, depth=0):
        if depth > 4:
            raise ValueError('OCI index depth exceeds bound')
        self.check_time()
        platform = descriptor.get('platform')
        if platform and (platform.get('os'), platform.get('architecture')) != self.platform:
            return []
        media = descriptor.get('mediaType')
        value = json.loads(self.blob(descriptor))
        if value.get('schemaVersion') != 2:
            raise ValueError('Unsupported OCI metadata schema')
        if media in INDEX_TYPES:
            children = value.get('manifests')
            if not isinstance(children, list) or len(children) > 64:
                raise ValueError('Invalid OCI index')
            result = []
            for child in children:
                result.extend(self.candidates(child, depth + 1))
            return result
        if media not in MANIFEST_TYPES:
            raise ValueError('Unsupported OCI image manifest type')
        if value['config'].get('mediaType') not in {'application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'}:
            raise ValueError('Unsupported OCI image config type')
        config = self.blob(value['config'])
        body = json.loads(config)
        if (body.get('os'), body.get('architecture')) != self.platform:
            return []
        return [(descriptor, value, config)]

    def verify_layer_descriptor(self, descriptor, member, name, raw_digest):
        if descriptor:
            if descriptor.get('mediaType') not in LAYER_TYPES or descriptor.get('urls'):
                raise ValueError('Unsupported/external OCI layer type')
            if type(descriptor.get('size')) is not int or descriptor.get('digest') != raw_digest or descriptor.get('size') != member.size:
                raise ValueError('OCI layer descriptor mismatch')
        elif name.startswith(BLOB_PREFIX) and name != BLOB_PREFIX + raw_digest[7:]:
            raise ValueError('Content-addressed Docker layer digest mismatch')

    def layer(self, name, expected_diff, remaining, descriptor=None):
        member = self.member(name)
        compressed = hashlib.sha256()
        with self.tar.extractfile(member) as source:
            for chunk in iter(lambda: source.read(65536), b''):
                self.check_time()
                compressed.update(chunk)
        raw_digest = SHA_PREFIX + compressed.hexdigest()
        self.verify_layer_descriptor(descriptor, member, name, raw_digest)
        with self.tar.extractfile(member) as source:
            magic = source.read(2); source.seek(0)
            compressed_type = descriptor and descriptor['mediaType'].endswith(('gzip', '.gzip'))
            if descriptor and bool(compressed_type) != (magic == b'\x1f\x8b'):
                raise ValueError('OCI layer compression disagrees with descriptor')
            stream = gzip.GzipFile(fileobj=source) if magic == b'\x1f\x8b' else source
            digest = hashlib.sha256(); count = 0
            while chunk := stream.read(65536):
                self.check_time()
                count += len(chunk)
                if count > remaining:
                    raise ValueError(f'Validated unpacked layer bytes exceed admission cap: current_layer_bytes={count}, remaining_bytes={remaining}, compressed_bytes={member.size}')
                digest.update(chunk)
        diff = SHA_PREFIX + digest.hexdigest()
        if not DIGEST.fullmatch(expected_diff) or diff != expected_diff:
            raise ValueError('Uncompressed layer diffID mismatch')
        return {'archive_path': name, 'compressed_digest': raw_digest, 'compressed_bytes': member.size,
                'diff_id': diff, 'uncompressed_bytes': count}


def select_oci_candidate(archive, store_id, descriptor, config_bytes, config_digest):
    index = json.loads(archive.read(INDEX_FILE))
    roots = index.get('manifests', [])
    if index.get('schemaVersion') != 2 or len(roots) > 64:
        raise ValueError('Invalid saved OCI index')
    root_matches = [r for r in roots if r.get('digest') == store_id]
    if not root_matches and descriptor:
        root_matches = [r for r in roots if r.get('digest') == descriptor.get('digest')]
    if not root_matches and store_id != config_digest:
        raise ValueError('Observed store root is absent from OCI archive')
    candidates = [(root, entry) for root in root_matches or roots for entry in archive.candidates(root)
                  if entry[2] == config_bytes]
    if len(candidates) != 1:
        raise ValueError('OCI selected-platform graph is missing or ambiguous')
    return candidates[0]


def validate_selected_descriptor(archive, root, selected, descriptor, expected_source):
    if expected_source is not None and (selected[0].get('platform', {}).get('os'), selected[0].get('platform', {}).get('architecture')) != archive.platform:
        raise ValueError('Selected target descriptor platform is missing or mismatched')
    if descriptor is not None:
        matching = next((d for d in (root, selected[0]) if d.get('digest') == descriptor.get('digest')), None)
        if not matching or any(descriptor.get(k) != matching.get(k) for k in ['digest', 'mediaType', 'size']) or ('platform' in descriptor and descriptor['platform'] != matching.get('platform')):
            raise ValueError('Inspect descriptor differs from saved graph')


def store_role(store_id, root, selected, config_digest):
    if store_id == root['digest']:
        return 'index' if root['mediaType'] in INDEX_TYPES else 'manifest'
    if store_id == selected[0]['digest']:
        return 'manifest'
    if store_id == config_digest:
        return 'config'
    raise ValueError('Store ID has no exact role in selected OCI graph')


def select_oci_graph(archive, store_id, descriptor, config_bytes, config_digest, docker, expected_source, inspection_descriptor=NO_INSPECTION_DESCRIPTOR):
    root, selected = select_oci_candidate(archive, store_id, descriptor, config_bytes, config_digest)
    validate_selected_descriptor(archive, root, selected, descriptor, expected_source)
    if inspection_descriptor is not NO_INSPECTION_DESCRIPTOR:
        validate_selected_descriptor(archive, root, selected, inspection_descriptor, expected_source)
    role = store_role(store_id, root, selected, config_digest)
    if selected[1]['config']['digest'] != config_digest:
        raise ValueError('OCI and Docker config digest disagree')
    descriptors = selected[1]['layers']
    if [BLOB_PREFIX + d['digest'][7:] for d in descriptors] != docker['Layers']:
        raise ValueError('Docker compatibility layers disagree with OCI selected manifest')
    return root['digest'], selected, role, descriptors


def saved_config(archive, expected_source):
    docker = json.loads(archive.read('manifest.json'))
    if not isinstance(docker, list) or len(docker) != 1:
        raise ValueError('Expected exactly one Docker compatibility manifest')
    docker = docker[0]
    config_bytes = archive.read(docker['Config'])
    config = json.loads(config_bytes)
    if expected_source is not None and config.get('config', {}).get('Labels', {}).get('org.dollhousemcp.engine-proof-source') != expected_source:
        raise ValueError('Saved target source label mismatch')
    if (config.get('os'), config.get('architecture')) != archive.platform:
        raise ValueError('Saved target platform mismatch')
    return docker, config_bytes, config


def verified_layers(archive, config, docker, descriptors, unpacked_cap):
    diffs = config.get('rootfs', {}).get('diff_ids')
    if config.get('rootfs', {}).get('type') != 'layers' or not isinstance(diffs, list) or not 0 < len(diffs) <= 256 or len(diffs) != len(docker['Layers']):
        raise ValueError('Image rootfs/layer graph is invalid')
    layers = []; total = 0
    for name, diff, desc in zip(docker['Layers'], diffs, descriptors):
        record = archive.layer(name, diff, unpacked_cap - total, desc)
        total += record['uncompressed_bytes']; layers.append(record)
    return layers, total


def normalized_admission_descriptor(descriptor):
    if descriptor is None: return None
    return {key: descriptor[key] for key in ('digest', 'mediaType', 'size', 'platform') if key in descriptor}


def _validate_external_descriptors(descriptor, inspection_descriptor):
    if descriptor is not None and not isinstance(descriptor, dict):
        raise ValueError('Admission descriptor must be an object or null')
    if inspection_descriptor is not NO_INSPECTION_DESCRIPTOR and inspection_descriptor is not None and not isinstance(inspection_descriptor, dict):
        raise ValueError('Inspection descriptor must be an object or null')


def _verify_saved_image(path, store_id, unpacked_cap, descriptor=None, *, platform=DEFAULT_PLATFORM, expected_source=None, fileobj=None, inspection_descriptor=NO_INSPECTION_DESCRIPTOR):
    """The opaque store ID must bind to its exact role, never an arbitrary digest."""
    _validate_external_descriptors(descriptor, inspection_descriptor)
    if not DIGEST.fullmatch(store_id):
        raise ValueError('Invalid local store identifier')
    archive = SavedImage(path, platform, fileobj)
    try:
        docker, config_bytes, config = saved_config(archive, expected_source)
        config_digest = sha(config_bytes)
        selected = None; root_digest = None
        if INDEX_FILE in archive.members:
            root_digest, selected, role, descriptors = select_oci_graph(archive, store_id, descriptor, config_bytes, config_digest, docker, expected_source, inspection_descriptor)
        else:
            if descriptor is not None or (inspection_descriptor is not NO_INSPECTION_DESCRIPTOR and inspection_descriptor is not None):
                raise ValueError('Classic Docker archive does not support an inspect descriptor')
            if store_id != config_digest:
                raise ValueError('Classic Docker config identity does not match observed store ID')
            role = 'config'; descriptors = [None] * len(docker['Layers'])
        layers, total = verified_layers(archive, config, docker, descriptors, unpacked_cap)
        return {'store_id': store_id, 'store_id_role': role, 'root_digest': root_digest,
                'admission_descriptor': normalized_admission_descriptor(descriptor),
                'manifest_digest': selected[0]['digest'] if selected else None,
                'manifest_descriptor': selected[0] if selected else None,
                'config_digest': config_digest, 'layers': layers,
                'archive_bytes': os.fstat(fileobj.fileno()).st_size if fileobj is not None else path.stat().st_size, 'unpacked_layer_bytes': total,
                'format': 'oci-with-docker-manifest' if selected else 'classic-docker'}
    finally:
        archive.close()


def verify_saved_image(path, store_id, unpacked_cap, descriptor=None, *, platform=DEFAULT_PLATFORM, expected_source=None):
    """Verify a library caller's trusted path; CLI callers must use the FD API."""
    return _verify_saved_image(path, store_id, unpacked_cap, descriptor, platform=platform, expected_source=expected_source)


def verify_saved_image_file(stream, store_id, unpacked_cap, descriptor=None, *, platform=DEFAULT_PLATFORM, expected_source=None, inspection_descriptor=NO_INSPECTION_DESCRIPTOR):
    """Verify an already admitted open file object without reopening its name."""
    try: info = os.fstat(stream.fileno())
    except (AttributeError, OSError, ValueError, TypeError) as error:
        raise ValueError('Saved-image FD must be an open regular file') from error
    if not stat.S_ISREG(info.st_mode): raise ValueError('Saved-image FD must be an open regular file')
    return _verify_saved_image(None, store_id, unpacked_cap, descriptor, platform=platform, expected_source=expected_source, fileobj=stream, inspection_descriptor=inspection_descriptor)


def verify_fixed_runner(evidence, reference_directory):
    """Anchor either archive format to the exact protected public reference graph."""
    index_bytes = (reference_directory / INDEX_FILE).read_bytes()
    manifest_bytes = (reference_directory / 'linux-amd64-manifest.json').read_bytes()
    root = RUNNER_INDEX_DIGEST
    manifest_digest = RUNNER_MANIFEST_DIGEST
    config_digest = RUNNER_CONFIG_DIGEST
    if sha(index_bytes) != root or sha(manifest_bytes) != manifest_digest:
        raise ValueError('Protected runner reference bytes do not match fixed digests')
    index, manifest = json.loads(index_bytes), json.loads(manifest_bytes)
    choices = [d for d in index['manifests'] if d.get('platform', {}).get('os') == 'linux' and d.get('platform', {}).get('architecture') == 'amd64']
    if len(choices) != 1 or choices[0]['digest'] != manifest_digest or choices[0]['size'] != len(manifest_bytes) or manifest['config']['digest'] != config_digest:
        raise ValueError('Protected runner index/manifest/config graph mismatch')
    if evidence['config_digest'] != config_digest:
        raise ValueError('Runner archive is not the protected independent config')
    if evidence['format'] == 'classic-docker' and (evidence.get('store_id_role') != 'config' or evidence.get('store_id') != config_digest):
        raise ValueError('Classic runner store identity must be the protected config')
    if evidence['format'] == 'oci-with-docker-manifest':
        if evidence['root_digest'] not in {root, manifest_digest} or evidence['manifest_digest'] != manifest_digest:
            raise ValueError('Runner selected manifest is not the exact protected platform')
    return {'reference': 'node@' + root, 'index_digest': root, 'manifest_digest': manifest_digest,
            'config_digest': config_digest, 'execution_reference': 'node@' + root,
            'container_image_id': evidence['store_id'], 'archive': evidence}
