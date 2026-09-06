import assert from 'node:assert/strict';
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
