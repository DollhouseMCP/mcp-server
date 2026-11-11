#!/usr/bin/env python3
"""External command forms of the hosted deploy tooling, and which of them a rehearsal exercised.

A form is the fixed leading part of one docker, nsenter or curl command that
scripts/hosted-deploy/*.py builds: its literal words in order, with a
placeholder wherever the source supplies a value. command-forms.json is the
checked-in list. tests/scripts/test_hosted_caddy_replica_command_forms.py fails
when the source and that list differ, so a new form cannot appear unlisted.

A rehearsal records every child process the tooling starts (see
recorder/sitecustomize.py). Each recorded docker, nsenter or curl command counts
for the most specific form it starts with. `coverage` then fails unless every
listed form was issued at least once and no recorded command is outside the
list. A fake cannot satisfy it: the record is written when the real process
is started.

    command_forms.py scan                 print the forms found in the source
    cat LOG... | command_forms.py coverage    exit 0 when the logs exercise every form, 3 otherwise

Limits. A form is a prefix: words that the source appends later, such as the
POST body options of the private Caddy request, belong to the same form. Shell
commands in scripts/hosted-deploy/*.sh are outside this list.
"""
import ast
import json
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / 'hosted-deploy'
FORMS_FILE = HERE / 'command-forms.json'
PROGRAMS = {'docker': 'docker', 'DOCKER': 'docker', 'NSENTER': 'nsenter', 'CURL': 'curl'}
ONE = None  # exactly one argument supplied at run time
MANY = []  # any number of arguments supplied at run time


def program(node):
    if isinstance(node, ast.Constant) and node.value == 'docker':
        return 'docker'
    return PROGRAMS.get(getattr(node, 'id', None) or getattr(node, 'attr', None))


def words(nodes):
    result = []
    for node in nodes:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            result.append(node.value)
        else:
            result.append(MANY if isinstance(node, ast.Starred) else ONE)
    return result


def call_form(node):
    name = getattr(node.func, 'id', getattr(node.func, 'attr', None))
    if name == 'docker_json':
        literal = next((arg for arg in node.args if isinstance(arg, ast.List)), None)
        return ['docker', *words(literal.elts)] if literal is not None else None
    if name == 'inspect_one' and len(node.args) >= 2 and isinstance(node.args[-2], ast.Constant):
        return ['docker', node.args[-2].value, 'inspect', ONE]
    if name == 'inspect_volumes':
        return ['docker', 'volume', 'inspect', ONE]
    return None


def scan(directory=SOURCE):
    """Every form in the source, with the places that build it."""
    found = {}
    for path in sorted(Path(directory).glob('*.py')):
        for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
            form = None
            if isinstance(node, ast.List) and node.elts and program(node.elts[0]):
                form = [program(node.elts[0]), *words(node.elts[1:])]
            elif isinstance(node, ast.Call):
                form = call_form(node)
            # A docker list with no literal subcommand is a wrapper around a form built elsewhere.
            if form is not None and len(form) > 1 and (form[0] != 'docker' or isinstance(form[1], str)):
                found.setdefault(json.dumps(form), []).append('%s:%d' % (path.name, node.lineno))
    return {key: sorted(places) for key, places in sorted(found.items())}


def listed():
    forms = json.loads(FORMS_FILE.read_text(encoding='utf-8'))
    if not isinstance(forms, list) or len({json.dumps(form) for form in forms}) != len(forms):
        raise ValueError('command form list is malformed or repeats a form')
    return forms


def matches(form, argv):
    """True when argv starts with the form. Later arguments are free."""
    if not form:
        return True
    head, rest = form[0], form[1:]
    if head == MANY:
        return any(matches(rest, argv[skip:]) for skip in range(len(argv) + 1))
    if not argv:
        return False
    return (head is ONE or head == argv[0]) and matches(rest, argv[1:])


def normalised(argv):
    """A recorded command as the forms name it, or None for any other program."""
    if not isinstance(argv, list) or not argv or not all(isinstance(item, str) for item in argv):
        return None
    name = os.path.basename(argv[0])
    return [name, *argv[1:]] if name in ('docker', 'nsenter', 'curl') else None


def recorded(lines):
    """The docker, nsenter and curl commands among the recorder's log lines."""
    commands = (normalised(json.loads(line).get('argv')) for line in lines if line.strip())
    return [command for command in commands if command is not None]


def display(form):
    return ' '.join('<arg>' if item is ONE else '<args>' if item == MANY else item for item in form)


def assigned(forms, command):
    """The index of the most specific form the command starts with, or None."""
    candidates = [index for index, form in enumerate(forms) if matches(form, command)]
    return max(candidates, key=lambda index: (sum(isinstance(item, str) for item in forms[index]), len(forms[index])),
               default=None)


def coverage(forms, commands):
    """Which forms the commands exercised, and which commands no form explains."""
    counts, unlisted = [0] * len(forms), set()
    for command in commands:
        index = assigned(forms, command)
        if index is None:
            unlisted.add(display(command[:3]))
        else:
            counts[index] += 1
    unlisted = sorted(unlisted)
    return {'schema': 1, 'forms': len(forms), 'commands': len(commands),
            'exercised': [{'form': display(form), 'count': count} for form, count in zip(forms, counts) if count],
            'unexercised': [display(form) for form, count in zip(forms, counts) if not count],
            'unlisted': unlisted, 'complete': all(counts) and not unlisted}


def main(argv):
    if argv[1:] == ['scan']:
        print('[\n' + ',\n'.join(' ' + key for key in scan()) + '\n]')  # one form per line
        return 0
    if argv[1:] == ['coverage']:
        report = coverage(listed(), recorded(sys.stdin))
        print(json.dumps(report, indent=1))
        return 0 if report['complete'] else 3
    raise ValueError('usage: command_forms.py scan | coverage < LOG')


if __name__ == '__main__':
    sys.exit(main(sys.argv))
