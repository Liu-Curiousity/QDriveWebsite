import type { APIRoute } from 'astro';
import { verifyAuthingToken } from '../../../lib/server/authing';
import {
  createPointRedemption,
  getUserByAuthingId,
  listUserPointRedemptions,
  upsertAuthingUser,
} from '../../../lib/server/database';

export const prerender = false;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const authorize = async (request: Request) => {
  const [scheme, token] = (request.headers.get('authorization') || '').split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token || token.length > 20_000) throw new Error('unauthorized');
  return verifyAuthingToken(token);
};

const getState = (authingUserId: string) => {
  const user = getUserByAuthingId(authingUserId);
  if (!user) throw new Error('User does not exist.');
  const redemptions = listUserPointRedemptions(authingUserId);
  const pendingPoints = redemptions
    .filter((redemption) => redemption.status === 'pending')
    .reduce((sum, redemption) => sum + redemption.requestedPoints, 0);
  return { redemptions, points: user.points, availablePoints: Math.max(0, user.points - pendingPoints) };
};

export const GET: APIRoute = async ({ request }) => {
  try {
    const profile = await authorize(request);
    getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    return json(getState(profile.sub));
  } catch {
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const profile = await authorize(request);
    const body = (await request.json()) as { taobaoAccount?: unknown; points?: unknown };
    const taobaoAccount = typeof body.taobaoAccount === 'string' ? body.taobaoAccount.trim() : '';
    const points = Number(body.points);
    if (taobaoAccount.length < 2 || taobaoAccount.length > 64 || /[<>\r\n]/.test(taobaoAccount)) {
      return json({ error: '请输入 2–64 个字符的淘宝账号。' }, 400);
    }
    if (!Number.isInteger(points) || points < 1 || points > 1_000_000) {
      return json({ error: '兑换积分必须是大于 0 的整数。' }, 400);
    }
    getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    const redemption = createPointRedemption(profile.sub, taobaoAccount, points);
    return json({ redemption, ...getState(profile.sub) }, 201);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    if (error instanceof Error && error.message !== 'unauthorized') return json({ error: error.message }, 400);
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};
