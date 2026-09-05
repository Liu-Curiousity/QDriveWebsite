import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AUTHING_APP_ID,
  AUTHING_HOST,
  AUTHING_USER_POOL_ID,
} from '../../config/authing';

const issuer = `${AUTHING_HOST}/oidc`;
const jwks = createRemoteJWKSet(
  new URL(`${issuer}/.well-known/jwks.json`),
);

export interface VerifiedAuthingUser extends JWTPayload {
  sub: string;
}

export type AdminAuthorizationCode =
  | 'unauthorized'
  | 'forbidden'
  | 'second_factor_required';

export class AdminAuthorizationError extends Error {
  code: AdminAuthorizationCode;

  constructor(code: AdminAuthorizationCode) {
    super(code === 'second_factor_required' ? 'unauthorized' : code);
    this.name = 'AdminAuthorizationError';
    this.code = code;
  }
}

const ADMIN_VERIFICATION_COOKIE = 'qdrive_admin_verified';
export const ADMIN_VERIFICATION_TTL_SECONDS = 15 * 60;
const adminSessionSecret =
  process.env.QDRIVE_ADMIN_SESSION_SECRET || randomBytes(32).toString('hex');

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

export function getBearerToken(request: Request) {
  const [scheme, token] = (request.headers.get('authorization') || '').split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token || token.length > 20_000) {
    throw new AdminAuthorizationError('unauthorized');
  }
  return token;
}

export function isAdminAuthingUser(user: VerifiedAuthingUser): boolean {
  const configuredAdminIds =
    process.env.QDRIVE_ADMIN_AUTHING_IDS || import.meta.env.QDRIVE_ADMIN_AUTHING_IDS || '';
  const adminIds = String(configuredAdminIds)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return adminIds.includes(user.sub);
}

export async function authorizeAdminRequest(
  request: Request,
  options: { requireSecondFactor?: boolean } = {},
) {
  const token = getBearerToken(request);
  let profile: VerifiedAuthingUser;
  try {
    profile = await verifyAuthingToken(token);
  } catch {
    throw new AdminAuthorizationError('unauthorized');
  }
  if (!isAdminAuthingUser(profile)) throw new AdminAuthorizationError('forbidden');
  if (
    options.requireSecondFactor !== false &&
    !isAdminSecondFactorVerified(request, profile.sub)
  ) {
    throw new AdminAuthorizationError('second_factor_required');
  }
  return profile;
}

async function fetchVerifiedAuthingProfile(
  token: string,
): Promise<VerifiedAuthingUser> {
  const response = await fetch(`${AUTHING_HOST}/api/v3/get-profile`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-authing-app-id': AUTHING_APP_ID,
      'x-authing-userpool-id': AUTHING_USER_POOL_ID,
    },
  });
  const result = (await response.json()) as {
    statusCode?: number;
    data?: Record<string, unknown>;
  };
  const subject = result.data?.userId ?? result.data?.sub;

  if (
    !response.ok ||
    result.statusCode !== 200 ||
    !result.data ||
    typeof subject !== 'string' ||
    !subject.trim()
  ) {
    throw new Error('Authing token is invalid.');
  }

  return { ...result.data, sub: subject } as VerifiedAuthingUser;
}

export async function verifyAuthingToken(
  token: string,
): Promise<VerifiedAuthingUser> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: AUTHING_APP_ID,
    });

    if (!payload.sub) {
      throw new Error('Authing token does not contain a user id.');
    }

    return payload as VerifiedAuthingUser;
  } catch {
    return fetchVerifiedAuthingProfile(token);
  }
}

export async function getVerifiedAuthingProfile(
  token: string,
): Promise<VerifiedAuthingUser> {
  const verified = await verifyAuthingToken(token);
  try {
    const profile = await fetchVerifiedAuthingProfile(token);
    if (profile.sub === verified.sub) {
      return { ...verified, ...profile, sub: verified.sub };
    }
  } catch {
    // The signed token payload remains a safe fallback.
  }
  return verified;
}
