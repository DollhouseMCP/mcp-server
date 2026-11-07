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
from image_archive_identity import verify_saved_image, verify_saved_image_file, verify_fixed_runner, sha
import image_archive_identity as identity


def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode()


def layer(data=b'owned content'):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as bundle:
        entry = tarfile.TarInfo('owned-file'); entry.size = len(data)
        bundle.addfile(entry, io.BytesIO(data))
    return out.getvalue()


def fixture(modern=False, indexed=False, wrong_diff=False, arch="amd64", source=None, labels=None):
    if source is not None and labels is not None:
        raise ValueError('Use either source or labels for a fixture')
    raw = layer(); compressed = gzip.compress(raw, mtime=0) if modern else raw
    config_data = {'os': 'linux', 'architecture': arch, 'rootfs': {'type': 'layers',
                   'diff_ids': [sha(b'wrong') if wrong_diff else sha(raw)]}}
    if source is not None: config_data['config'] = {'Labels': {'org.dollhousemcp.engine-proof-source': source}}
    if labels is not None: config_data['config'] = {'Labels': labels}
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
    def test_nonobject_descriptors_refuse_before_archive_parser_for_both_apis(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'archive'; path.write_bytes(b'inert')
            for value in ('descriptor', [], 7):
                with self.subTest(value=value), patch.object(identity, 'SavedImage') as parser:
                    with self.assertRaisesRegex(ValueError, 'Admission descriptor'):
                        verify_saved_image(path, 'sha256:' + 'a' * 64, 1024, value)
                    with path.open('rb') as stream:
                        with self.assertRaisesRegex(ValueError, 'Admission descriptor'):
                            verify_saved_image_file(stream, 'sha256:' + 'a' * 64, 1024, value)
                        with self.assertRaisesRegex(ValueError, 'Inspection descriptor'):
                            verify_saved_image_file(stream, 'sha256:' + 'a' * 64, 1024, inspection_descriptor=value)
                    parser.assert_not_called()

    def test_fd_api_rejects_unbacked_or_nonregular_streams_before_parsing(self):
        import os
        stream = io.BytesIO(b'not an archive')
        with self.assertRaisesRegex(ValueError, 'open regular file'):
            verify_saved_image_file(stream, 'sha256:' + 'a' * 64, 1024)
        with open(os.devnull, 'rb') as device:
            with self.assertRaisesRegex(ValueError, 'open regular file'):
                verify_saved_image_file(device, 'sha256:' + 'a' * 64, 1024)

    def test_classic_descriptor_and_store_mismatch_have_distinct_failures(self):
        members, store, _, _, size = fixture()
        with tempfile.TemporaryDirectory() as d:
            path = write_archive(Path(d), members)
            descriptor = {'digest': store, 'size': 1, 'mediaType': 'fixture'}
            with self.assertRaisesRegex(ValueError, 'does not support an inspect descriptor'):
                verify_saved_image(path, store, size, descriptor)
            with self.assertRaisesRegex(ValueError, 'config identity'):
                verify_saved_image(path, 'sha256:' + 'f' * 64, size)

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

    def test_retained_direct_single_manifest_can_bind_missing_platform_to_config(self):
        source = 'a' * 40
        for arch in ('amd64', 'arm64'):
            members, store, config, desc, size = fixture(True, arch=arch, source=source)
            del desc['platform']
            members['index.json'] = encoded({'schemaVersion': 2, 'manifests': [desc]})
            with self.subTest(arch=arch), tempfile.TemporaryDirectory() as d:
                path = write_archive(Path(d), members)
                for identity_value, role in ((store, 'manifest'), (config, 'config')):
                    graph = verify_saved_image(path, identity_value, size, desc, platform='linux/'+arch, expected_source=source)
                    self.assertEqual(graph['store_id_role'], role)
                    self.assertEqual(graph['unpacked_layer_bytes'], size)
                    with path.open('rb') as stream:
                        self.assertEqual(verify_saved_image_file(stream, identity_value, size, desc, platform='linux/'+arch, expected_source=source)['store_id_role'], role)
                with self.assertRaisesRegex(ValueError, 'source label'):
                    verify_saved_image(path, store, size, desc, platform='linux/'+arch, expected_source='b'*40)
                self.assertEqual(verify_saved_image(path, store, size, None, platform='linux/'+arch, expected_source=source)['store_id_role'], 'manifest')
                with path.open('rb') as stream:
                    self.assertEqual(verify_saved_image_file(stream, store, size, None, platform='linux/'+arch, expected_source=source, inspection_descriptor=desc)['store_id_role'], 'manifest')
                null_platform = {**desc, 'platform': None}
                with self.assertRaisesRegex(ValueError, 'Inspect descriptor'):
                    verify_saved_image(path, store, size, null_platform, platform='linux/'+arch, expected_source=source)
                with path.open('rb') as stream:
                    with self.assertRaisesRegex(ValueError, 'Inspect descriptor'):
                        verify_saved_image_file(stream, store, size, None, platform='linux/'+arch, expected_source=source, inspection_descriptor=null_platform)
                wrong = {**desc, 'platform': {'os':'linux', 'architecture':arch}}
                with self.assertRaisesRegex(ValueError, 'Inspect descriptor'):
                    verify_saved_image(path, store, size, wrong, platform='linux/'+arch, expected_source=source)
                with self.assertRaises(ValueError):
                    verify_saved_image(path, store, size-1, desc, platform='linux/'+arch, expected_source=source)
                other_arch = 'arm64' if arch == 'amd64' else 'amd64'
                with self.assertRaisesRegex(ValueError, 'platform'):
                    verify_saved_image(path, store, size, desc, platform='linux/'+other_arch, expected_source=source)
                with path.open('rb') as stream:
                    with self.assertRaisesRegex(ValueError, 'Inspect descriptor'):
                        verify_saved_image_file(stream, store, size, desc, platform='linux/'+arch, expected_source=source, inspection_descriptor=wrong)

    def test_unknown_source_kind_fails_before_opening_archive(self):
        for source in (None, 'a' * 40):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, 'Unknown image source kind'):
                verify_saved_image(Path('not-opened.tar'), 'sha256:' + '0' * 64, 100, expected_source=source, source_kind='unknown')

    def test_caddy_requires_explicit_mode_and_both_bound_labels(self):
        source = 'a' * 40
        revision = {'org.opencontainers.image.revision': source}
        distribution = {'org.dollhousemcp.caddy.distribution': 'source-rebuilt-security-candidate'}
        for labels in (revision, revision | distribution):
            with tempfile.TemporaryDirectory() as tmp:
                members, store, _, _, size = fixture(modern=True, labels=labels)
                path = write_archive(Path(tmp), members)
                with self.assertRaisesRegex(ValueError, 'source label mismatch'):
                    verify_saved_image(path, store, size, expected_source=source)
                if labels == revision:
                    with self.assertRaisesRegex(ValueError, 'retained Caddy'):
                        verify_saved_image(path, store, size, expected_source=source, source_kind='caddy')
                else:
                    graph = verify_saved_image(path, store, size, expected_source=source, source_kind='caddy')
                    self.assertEqual(graph['store_id'], store)
                    with self.assertRaisesRegex(ValueError, 'retained Caddy'):
                        verify_saved_image(path, store, size, expected_source=None, source_kind='caddy')
                    with self.assertRaisesRegex(ValueError, 'source label mismatch'):
                        verify_saved_image(path, store, size, expected_source='b' * 40, source_kind='caddy')

    def test_retained_missing_platform_fallback_refuses_explicit_invalid_and_multiple_roots(self):
        source = 'a' * 40
        for value in (None, {}, '', False, [], {'os':'linux','architecture':'arm64'}, {'os':'windows','architecture':'amd64'}):
            members, store, _, desc, size = fixture(True, source=source)
            desc['platform'] = value; members['index.json'] = encoded({'schemaVersion':2, 'manifests':[desc]})
            with self.subTest(platform=value), tempfile.TemporaryDirectory() as d:
                path = write_archive(Path(d), members)
                with self.assertRaises(ValueError): verify_saved_image(path, store, size, desc, expected_source=source)
        members, store, _, desc, size = fixture(True, source=source)
        del desc['platform']; other = {**desc, 'platform': {'os':'linux', 'architecture':'arm64'}}
        members['index.json'] = encoded({'schemaVersion':2, 'manifests':[desc, other]})
        with tempfile.TemporaryDirectory() as d:
            path = write_archive(Path(d), members)
            with self.assertRaisesRegex(ValueError, 'platform'):
                verify_saved_image(path, store, size, desc, expected_source=source)

    def test_retained_missing_platform_fallback_refuses_nested_graph_and_bad_layer(self):
        source = 'a' * 40
        members, store, config, root, size = fixture(True, indexed=True, source=source)
        nested = json.loads(members['blobs/sha256/'+store[7:]])
        child = nested['manifests'][0]; del child['platform']
        data = encoded(nested); root = {**root, 'digest':sha(data), 'size':len(data)}
        members['blobs/sha256/'+root['digest'][7:]] = data
        members['index.json'] = encoded({'schemaVersion':2, 'manifests':[root]})
        with tempfile.TemporaryDirectory() as d:
            path = write_archive(Path(d), members)
            with self.assertRaisesRegex(ValueError, 'platform'):
                verify_saved_image(path, config, size, root, expected_source=source)
        members, store, _, desc, size = fixture(True, wrong_diff=True, source=source)
        del desc['platform']; members['index.json'] = encoded({'schemaVersion':2, 'manifests':[desc]})
        with tempfile.TemporaryDirectory() as d:
            path = write_archive(Path(d), members)
            with self.assertRaisesRegex(ValueError, 'diffID'):
                verify_saved_image(path, store, size, desc, expected_source=source)

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
