import type { APIRoute } from 'astro';
import { isAdminAuthingUser, verifyAuthingToken } from '../../../../lib/server/authing';
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
    const authorization = request.headers.get('authorization') || '';
    const [scheme, token] = authorization.split(/\s+/, 2);
    if (scheme?.toLowerCase() !== 'bearer' || !token) return json({ error: '请先登录管理员账户。' }, 401);
    const profile = await verifyAuthingToken(token);
    if (!isAdminAuthingUser(profile)) return json({ error: '当前账户没有管理员权限。' }, 403);
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
