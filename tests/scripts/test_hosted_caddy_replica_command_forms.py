"""The external command form list matches the source, and coverage cannot be claimed without a record.

Synthetic values only. The record of a real rehearsal stays on the replica.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-replica'))
import command_forms as forms

RECORDER = SCRIPTS / 'hosted-replica' / 'recorder'
TARGET = 'a' * 64


class CommandFormTests(unittest.TestCase):
    def test_checked_in_list_is_exactly_what_the_source_builds(self):
        self.assertEqual([json.loads(key) for key in forms.scan()], forms.listed(),
                         'run scripts/hosted-replica/command_forms.py scan > scripts/hosted-replica/command-forms.json')

    def test_scan_command_prints_the_list_as_it_is_checked_in(self):
        done = subprocess.run([sys.executable, str(SCRIPTS / 'hosted-replica' / 'command_forms.py'), 'scan'],
                              capture_output=True, check=True)
        self.assertEqual(done.stdout.decode('utf-8'), forms.FORMS_FILE.read_text(encoding='utf-8'))

    def test_every_form_names_a_program_and_a_literal_word(self):
        for form in forms.listed():
            self.assertIn(form[0], ('docker', 'nsenter', 'curl'))
            self.assertTrue(any(isinstance(item, str) for item in form[1:]), form)

    def test_scan_reads_lists_helpers_and_constants(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'sample.py').write_text(
                "run(['docker', 'stop', '--time', '5', name], 1, 2)\n"
                "run([DOCKER, *command[1:]], 1, 2)\n"
                "bounded([NSENTER, '--net=' + path, '--', CURL, '--fail'])\n"
                "inspect_one(run, 'volume', name)\n"
                "inspect_one(run, kind, name)\n"
                "docker_json(run, ['info', '--format', '{{json .}}'])\n", encoding='utf-8')
            found = [json.loads(key) for key in forms.scan(directory)]
        self.assertEqual(found, [['docker', 'info', '--format', '{{json .}}'], ['docker', 'stop', '--time', '5', None],
                                 ['docker', 'volume', 'inspect', None], ['nsenter', None, '--', None, '--fail']])

    def test_form_is_a_prefix_with_placeholders(self):
        stop = ['docker', 'stop', '--time', '5', None]
        self.assertTrue(forms.matches(stop, ['docker', 'stop', '--time', '5', TARGET]))
        self.assertFalse(forms.matches(stop, ['docker', 'stop', '--time', '9', TARGET]))
        self.assertFalse(forms.matches(stop, ['docker', 'stop', '--time', '5']))
        self.assertTrue(forms.matches(['docker', 'create', None], ['docker', 'create', TARGET, '--later', 'words']))
        self.assertTrue(forms.matches(['curl', '--request', None, [], '--silent'], ['curl', '--request', 'GET', '--silent']))
        self.assertTrue(forms.matches(['curl', '--request', None, [], '--silent'],
                                      ['curl', '--request', 'GET', '--header', 'x', '--silent']))

    def test_command_counts_for_its_most_specific_form_only(self):
        listed = [['docker', 'start', None], ['docker', 'start', '--attach', None]]
        report = forms.coverage(listed, [['docker', 'start', '--attach', TARGET]])
        self.assertEqual(report['exercised'], [{'form': 'docker start --attach <arg>', 'count': 1}])
        self.assertEqual(report['unexercised'], ['docker start <arg>'])
        self.assertFalse(report['complete'])

    def test_coverage_needs_every_form_and_no_unlisted_command(self):
        listed = [['docker', 'rm', None], ['nsenter', None, '--', '/usr/bin/true']]
        both = [['docker', 'rm', TARGET], ['nsenter', '--net=/proc/self/fd/3', '--', '/usr/bin/true']]
        self.assertTrue(forms.coverage(listed, both)['complete'])
        self.assertFalse(forms.coverage(listed, both[:1])['complete'])
        extra = forms.coverage(listed, both + [['docker', 'kill', TARGET]])
        self.assertEqual((extra['unlisted'], extra['complete']), (['docker kill ' + TARGET], False))

    def test_other_programs_are_not_commands_under_the_list(self):
        self.assertIsNone(forms.normalised(['/usr/bin/flock', '--help']))
        self.assertEqual(forms.normalised(['/usr/bin/docker', 'info']), ['docker', 'info'])
        self.assertIsNone(forms.normalised('docker info'))

    def run_recorded(self, directory, log):
        environment = {key: value for key, value in os.environ.items() if key != 'DOLLHOUSE_REPLICA_COMMAND_LOG'}
        environment['PYTHONPATH'] = str(RECORDER)
        if log is not None:
            environment['DOLLHOUSE_REPLICA_COMMAND_LOG'] = str(log)
        subprocess.run([sys.executable, '-c', 'import subprocess, sys; subprocess.run([sys.executable, "-c", "pass"])'],
                       check=True, cwd=directory, env=environment)

    def test_recorder_writes_real_child_processes_to_a_private_log(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory, 'commands.jsonl')
            self.run_recorded(directory, log)
            self.run_recorded(directory, log)
            lines = [json.loads(line) for line in log.read_text(encoding='utf-8').splitlines()]
            self.assertEqual([line['argv'] for line in lines], [[sys.executable, '-c', 'pass']] * 2)
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)
            self.assertEqual(forms.recorded([log]), [])

    def test_recorder_does_nothing_without_a_log(self):
        with tempfile.TemporaryDirectory() as directory:
            self.run_recorded(directory, None)
            self.assertEqual(os.listdir(directory), [])

    def test_coverage_command_reports_and_fails_on_a_gap(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory, 'commands.jsonl')
            log.write_text(json.dumps({'argv': ['/usr/bin/docker', 'ps', '--no-trunc', '--quiet']}) + '\n', encoding='utf-8')
            done = subprocess.run([sys.executable, str(SCRIPTS / 'hosted-replica' / 'command_forms.py'), 'coverage', str(log)],
                                  capture_output=True, check=False)
        report = json.loads(done.stdout)
        self.assertEqual(done.returncode, 3)
        self.assertEqual(report['exercised'], [{'form': 'docker ps --no-trunc --quiet', 'count': 1}])
        self.assertEqual(len(report['unexercised']), report['forms'] - 1)


if __name__ == '__main__':
    unittest.main()
