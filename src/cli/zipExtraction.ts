import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export const MAX_ZIP_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_EXTRACTED_SIZE_BYTES = 500 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 10_000;

const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMBOLIC_LINK = 0o120000;
const DOS_DIRECTORY = 0x0010;
const DOS_REPARSE_POINT = 0x0400;
const INFO_ZIP_UNIX_EXTRA_FIELD = 0x000d;
const ASI_UNIX_EXTRA_FIELD = 0x756e;
const UNIX_HOST_SYSTEMS = new Set([3, 19]);

export interface ZipEntryMetadata {
    readonly fileName: string;
    readonly externalFileAttributes: number;
    readonly versionMadeBy: number;
    readonly generalPurposeBitFlag: number;
    readonly uncompressedSize: number;
    readonly extraFields?: ReadonlyArray<{
        readonly id: number;
        readonly data: Buffer;
    }>;
}

export interface ZipExtractionLimits {
    readonly maxArchiveBytes: number;
    readonly maxExpandedBytes: number;
    readonly maxEntries: number;
}

export interface ZipValidationState {
    entryCount: number;
    expandedBytes: number;
}

export interface ZipExtractionStart {
    readonly archiveSize: number;
    readonly tempDir: string;
}

export interface ZipExtractionResult extends ZipExtractionStart {
    readonly actualInput: string;
    readonly expandedSize: number;
    readonly elapsedMs: number;
}

interface ZipExtractionOptions {
    readonly limits?: Partial<ZipExtractionLimits>;
    readonly tempParent?: string;
    readonly onStart?: (context: ZipExtractionStart) => void;
}

const DEFAULT_LIMITS: ZipExtractionLimits = {
    maxArchiveBytes: MAX_ZIP_SIZE_BYTES,
    maxExpandedBytes: MAX_EXTRACTED_SIZE_BYTES,
    maxEntries: MAX_ZIP_ENTRIES,
};

/**
 * Extract one validated entry at a time and create only private directories and regular files.
 * Archive permissions are never applied, so link and special-file metadata cannot become active.
 */
export async function extractZipForConversion(
    zipPath: string,
    options: ZipExtractionOptions = {},
): Promise<ZipExtractionResult> {
    const limits = resolveLimits(options.limits);
    const archiveStats = fs.lstatSync(zipPath);
    if (!archiveStats.isFile()) {
        throw new Error('ZIP input must be a regular file');
    }
    if (archiveStats.size > limits.maxArchiveBytes) {
        throw new Error(
            `ZIP file too large: ${formatBytes(archiveStats.size)}. ` +
            `Maximum allowed: ${formatBytes(limits.maxArchiveBytes)}.`,
        );
    }

    const tempParent = path.resolve(options.tempParent ?? os.tmpdir());
    fs.mkdirSync(tempParent, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(tempParent, 'dollhouse-extract-'));
    const startedAt = Date.now();

    try {
        options.onStart?.({ archiveSize: archiveStats.size, tempDir });
        await extractArchive(zipPath, tempDir, limits);
        const expandedSize = inspectExtractedTree(tempDir, limits.maxExpandedBytes);
        return {
            actualInput: selectConversionInput(tempDir),
            tempDir,
            archiveSize: archiveStats.size,
            expandedSize,
            elapsedMs: Date.now() - startedAt,
        };
    } catch (error) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw error;
    }
}

export function validateZipEntryForExtraction(
    entry: ZipEntryMetadata,
    destinationRoot: string,
    state: ZipValidationState,
    limits: ZipExtractionLimits = DEFAULT_LIMITS,
): void {
    validateEntryPath(entry.fileName, destinationRoot);
    validateEntryType(entry);

    if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
        throw new Error(`Encrypted ZIP entries are not supported: ${entry.fileName}`);
    }
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
        throw new Error(`ZIP entry has an invalid expanded size: ${entry.fileName}`);
    }

    const nextEntryCount = state.entryCount + 1;
    if (nextEntryCount > limits.maxEntries) {
        throw new Error(`ZIP contains too many entries. Maximum allowed: ${limits.maxEntries}`);
    }

    const nextExpandedBytes = state.expandedBytes + entry.uncompressedSize;
    if (!Number.isSafeInteger(nextExpandedBytes) || nextExpandedBytes > limits.maxExpandedBytes) {
        throw new Error(
            `Extracted content too large. Maximum allowed: ${formatBytes(limits.maxExpandedBytes)}.`,
        );
    }

    state.entryCount = nextEntryCount;
    state.expandedBytes = nextExpandedBytes;
}

function resolveLimits(overrides?: Partial<ZipExtractionLimits>): ZipExtractionLimits {
    const limits = { ...DEFAULT_LIMITS, ...overrides };
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`ZIP extraction limit ${name} must be a positive safe integer`);
        }
    }
    return limits;
}

function extractArchive(
    zipPath: string,
    destinationRoot: string,
    limits: ZipExtractionLimits,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let zipFile: ZipFile | undefined;
        let settled = false;
        const state: ZipValidationState = { entryCount: 0, expandedBytes: 0 };
        const extracted = { bytes: 0 };

        const fail = (reason: unknown): void => {
            if (settled) return;
            settled = true;
            if (zipFile?.isOpen) zipFile.close();
            reject(toError(reason));
        };

        yauzl.open(zipPath, {
            autoClose: true,
            lazyEntries: true,
            decodeStrings: true,
            validateEntrySizes: true,
            strictFileNames: true,
        }, (openError, openedZip) => {
            if (openError || !openedZip) {
                fail(openError ?? new Error('Unable to open ZIP file'));
                return;
            }
            zipFile = openedZip;
            if (openedZip.entryCount > limits.maxEntries) {
                fail(new Error(`ZIP contains too many entries. Maximum allowed: ${limits.maxEntries}`));
                return;
            }

            openedZip.on('error', fail);
            openedZip.on('end', () => {
                if (settled) return;
                settled = true;
                resolve();
            });
            openedZip.on('entry', (entry: Entry) => {
                try {
                    validateZipEntryForExtraction(entry, destinationRoot, state, limits);
                } catch (validationError) {
                    fail(validationError);
                    return;
                }

                // Lazy entry reads remain sequential: the shared byte ceiling is updated by one
                // extraction at a time, and the next entry is requested only after it completes.
                extractEntry(openedZip, entry, destinationRoot, extracted, limits.maxExpandedBytes)
                    .then(() => {
                        if (!settled) openedZip.readEntry();
                    })
                    .catch(fail);
            });
            openedZip.readEntry();
        });
    });
}

async function extractEntry(
    zipFile: ZipFile,
    entry: Entry,
    destinationRoot: string,
    extracted: { bytes: number },
    maxExpandedBytes: number,
): Promise<void> {
    // Preserve extract-zip's handling of Finder metadata without weakening entry validation.
    if (entry.fileName === '__MACOSX/' || entry.fileName.startsWith('__MACOSX/')) {
        return;
    }

    const destination = destinationForEntry(destinationRoot, entry.fileName);
    // validateEntryType has already required directory names and attributes to agree.
    if (isDirectoryEntry(entry)) {
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        return;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const input = await openEntryStream(zipFile, entry);
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number;
    try {
        descriptor = fs.openSync(
            destination,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
            0o600,
        );
    } catch (error) {
        input.destroy();
        throw error;
    }

    let entryBytes = 0;
    const sizeLimiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            entryBytes += chunk.length;
            extracted.bytes += chunk.length;
            if (!Number.isSafeInteger(extracted.bytes) || extracted.bytes > maxExpandedBytes) {
                callback(new Error(
                    `Extracted content too large. Maximum allowed: ${formatBytes(maxExpandedBytes)}.`,
                ));
                return;
            }
            callback(null, chunk);
        },
    });
    const output = fs.createWriteStream(destination, { fd: descriptor, autoClose: true });

    try {
        await pipeline(input, sizeLimiter, output);
        if (entryBytes !== entry.uncompressedSize) {
            throw new Error(`ZIP entry size does not match its metadata: ${entry.fileName}`);
        }
    } catch (error) {
        fs.rmSync(destination, { force: true });
        throw error;
    }
}

function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
    return new Promise((resolve, reject) => {
        zipFile.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
                reject(error ?? new Error(`Unable to read ZIP entry: ${entry.fileName}`));
                return;
            }
            resolve(stream);
        });
    });
}

function validateEntryPath(fileName: string, destinationRoot: string): void {
    if (fileName === '' || fileName.includes('\0') || fileName.includes('\\')) {
        throw new Error(`ZIP entry has an invalid path: ${fileName}`);
    }
    const segments = fileName.split('/');
    if (
        path.posix.isAbsolute(fileName) ||
        /^[a-zA-Z]:/.test(fileName) ||
        segments.includes('..')
    ) {
        throw new Error(`ZIP entry escapes the extraction directory: ${fileName}`);
    }
    // Canonical containment is enforced by destinationForEntry before any filesystem write.
    destinationForEntry(destinationRoot, fileName);
}

function destinationForEntry(destinationRoot: string, fileName: string): string {
    const destination = path.resolve(destinationRoot, ...fileName.split('/').filter(Boolean));
    const relative = path.relative(path.resolve(destinationRoot), destination);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new Error(`ZIP entry escapes the extraction directory: ${fileName}`);
    }
    return destination;
}

function validateEntryType(entry: ZipEntryMetadata): void {
    const unixType = getUnixType(entry);
    if (unixType === UNIX_SYMBOLIC_LINK) {
        throw new Error(`Symbolic links are not allowed in ZIP imports: ${entry.fileName}`);
    }
    if (unixType !== 0 && unixType !== UNIX_REGULAR_FILE && unixType !== UNIX_DIRECTORY) {
        throw new Error(`Special files are not allowed in ZIP imports: ${entry.fileName}`);
    }
    if ((entry.externalFileAttributes & DOS_REPARSE_POINT) !== 0) {
        throw new Error(`Windows reparse points are not allowed in ZIP imports: ${entry.fileName}`);
    }

    const directoryByName = entry.fileName.endsWith('/');
    const directoryByAttributes = unixType === UNIX_DIRECTORY ||
        (entry.externalFileAttributes & DOS_DIRECTORY) !== 0;
    if (directoryByName !== directoryByAttributes && (unixType !== 0 || directoryByAttributes)) {
        throw new Error(`ZIP entry has inconsistent file type metadata: ${entry.fileName}`);
    }

    for (const field of entry.extraFields ?? []) {
        if (field.id === INFO_ZIP_UNIX_EXTRA_FIELD && field.data.length > 12) {
            throw new Error(`Linked or special UNIX entries are not allowed in ZIP imports: ${entry.fileName}`);
        }
        if (field.id === ASI_UNIX_EXTRA_FIELD) {
            validateAsiUnixField(field.data, entry.fileName);
        }
    }
}

function validateAsiUnixField(data: Buffer, fileName: string): void {
    // ASi UNIX metadata stores a mode at byte 4 and an optional link name after byte 14.
    if (data.length < 14) {
        throw new Error(`Malformed UNIX file metadata is not allowed in ZIP imports: ${fileName}`);
    }
    const unixType = data.readUInt16LE(4) & UNIX_FILE_TYPE_MASK;
    if (unixType !== 0 && unixType !== UNIX_REGULAR_FILE && unixType !== UNIX_DIRECTORY) {
        throw new Error(`Linked or special UNIX entries are not allowed in ZIP imports: ${fileName}`);
    }
    if (data.length > 14) {
        throw new Error(`Linked or special UNIX entries are not allowed in ZIP imports: ${fileName}`);
    }
}

function getUnixType(entry: ZipEntryMetadata): number {
    const hostSystem = (entry.versionMadeBy >>> 8) & 0xff;
    if (!UNIX_HOST_SYSTEMS.has(hostSystem)) return 0;
    const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
    return unixMode & UNIX_FILE_TYPE_MASK;
}

function isDirectoryEntry(entry: ZipEntryMetadata): boolean {
    return entry.fileName.endsWith('/');
}

function inspectExtractedTree(root: string, maxExpandedBytes: number): number {
    let totalSize = 0;
    const pendingDirectories = [root];
    while (pendingDirectories.length > 0) {
        const directory = pendingDirectories.pop();
        if (!directory) break;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const candidate = path.join(directory, entry.name);
            const stats = fs.lstatSync(candidate);
            if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
                throw new Error(`ZIP extraction produced an unsupported file type: ${entry.name}`);
            }
            if (stats.isDirectory()) {
                pendingDirectories.push(candidate);
                continue;
            }
            totalSize += stats.size;
            if (!Number.isSafeInteger(totalSize) || totalSize > maxExpandedBytes) {
                throw new Error(
                    `Extracted content too large. Maximum allowed: ${formatBytes(maxExpandedBytes)}.`,
                );
            }
        }
    }
    return totalSize;
}

function selectConversionInput(tempDir: string): string {
    const contents = fs.readdirSync(tempDir, { withFileTypes: true });
    if (contents.length === 0) {
        throw new Error('ZIP file appears to be empty');
    }
    if (isRegularFile(path.join(tempDir, 'SKILL.md'))) {
        return tempDir;
    }

    const skillDirectories = contents
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(tempDir, entry.name))
        .filter(directory => isRegularFile(path.join(directory, 'SKILL.md')));
    if (skillDirectories.length === 1) {
        return skillDirectories[0];
    }
    if (contents.length === 1 && contents[0].isDirectory()) {
        return path.join(tempDir, contents[0].name);
    }
    return tempDir;
}

function isRegularFile(candidate: string): boolean {
    try {
        return fs.lstatSync(candidate).isFile();
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function toError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error(String(reason));
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const unit = 1024;
    const units = ['Bytes', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(unit)), units.length - 1);
    return `${Math.round((bytes / Math.pow(unit, index)) * 100) / 100} ${units[index]}`;
}
