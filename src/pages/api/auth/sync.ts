import type { APIRoute } from 'astro';
import { getVerifiedAuthingProfile } from '../../../lib/server/authing';
import { upsertAuthingUser } from '../../../lib/server/database';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

export const POST: APIRoute = async ({ request }) => {
  const authorization = request.headers.get('authorization') || '';
  const [scheme, token] = authorization.split(/\s+/, 2);

  if (scheme?.toLowerCase() !== 'bearer' || !token || token.length > 20_000) {
    return json({ error: '需要有效的登录凭证。' }, 401);
  }

  try {
    const profile = await getVerifiedAuthingProfile(token);
    const user = upsertAuthingUser(profile);

    return json({ user });
  } catch (error) {
    console.error('Failed to verify or sync Authing user:', error);
    return json({ error: '登录凭证无效或已过期，请重新登录。' }, 401);
  }
};
