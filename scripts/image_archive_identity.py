"""Verify classic Docker or OCI/containerd saved images without extracting them."""
import gzip
import hashlib
import json
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


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


class SavedImage:
    def __init__(self, path):
        self.path = path
        self.deadline = time.monotonic() + 30
        self.tar = tarfile.open(path, 'r:')
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
        name = 'blobs/sha256/' + digest[7:]
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
                platform = child.get('platform')
                if platform and (platform.get('os'), platform.get('architecture')) != ('linux', 'amd64'):
                    continue
                result.extend(self.candidates(child, depth + 1))
            return result
        if media not in MANIFEST_TYPES:
            raise ValueError('Unsupported OCI image manifest type')
        if value['config'].get('mediaType') not in {'application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'}:
            raise ValueError('Unsupported OCI image config type')
        config = self.blob(value['config'])
        body = json.loads(config)
        if (body.get('os'), body.get('architecture')) != ('linux', 'amd64'):
            return []
        return [(descriptor, value, config)]

    def layer(self, name, expected_diff, remaining, descriptor=None):
        member = self.member(name)
        compressed = hashlib.sha256()
        with self.tar.extractfile(member) as source:
            for chunk in iter(lambda: source.read(65536), b''):
                self.check_time()
                compressed.update(chunk)
        raw_digest = 'sha256:' + compressed.hexdigest()
        if descriptor:
            if descriptor.get('mediaType') not in LAYER_TYPES or descriptor.get('urls'):
                raise ValueError('Unsupported/external OCI layer type')
            if type(descriptor.get('size')) is not int or descriptor.get('digest') != raw_digest or descriptor.get('size') != member.size:
                raise ValueError('OCI layer descriptor mismatch')
        elif name.startswith('blobs/sha256/') and name != 'blobs/sha256/' + raw_digest[7:]:
            raise ValueError('Content-addressed Docker layer digest mismatch')
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
        diff = 'sha256:' + digest.hexdigest()
        if not DIGEST.fullmatch(expected_diff) or diff != expected_diff:
            raise ValueError('Uncompressed layer diffID mismatch')
        return {'archive_path': name, 'compressed_digest': raw_digest, 'compressed_bytes': member.size,
                'diff_id': diff, 'uncompressed_bytes': count}


def verify_saved_image(path, store_id, unpacked_cap, descriptor=None):
    """The opaque store ID must bind to its exact role, never an arbitrary digest."""
    if not DIGEST.fullmatch(store_id):
        raise ValueError('Invalid local store identifier')
    archive = SavedImage(path)
    try:
        docker = json.loads(archive.read('manifest.json'))
        if not isinstance(docker, list) or len(docker) != 1:
            raise ValueError('Expected exactly one Docker compatibility manifest')
        docker = docker[0]
        config_bytes = archive.read(docker['Config'])
        config_digest = sha(config_bytes)
        config = json.loads(config_bytes)
        if (config.get('os'), config.get('architecture')) != ('linux', 'amd64'):
            raise ValueError('Saved target is not linux/amd64')
        selected = None; root_digest = None; role = None
        if 'index.json' in archive.members:
            index = json.loads(archive.read('index.json'))
            roots = index.get('manifests', [])
            if index.get('schemaVersion') != 2 or len(roots) > 64:
                raise ValueError('Invalid saved OCI index')
            # New stores identify the root manifest/index; classic stores identify config.
            root_matches = [r for r in roots if r.get('digest') == store_id]
            if descriptor and descriptor.get('digest') != store_id:
                root_matches = [r for r in roots if r.get('digest') == descriptor.get('digest')]
            if not root_matches and store_id != config_digest:
                raise ValueError('Observed store root is absent from OCI archive')
            candidates = []
            for root in root_matches or roots:
                for entry in archive.candidates(root):
                    if entry[2] == config_bytes:
                        candidates.append((root, entry))
            if len(candidates) != 1:
                raise ValueError('OCI selected-platform graph is missing or ambiguous')
            root, selected = candidates[0]; root_digest = root['digest']
            if descriptor and any(descriptor.get(key) != root.get(key) for key in ['digest', 'mediaType', 'size']):
                raise ValueError('Inspect descriptor differs from saved root')
            if store_id == root_digest:
                role = 'index' if root['mediaType'] in INDEX_TYPES else 'manifest'
            elif store_id == selected[0]['digest']:
                role = 'manifest'
            elif store_id == config_digest:
                role = 'config'
            else:
                raise ValueError('Store ID has no exact role in selected OCI graph')
            if selected[1]['config']['digest'] != config_digest:
                raise ValueError('OCI and Docker config digest disagree')
            descriptors = selected[1]['layers']
            names = ['blobs/sha256/' + d['digest'][7:] for d in descriptors]
            if names != docker['Layers']:
                raise ValueError('Docker compatibility layers disagree with OCI selected manifest')
        else:
            if descriptor or store_id != config_digest:
                raise ValueError('Classic Docker config identity does not match observed store ID')
            role = 'config'; descriptors = [None] * len(docker['Layers'])
        diffs = config.get('rootfs', {}).get('diff_ids')
        if config.get('rootfs', {}).get('type') != 'layers' or not isinstance(diffs, list) or not 0 < len(diffs) <= 256 or len(diffs) != len(docker['Layers']):
            raise ValueError('Image rootfs/layer graph is invalid')
        layers = []; total = 0
        for name, diff, desc in zip(docker['Layers'], diffs, descriptors):
            record = archive.layer(name, diff, unpacked_cap - total, desc)
            total += record['uncompressed_bytes']; layers.append(record)
        return {'store_id': store_id, 'store_id_role': role, 'root_digest': root_digest,
                'manifest_digest': selected[0]['digest'] if selected else None,
                'manifest_descriptor': selected[0] if selected else None,
                'config_digest': config_digest, 'layers': layers,
                'archive_bytes': path.stat().st_size, 'unpacked_layer_bytes': total,
                'format': 'oci-with-docker-manifest' if selected else 'classic-docker'}
    finally:
        archive.close()


def verify_fixed_runner(evidence, reference_directory):
    """Anchor either archive format to the exact protected public reference graph."""
    index_bytes = (reference_directory / 'index.json').read_bytes()
    manifest_bytes = (reference_directory / 'linux-amd64-manifest.json').read_bytes()
    root = 'sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66'
    manifest_digest = 'sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63'
    config_digest = 'sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f'
    if sha(index_bytes) != root or sha(manifest_bytes) != manifest_digest:
        raise ValueError('Protected runner reference bytes do not match fixed digests')
    index, manifest = json.loads(index_bytes), json.loads(manifest_bytes)
    choices = [d for d in index['manifests'] if d.get('platform', {}).get('os') == 'linux' and d.get('platform', {}).get('architecture') == 'amd64']
    if len(choices) != 1 or choices[0]['digest'] != manifest_digest or choices[0]['size'] != len(manifest_bytes) or manifest['config']['digest'] != config_digest:
        raise ValueError('Protected runner index/manifest/config graph mismatch')
    if evidence['config_digest'] != config_digest:
        raise ValueError('Runner archive is not the protected independent config')
    if evidence['format'] == 'oci-with-docker-manifest':
        if evidence['root_digest'] not in {root, manifest_digest} or evidence['manifest_digest'] != manifest_digest:
            raise ValueError('Runner selected manifest is not the exact protected platform')
    return {'reference': 'node@' + root, 'index_digest': root, 'manifest_digest': manifest_digest,
            'config_digest': config_digest, 'execution_reference': 'node@' + root,
            'container_image_id': evidence['store_id'], 'archive': evidence}
