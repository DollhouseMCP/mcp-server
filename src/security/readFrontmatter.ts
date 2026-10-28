import type { FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { SECURITY_LIMITS } from './constants.js';
import { canStartFrontmatterFrame, matchFrontmatterFrame } from './secureYamlParser.js';

function completeFrontmatter(header: string, maxYamlSize: number): { value: string | null } | undefined {
  const frame = matchFrontmatterFrame(header);
  if (!frame) return undefined;
  return { value: frame.frontmatter.length <= maxYamlSize ? frame.frontmatter : null };
}

/** Read a complete frame using a reusable chunk; preserve absent versus unavailable. */
export async function readFrontmatter(
  file: Pick<FileHandle, 'read'>,
  buffer: Buffer,
  maxYamlSize = SECURITY_LIMITS.MAX_YAML_LENGTH,
): Promise<string | null | undefined> {
  if (buffer.length === 0) throw new RangeError('A nonempty read buffer is required');
  const decoder = new StringDecoder('utf8');
  let header = '';
  let position = 0;
  // The parser counts UTF-16 code units, excluding the opening and closing fences.
  const framingAllowance = '---\r\n\r\n---'.length;
  while (header.length <= maxYamlSize + framingAllowance) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    position += bytesRead;
    header += bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end();
    const frame = completeFrontmatter(header, maxYamlSize);
    if (frame) return frame.value;
    if (bytesRead === 0 || !canStartFrontmatterFrame(header)) return undefined;
  }
  return null;
}
