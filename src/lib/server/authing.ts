import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
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

export function isAdminAuthingUser(user: VerifiedAuthingUser): boolean {
  const adminIds = (process.env.QDRIVE_ADMIN_AUTHING_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return adminIds.includes(user.sub);
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
