import { setupWorld, type World } from '../harness/world.js';

let world: World;
beforeAll(async () => { world = await setupWorld(); });

const admin = () => world.clients.admin;
const AUTH_POLICY = '/api/v1/admin/security/auth-policy';

describe('admin/security — signing keys', () => {
  it('lists signing keys (all kinds)', async () => {
    const res = await admin().get('/api/v1/admin/security/signing-keys');
    expect(res.status).toBe(200);
  });

  it.each(['jwks', 'cookie', 'invite'])('lists %s signing keys', async (kind) => {
    const res = await admin().get(`/api/v1/admin/security/signing-keys/${kind}`);
    expect(res.status).toBe(200);
  });

  // The 'invite' kind is safe to mutate in-suite: it is not used by forged
  // console sessions or the active AS token flow, and new invites use the new
  // active key after rotation (verified). We exercise the full lifecycle on it.
  it('full lifecycle: rotate -> job -> retire superseded -> delete (force)', async () => {
    // Rotate twice so there is guaranteed to be a non-active (superseded) key,
    // regardless of whether the invite key existed before this spec ran.
    const rotate = await admin().post('/api/v1/admin/security/signing-keys/invite/rotate', { body: {} });
    expect(rotate.status).toBe(202);
    const jobId = rotate.body?.job_id ?? rotate.body?.id;
    if (jobId) {
      const job = await admin().get(`/api/v1/admin/security/signing-keys/jobs/${jobId}`);
      expect(job.status).toBe(200);
    }
    await admin().post('/api/v1/admin/security/signing-keys/invite/rotate', { body: {} });

    const kind = await admin().get('/api/v1/admin/security/signing-keys/invite');
    expect(kind.status).toBe(200);
    const activeKid: string | null = kind.body?.active_kid ?? null;
    const keys: Array<{ kid: string }> = kind.body?.keys ?? [];
    const superseded = keys.find(k => k.kid !== activeKid);
    if (!superseded) throw new Error('rotation should leave a superseded key');

    const retire = await admin().post(`/api/v1/admin/security/signing-keys/invite/${superseded.kid}/retire`, { body: {} });
    expect(retire.status).toBe(202);

    const del = await admin().delete(`/api/v1/admin/security/signing-keys/invite/${superseded.kid}`, { body: { force: true } });
    expect([200, 202, 204]).toContain(del.status);
  });

  it('retiring an unknown signing key is 404', async () => {
    const res = await admin().post('/api/v1/admin/security/signing-keys/invite/nonexistent-kid/retire', { body: {} });
    expect(res.status).toBe(404);
  });

  it('deleting an unknown signing key is 404 (matches retire)', async () => {
    const res = await admin().delete('/api/v1/admin/security/signing-keys/invite/nonexistent-kid', { body: { force: true } });
    expect(res.status).toBe(404);
  });
});

describe('admin/security — auth policy', () => {
  it('reads the auth policy', async () => {
    const res = await admin().get(AUTH_POLICY);
    expect(res.status).toBe(200);
    expect(res.etag).toBeTruthy();
  });

  it('write requires If-Match (428 without it)', async () => {
    const res = await admin().put(AUTH_POLICY, { body: { max_admin_elevation_seconds: 300 } });
    expect(res.status).toBe(428);
  });

  it('updates the auth policy with If-Match', async () => {
    const read = await admin().get(AUTH_POLICY);
    const res = await admin().put(AUTH_POLICY, {
      body: { max_admin_elevation_seconds: 300 },
      ifMatch: read.etag,
    });
    expect(res.status).toBe(200);
  });

  it('rejects an out-of-range elevation window (422)', async () => {
    const read = await admin().get(AUTH_POLICY);
    const res = await admin().put(AUTH_POLICY, {
      body: { max_admin_elevation_seconds: 99999 },
      ifMatch: read.etag,
    });
    expect(res.status).toBe(422);
  });
});

describe('admin/security — admin TOTP reset', () => {
  it('resets a user TOTP factor without a server error', async () => {
    const res = await admin().post(`/api/v1/admin/security/users/${world.userB.id}/factors/totp/reset`, { body: {} });
    expect(res.status).toBeLessThan(500);
  });
});
