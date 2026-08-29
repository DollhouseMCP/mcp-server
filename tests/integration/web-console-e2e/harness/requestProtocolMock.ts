export interface ProtocolProblem {
  readonly status: number;
  readonly body: unknown;
}

export function mutationProtocolProblem(
  headers: Readonly<Record<string, string>>,
): ProtocolProblem | null {
  if (headers['x-console-request'] !== '1') {
    return forbidden('The console request marker is required.');
  }

  const cookieToken = cookieValue(headers.cookie, 'dh_csrf');
  if (!cookieToken || headers['x-csrf-token'] !== cookieToken) {
    return forbidden('The CSRF token is missing or does not match the cookie.');
  }

  if (!headers['idempotency-key']) {
    return {
      status: 400,
      body: { code: 'idempotency_key_required', detail: 'An Idempotency-Key header is required.' },
    };
  }

  return null;
}

export function preconditionProblem(
  headers: Readonly<Record<string, string>>,
  currentEtag: string,
): ProtocolProblem | null {
  const ifMatch = headers['if-match'];
  if (!ifMatch) {
    return {
      status: 428,
      body: { code: 'precondition_required', detail: 'An If-Match header is required.' },
    };
  }
  if (ifMatch !== currentEtag) {
    return {
      status: 412,
      body: { code: 'precondition_failed', detail: 'The resource changed.' },
    };
  }
  return null;
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  const prefix = `${name}=`;
  const match = cookieHeader?.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(prefix.length));
  } catch {
    return null;
  }
}

function forbidden(detail: string): ProtocolProblem {
  return { status: 403, body: { code: 'csrf_failed', detail } };
}
