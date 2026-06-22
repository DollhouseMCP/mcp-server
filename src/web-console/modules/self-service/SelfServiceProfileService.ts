import type { ConsoleHandlerResult, ConsoleRequest } from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { IConsoleAccountAdminStore } from '../../stores/IConsoleAccountAdminStore.js';
import { validateConsoleDisplayName } from '../../stores/IConsoleAccountAdminStore.js';
import { serializeSelfProfile } from './SelfServiceDtos.js';

export class SelfServiceProfileService {
  constructor(
    private readonly accountAdminStore: IConsoleAccountAdminStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getProfile(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const principal = await this.accountAdminStore.findPrincipal(actor.userId);
    if (!principal) return problem(404, 'not_found', 'Not found', 'User principal was not found.');
    if (principal.disabledAt) return problem(403, 'principal_disabled', 'Forbidden', 'User principal is disabled.');
    return { status: 200, body: serializeSelfProfile(principal) };
  }

  async patchProfile(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const parsed = parseProfilePatch(req.body);
    if (parsed.kind === 'problem') return parsed.result;
    const current = await this.accountAdminStore.findPrincipal(actor.userId);
    if (!current) return problem(404, 'not_found', 'Not found', 'User principal was not found.');
    if (current.disabledAt) return problem(403, 'principal_disabled', 'Forbidden', 'User principal is disabled.');
    const updated = await this.accountAdminStore.updatePrincipalProfile({
      userId: actor.userId,
      displayName: parsed.displayName,
      updatedAt: this.now(),
    });
    if (!updated) return problem(404, 'not_found', 'Not found', 'User principal was not found.');
    return { status: 200, body: serializeSelfProfile(updated) };
  }
}

function parseProfilePatch(body: unknown):
  | { readonly kind: 'valid'; readonly displayName: string | null }
  | { readonly kind: 'problem'; readonly result: ConsoleHandlerResult } {
  if (!isRecord(body) || Object.keys(body).some(key => key !== 'display_name')) {
    return { kind: 'problem', result: problem(400, 'invalid_request', 'Invalid request', 'Only display_name may be updated.') };
  }
  if (!Object.hasOwn(body, 'display_name')) {
    return { kind: 'problem', result: problem(400, 'invalid_request', 'Invalid request', 'display_name is required.') };
  }
  const value = body.display_name;
  if (value === null) return { kind: 'valid', displayName: null };
  if (typeof value !== 'string') {
    return { kind: 'problem', result: problem(422, 'validation_failed', 'Validation failed', 'display_name must be a string or null.') };
  }
  const trimmed = value.normalize('NFC').trim();
  try {
    validateConsoleDisplayName(trimmed, 'display_name');
  } catch (error) {
    return {
      kind: 'problem',
      result: problem(
        422,
        'validation_failed',
        'Validation failed',
        error instanceof Error ? error.message : 'display_name is invalid.',
      ),
    };
  }
  return { kind: 'valid', displayName: trimmed === '' ? null : trimmed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function problem(status: number, code: string, title: string, detail: string): ConsoleHandlerResult {
  return {
    status,
    body: {
      type: 'about:blank',
      title,
      status,
      code,
      detail,
    },
  };
}
