#!/usr/bin/env python3
"""Tiny mocked orchestration fixtures; no Docker, compiler or candidate executes."""
import json
import os
from pathlib import Path
import subprocess
import signal
import shutil
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[3]
SCRIPT = SOURCE / 'tests/qualification/node-runtime/run-proof.sh'
FAKE_DOCKER = r'''
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
root=Path(os.environ['RUNNER_TEMP'])/'node-runtime-qualification'
with open(Path(os.environ['RUNNER_TEMP'])/'docker-calls.jsonl','a') as stream:
    stream.write(json.dumps(args)+'\n')
phase=''
if args[:2] == ['image','inspect']:
    image=args[-1]
    stage='node-base' if 'qualification-base' in image else 'builder' if ':builder-' in image else 'production'
    if os.environ.get('MOCK_FAIL') == 'binding' and stage == 'production':
        raise SystemExit(7)
    digit={'builder':'1','production':'2','node-base':'3'}[stage]
    print(json.dumps({'Id':'sha256:'+digit*64,'Architecture':'amd64','Os':'linux','Size':1024,'RootFS':{'Layers':[]},'labels':{}}))
    raise SystemExit(0)
if args[:2] == ['container','ls']:
    if os.environ.get('MOCK_FAIL') == 'cleanup':
        raise SystemExit(7)
    raise SystemExit(0)
if args[:2] == ['buildx','build']:
    phase='node-base-build'
elif args[0] == 'run':
    assert (root/'source-image-binding.json').is_file(), 'Missing pre-probe image binding'
    assert any(value.startswith('sha256:') for value in args), 'Tag-based proof execution refused'
    if '/usr/bin/g++' in args:
        phase='native-compile'
        assert '-std=c++20' in args, 'Missing explicit language dialect'
    elif '/qualification/application-proof.mjs' in args:
        phase='application-runtime'
    else:
        phase=args[-1]+'-runtime'
if phase == os.environ.get('MOCK_FAIL'):
    print('partial mock stdout')
    print('intentional mock failure',file=sys.stderr)
    raise SystemExit(7)
print(json.dumps({'mock_only':True,'phase':phase}))
'''


class Orchestration(unittest.TestCase):
    def attempt(self, failure):
        with tempfile.TemporaryDirectory(prefix='node-qualification-mock-') as directory:
            root=Path(directory); binaries=root/'bin'; binaries.mkdir()
            for name, source in [('docker',FAKE_DOCKER),('timeout','import os,sys\nos.execvp(sys.argv[2],sys.argv[2:])\n')]:
                path=binaries/name; path.write_text('#!'+sys.executable+'\n'+source); path.chmod(0o700)
            head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=SOURCE,text=True).strip()
            env=dict(os.environ,PATH=str(binaries)+os.pathsep+os.environ['PATH'],GITHUB_ACTIONS='true',RUNNER_OS='Linux',
                     RUNNER_ARCH='X64',GITHUB_SHA=head,GITHUB_RUN_ID='123',GITHUB_RUN_ATTEMPT='1',RUNNER_TEMP=directory,MOCK_FAIL=failure)
            child=subprocess.Popen(['bash',str(SCRIPT),'linux/amd64'],cwd=SOURCE,env=env,
                                   stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
            timed_out=False
            try:
                stdout,stderr=child.communicate(timeout=20)
            except subprocess.TimeoutExpired:
                timed_out=True
                os.killpg(child.pid,signal.SIGKILL)
                stdout,stderr=child.communicate(timeout=2)
            result=subprocess.CompletedProcess(child.args,child.returncode,stdout,stderr)
            proof=root/'node-runtime-qualification'
            if os.environ.get('NODE_RUNTIME_MOCK_EVIDENCE'):
                retained=Path(os.environ['NODE_RUNTIME_MOCK_EVIDENCE'])/(failure or 'success')
                retained.mkdir(parents=True,exist_ok=False)
                if proof.exists(): shutil.copytree(proof,retained/'proof')
                (retained/'shell-stdout.log').write_text(stdout)
                (retained/'shell-stderr.log').write_text(stderr)
                (retained/'fixture-status.json').write_text(json.dumps({'timed_out':timed_out,'exit_status':child.returncode,
                    'fixture_limit_seconds':20,'mock_only':True,'source':head},indent=2)+'\n')
            self.assertFalse(timed_out,'Shell/mock integration exceeded its unchanged20s cap; no candidate qualification follows')
            completion=json.loads((proof/'completion.json').read_text())
            self.assertEqual(completion['source']['GITHUB_SHA'],head)
            self.assertEqual(completion['state'],'TERMINAL_OBSERVED')
            self.assertTrue(completion['hash_inventory_complete'])
            if failure == 'cleanup':
                self.assertEqual(result.returncode,1)
                self.assertEqual(completion['exit_status'],1)
                self.assertEqual(completion['probe_exit_status'],0)
                self.assertNotEqual(completion['cleanup_status'],0)
                self.assertEqual(json.loads((proof/'cleanup.json').read_text())['state'],'UNKNOWN')
            elif failure:
                self.assertEqual(result.returncode,7 if failure != 'binding' else 1,result.stderr)
                self.assertNotEqual(completion['exit_status'],0)
                self.assertEqual(completion['last_phase'],'bind-existing-images' if failure=='binding' else failure)
            else:
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(completion['last_phase'],'complete')
            if failure not in ['binding','node-base-build']:
                binding=json.loads((proof/'source-image-binding.json').read_text())
                self.assertEqual(set(binding['images']),{'builder','production','node-base'})
                self.assertTrue(binding['bound_before_runtime_probes'])
            if failure != 'binding':
                self.assertTrue((proof/'source-images-before-base-build.json').is_file())
            phases=json.loads((proof/'phases.json').read_text())
            self.assertEqual(phases[-1]['state'],'finished')
            self.assertEqual(phases[-1]['exit_status'],completion['probe_exit_status'])
            self.assertIn('cleanup.json',completion['files'])

    def test_failure_evidence_is_bound_and_original_failure_preserved(self):
        for failure in ['binding','node-base-build','node-base-runtime','native-compile','builder-runtime','production-runtime','application-runtime']:
            with self.subTest(failure=failure): self.attempt(failure)

    def test_success_remains_bound(self):
        self.attempt('')

    def test_unknown_cleanup_turns_success_into_failure(self):
        self.attempt('cleanup')


if __name__ == '__main__':
    unittest.main()
