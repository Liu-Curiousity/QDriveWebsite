import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ADMIN_VERIFICATION_TTL_SECONDS,
  createAdminVerificationCookie,
  getAdminSecondFactorRemainingSeconds,
} from '../src/lib/server/admin-verification-session.ts';

test('administrator email verification remains valid for one hour', () => {
  assert.equal(ADMIN_VERIFICATION_TTL_SECONDS, 60 * 60);

  const request = new Request('https://qdrive.example/admin');
  const cookie = createAdminVerificationCookie(request, 'admin-user');

  assert.match(cookie, /Max-Age=3600/);
  assert.match(cookie, /; Secure/);

  const cookiePair = cookie.split(';', 1)[0];
  const authenticatedRequest = new Request('https://qdrive.example/admin/users', {
    headers: { cookie: cookiePair },
  });
  const remaining = getAdminSecondFactorRemainingSeconds(
    authenticatedRequest,
    'admin-user',
  );

  assert.ok(remaining >= 3599 && remaining <= 3600);
});

test('administrator verification cookie remains bound to its user', () => {
  const request = new Request('http://localhost/admin');
  const cookie = createAdminVerificationCookie(request, 'first-admin');
  const cookiePair = cookie.split(';', 1)[0];
  const authenticatedRequest = new Request('http://localhost/admin/lotteries', {
    headers: { cookie: cookiePair },
  });

  assert.equal(
    getAdminSecondFactorRemainingSeconds(authenticatedRequest, 'second-admin'),
    0,
  );
});

test('administrator verification rejects a tampered signature', () => {
  const request = new Request('http://localhost/admin');
  const cookiePair = createAdminVerificationCookie(request, 'admin-user').split(';', 1)[0];
  const [name, value] = cookiePair.split('=', 2);
  const [payload, signature] = value.split('.', 2);
  const replacement = signature.endsWith('a') ? 'b' : 'a';
  const tampered = `${name}=${payload}.${signature.slice(0, -1)}${replacement}`;
  const tamperedRequest = new Request('http://localhost/admin/users', {
    headers: { cookie: tampered },
  });

  assert.equal(
    getAdminSecondFactorRemainingSeconds(tamperedRequest, 'admin-user'),
    0,
  );
});

test('local verification uses an unpredictable process-level fallback secret', async () => {
  const source = await readFile(
    new URL('../src/lib/server/admin-verification-session.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /randomBytes\(32\)/);
  assert.match(source, /globalThis/);
  assert.doesNotMatch(source, /qdrive-local-development-admin-verification-v1/);
});

test('local verification sessions survive independent module reloads', async () => {
  const moduleUrl = new URL(
    '../src/lib/server/admin-verification-session.ts',
    import.meta.url,
  );
  const [issuer, verifier] = await Promise.all([
    import(`${moduleUrl.href}?reload=issuer`),
    import(`${moduleUrl.href}?reload=verifier`),
  ]);
  const request = new Request('http://localhost/admin');
  const cookiePair = issuer
    .createAdminVerificationCookie(request, 'admin-user')
    .split(';', 1)[0];
  const nextPageRequest = new Request('http://localhost/admin/contributions', {
    headers: { cookie: cookiePair },
  });

  assert.ok(
    verifier.getAdminSecondFactorRemainingSeconds(nextPageRequest, 'admin-user') >= 3599,
  );
});
