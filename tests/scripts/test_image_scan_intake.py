"""Inert retained-intake refusal and identity tests; no daemon or scanner runs."""
import copy
import hashlib
import io
import tarfile
import json
import os
from pathlib import Path
import sys
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import image_scan_intake as intake


class IntakeArgumentTests(unittest.TestCase):
    def test_absent_legacy_and_complete_positive_attempt_are_accepted(self):
        intake.validate_intake_arguments([None, None], None)
        intake.validate_intake_arguments(['record', 1], 1)
        for supplied, attempt in [(['', None], None), ([None, 0], 0), (['record', -1], -1)]:
            with self.subTest(supplied=supplied), self.assertRaises(ValueError):
                intake.validate_intake_arguments(supplied, attempt)


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.work = self.root / 'image-security'; self.slot = self.work / 'retained/arm64'; self.slot.mkdir(parents=True); (self.work / 'inputs').mkdir(); self.archive = self.slot / 'production-arm64.docker.tar'; self.archive.write_bytes(b'inert archive')
        self.head = '1' * 40; self.tree = '2' * 40
        self.approved = {'source': '07bf8185cd8a63ab0202745a10213ebffaff070b', 'tree': 'd51c9caf78a4bd8257f2de9b58e42e5338dbfd3a', 'run_id': '40929259427', 'attempt': 1, 'runtime_receipt_sha256': '3'*64}
        self.record = {'schema': 'retained-image-intake-v1', **self.approved, 'archive_sha256': hashlib.sha256(self.archive.read_bytes()).hexdigest(),
            'archive_bytes': self.archive.stat().st_size, 'platform': 'linux/arm64', 'store_id': 'sha256:'+'4'*64,
            'store_id_role': 'config', 'root_digest': None, 'manifest_digest': None, 'config_digest': 'sha256:'+'4'*64,
            'diff_ids': ['sha256:'+'5'*64], 'descriptor': None}
        self.graph = {k:self.record[k] for k in ('store_id','store_id_role','root_digest','manifest_digest','config_digest')}
        self.graph['layers'] = [{'diff_id': self.record['diff_ids'][0]}]

    def invoke(self, record=None, approved=None, github=None, git_values=None, raw=None):
        raw = raw if raw is not None else json.dumps(record or self.record).encode()
        path = self.slot / 'intake.json'; path.write_bytes(raw)
        outputs = iter(git_values or [self.head, self.tree, ''])
        def git(*args, **kwargs):
            class Result: pass
            result = Result(); result.stdout = next(outputs).encode(); return result
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake.subprocess, 'run', side_effect=git), patch.object(intake, 'verify_saved_image_file', return_value=self.graph) as verify:
            result = intake.validate_intake(path, hashlib.sha256(raw).hexdigest(), self.archive, self.head, self.tree,
                                           self.head if github is None else github, Path(intake.__file__).resolve().parent.parent, approved or self.approved)
            self.assertEqual(verify.call_args.kwargs['platform'], 'linux/arm64')
            self.assertEqual(verify.call_args.kwargs['expected_source'], self.approved['source'])
            return result

    def test_explicit_target_and_scanner_tuples_accept(self):
        self.assertEqual(self.invoke()[0], self.record)

    def test_staged_output_slot_rejects_unsafe_names_before_any_access(self):
        from unittest.mock import Mock
        invalid = [('inputs', name) for name in ('', '.', '..', '/tmp/escape', '../escape', 'part/name', 'part\\name', 'white space', 'é', None)]
        invalid += [(name, 'image.tar') for name in ('', '..', '/tmp', '../inputs', 'inputs/other', 'other')]
        for directory, name in invalid:
            tree = Mock()
            with self.subTest(directory=directory, name=name), patch.object(intake.os, 'open') as opened:
                with self.assertRaisesRegex(ValueError, 'Invalid staged output slot'):
                    intake.stage_verified(tree, None, 1, 'x', None, 1, 'source', output_dir=directory, output_name=name)
                tree.directory.assert_not_called(); opened.assert_not_called()

    def test_raw_fds_close_when_wrapping_or_first_stage_stat_fails(self):
        (self.work / 'reports').mkdir()
        for scenario in ('file-fdopen', 'failure-fdopen', 'stage-fdopen', 'stage-fstat', 'stage-cancel'):
            captured = []; real_open, real_fstat = os.open, os.fstat
            def opened(path, flags, *args, **kwargs):
                fd = real_open(path, flags, *args, **kwargs)
                if path in ('production-arm64.docker.tar', 'failure.json', 'image.tar'): captured.append(fd)
                return fd
            def wrapping(fd, *_args, **_kwargs):
                captured.append(fd)
                if scenario == 'stage-cancel': raise KeyboardInterrupt('fixture cancellation')
                raise OSError('fixture fdopen failure')
            def fstat(fd):
                if captured and fd == captured[-1]: raise OSError('fixture fstat failure')
                return real_fstat(fd)
            expected = KeyboardInterrupt if scenario == 'stage-cancel' else (ValueError if scenario.startswith('stage-') else OSError)
            with self.subTest(scenario=scenario):
                if scenario == 'failure-fdopen':
                    with patch.object(intake.os, 'open', side_effect=opened), patch.object(intake.os, 'fdopen', side_effect=wrapping):
                        with self.assertRaises(expected): intake.write_failure_report(self.work, {'status': 'UNKNOWN'})
                    (self.work / 'reports/failure.json').unlink()
                else:
                    with intake.TrustedTree(self.work) as tree:
                        slot = tree.directory(tree.directory(tree.workfd, 'retained'), 'arm64')
                        if scenario == 'file-fdopen':
                            with patch.object(intake.os, 'open', side_effect=opened), patch.object(intake.os, 'fdopen', side_effect=wrapping):
                                with self.assertRaises(expected): tree.file(slot, 'production-arm64.docker.tar', 1024)
                        else:
                            stream, identity = tree.file(slot, 'production-arm64.docker.tar', 1024)
                            with patch.object(intake.os, 'open', side_effect=opened), \
                                    patch.object(intake.os, 'fdopen', side_effect=wrapping if scenario != 'stage-fstat' else os.fdopen), \
                                    patch.object(intake.os, 'fstat', side_effect=fstat if scenario == 'stage-fstat' else real_fstat):
                                with self.assertRaises(expected):
                                    intake.stage_verified(tree, stream, identity[5], self.record['archive_sha256'], identity, slot, 'production-arm64.docker.tar')
                    if scenario.startswith('stage-'): (self.work / 'inputs/image.tar').unlink()
                self.assertTrue(captured)
                with self.assertRaises(OSError): real_fstat(captured[-1])

    def test_record_rejects_nonobject_descriptor(self):
        for value in ('descriptor', [], 7):
            record = copy.deepcopy(self.record); record['descriptor'] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'descriptor must be'):
                intake.validate_record(record, self.approved)
        record = copy.deepcopy(self.record); record['descriptor'] = None
        self.assertEqual(intake.validate_record(record, self.approved), record)

    def test_clean_real_checkout_and_copied_helper_refusal(self):
        checkout = self.root / 'checkout'; (checkout / 'scripts').mkdir(parents=True)
        helper = checkout / 'scripts/image_scan_intake.py'; helper.write_text('fixture')
        def git(*args):
            return subprocess.run(['git', '-C', str(checkout), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()
        git('init', '-q'); git('add', 'scripts/image_scan_intake.py')
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
        head, tree = git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}')
        path = self.slot / 'intake.json'; raw = json.dumps(self.record).encode(); path.write_bytes(raw)
        digest = hashlib.sha256(raw).hexdigest()
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake, '__file__', str(helper)), patch.object(intake, 'verify_saved_image_file', return_value=self.graph):
            intake.validate_intake(path, digest, self.archive, head, tree, head, checkout, self.approved)
            helper.write_text('modified')
            with self.assertRaisesRegex(ValueError, 'modified or untracked'):
                intake.validate_intake(path, digest, self.archive, head, tree, head, checkout, self.approved)
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake, '__file__', str(self.root / 'copied-helper.py')):
            with self.assertRaisesRegex(ValueError, 'does not belong'):
                intake.validate_intake(path, digest, self.archive, head, tree, head, checkout, self.approved)

    def test_scanner_output_directories_are_owned_empty_and_nonsymlink(self):
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}):
            reports, inputs = intake.prepare_scanner_output(self.work)
            self.assertEqual((reports, inputs), (self.work/'reports', self.work/'inputs'))
            (inputs/'existing').write_text('do not overwrite')
            with self.assertRaisesRegex(ValueError, 'empty'): intake.prepare_scanner_output(self.work)
            self.assertEqual((inputs/'existing').read_text(), 'do not overwrite')
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve(); work=root/'image-security'; work.mkdir(); outside=root/'outside'; outside.mkdir()
            (work/'reports').symlink_to(outside,target_is_directory=True)
            with self.assertRaises((ValueError,OSError)): intake.prepare_scanner_output(work)
            self.assertEqual(list(outside.iterdir()), [])

    def test_capture_requires_existing_parents_and_exclusive_private_directories(self):
        (self.work/'reports').mkdir()
        reports, private = intake.prepare_capture_output(self.work)
        self.assertEqual((reports, private), (self.work/'reports/applicability', self.work/'applicability-inputs'))
        self.assertEqual(reports.stat().st_mode & 0o777, 0o700)
        self.assertEqual(private.stat().st_mode & 0o777, 0o700)
        with self.assertRaises(FileExistsError): intake.prepare_capture_output(self.work)

    def test_paths_must_be_exact_trusted_slot_and_workroot(self):
        raw = json.dumps(self.record).encode(); doc = self.slot / 'intake.json'; doc.write_bytes(raw)
        digest = hashlib.sha256(raw).hexdigest(); checkout = Path(intake.__file__).resolve().parent.parent
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}):
            for document, archive in [(self.root/'intake.json',self.archive), (doc,self.root/'target.tar'),
                                      (str(self.slot/'..'/'arm64'/'intake.json'),self.archive), (doc,'relative.tar')]:
                with self.subTest(document=document,archive=archive), self.assertRaises(ValueError):
                    intake.validate_intake(document,digest,archive,self.head,self.tree,self.head,checkout,self.approved)
            with self.assertRaises(ValueError): intake.trusted_work_root(self.root/'outside', create=True)
            self.assertFalse((self.root/'outside').exists())
        with patch.dict(os.environ, {'RUNNER_TEMP':''}):
            with self.assertRaises(ValueError): intake.trusted_work_root(self.work)

    def test_symlink_fifo_oversize_and_writable_inputs_refuse(self):
        raw = json.dumps(self.record).encode(); doc = self.slot/'intake.json'; digest=hashlib.sha256(raw).hexdigest()
        checkout=Path(intake.__file__).resolve().parent.parent
        for case in ('doc-link','archive-link','fifo','doc-oversize','archive-oversize','writable','hardlink','parent-link'):
            with self.subTest(case=case):
                doc.write_bytes(raw); self.archive.write_bytes(b'inert archive'); self.archive.chmod(0o644)
                if case=='doc-link': doc.unlink(); doc.symlink_to(self.archive)
                if case=='archive-link': self.archive.unlink(); self.archive.symlink_to(doc)
                if case=='fifo': self.archive.unlink(); os.mkfifo(self.archive)
                if case=='doc-oversize': doc.write_bytes(b'x'*(1024*1024+1))
                if case=='archive-oversize':
                    with self.archive.open('r+b') as stream: stream.truncate(intake.MAX_ARCHIVE+1)
                if case=='writable': self.archive.chmod(0o666)
                if case=='hardlink': os.link(self.archive,self.root/'hardlink')
                if case=='parent-link':
                    moved=self.slot.with_name('arm64-real'); self.slot.rename(moved); self.slot.symlink_to(moved, target_is_directory=True)
                try:
                    with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake,'validate_checkout'), self.assertRaises((ValueError,OSError)):
                        intake.validate_intake(doc,digest,self.archive,self.head,self.tree,self.head,checkout,self.approved)
                finally:
                    if case=='parent-link': self.slot.unlink(); moved.rename(self.slot)
                    if case in ('doc-link',): doc.unlink()
                    if case in ('archive-link','fifo','archive-oversize'): self.archive.unlink(); self.archive.write_bytes(b'inert archive')
                    if case=='hardlink': (self.root/'hardlink').unlink()

    def test_same_verified_descriptor_used_for_graph_and_staging(self):
        raw = json.dumps(self.record).encode(); doc=self.slot/'intake.json'; doc.write_bytes(raw)
        observed = []; staged_fd = []; real_stage = intake.stage_verified
        def stage(tree, stream, *args):
            staged_fd.append(stream.fileno()); return real_stage(tree, stream, *args)
        def graph(stream, store, cap, descriptor, **kwargs):
             observed.append((stream.fileno(),stream.read())); return self.graph
        checkout=Path(intake.__file__).resolve().parent.parent
        digest=hashlib.sha256(raw).hexdigest()
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake,'validate_checkout'), patch.object(intake,'verify_saved_image_file',side_effect=graph), patch.object(intake,'stage_verified',side_effect=stage):
            intake.validate_intake(doc,digest,self.archive,self.head,self.tree,self.head,checkout,self.approved,stage=True)
        self.assertEqual(observed[0][1],b'inert archive')
        self.assertEqual(staged_fd, [observed[0][0]])
        self.assertEqual((self.work/'inputs/image.tar').read_bytes(),b'inert archive')
        self.assertEqual((self.work/'inputs/image.tar').stat().st_mode & 0o777,0o600)

    def test_fixed_legacy_output_refuses_file_and_parent_replacement(self):
        output=self.work/'inputs/image.tar'; output.write_bytes(b'inert archive')
        store='sha256:'+'4'*64
        def replace_file(*args,**kwargs):
            output.rename(output.with_name('old.tar')); output.write_bytes(b'inert archive'); return self.graph
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake,'verify_saved_image_file',side_effect=replace_file):
            with self.assertRaises(ValueError): intake.verify_trusted_image(self.work,'target',store,1024**3)
        output.unlink(); output.symlink_to(self.archive)
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), self.assertRaises((ValueError,OSError)):
            intake.verify_trusted_image(self.work,'target',store,1024**3)
        output.unlink(); (self.work/'inputs/old.tar').unlink(); (self.work/'inputs').rmdir()
        (self.work/'inputs').symlink_to(self.slot,target_is_directory=True)
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), self.assertRaises((ValueError,OSError)):
            intake.verify_trusted_image(self.work,'target',store,1024**3)

    def test_path_replacement_during_graph_refuses_before_staging(self):
        raw=json.dumps(self.record).encode(); doc=self.slot/'intake.json'; doc.write_bytes(raw)
        def graph(*args,**kwargs):
            self.archive.rename(self.slot/'old.tar'); self.archive.write_bytes(b'inert archive'); return self.graph
        checkout=Path(intake.__file__).resolve().parent.parent
        digest=hashlib.sha256(raw).hexdigest()
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake,'validate_checkout'), patch.object(intake,'verify_saved_image_file',side_effect=graph):
            with self.assertRaises(ValueError): intake.validate_intake(doc,digest,self.archive,self.head,self.tree,self.head,checkout,self.approved,stage=True)
        self.assertFalse((self.work/'inputs/image.tar').exists())

    def test_document_or_parent_replacement_during_graph_refuses(self):
        for scenario in ('document', 'parent'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root=Path(directory).resolve(); work=root/'image-security'; slot=work/'retained/arm64'; slot.mkdir(parents=True); (work/'inputs').mkdir()
                archive=slot/'production-arm64.docker.tar'; archive.write_bytes(b'inert archive')
                raw=json.dumps(self.record).encode(); doc=slot/'intake.json'; doc.write_bytes(raw)
                def graph(*args,**kwargs):
                    if scenario=='document': doc.rename(slot/'old.json'); doc.write_bytes(raw)
                    else: slot.rename(slot.with_name('old-slot')); slot.mkdir()
                    return self.graph
                checkout=Path(intake.__file__).resolve().parent.parent
                digest=hashlib.sha256(raw).hexdigest()
                with patch.dict(os.environ, {'RUNNER_TEMP':str(root)}), patch.object(intake,'validate_checkout'), patch.object(intake,'verify_saved_image_file',side_effect=graph):
                    with self.assertRaises((ValueError,OSError)):
                        intake.validate_intake(doc,digest,archive,self.head,self.tree,self.head,checkout,self.approved,stage=True)
                self.assertFalse((work/'inputs/image.tar').exists())

    def test_bounded_hash_refuses_short_or_growing_input(self):
        for data in (b'abc', b'abcde'):
            stream = io.BytesIO(data)
            with self.subTest(data=data), self.assertRaises(ValueError):
                intake.bounded_hash(stream, 4)
        self.assertEqual(intake.bounded_hash(io.BytesIO(b'abcd'), 4), hashlib.sha256(b'abcd').hexdigest())

    def test_staged_path_replacement_is_not_deleted(self):
        raw=json.dumps(self.record).encode(); doc=self.slot/'intake.json'; doc.write_bytes(raw)
        staged=self.work/'inputs/image.tar'; moved=self.work/'inputs/original.tar'; real_check=intake.TrustedTree.check_file; changed=[]
        def check(tree, stream, identity, parent, name):
            if staged.exists() and not changed:
                changed.append(True); staged.rename(moved); staged.write_bytes(b'foreign')
            return real_check(tree, stream, identity, parent, name)
        checkout=Path(intake.__file__).resolve().parent.parent
        digest=hashlib.sha256(raw).hexdigest()
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake,'validate_checkout'), patch.object(intake,'verify_saved_image_file',return_value=self.graph), patch.object(intake.TrustedTree,'check_file',check):
            with self.assertRaisesRegex(ValueError, 'cleanup UNKNOWN'):
                intake.validate_intake(doc,digest,self.archive,self.head,self.tree,self.head,checkout,self.approved,stage=True)
        self.assertEqual(staged.read_bytes(),b'foreign'); self.assertEqual(moved.read_bytes(),b'inert archive')

    def test_failed_staging_never_unlinks_or_deletes_replacement(self):
        raw=json.dumps(self.record).encode(); doc=self.slot/'intake.json'; doc.write_bytes(raw)
        staged=self.work/'inputs/image.tar'; moved=self.work/'inputs/original.tar'; real_check=intake.TrustedTree.check_file; changed=[]
        def check(tree, stream, identity, parent, name):
            if staged.exists() and not changed:
                changed.append(True); staged.rename(moved); staged.write_bytes(b'foreign')
                raise ValueError('fixture failure before cleanup')
            return real_check(tree, stream, identity, parent, name)
        checkout=Path(intake.__file__).resolve().parent.parent
        digest=hashlib.sha256(raw).hexdigest()
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake,'validate_checkout'), patch.object(intake,'verify_saved_image_file',return_value=self.graph), patch.object(intake.TrustedTree,'check_file',check), patch.object(intake.os,'unlink',side_effect=AssertionError('unlink must not run')) as unlink:
            with self.assertRaisesRegex(ValueError, 'cleanup UNKNOWN'):
                intake.validate_intake(doc,digest,self.archive,self.head,self.tree,self.head,checkout,self.approved,stage=True)
            unlink.assert_not_called()
        self.assertEqual(staged.read_bytes(),b'foreign'); self.assertEqual(moved.read_bytes(),b'inert archive')

    def test_staging_cancellation_propagates_and_retains_partial_file(self):
        raw=json.dumps(self.record).encode(); doc=self.slot/'intake.json'; doc.write_bytes(raw)
        staged=self.work/'inputs/image.tar'; real_check=intake.TrustedTree.check_file
        def check(tree, stream, identity, parent, name):
            if staged.exists(): raise KeyboardInterrupt()
            return real_check(tree, stream, identity, parent, name)
        checkout=Path(intake.__file__).resolve().parent.parent
        digest=hashlib.sha256(raw).hexdigest()
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake,'validate_checkout'), patch.object(intake,'verify_saved_image_file',return_value=self.graph), patch.object(intake.TrustedTree,'check_file',check), patch.object(intake.os,'unlink',side_effect=AssertionError('unlink must not run')) as unlink:
            with self.assertRaises(KeyboardInterrupt):
                intake.validate_intake(doc,digest,self.archive,self.head,self.tree,self.head,checkout,self.approved,stage=True)
            unlink.assert_not_called()
        self.assertTrue(staged.is_file())

    def test_staged_capture_preserves_admitted_root_and_checks_fresh_descriptor(self):
        from test_image_archive_identity import fixture, write_archive
        from image_archive_identity import verify_saved_image
        members, root_id, config_id, root_descriptor, size = fixture(True, True, arch='arm64', source=self.approved['source'])
        child = json.loads(members['blobs/sha256/' + root_id[7:]])['manifests'][0]
        temporary_archive = write_archive(self.slot, members); temporary_archive.replace(self.archive)
        staged = self.work/'inputs/image.tar'; shutil.copyfile(self.archive, staged)
        graph = verify_saved_image(staged, child['digest'], size, root_descriptor, platform='linux/arm64', expected_source=self.approved['source'])
        self.record.update(store_id=child['digest'], store_id_role='manifest', root_digest=root_id,
                           manifest_digest=child['digest'], config_digest=config_id, descriptor=root_descriptor,
                           diff_ids=[item['diff_id'] for item in graph['layers']], archive_bytes=staged.stat().st_size,
                           archive_sha256=hashlib.sha256(staged.read_bytes()).hexdigest())
        doc=self.slot/'intake.json'; checkout=Path(intake.__file__).resolve().parent.parent
        def invoke(record, inspection):
            raw=json.dumps(record).encode(); doc.write_bytes(raw); digest=hashlib.sha256(raw).hexdigest()
            return intake.validate_intake(doc,digest,staged,self.head,self.tree,self.head,checkout,self.approved,staged=True,inspect_descriptor=inspection)
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake,'validate_checkout'):
            for inspection in (child, root_descriptor):
                with self.subTest(inspection=inspection): self.assertEqual(invoke(self.record,inspection)[1], graph)
            original=staged.read_bytes(); changed=bytearray(original); changed[-1] ^= 1; staged.write_bytes(changed)
            self.assertEqual(verify_saved_image(staged, child['digest'], size, root_descriptor, platform='linux/arm64', expected_source=self.approved['source']), graph)
            with self.assertRaisesRegex(ValueError, 'Archive hash mismatch'): invoke(self.record,child)
            staged.write_bytes(original)
            for key, value in [('digest','sha256:'+'f'*64),('mediaType','wrong'),('size',child['size']+1),('platform',{'os':'linux','architecture':'amd64'})]:
                bad=copy.deepcopy(child); bad[key]=value
                with self.subTest(key=key), self.assertRaises(ValueError): invoke(self.record,bad)
            with self.assertRaises(ValueError): invoke(self.record,{})
            wrong_record=copy.deepcopy(self.record); wrong_record['descriptor']['size'] += 1
            with self.assertRaises(ValueError): invoke(wrong_record,child)

    def test_real_classic_archive_is_verified_and_staged_through_fd(self):
        raw_layer=b'inert layer bytes'; diff='sha256:'+hashlib.sha256(raw_layer).hexdigest()
        config=json.dumps({'os':'linux','architecture':'arm64','config':{'Labels':{'org.dollhousemcp.engine-proof-source':self.approved['source']}},'rootfs':{'type':'layers','diff_ids':[diff]}},separators=(',',':')).encode()
        config_id='sha256:'+hashlib.sha256(config).hexdigest()
        entries={'config.json':config,'layer.tar':raw_layer,'manifest.json':json.dumps([{'Config':'config.json','Layers':['layer.tar']}]).encode()}
        with tarfile.open(self.archive,'w') as bundle:
            for name,data in entries.items():
                info=tarfile.TarInfo(name); info.size=len(data); bundle.addfile(info,io.BytesIO(data))
        self.record.update(store_id=config_id,config_digest=config_id,diff_ids=[diff],archive_bytes=self.archive.stat().st_size,archive_sha256=hashlib.sha256(self.archive.read_bytes()).hexdigest())
        raw=json.dumps(self.record).encode(); doc=self.slot/'intake.json'; doc.write_bytes(raw)
        checkout=Path(intake.__file__).resolve().parent.parent
        digest=hashlib.sha256(raw).hexdigest()
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake,'validate_checkout'):
            record, graph = intake.validate_intake(doc,digest,self.archive,self.head,self.tree,self.head,checkout,self.approved,stage=True)
        self.assertEqual(graph['config_digest'],config_id); self.assertEqual(graph['layers'][0]['diff_id'],diff)
        self.assertEqual(hashlib.sha256((self.work/'inputs/image.tar').read_bytes()).hexdigest(),record['archive_sha256'])
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake,'validate_checkout'):
            _, staged_graph = intake.validate_intake(doc,digest,self.work/'inputs/image.tar',self.head,self.tree,self.head,checkout,self.approved,staged=True,inspect_descriptor=None)
            self.assertEqual(staged_graph, graph)
            with self.assertRaises(ValueError):
                intake.validate_intake(doc,digest,self.work/'inputs/image.tar',self.head,self.tree,self.head,checkout,self.approved,staged=True,inspect_descriptor={})
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}):
            staged_graph, staged_hash = intake.verify_trusted_image(self.work, 'target', config_id, 1024**3,
                                                                     include_hash=True, platform='linux/arm64', expected_source=self.approved['source'])
            self.assertEqual(staged_graph, graph); self.assertEqual(staged_hash, record['archive_sha256'])
            with self.assertRaises(ValueError): intake.verify_trusted_image(self.root, 'target', config_id, 1024**3)
            with self.assertRaises(ValueError): intake.verify_trusted_image(self.work, 'other', config_id, 1024**3)


    def test_run_id_remains_ascii_only(self):
        record=copy.deepcopy(self.record); approved=copy.deepcopy(self.approved)
        record['run_id']=approved['run_id']='1٢'
        with self.assertRaises(ValueError): self.invoke(record, approved=approved)

    def test_wrong_owned_archive_refuses(self):
        raw=json.dumps(self.record).encode(); doc=self.slot/'intake.json'; doc.write_bytes(raw)
        real_stat=os.stat
        def fake_stat(path, *args, **kwargs):
            value=real_stat(path, *args, **kwargs)
            if path == 'production-arm64.docker.tar':
                values=list(value); values[4]=os.getuid()+1; return os.stat_result(values)
            return value
        checkout=Path(intake.__file__).resolve().parent.parent
        digest=hashlib.sha256(raw).hexdigest()
        with patch.dict(os.environ, {'RUNNER_TEMP':str(self.root)}), patch.object(intake,'validate_checkout'), patch.object(intake.os,'stat',side_effect=fake_stat):
            with self.assertRaisesRegex(ValueError, 'Untrusted or oversized'):
                intake.validate_intake(doc,digest,self.archive,self.head,self.tree,self.head,checkout,self.approved)

    def test_bad_bindings_and_dirty_checkout_refuse(self):
        mutations = [('source','f'*40), ('tree','f'*40), ('run_id','1'), ('attempt',2), ('runtime_receipt_sha256','f'*64),
                     ('archive_sha256','f'*64), ('archive_bytes',1), ('platform','linux/ppc64le'), ('store_id_role','manifest'),
                     ('config_digest','sha256:'+'f'*64), ('diff_ids',['sha256:'+'f'*64])]
        for key,value in mutations:
            with self.subTest(key=key), self.assertRaises((ValueError, TypeError)):
                record=copy.deepcopy(self.record); record[key]=value; self.invoke(record)
        for kwargs in ({'github':'f'*40}, {'git_values':['f'*40,self.tree,'']}, {'git_values':[self.head,'f'*40,'']},
                       {'git_values':[self.head,self.tree,' M scripts/scan-built-image.py']}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError): self.invoke(**kwargs)
        with self.assertRaises(ValueError): self.invoke(raw=b'{"schema":"a","schema":"b"}')
        record=copy.deepcopy(self.record); record['unexpected']=True
        with self.assertRaises(ValueError): self.invoke(record)

if __name__ == '__main__': unittest.main()
