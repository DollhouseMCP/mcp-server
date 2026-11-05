"""Small real classic/OCI archives exercise identity roles and bounded expansion."""
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from image_archive_identity import verify_saved_image, verify_fixed_runner, sha


def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode()


def layer(data=b'owned content'):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as bundle:
        entry = tarfile.TarInfo('owned-file'); entry.size = len(data)
        bundle.addfile(entry, io.BytesIO(data))
    return out.getvalue()


def fixture(modern=False, indexed=False, wrong_diff=False, arch="amd64", source=None):
    raw = layer(); compressed = gzip.compress(raw, mtime=0) if modern else raw
    config_data = {'os': 'linux', 'architecture': arch, 'rootfs': {'type': 'layers',
                   'diff_ids': [sha(b'wrong') if wrong_diff else sha(raw)]}}
    if source is not None: config_data['config'] = {'Labels': {'org.dollhousemcp.engine-proof-source': source}}
    config = encoded(config_data)
    config_id = sha(config); layer_id = sha(compressed)
    config_path = 'blobs/sha256/' + config_id[7:] if modern else config_id[7:] + '.json'
    layer_path = 'blobs/sha256/' + layer_id[7:] if modern else 'classic/layer.tar'
    members = {config_path: config, layer_path: compressed}
    members['manifest.json'] = encoded([{'Config': config_path, 'Layers': [layer_path], 'RepoTags': None}])
    if not modern:
        return members, config_id, config_id, None, len(raw)
    manifest = encoded({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                        'config': {'mediaType': 'application/vnd.oci.image.config.v1+json', 'digest': config_id, 'size': len(config)},
                        'layers': [{'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip', 'digest': layer_id, 'size': len(compressed)}]})
    desc = {'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'digest': sha(manifest), 'size': len(manifest),
            'platform': {'os': 'linux', 'architecture': arch}}
    members['blobs/sha256/' + desc['digest'][7:]] = manifest
    if indexed:
        index = encoded({'schemaVersion': 2, 'manifests': [desc]})
        desc = {'mediaType': 'application/vnd.oci.image.index.v1+json', 'digest': sha(index), 'size': len(index)}
        members['blobs/sha256/' + desc['digest'][7:]] = index
    members['index.json'] = encoded({'schemaVersion': 2, 'manifests': [desc]})
    members['oci-layout'] = encoded({'imageLayoutVersion': '1.0.0'})
    return members, desc['digest'], config_id, desc, len(raw)


def write_archive(root, members):
    path = root / 'image.tar'
    with tarfile.open(path, 'w') as bundle:
        for name, data in members.items():
            entry = tarfile.TarInfo(name); entry.size = len(data)
            bundle.addfile(entry, io.BytesIO(data))
    return path


class ImageGraphTests(unittest.TestCase):
    def test_classic_config_id_and_real_diffid_are_verified(self):
        members, store, config, desc, size = fixture()
        with tempfile.TemporaryDirectory() as d:
            result = verify_saved_image(write_archive(Path(d), members), store, size, desc)
            self.assertEqual((result['store_id_role'], result['config_digest'], result['unpacked_layer_bytes']), ('config', config, size))

    def test_docker29_manifest_id_is_distinct_from_config_and_compressed_size(self):
        members, store, config, desc, size = fixture(True)
        self.assertNotEqual(store, config)
        with tempfile.TemporaryDirectory() as d:
            path = write_archive(Path(d), members)
            result = verify_saved_image(path, store, size, desc)
            self.assertEqual(result['store_id_role'], 'manifest')
            self.assertEqual(result['config_digest'], config)
            self.assertGreater(result['unpacked_layer_bytes'], result['layers'][0]['compressed_bytes'])
            with self.assertRaisesRegex(ValueError, 'unpacked layer bytes'):
                verify_saved_image(path, store, size - 1, desc)

    def test_index_root_and_legacy_config_alias_keep_explicit_roles(self):
        for indexed in [False, True]:
            members, store, config, desc, size = fixture(True, indexed)
            with tempfile.TemporaryDirectory() as d:
                path = write_archive(Path(d), members)
                result = verify_saved_image(path, store, size, desc)
                self.assertEqual(result['store_id_role'], 'index' if indexed else 'manifest')
                alias = verify_saved_image(path, config, size, desc)
                self.assertEqual(alias['store_id_role'], 'config')

    def test_index_store_accepts_only_its_selected_child_descriptor(self):
        members, store, _, root_desc, size = fixture(True, True)
        index = json.loads(members['blobs/sha256/' + store[7:]])
        child = index['manifests'][0]
        with tempfile.TemporaryDirectory() as d:
            path = write_archive(Path(d), members)
            graph = verify_saved_image(path, store, size, child)
            self.assertEqual((graph['store_id_role'], graph['root_digest'], graph['manifest_digest']), ('index', store, child['digest']))
            for key, value in [('digest', 'sha256:' + 'f'*64), ('mediaType', 'wrong'), ('size', child['size'] + 1), ('platform', {'os':'linux', 'architecture':'arm64'})]:
                bad = copy.deepcopy(child); bad[key] = value
                with self.subTest(key=key), self.assertRaises(ValueError): verify_saved_image(path, store, size, bad)
            with self.assertRaises(ValueError): verify_saved_image(path, 'sha256:' + 'f'*64, size, child)
            verify_saved_image(path, store, size, root_desc)
            alias = verify_saved_image(path, child['digest'], size, root_desc)
            self.assertEqual((alias['store_id_role'], alias['root_digest']), ('manifest', store))
            with self.assertRaises(ValueError): verify_saved_image(path, 'sha256:' + 'f'*64, size, root_desc)
            unrelated = copy.deepcopy(root_desc); unrelated['digest'] = 'sha256:' + 'f'*64
            with self.assertRaises(ValueError): verify_saved_image(path, child['digest'], size, unrelated)

    def test_duplicate_index_child_is_ambiguous(self):
        members, store, _, root_desc, size = fixture(True, True)
        index = json.loads(members['blobs/sha256/' + store[7:]])
        child = index['manifests'][0]; index['manifests'].append(copy.deepcopy(child))
        content = encoded(index); new_store = sha(content)
        members['blobs/sha256/' + new_store[7:]] = content
        root_desc = {**root_desc, 'digest': new_store, 'size': len(content)}
        members['index.json'] = encoded({'schemaVersion':2, 'manifests':[root_desc]})
        with tempfile.TemporaryDirectory() as d:
            path = write_archive(Path(d), members)
            with self.assertRaisesRegex(ValueError, 'ambiguous'):
                verify_saved_image(path, new_store, size, child)

    def test_mutated_blob_and_rehashed_wrong_diffid_are_both_refused(self):
        for wrong_diff in [False, True]:
            members, store, config, desc, size = fixture(True, wrong_diff=wrong_diff)
            if not wrong_diff:
                config_path = 'blobs/sha256/' + config[7:]
                members[config_path] += b' '
            with tempfile.TemporaryDirectory() as d:
                path = write_archive(Path(d), members)
                with self.assertRaises(ValueError):
                    verify_saved_image(path, store, size, desc)

    def test_layer_digest_is_not_an_acceptable_store_identity(self):
        members, _, _, _, size = fixture(True)
        docker = json.loads(members['manifest.json'])
        fake_store = 'sha256:' + docker[0]['Layers'][0].split('/')[-1]
        with tempfile.TemporaryDirectory() as d:
            path = write_archive(Path(d), members)
            with self.assertRaisesRegex(ValueError, 'store root'):
                verify_saved_image(path, fake_store, size)

    def test_docker_compatibility_view_cannot_disagree_with_oci_graph(self):
        members, store, _, desc, size = fixture(True)
        docker = json.loads(members['manifest.json']); docker[0]['Layers'] = ['other/layer.tar']
        members['manifest.json'] = encoded(docker); members['other/layer.tar'] = layer()
        with tempfile.TemporaryDirectory() as d:
            path = write_archive(Path(d), members)
            with self.assertRaisesRegex(ValueError, 'compatibility layers disagree'):
                verify_saved_image(path, store, size, desc)

    def test_unchanged_metadata_cannot_hide_modified_layer_bytes(self):
        members, store, _, desc, size = fixture(True)
        docker = json.loads(members['manifest.json'])
        name = docker[0]['Layers'][0]
        data = bytearray(members[name]); data[-1] ^= 1; members[name] = bytes(data)
        with tempfile.TemporaryDirectory() as d:
            path = write_archive(Path(d), members)
            with self.assertRaisesRegex(ValueError, 'layer descriptor mismatch'):
                verify_saved_image(path, store, size, desc)

    def test_root_metadata_digest_and_descriptor_size_must_match(self):
        for change in ['metadata', 'descriptor']:
            members, store, _, desc, size = fixture(True)
            if change == 'metadata':
                name = 'blobs/sha256/' + store[7:]
                members[name] = members[name].replace(b'"schemaVersion":2', b'"schemaVersion":3')
            else:
                desc['size'] += 1
            with tempfile.TemporaryDirectory() as d:
                path = write_archive(Path(d), members)
                with self.assertRaisesRegex(ValueError, 'descriptor.*mismatch|Inspect descriptor'):
                    verify_saved_image(path, store, size, desc)

    def test_inspect_descriptor_can_omit_platform_but_cannot_disagree(self):
        members, store, _, desc, size = fixture(True)
        with tempfile.TemporaryDirectory() as d:
            path = write_archive(Path(d), members)
            no_platform = {k:v for k,v in desc.items() if k != 'platform'}
            verify_saved_image(path, store, size, no_platform)
            wrong = copy.deepcopy(desc); wrong['platform']['architecture'] = 'arm64'
            with self.assertRaises(ValueError): verify_saved_image(path, store, size, wrong)

    def test_arm_data_requires_explicit_platform_and_matching_descriptor(self):
        for modern in (False, True):
            members, store, _, desc, size = fixture(modern, arch='arm64')
            with tempfile.TemporaryDirectory() as d:
                path = write_archive(Path(d), members)
                with self.assertRaises(ValueError): verify_saved_image(path, store, size, desc)
                result = verify_saved_image(path, store, size, desc, platform='linux/arm64')
                self.assertEqual(result['store_id'], store)
                if modern:
                    bad = copy.deepcopy(desc); bad['platform']['architecture'] = 'amd64'
                    with self.assertRaises(ValueError): verify_saved_image(path, store, size, bad, platform='linux/arm64')

    def test_protected_runner_reference_is_independent_and_hash_pinned(self):
        reference = Path(__file__).resolve().parents[2] / '.github/grype-runner-reference'
        evidence = {'format': 'oci-with-docker-manifest',
                    'store_id': 'sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66',
                    'root_digest': 'sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66',
                    'config_digest': 'sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f',
                    'manifest_digest': 'sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63'}
        result = verify_fixed_runner(evidence, reference)
        self.assertEqual(result['container_image_id'], evidence['store_id'])
        self.assertEqual(result['execution_reference'], result['reference'])
        bad = copy.deepcopy(evidence); bad['config_digest'] = 'sha256:' + 'e' * 64
        with self.assertRaisesRegex(ValueError, 'independent config'):
            verify_fixed_runner(bad, reference)

    def test_classic_runner_requires_exact_config_store_identity(self):
        reference = Path(__file__).resolve().parents[2] / '.github/grype-runner-reference'
        config = 'sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f'
        evidence = {'format': 'classic-docker', 'store_id_role': 'config', 'store_id': config,
                    'config_digest': config, 'root_digest': None, 'manifest_digest': None}
        self.assertEqual(verify_fixed_runner(evidence, reference)['container_image_id'], config)
        for key, bad in [('store_id', 'sha256:' + 'f' * 64), ('store_id_role', 'manifest')]:
            changed = copy.deepcopy(evidence); changed[key] = bad
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'Classic runner store identity'):
                verify_fixed_runner(changed, reference)

    def test_fixed_oci_runner_retains_distinct_store_aliases(self):
        reference = Path(__file__).resolve().parents[2] / '.github/grype-runner-reference'
        root = 'sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66'
        manifest = 'sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63'
        config = 'sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f'
        for role, identifier in [('index', root), ('manifest', manifest), ('config', config)]:
            evidence = {'format': 'oci-with-docker-manifest', 'store_id_role': role, 'store_id': identifier,
                        'root_digest': root, 'manifest_digest': manifest, 'config_digest': config}
            with self.subTest(role=role):
                self.assertEqual(verify_fixed_runner(evidence, reference)['container_image_id'], identifier)


if __name__ == '__main__':
    unittest.main()
