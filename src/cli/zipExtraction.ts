import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import extract from 'extract-zip';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

const MAX_ZIP_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_SIZE_BYTES = 500 * 1024 * 1024;

interface ExtractionOptions {
    readonly tempParent?: string;
    readonly onStart?: (archiveSize: number, tempDir: string) => void;
}

export interface ConversionZipInput {
    readonly actualInput: string;
    /** Exact private root owned by this extraction, independent of archive layout. */
    readonly tempDir: string;
    readonly expandedSize: number;
}

/**
 * Refuse the Unix link mode that extract-zip would otherwise materialize.
 * onEntry is synchronous and runs before the entry stream/link is created.
 * The expanded-size check retains the existing post-extraction limit; it is
 * not a streaming resource bound.
 */
export async function extractZipForConversion(
    zipPath: string,
    options: ExtractionOptions = {},
): Promise<ConversionZipInput> {
    zipPath = UnicodeValidator.normalize(zipPath).normalizedContent;
    const archiveSize = fs.statSync(zipPath).size;
    if (archiveSize > MAX_ZIP_SIZE_BYTES) {
        throw new Error('ZIP file too large. Maximum allowed: 100 MB.');
    }
    const tempDir = fs.mkdtempSync(path.join(options.tempParent ?? os.tmpdir(), 'dollhouse-extract-'));
    try {
        options.onStart?.(archiveSize, tempDir);
        await extract(zipPath, {
            dir: tempDir,
            onEntry(entry) {
                const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
                if ((mode & 0o170000) === 0o120000) {
                    throw new Error('Symbolic links are not allowed in ZIP imports');
                }
            },
        });
        const expandedSize = calculateExtractedSize(tempDir);
        if (expandedSize > MAX_EXTRACTED_SIZE_BYTES) {
            throw new Error('Extracted content too large. Maximum allowed: 500 MB.');
        }
        const contents = fs.readdirSync(tempDir);
        if (contents.length === 0) throw new Error('ZIP file appears to be empty');
        const directories = contents.filter(item => fs.statSync(path.join(tempDir, item)).isDirectory());
        return {
            actualInput: directories.length === 1 ? path.join(tempDir, directories[0]) : tempDir,
            tempDir,
            expandedSize,
        };
    } catch (error) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw error;
    }
}

function calculateExtractedSize(directory: string): number {
    let size = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        size += entry.isDirectory() ? calculateExtractedSize(candidate) : fs.statSync(candidate).size;
    }
    return size;
}
