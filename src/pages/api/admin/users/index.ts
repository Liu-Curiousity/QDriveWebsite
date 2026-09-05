import type { APIRoute } from 'astro';
import { authorizeAdminRequest } from '../../../../lib/server/authing';
import { searchUsersByAccountOrEmail } from '../../../../lib/server/database';

export const prerender = false;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  },
});

export const GET: APIRoute = async ({ request, url }) => {
  try {
    await authorizeAdminRequest(request);
    const query = (url.searchParams.get('query') || '').trim();
    if (query.length < 2 || query.length > 100) {
      return json({ error: '请输入至少 2 个字符的用户名或邮箱。' }, 400);
    }
    const users = searchUsersByAccountOrEmail(query).map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      points: user.points,
    }));
    return json({ users });
  } catch {
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};
