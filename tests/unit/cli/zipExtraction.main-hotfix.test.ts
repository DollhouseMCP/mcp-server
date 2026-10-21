import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import archiver from 'archiver';
import { extractZipForConversion } from '../../../src/cli/zipExtraction.js';

const roots: string[] = [];
const skill = '---\nname: Safe Skill\ndescription: Safe conversion fixture\n---\n\n# Safe Skill\n\nUse safely.\n';

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-safety-test-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'sibling.txt'), 'keep sibling');
    return root;
}

async function createZip(zipPath: string, populate: (archive: archiver.Archiver) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip');
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        populate(archive);
        archive.finalize().catch(reject);
    });
}

function extractionRoots(root: string): string[] {
    return fs.readdirSync(root).filter(name => name.startsWith('dollhouse-extract-'));
}

describe('main conversion ZIP safety', () => {
    it.each(['flat', 'nested', 'multiple'])('retains exact private cleanup ownership for %s layout', async layout => {
        const root = fixture();
        const zipPath = path.join(root, 'skill.zip');
        await createZip(zipPath, archive => {
            const prefix = layout === 'nested' ? 'safe-skill/' : '';
            archive.append(skill, { name: `${prefix}SKILL.md` });
            if (layout === 'multiple') {
                archive.append('a', { name: 'one/file.txt' });
                archive.append('b', { name: 'two/file.txt' });
            }
        });
        const result = await extractZipForConversion(zipPath, { tempParent: root });
        expect(path.dirname(result.tempDir)).toBe(root);
        expect(result.actualInput).toBe(layout === 'nested' ? path.join(result.tempDir, 'safe-skill') : result.tempDir);
        expect(fs.readFileSync(path.join(result.actualInput, 'SKILL.md'), 'utf8')).toBe(skill);
        fs.rmSync(result.tempDir, { recursive: true, force: true });
        expect(extractionRoots(root)).toEqual([]);
        expect(fs.readFileSync(path.join(root, 'sibling.txt'), 'utf8')).toBe('keep sibling');
    });

    it.each(['same-name', 'nested-target'])('refuses %s symlink payload before touching an isolated outside sentinel', async shape => {
        const root = fixture();
        const outside = path.join(root, 'outside');
        fs.mkdirSync(outside);
        const sentinel = path.join(outside, 'keep.txt');
        fs.writeFileSync(sentinel, 'unchanged');
        const zipPath = path.join(root, 'links.zip');
        await createZip(zipPath, archive => {
            archive.append('partial', { name: 'ordinary.txt' });
            archive.symlink('escape', shape === 'same-name' ? sentinel : outside);
            archive.append('replacement', { name: shape === 'same-name' ? 'escape' : 'escape/keep.txt' });
        });
        await expect(extractZipForConversion(zipPath, { tempParent: root })).rejects.toThrow('Symbolic links');
        expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
        expect(extractionRoots(root)).toEqual([]);
        expect(fs.readFileSync(path.join(root, 'sibling.txt'), 'utf8')).toBe('keep sibling');
    });

    it('cleans an owned root when extraction or its start observer fails', async () => {
        const root = fixture();
        const zipPath = path.join(root, 'invalid.zip');
        fs.writeFileSync(zipPath, 'not a ZIP');
        await expect(extractZipForConversion(zipPath, { tempParent: root })).rejects.toThrow();
        const failure = new Error('observer refused');
        await expect(extractZipForConversion(zipPath, {
            tempParent: root, onStart() { throw failure; },
        })).rejects.toBe(failure);
        expect(extractionRoots(root)).toEqual([]);
        expect(fs.readFileSync(path.join(root, 'sibling.txt'), 'utf8')).toBe('keep sibling');
    });

    it.each(['nested', 'flat', 'dry-run', 'refusal'])('real CLI completes cleanup before exit for %s', async scenario => {
        const root = fixture();
        const tempParent = path.join(root, 'tmp');
        fs.mkdirSync(tempParent);
        const sibling = path.join(tempParent, 'sibling.txt');
        fs.writeFileSync(sibling, 'keep sibling');
        const zipPath = path.join(root, 'skill.zip');
        await createZip(zipPath, archive => {
            if (scenario === 'refusal') archive.symlink('escape', sibling);
            else archive.append(skill, { name: scenario === 'nested' ? 'safe-skill/SKILL.md' : 'SKILL.md' });
        });
        const output = path.join(root, 'output');
        const args = [path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
            path.join(process.cwd(), 'src/cli/convert.ts'), 'from-anthropic', zipPath, '--output', output];
        if (scenario === 'dry-run') args.push('--dry-run');
        const child = spawnSync(process.execPath, args, {
            cwd: process.cwd(), encoding: 'utf8',
            env: { ...process.env, TMPDIR: tempParent, TMP: tempParent, TEMP: tempParent },
        });
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(scenario === 'refusal' ? 1 : 0);
        if (scenario === 'refusal') expect(child.stderr).toContain('Symbolic links');
        else expect(child.stderr).toBe('');
        if (scenario === 'nested' || scenario === 'flat') {
            const outputFiles = fs.readdirSync(output);
            expect(outputFiles).toHaveLength(1);
            expect(fs.readFileSync(path.join(output, outputFiles[0]), 'utf8')).toContain('name: Safe Skill');
        } else expect(fs.existsSync(output)).toBe(false);
        expect(extractionRoots(tempParent)).toEqual([]);
        expect(fs.readFileSync(sibling, 'utf8')).toBe('keep sibling');
    });
});
