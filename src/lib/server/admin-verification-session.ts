import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ADMIN_VERIFICATION_COOKIE = 'qdrive_admin_verified';
export const ADMIN_VERIFICATION_TTL_SECONDS = 60 * 60;
const astroEnv = (import.meta as ImportMeta & {
  env?: Record<string, string | boolean | undefined>;
}).env;
const configuredAdminSessionSecret = String(
  process.env.QDRIVE_ADMIN_SESSION_SECRET ||
  astroEnv?.QDRIVE_ADMIN_SESSION_SECRET ||
  '',
).trim();
const isProduction = process.env.NODE_ENV === 'production' || astroEnv?.PROD === true;

if (!configuredAdminSessionSecret && isProduction) {
  throw new Error('QDRIVE_ADMIN_SESSION_SECRET must be configured in production.');
}

// Keep local/test sessions stable across Vite module reloads without making the
// signing key predictable. Production still requires an explicitly configured
// secret and never reaches this process-local fallback.
const adminSessionSecretStore = globalThis as typeof globalThis & {
  __qdriveAdminSessionSecret?: string;
};
const adminSessionSecret = configuredAdminSessionSecret ||
  (adminSessionSecretStore.__qdriveAdminSessionSecret ??=
    randomBytes(32).toString('hex'));

const base64UrlEncode = (value: string | Buffer) =>
  Buffer.from(value).toString('base64url');

const signAdminSession = (payload: string) =>
  createHmac('sha256', adminSessionSecret).update(payload).digest('base64url');

const readCookie = (request: Request, name: string) => {
  const cookieHeader = request.headers.get('cookie') || '';
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return '';
};

export function createAdminVerificationCookie(request: Request, authingUserId: string) {
  const payload = base64UrlEncode(JSON.stringify({
    sub: authingUserId,
    exp: Math.floor(Date.now() / 1000) + ADMIN_VERIFICATION_TTL_SECONDS,
  }));
  const value = `${payload}.${signAdminSession(payload)}`;
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${ADMIN_VERIFICATION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_VERIFICATION_TTL_SECONDS}${secure}`;
}

export function clearAdminVerificationCookie(request: Request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${ADMIN_VERIFICATION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export function getAdminSecondFactorRemainingSeconds(request: Request, authingUserId: string) {
  const value = readCookie(request, ADMIN_VERIFICATION_COOKIE);
  const [payload, signature] = value.split('.', 2);
  if (!payload || !signature) return 0;

  const expected = Buffer.from(signAdminSession(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return 0;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (parsed.sub !== authingUserId || typeof parsed.exp !== 'number') return 0;
    return Math.max(0, parsed.exp - Math.floor(Date.now() / 1000));
  } catch {
    return 0;
  }
}

export function isAdminSecondFactorVerified(request: Request, authingUserId: string) {
  return getAdminSecondFactorRemainingSeconds(request, authingUserId) > 0;
}
