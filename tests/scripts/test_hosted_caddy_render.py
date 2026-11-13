"""Inert hosted Caddy rendering/refusal tests; no Docker or network."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/hosted-deploy.sh'
PYTHON = sys.executable


class HostedCaddyRenderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.bin = self.root/'bin'; self.bin.mkdir()
        (self.bin/'python3').symlink_to(PYTHON)
        self.deploy = self.root/'deploy'
        self.ref = 'registry.example.test/team/caddy@sha256:'+'a'*64
        self.env = dict(os.environ, PATH=str(self.bin)+os.pathsep+os.environ['PATH'],
                        DOLLHOUSE_HOSTED_DEPLOY_DIR=str(self.deploy), DOLLHOUSE_HOSTED_HOSTNAME='mcp.example.com',
                        DOLLHOUSE_AUTH_GITHUB_CLIENT_ID='fixture', DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET='fixture',
                        DOLLHOUSE_HOSTED_CADDY_IMAGE=self.ref, DOLLHOUSE_HOSTED_CADDY_DATA_VOLUME='fixture_data',
                        DOLLHOUSE_HOSTED_CADDY_CONFIG_VOLUME='fixture_config')

    def run_render(self, *, dry=False, mask=None):
        return subprocess.run(['bash', str(SCRIPT), *(['--dry-run'] if dry else []), 'render'], env=self.env,
                              capture_output=True, text=True, preexec_fn=(lambda: os.umask(mask)) if mask is not None else None)

    def test_digest_profile_persistence_and_caddyfile_readability(self):
        result = self.run_render(mask=0o077); self.assertEqual(result.returncode,0,result.stderr)
        compose=(self.deploy/'compose.yml').read_text(); env=(self.deploy/'.env.production').read_text(); caddy=self.deploy/'Caddyfile'
        for value in (self.ref,'user: "1001:1001"','read_only: true','NET_BIND_SERVICE','net.ipv4.ip_unprivileged_port_start: "1024"','name: fixture_data','name: fixture_config'):
            self.assertIn(value,compose)
        self.assertIn('DOLLHOUSE_HOSTED_CADDY_IMAGE='+self.ref,env)
        self.assertEqual(caddy.stat().st_mode & 0o777,0o644)
        inode = caddy.stat().st_ino
        caddy.chmod(0o600); result=self.run_render(mask=0o077)
        self.assertEqual(result.returncode,0,result.stderr); self.assertEqual(caddy.stat().st_mode & 0o777,0o644)
        self.assertEqual(caddy.stat().st_ino, inode)

    def test_bad_cli_selections_refuse_before_mutation(self):
        for value in ('caddy:latest','-evil@sha256:'+'a'*64,self.ref+'$(touch x)',self.ref+'\nBAD=1',self.ref.replace('sha256:','sha256:$')):
            self.env['DOLLHOUSE_HOSTED_CADDY_IMAGE']=value
            with self.subTest(value=value):
                self.assertNotEqual(self.run_render().returncode,0)
                self.assertFalse(self.deploy.exists())

    def test_clone_dry_run_reports_explicit_volumes_without_mutation(self):
        result = subprocess.run(['bash', str(SCRIPT), '--dry-run', 'clone-caddy-volumes'],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('fixture_data', result.stdout)
        self.assertIn('fixture_config', result.stdout)
        self.assertFalse(self.deploy.exists())

    def test_active_deployment_refuses_unrecorded_caddyfile_change(self):
        result = self.run_render()
        self.assertEqual(result.returncode, 0, result.stderr)
        (self.deploy / 'server').mkdir()
        caddy = self.deploy / 'Caddyfile'
        before = caddy.read_bytes()
        self.env['DOLLHOUSE_HOSTED_HOSTNAME'] = 'different.example.com'
        result = self.run_render()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(caddy.read_bytes(), before)

    def test_persisted_metacharacters_or_internal_alias_refuse_before_mutation(self):
        self.deploy.mkdir(); envfile=self.deploy/'.env.production'; marker=self.root/'injected'
        for line in ('DOLLHOUSE_HOSTED_CADDY_IMAGE=$(touch '+str(marker)+')',
                     'DOLLHOUSE_HOSTED_CADDY_DATA_VOLUME=`touch '+str(marker)+'`',
                     'CADDY_IMAGE=$(touch '+str(marker)+')',
                     'CADDY_KEEP_PROXY=$(touch '+str(marker)+')',
                     'HOSTED_CADDY_REQUEST_ROOT=$(touch '+str(marker)+')',
                     'DOLLHOUSE_HOSTED_CADDY_CONFIG_VOLUME=${HOME}'):
            with self.subTest(line=line):
                envfile.write_text(line+'\n'); before=envfile.read_bytes()
                self.assertNotEqual(self.run_render().returncode,0)
                self.assertEqual(envfile.read_bytes(),before); self.assertFalse(marker.exists())
                self.assertFalse((self.deploy/'compose.yml').exists())


if __name__ == '__main__': unittest.main()
