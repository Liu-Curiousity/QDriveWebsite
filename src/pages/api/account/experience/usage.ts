import type { APIRoute } from 'astro';
import { verifyAuthingToken } from '../../../../lib/server/authing';
import {
  getUserByAuthingId,
  recordUsageHeartbeat,
  upsertAuthingUser,
} from '../../../../lib/server/database';

export const prerender = false;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  },
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const authorization = request.headers.get('authorization') || '';
    const [scheme, token] = authorization.split(/\s+/, 2);
    if (scheme?.toLowerCase() !== 'bearer' || !token || token.length > 20_000) {
      return json({ error: '需要有效的登录凭证。' }, 401);
    }
    const profile = await verifyAuthingToken(token);
    getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    return json(recordUsageHeartbeat(profile.sub));
  } catch {
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};
