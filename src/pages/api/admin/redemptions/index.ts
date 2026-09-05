import type { APIRoute } from 'astro';
import { authorizeAdminRequest } from '../../../../lib/server/authing';
import {
  getUserByAuthingId,
  listAllPointRedemptions,
  reviewPointRedemption,
} from '../../../../lib/server/database';

export const prerender = false;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const authorizeAdmin = authorizeAdminRequest;

const getReviewer = (profile: Awaited<ReturnType<typeof authorizeAdmin>>) => {
  const siteUser = getUserByAuthingId(profile.sub);
  const profileName = [profile.nickname, profile.name, profile.username, profile.email]
    .find((value) => typeof value === 'string' && value.trim());
  return {
    authingUserId: profile.sub,
    name: siteUser?.displayName || (typeof profileName === 'string' ? profileName.trim() : '') || '管理员',
  };
};

export const GET: APIRoute = async ({ request }) => {
  try {
    await authorizeAdmin(request);
    return json({ redemptions: listAllPointRedemptions() });
  } catch (error) {
    const forbidden = error instanceof Error && error.message === 'forbidden';
    return json({ error: forbidden ? '无权访问兑换审核。' : '登录状态无效或已过期。' }, forbidden ? 403 : 401);
  }
};

export const PATCH: APIRoute = async ({ request }) => {
  try {
    const profile = await authorizeAdmin(request);
    const body = (await request.json()) as { id?: unknown; status?: unknown; remainingPoints?: unknown; note?: unknown };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const status = body.status === 'approved' || body.status === 'rejected' ? body.status : null;
    const remainingPoints = Number(body.remainingPoints);
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!id || !status) return json({ error: '审核参数无效。' }, 400);
    if (status === 'approved' && (!Number.isInteger(remainingPoints) || remainingPoints < 0 || remainingPoints > 1_000_000)) {
      return json({ error: '积分余量必须是大于或等于 0 的整数。' }, 400);
    }
    if (note.length > 500 || /[<>]/.test(note)) return json({ error: '审核备注不能超过 500 个普通字符。' }, 400);
    const redemption = reviewPointRedemption(id, {
      status,
      remainingPoints: status === 'approved' ? remainingPoints : null,
      note: note || null,
      reviewer: getReviewer(profile),
    });
    return json({ redemption });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    if (error instanceof Error && error.message === 'forbidden') return json({ error: '无权访问兑换审核。' }, 403);
    if (error instanceof Error && error.message !== 'unauthorized') return json({ error: error.message }, 400);
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};
