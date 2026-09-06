import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import {
  AUTHING_APP_ID,
  AUTHING_HOST,
  AUTHING_USER_POOL_ID,
} from '../../config/authing';
import { isAdminSecondFactorVerified } from './admin-verification-session';

export {
  ADMIN_VERIFICATION_TTL_SECONDS,
  clearAdminVerificationCookie,
  createAdminVerificationCookie,
  getAdminSecondFactorRemainingSeconds,
  isAdminSecondFactorVerified,
} from './admin-verification-session';

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
