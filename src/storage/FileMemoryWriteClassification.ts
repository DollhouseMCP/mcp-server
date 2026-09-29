/** Diagnostic evidence only. Nothing in this module is a persistence token or repair authority. */
export interface FileEvidenceIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly ctimeNs: string;
  readonly mtimeNs: string;
}

export interface FileEvidenceRecord {
  readonly state: 'RESERVED' | 'ACTIVE';
  readonly userId: string;
  readonly ownerId: string;
  readonly locator: string;
  readonly revision: string;
  readonly contentHash: string;
  readonly fileIdentity: FileEvidenceIdentity;
}

export interface FileEvidenceJournal {
  readonly state: 'PREPARED_WRITE' | 'PUBLISHED_WRITE';
  readonly userId: string;
  readonly ownerId: string;
  readonly locator: string;
  readonly operationId: string;
  readonly oldRevision: string;
  readonly newRevision: string;
  readonly oldContentHash: string;
  readonly newContentHash: string;
  readonly oldFileIdentity: FileEvidenceIdentity;
  readonly preparedTempName: string;
  readonly preparedTempIdentity: FileEvidenceIdentity;
  readonly publishedHeadIdentity?: FileEvidenceIdentity;
}

interface FileEvidenceContent {
  readonly hash: string;
  readonly identity: FileEvidenceIdentity;
}

export interface FileMemoryWriteEvidence {
  readonly userId: string;
  readonly locator: string;
  readonly head: FileEvidenceContent;
  readonly sidecar?: FileEvidenceRecord;
  readonly registry?: FileEvidenceRecord;
  readonly journal?: FileEvidenceJournal;
  readonly temp?: FileEvidenceContent;
  readonly artifactNames: readonly string[];
  readonly unexpectedArtifacts: boolean;
}

export type FileMemoryWriteKind =
  | 'clean-consistent'
  | 'pre-journal-orphan-candidate'
  | 'prepared-not-published'
  | 'renamed-before-published-journal'
  | 'published-before-registry'
  | 'registry-advanced'
  | 'metadata-advanced-before-unlink'
  | 'blocked-by-fence'
  | 'unstable-or-unknown'
  | 'unknown-manual-review';

export interface FileMemoryWriteDiagnostic {
  readonly kind: FileMemoryWriteKind;
  readonly reason: string;
  readonly journalState?: 'PREPARED_WRITE' | 'PUBLISHED_WRITE';
  readonly operationId?: string;
  readonly artifactNames: readonly string[];
  /** Null means evidence collection did not complete; zero is a complete empty scan. */
  readonly artifactCount: number | null;
  readonly artifactNamesTruncated: boolean;
  /** True when unexpected names are withheld because they are not bound to the owner. */
  readonly artifactNamesRedacted: boolean;
  readonly evidenceComplete: boolean;
}

function identityEqual(left: FileEvidenceIdentity, right: FileEvidenceIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}

function publishedFileEqual(left: FileEvidenceIdentity, right: FileEvidenceIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

function matchingRecord(
  record: FileEvidenceRecord | undefined, evidence: FileMemoryWriteEvidence,
  ownerId: string, revision: string, hash: string, identity: FileEvidenceIdentity,
): boolean {
  return record?.state === 'ACTIVE' && record.userId === evidence.userId &&
    record.ownerId === ownerId && record.locator === evidence.locator &&
    record.revision === revision && record.contentHash === hash &&
    identityEqual(record.fileIdentity, identity);
}

function result(kind: FileMemoryWriteKind, evidence: FileMemoryWriteEvidence, reason: string): FileMemoryWriteDiagnostic {
  const redacted = evidence.unexpectedArtifacts;
  return {
    kind, reason, journalState: evidence.journal?.state,
    operationId: evidence.journal?.operationId,
    artifactNames: redacted ? [] : evidence.artifactNames.slice(0, 32),
    artifactCount: evidence.artifactNames.length,
    artifactNamesTruncated: !redacted && evidence.artifactNames.length > 32,
    artifactNamesRedacted: redacted,
    evidenceComplete: true,
  };
}

function unboundResult(): FileMemoryWriteDiagnostic {
  return {
    kind: 'unknown-manual-review', reason: 'Memory evidence does not bind to the requested owner',
    artifactNames: [], artifactCount: null, artifactNamesTruncated: false,
    artifactNamesRedacted: true, evidenceComplete: false,
  };
}

function boundToRequestedOwner(evidence: FileMemoryWriteEvidence): boolean {
  const { sidecar, registry, journal } = evidence;
  if (!sidecar || !registry || sidecar.userId !== evidence.userId ||
    sidecar.locator !== evidence.locator || registry.userId !== evidence.userId ||
    registry.locator !== evidence.locator || registry.ownerId !== sidecar.ownerId) return false;
  return !journal || (journal.userId === evidence.userId &&
    journal.locator === evidence.locator && journal.ownerId === sidecar.ownerId);
}

/** Pure phase decision. Callers must first prove stable, bounded, safe evidence. */
export function classifyFileMemoryWrite(evidence: FileMemoryWriteEvidence): FileMemoryWriteDiagnostic {
  if (!boundToRequestedOwner(evidence)) return unboundResult();
  const unknown = (reason: string) => result('unknown-manual-review', evidence, reason);
  if (evidence.unexpectedArtifacts || !evidence.sidecar || !evidence.registry) {
    return unknown('Unexpected artifacts or incomplete owner metadata');
  }
  if (!evidence.journal) return classifyWithoutJournal(evidence);
  const { journal, sidecar, registry } = evidence;
  if (journal.userId !== evidence.userId || journal.locator !== evidence.locator ||
    sidecar.ownerId !== journal.ownerId || registry.ownerId !== journal.ownerId) {
    return unknown('Journal owner or locator disagrees');
  }
  return journal.state === 'PREPARED_WRITE'
    ? classifyPrepared(evidence, journal) : classifyPublished(evidence, journal);
}

function classifyWithoutJournal(evidence: FileMemoryWriteEvidence): FileMemoryWriteDiagnostic {
  const { sidecar, registry, head, temp } = evidence;
  if (!sidecar || !registry ||
    !matchingRecord(sidecar, evidence, sidecar.ownerId, sidecar.revision, head.hash, head.identity) ||
    !matchingRecord(registry, evidence, sidecar.ownerId, sidecar.revision, head.hash, head.identity)) {
    return result('unknown-manual-review', evidence, 'Owner metadata and head disagree');
  }
  return result(temp ? 'pre-journal-orphan-candidate' : 'clean-consistent', evidence,
    temp ? 'Unjournaled write artifact requires manual review' : 'Owner metadata and head agree');
}

function classifyPrepared(
  evidence: FileMemoryWriteEvidence, journal: FileEvidenceJournal,
): FileMemoryWriteDiagnostic {
  const { sidecar, registry, head, temp } = evidence;
  const oldSidecar = matchingRecord(sidecar, evidence, journal.ownerId, journal.oldRevision,
    journal.oldContentHash, journal.oldFileIdentity);
  const oldRegistry = matchingRecord(registry, evidence, journal.ownerId, journal.oldRevision,
    journal.oldContentHash, journal.oldFileIdentity);
  const oldHead = head.hash === journal.oldContentHash && identityEqual(head.identity, journal.oldFileIdentity);
  if (oldHead && oldSidecar && oldRegistry && temp?.hash === journal.newContentHash &&
    identityEqual(temp.identity, journal.preparedTempIdentity)) {
    return result('prepared-not-published', evidence, 'Prepared journal and old head agree');
  }
  if (!temp && oldSidecar && oldRegistry && head.hash === journal.newContentHash &&
    publishedFileEqual(head.identity, journal.preparedTempIdentity)) {
    return result('renamed-before-published-journal', evidence, 'Prepared file is at the head');
  }
  return result('unknown-manual-review', evidence, 'Prepared journal does not match ordered publication evidence');
}

function classifyPublished(
  evidence: FileMemoryWriteEvidence, journal: FileEvidenceJournal,
): FileMemoryWriteDiagnostic {
  const { sidecar, registry, head, temp } = evidence;
  if (temp || !journal.publishedHeadIdentity || head.hash !== journal.newContentHash ||
    !identityEqual(head.identity, journal.publishedHeadIdentity) ||
    !publishedFileEqual(journal.preparedTempIdentity, head.identity)) {
    return result('unknown-manual-review', evidence, 'Published journal and head disagree');
  }
  const oldSidecar = matchingRecord(sidecar, evidence, journal.ownerId, journal.oldRevision,
    journal.oldContentHash, journal.oldFileIdentity);
  const oldRegistry = matchingRecord(registry, evidence, journal.ownerId, journal.oldRevision,
    journal.oldContentHash, journal.oldFileIdentity);
  const newSidecar = matchingRecord(sidecar, evidence, journal.ownerId, journal.newRevision,
    journal.newContentHash, head.identity);
  const newRegistry = matchingRecord(registry, evidence, journal.ownerId, journal.newRevision,
    journal.newContentHash, head.identity);
  if (oldSidecar && oldRegistry) return result('published-before-registry', evidence, 'Registry has not advanced');
  if (oldSidecar && newRegistry) return result('registry-advanced', evidence, 'Sidecar has not advanced');
  if (newSidecar && newRegistry) {
    return result('metadata-advanced-before-unlink', evidence, 'Journal remains after metadata advance');
  }
  return result('unknown-manual-review', evidence, 'Published metadata order or owner disagrees');
}
