import { assertUuid, ConsoleStoreValidationError } from '../../stores/ConsoleStoreValidation.js';
import type { ConsoleOAuthSubjectResolver } from './IConsoleOAuthGrantRevocationService.js';

export interface InMemoryConsoleOAuthSubjectLink {
  readonly userId: string;
  readonly sub: string;
}

export class InMemoryConsoleOAuthSubjectResolver implements ConsoleOAuthSubjectResolver {
  private readonly subjectsByUserId = new Map<string, Set<string>>();

  constructor(initialLinks: readonly InMemoryConsoleOAuthSubjectLink[] = []) {
    for (const link of initialLinks) {
      assertUuid(link.userId, 'userId');
      this.addLink(link.userId, link.sub);
    }
  }

  async listLinkedSubjects(userId: string): Promise<readonly string[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    return [...(this.subjectsByUserId.get(userId) ?? [])].sort();
  }

  private addLink(userId: string, sub: string): void {
    const trimmedSub = sub.trim();
    if (trimmedSub === '') {
      throw new ConsoleStoreValidationError('sub must be non-empty');
    }
    const subjects = this.subjectsByUserId.get(userId) ?? new Set<string>();
    subjects.add(trimmedSub);
    this.subjectsByUserId.set(userId, subjects);
  }
}
