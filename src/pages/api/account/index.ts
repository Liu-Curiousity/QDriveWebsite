import type { APIRoute } from 'astro';
import { isAdminAuthingUser, verifyAuthingToken } from '../../../lib/server/authing';
import {
  getUserByAuthingId,
  updateSiteProfile,
  upsertAuthingUser,
} from '../../../lib/server/database';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const authorize = async (request: Request) => {
  const authorization = request.headers.get('authorization') || '';
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token || token.length > 20_000) {
    throw new Error('unauthorized');
  }
  return verifyAuthingToken(token);
};

const decodeAvatar = (value: unknown) => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('头像仅支持 PNG、JPEG 或 WebP 格式。');

  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 800_000) {
    throw new Error('头像应用后不能超过 800 KB，请重新调整裁切范围。');
  }

  const mime = match[1];
  const isPng = mime === 'image/png' && data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpeg = mime === 'image/jpeg' && data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isWebp =
    mime === 'image/webp' &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!isPng && !isJpeg && !isWebp) {
    throw new Error('头像文件内容无效。');
  }
  return { mime, data };
};

export const GET: APIRoute = async ({ request }) => {
  try {
    const profile = await authorize(request);
    const user = getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    return json({ user, isAdmin: isAdminAuthingUser(profile) });
  } catch {
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};

export const PATCH: APIRoute = async ({ request }) => {
  try {
    const profile = await authorize(request);
    if (Number(request.headers.get('content-length') || 0) > 2_100_000) {
      return json({ error: '提交的数据过大。' }, 413);
    }

    const body = (await request.json()) as {
      displayName?: unknown;
      avatarDataUrl?: unknown;
    };
    let displayName: string | null | undefined;
    if (body.displayName !== undefined) {
      if (body.displayName === null) {
        displayName = null;
      } else if (typeof body.displayName === 'string') {
        const value = body.displayName.trim();
        if (value.length > 32 || /[\r\n<>]/.test(value)) {
          return json({ error: '昵称应为 1-32 个普通字符。' }, 400);
        }
        displayName = value || null;
      } else {
        return json({ error: '昵称格式无效。' }, 400);
      }
    }

    const avatar = decodeAvatar(body.avatarDataUrl);
    getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    const user = updateSiteProfile(profile.sub, { displayName, avatar });
    return json({ user });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    if (error instanceof Error && error.message !== 'unauthorized') {
      return json({ error: error.message }, 400);
    }
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};
