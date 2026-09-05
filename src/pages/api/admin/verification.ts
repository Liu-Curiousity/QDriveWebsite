import type { APIRoute } from 'astro';
import {
  ADMIN_VERIFICATION_TTL_SECONDS,
  AdminAuthorizationError,
  authorizeAdminRequest,
  clearAdminVerificationCookie,
  createAdminVerificationCookie,
  getAdminSecondFactorRemainingSeconds,
  getBearerToken,
  getVerifiedAuthingProfile,
} from '../../../lib/server/authing';
import { getUserByAuthingId } from '../../../lib/server/database';
import {
  AUTHING_APP_ID,
  AUTHING_HOST,
  AUTHING_USER_POOL_ID,
} from '../../../config/authing';

export const prerender = false;

interface AuthingResponse<T = Record<string, unknown>> {
  statusCode?: number;
  message?: string;
  data?: T;
}

const sendCooldowns = new Map<string, number>();

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });

const authingRequest = async <T>(
  endpoint: string,
  body: Record<string, unknown>,
  requireData = true,
) => {
  const response = await fetch(`${AUTHING_HOST}/api/v3/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-authing-app-id': AUTHING_APP_ID,
      'x-authing-userpool-id': AUTHING_USER_POOL_ID,
      'x-authing-request-from': 'qdrive-web',
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as AuthingResponse<T>;
  if (!response.ok || result.statusCode !== 200 || (requireData && !result.data)) {
    throw new Error(result.message || '认证服务暂时不可用。');
  }
  return (result.data ?? {}) as T;
};

const readAdminProfile = async (request: Request) => {
  const authorized = await authorizeAdminRequest(request, { requireSecondFactor: false });
  const token = getBearerToken(request);
  let profile = authorized;
  try {
    profile = await getVerifiedAuthingProfile(token);
  } catch {
    // A verified token remains sufficient for authorization; the local user
    // record below can supply the email if the profile endpoint is unavailable.
  }
  const siteUser = getUserByAuthingId(authorized.sub);
  const email = typeof profile.email === 'string' && profile.email.trim()
    ? profile.email.trim()
    : siteUser?.email?.trim() || '';
  return { profile: authorized, email };
};

const maskEmail = (email: string) => {
  const [name, domain] = email.split('@');
  if (!name || !domain) return '';
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(3, Math.min(8, name.length - visible.length)))}@${domain}`;
};

const authorizationError = (error: unknown) => {
  if (error instanceof AdminAuthorizationError && error.code === 'forbidden') {
    return json({ error: '当前账户没有管理员权限。', code: error.code }, 403);
  }
  return json({ error: '请先登录管理员账户。', code: 'unauthorized' }, 401);
};

export const GET: APIRoute = async ({ request }) => {
  try {
    const { profile, email } = await readAdminProfile(request);
    const remainingSeconds = getAdminSecondFactorRemainingSeconds(request, profile.sub);
    return json({
      isAdmin: true,
      verified: remainingSeconds > 0,
      email: maskEmail(email),
      expiresIn: remainingSeconds || ADMIN_VERIFICATION_TTL_SECONDS,
    });
  } catch (error) {
    return authorizationError(error);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    if (Number(request.headers.get('content-length') || 0) > 4_096) {
      return json({ error: '请求内容过大。' }, 413);
    }
    const { profile, email } = await readAdminProfile(request);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: '管理员账户尚未绑定有效邮箱。' }, 400);
    }
    const body = (await request.json()) as { action?: unknown; passCode?: unknown };

    if (body.action === 'send') {
      const now = Date.now();
      const availableAt = sendCooldowns.get(profile.sub) || 0;
      if (availableAt > now) {
        return json({
          error: '验证码发送过于频繁，请稍后重试。',
          retryAfter: Math.ceil((availableAt - now) / 1000),
        }, 429);
      }
      await authingRequest('send-email', {
        channel: 'CHANNEL_LOGIN',
        email,
      }, false);
      sendCooldowns.set(profile.sub, now + 60_000);
      return json({ email: maskEmail(email), retryAfter: 60 });
    }

    if (body.action === 'verify') {
      const passCode = typeof body.passCode === 'string' ? body.passCode.trim() : '';
      if (!/^\d{4,8}$/.test(passCode)) {
        return json({ error: '请输入正确的邮箱验证码。' }, 400);
      }
      let signedIn: Record<string, unknown>;
      try {
        signedIn = await authingRequest<Record<string, unknown>>('signin', {
          connection: 'PASSCODE',
          passCodePayload: { email, passCode },
          options: { scope: 'openid profile email', autoRegister: false },
        });
      } catch {
        return json({ error: '验证码错误或已失效，请重新获取。' }, 400);
      }
      const verificationToken = [signedIn.access_token, signedIn.accessToken]
        .find((value) => typeof value === 'string' && value.trim());
      if (typeof verificationToken !== 'string') {
        return json({ error: '验证码已通过，但认证服务未返回完整凭证。' }, 502);
      }
      const verifiedProfile = await getVerifiedAuthingProfile(verificationToken);
      if (verifiedProfile.sub !== profile.sub) {
        return json({ error: '验证码与当前管理员账户不匹配。' }, 403);
      }
      return json(
        { verified: true, expiresIn: ADMIN_VERIFICATION_TTL_SECONDS },
        200,
        { 'Set-Cookie': createAdminVerificationCookie(request, profile.sub) },
      );
    }

    return json({ error: '二次验证操作无效。' }, 400);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    return authorizationError(error);
  }
};

export const DELETE: APIRoute = async ({ request }) =>
  json(
    { verified: false },
    200,
    { 'Set-Cookie': clearAdminVerificationCookie(request) },
  );
