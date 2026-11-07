"""Inert Caddy identity controls; no daemon, image execution or network."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

module_path = Path(__file__).resolve().parents[2] / 'scripts/hosted-deploy/caddy_image_admission.py'
spec = importlib.util.spec_from_file_location('caddy_admission', module_path)
admission = importlib.util.module_from_spec(spec); spec.loader.exec_module(admission)


class CaddyAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.approved = json.loads(module_path.with_name('caddy-qualified-native-graphs.json').read_text())
        self.ref = 'registry.example.test/team/caddy@sha256:' + 'a'*64
        self.daemon={'OSType':'linux','Architecture':'aarch64'}
        expected = self.approved['architectures']['arm64']
        self.image = {'Id':expected['manifest_digest'], 'RepoDigests':[self.ref], 'Os':'linux', 'Architecture':'arm64',
                      'Config':copy.deepcopy(expected['image_config']), 'RootFS':{'Type':'layers','Layers':expected['diff_ids']}}
        self.graph = {'store_id':self.image['Id'], 'store_id_role':'manifest','format':'oci-with-docker-manifest',
                      'manifest_digest':expected['manifest_digest'],'config_digest':expected['config_digest'],
                      'layers':[{'diff_id':v} for v in expected['diff_ids']]}

    def test_native_graph_binds_reference_without_assuming_id_is_config(self):
        result = admission.validate_observation(self.ref,self.image,self.graph,self.approved,self.daemon)
        self.assertNotEqual(result['store_id'],result['config_digest'])
        self.assertEqual(result['manifest_digest'],self.approved['architectures']['arm64']['manifest_digest'])
        classic={**self.graph,'format':'classic-docker','manifest_digest':None,'store_id_role':'config','store_id':result['config_digest']}
        classic_image={**self.image,'Id':result['config_digest']}
        self.assertEqual(admission.validate_observation(self.ref,classic_image,classic,self.approved,self.daemon)['config_digest'],result['config_digest'])

    def test_unqualified_image_or_graph_refuses(self):
        changes = [lambda i,g:i.update(RepoDigests=[]),lambda i,g:i.update(Architecture='amd64'),
                   lambda i,g:i.update(Os='windows'),lambda i,g:i['Config'].update(User='0:0'),
                   lambda i,g:i['Config']['Labels'].update({'org.opencontainers.image.revision':'b'*40}),
                   lambda i,g:i['RootFS'].update(Layers=list(reversed(i['RootFS']['Layers']))),
                   lambda i,g:g.update(config_digest='sha256:'+'f'*64),
                   lambda i,g:g.update(store_id='sha256:'+'f'*64),
                   lambda i,g:g['layers'][0].update(diff_id='sha256:'+'f'*64)]
        for change in changes:
            image=copy.deepcopy(self.image);graph=copy.deepcopy(self.graph);change(image,graph)
            with self.subTest(image=image,graph=graph), self.assertRaises(ValueError):
                admission.validate_observation(self.ref,image,graph,self.approved,self.daemon)

    def test_daemon_must_match_native_platform(self):
        for daemon in ({'OSType':'linux','Architecture':'x86_64'}, {'OSType':'darwin','Architecture':'arm64'}, {'OSType':'linux','Architecture':'unknown'}):
            with self.subTest(daemon=daemon), self.assertRaises(ValueError):
                admission.validate_observation(self.ref,self.image,self.graph,self.approved,daemon)

    def test_unpinned_or_different_repository_refuses(self):
        for bad in ('caddy:latest','registry.example.test/team/caddy@sha256:'+'A'*64,
                    'registry.example.test/team/caddy@sha256:'+'b'*64,
                    'registry.example.test/team/caddy@sha256:'+'a'*64+'$(touch x)'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                admission.validate_observation(bad,self.image,self.graph,self.approved,self.daemon)


if __name__ == '__main__': unittest.main()
