import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import archiver from 'archiver';
import {
    extractZipForConversion,
    MAX_EXTRACTED_SIZE_BYTES,
    MAX_ZIP_ENTRIES,
    MAX_ZIP_SIZE_BYTES,
    type ZipEntryMetadata,
    type ZipValidationState,
    validateZipEntryForExtraction,
} from '../../../src/cli/zipExtraction.js';

const cleanupPaths: string[] = [];

afterEach(() => {
    for (const cleanupPath of cleanupPaths.splice(0)) {
        fs.rmSync(cleanupPath, { recursive: true, force: true });
    }
});

describe('secure ZIP extraction', () => {
    it('extracts a normal skill and reports the exact temporary root', async () => {
        const fixture = createFixtureDirectory();
        const zipPath = path.join(fixture, 'skill.zip');
        await createZip(zipPath, archive => {
            archive.append('---\nname: safe-skill\n---\n', { name: 'safe-skill/SKILL.md' });
            archive.append('echo safe\n', { name: 'safe-skill/scripts/test.sh' });
        });

        const result = await extractZipForConversion(zipPath, { tempParent: fixture });
        cleanupPaths.push(result.tempDir);

        expect(path.dirname(result.tempDir)).toBe(fixture);
        expect(result.actualInput).toBe(path.join(result.tempDir, 'safe-skill'));
        expect(fs.readFileSync(path.join(result.actualInput, 'SKILL.md'), 'utf8')).toContain('safe-skill');
    });

    it('converts a ZIP through the real CLI and removes its temporary extraction root', async () => {
        const fixture = createFixtureDirectory();
        const zipPath = path.join(fixture, 'skill.zip');
        const outputDir = path.join(fixture, 'output');
        const tempDir = path.join(fixture, 'tmp');
        fs.mkdirSync(tempDir);
        await createZip(zipPath, archive => {
            archive.append(
                '---\nname: Safe Skill\ndescription: Safe conversion fixture\n---\n\n# Safe Skill\n\nUse safely.\n',
                { name: 'safe-skill/SKILL.md' },
            );
        });

        const cliResult = spawnSync(process.execPath, [
            path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
            path.join(process.cwd(), 'src/cli/convert.ts'),
            'from-anthropic',
            zipPath,
            '--output',
            outputDir,
        ], {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: { ...process.env, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir },
        });

        expect(cliResult.stderr).toBe('');
        expect(cliResult.status).toBe(0);
        expect(fs.readFileSync(path.join(outputDir, 'safe-skill.md'), 'utf8'))
            .toContain('name: Safe Skill');
        expect(extractionDirectories(tempDir)).toEqual([]);
    });

    it('keeps the extraction root as cleanup ownership for multiple top-level entries', async () => {
        const fixture = createFixtureDirectory();
        const zipPath = path.join(fixture, 'multi-root.zip');
        await createZip(zipPath, archive => {
            archive.append('skill', { name: 'SKILL.md' });
            archive.append('reference', { name: 'references/example.txt' });
        });

        const result = await extractZipForConversion(zipPath, { tempParent: fixture });
        cleanupPaths.push(result.tempDir);

        expect(result.actualInput).toBe(result.tempDir);
        expect(path.dirname(result.tempDir)).toBe(fixture);
    });

    it('selects the sole skill directory when harmless root files are present', async () => {
        const fixture = createFixtureDirectory();
        const zipPath = path.join(fixture, 'skill-with-readme.zip');
        await createZip(zipPath, archive => {
            archive.append('root notes', { name: 'README.md' });
            archive.append('skill', { name: 'safe-skill/SKILL.md' });
        });

        const result = await extractZipForConversion(zipPath, { tempParent: fixture });
        cleanupPaths.push(result.tempDir);

        expect(result.actualInput).toBe(path.join(result.tempDir, 'safe-skill'));
    });

    it('rejects duplicate file destinations and removes partial output', async () => {
        const fixture = createFixtureDirectory();
        const zipPath = path.join(fixture, 'duplicate.zip');
        await createZip(zipPath, archive => {
            archive.append('first', { name: 'SKILL.md' });
            archive.append('second', { name: 'SKILL.md' });
        });

        await expect(extractZipForConversion(zipPath, { tempParent: fixture }))
            .rejects.toThrow();
        expect(extractionDirectories(fixture)).toEqual([]);
    });

    it('rejects an archive symlink before materializing it and removes partial output', async () => {
        const fixture = createFixtureDirectory();
        const zipPath = path.join(fixture, 'symlink.zip');
        await createZip(zipPath, archive => {
            archive.append('skill', { name: 'safe/SKILL.md' });
            archive.symlink('safe/outside', '../../outside.txt');
        });

        await expect(extractZipForConversion(zipPath, { tempParent: fixture }))
            .rejects.toThrow('Symbolic links are not allowed');
        expect(extractionDirectories(fixture)).toEqual([]);
    });

    it('rejects a nested path that would traverse an earlier archive symlink', async () => {
        const fixture = createFixtureDirectory();
        const zipPath = path.join(fixture, 'nested-symlink.zip');
        await createZip(zipPath, archive => {
            archive.symlink('redirect', '../outside');
            archive.append('escape attempt', { name: 'redirect/escaped.txt' });
        });

        await expect(extractZipForConversion(zipPath, { tempParent: fixture }))
            .rejects.toThrow('Symbolic links are not allowed');
        expect(fs.existsSync(path.join(fixture, 'outside', 'escaped.txt'))).toBe(false);
        expect(extractionDirectories(fixture)).toEqual([]);
    });

    it('enforces expanded-size limits during extraction and removes partial output', async () => {
        const fixture = createFixtureDirectory();
        const zipPath = path.join(fixture, 'oversized.zip');
        await createZip(zipPath, archive => {
            archive.append('1234567890', { name: 'first.txt' });
            archive.append('abcdefghij', { name: 'second.txt' });
        });

        await expect(extractZipForConversion(zipPath, {
            tempParent: fixture,
            limits: { maxExpandedBytes: 15 },
        })).rejects.toThrow('Extracted content too large');
        expect(extractionDirectories(fixture)).toEqual([]);
    });

    it('removes its temporary root when start logging fails', async () => {
        const fixture = createFixtureDirectory();
        const zipPath = path.join(fixture, 'logging-failure.zip');
        await createZip(zipPath, archive => {
            archive.append('skill', { name: 'SKILL.md' });
        });

        await expect(extractZipForConversion(zipPath, {
            tempParent: fixture,
            onStart: () => {
                throw new Error('logging failed');
            },
        })).rejects.toThrow('logging failed');
        expect(extractionDirectories(fixture)).toEqual([]);
    });

    it('rejects symlink ZIP inputs instead of following them', async () => {
        if (process.platform === 'win32') return;
        const fixture = createFixtureDirectory();
        const zipPath = path.join(fixture, 'skill.zip');
        const linkPath = path.join(fixture, 'linked.zip');
        await createZip(zipPath, archive => {
            archive.append('skill', { name: 'SKILL.md' });
        });
        fs.symlinkSync(zipPath, linkPath);

        await expect(extractZipForConversion(linkPath, { tempParent: fixture }))
            .rejects.toThrow('ZIP input must be a regular file');
        expect(extractionDirectories(fixture)).toEqual([]);
    });

    it.each([
        ['path traversal', fakeEntry('../outside.txt')],
        ['absolute path', fakeEntry('/outside.txt')],
        ['symbolic link', fakeEntry('link', 0o120777)],
        ['device', fakeEntry('device', 0o020666)],
        ['Windows reparse point', fakeEntry('junction', 0, 0x0400)],
        ['UNIX linked entry metadata', fakeEntry('linked', 0o100644, 0, 13)],
        ['ASI hard-link metadata', fakeEntryWithAsiMetadata('hard-link', 0o100644, 15)],
    ])('rejects %s', (_label, entry) => {
        expect(() => validateZipEntryForExtraction(
            entry,
            os.tmpdir(),
            freshState(),
            defaultLimits(),
        )).toThrow();
    });

    it('rejects encrypted entries, excessive entry counts, and invalid sizes', () => {
        const encrypted = { ...fakeEntry('secret.txt'), generalPurposeBitFlag: 1 };
        expect(() => validateZipEntryForExtraction(
            encrypted,
            os.tmpdir(),
            freshState(),
            defaultLimits(),
        )).toThrow('Encrypted ZIP entries are not supported');

        const fullState = { entryCount: MAX_ZIP_ENTRIES, expandedBytes: 0 };
        expect(() => validateZipEntryForExtraction(
            fakeEntry('one-too-many.txt'),
            os.tmpdir(),
            fullState,
            defaultLimits(),
        )).toThrow('ZIP contains too many entries');

        const invalidSize = { ...fakeEntry('invalid.txt'), uncompressedSize: Number.MAX_VALUE };
        expect(() => validateZipEntryForExtraction(
            invalidSize,
            os.tmpdir(),
            freshState(),
            defaultLimits(),
        )).toThrow('invalid expanded size');
    });

    it('treats an unspecified UNIX mode as a regular entry', () => {
        expect(() => validateZipEntryForExtraction(
            fakeEntry('unspecified-mode.txt', 0),
            os.tmpdir(),
            freshState(),
            defaultLimits(),
        )).not.toThrow();
    });
});

function createFixtureDirectory(): string {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-extraction-test-'));
    cleanupPaths.push(fixture);
    return fixture;
}

async function createZip(
    outputPath: string,
    populate: (archive: archiver.Archiver) => void,
): Promise<void> {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    await new Promise<void>((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        populate(archive);
        archive.finalize().catch(reject);
    });
}

function extractionDirectories(fixture: string): string[] {
    return fs.readdirSync(fixture).filter(name => name.startsWith('dollhouse-extract-'));
}

function fakeEntry(
    fileName: string,
    unixMode = 0o100644,
    dosAttributes = 0,
    unixExtraFieldSize = 0,
): ZipEntryMetadata {
    return {
        fileName,
        externalFileAttributes: (((unixMode << 16) >>> 0) | dosAttributes) >>> 0,
        versionMadeBy: 3 << 8,
        generalPurposeBitFlag: 0,
        uncompressedSize: 1,
        extraFields: unixExtraFieldSize > 0
            ? [{ id: 0x000d, data: Buffer.alloc(unixExtraFieldSize) }]
            : [],
    };
}

function fakeEntryWithAsiMetadata(
    fileName: string,
    unixMode: number,
    fieldSize: number,
): ZipEntryMetadata {
    const data = Buffer.alloc(fieldSize);
    data.writeUInt16LE(unixMode, 4);
    return {
        ...fakeEntry(fileName, unixMode),
        extraFields: [{ id: 0x756e, data }],
    };
}

function freshState(): ZipValidationState {
    return { entryCount: 0, expandedBytes: 0 };
}

function defaultLimits() {
    return {
        maxArchiveBytes: MAX_ZIP_SIZE_BYTES,
        maxExpandedBytes: MAX_EXTRACTED_SIZE_BYTES,
        maxEntries: MAX_ZIP_ENTRIES,
    };
}
