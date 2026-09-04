import type { APIRoute } from 'astro';
import { isAdminAuthingUser, verifyAuthingToken } from '../../../../lib/server/authing';
import { drawLottery, getLotterySettings, getUserByAuthingId, listAllLotterySubmissions, reviewLotterySubmission, updateLotterySettings } from '../../../../lib/server/database';

export const prerender = false;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

const authorizeAdmin = async (request: Request) => {
  const [scheme, token] = (request.headers.get('authorization') || '').split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token || token.length > 20_000) throw new Error('unauthorized');
  const profile = await verifyAuthingToken(token);
  if (!isAdminAuthingUser(profile)) throw new Error('forbidden');
  return profile;
};

const reviewer = (profile: Awaited<ReturnType<typeof authorizeAdmin>>) => {
  const siteUser = getUserByAuthingId(profile.sub);
  const name = [profile.nickname, profile.name, profile.username, profile.email].find((value) => typeof value === 'string' && value.trim());
  return { authingUserId: profile.sub, name: siteUser?.displayName || (typeof name === 'string' ? name.trim() : '') || '管理员' };
};

export const GET: APIRoute = async ({ request }) => {
  try { await authorizeAdmin(request); return json({ submissions: listAllLotterySubmissions(), settings: getLotterySettings() }); }
  catch (error) { const forbidden = error instanceof Error && error.message === 'forbidden'; return json({ error: forbidden ? '无权访问抽奖管理。' : '登录状态无效或已过期。' }, forbidden ? 403 : 401); }
};

export const PATCH: APIRoute = async ({ request }) => {
  try {
    const profile = await authorizeAdmin(request);
    const body = (await request.json()) as { id?: unknown; status?: unknown; note?: unknown };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const status = body.status === 'approved' || body.status === 'rejected' ? body.status : null;
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!id || !status) return json({ error: '审核参数无效。' }, 400);
    if (note.length > 500 || /[<>]/.test(note)) return json({ error: '审核备注不能超过 500 个普通字符。' }, 400);
    return json({ submission: reviewLotterySubmission(id, { status, note: note || null, reviewer: reviewer(profile) }) });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    if (error instanceof Error && error.message === 'forbidden') return json({ error: '无权访问抽奖管理。' }, 403);
    if (error instanceof Error && error.message !== 'unauthorized') return json({ error: error.message }, 400);
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    await authorizeAdmin(request);
    const body = (await request.json()) as { action?: unknown; settings?: Partial<ReturnType<typeof getLotterySettings>> };
    if (body.action === 'draw') return json({ result: drawLottery() });
    if (body.action !== 'settings' || !body.settings) return json({ error: '抽奖操作无效。' }, 400);
    const s = body.settings;
    const integer = (value: unknown, fallback: number) => Number.isInteger(Number(value)) ? Number(value) : fallback;
    const mode = s.mode === 'count' ? 'count' : 'probability';
    const probabilities = [integer(s.firstProbability, 5), integer(s.secondProbability, 15), integer(s.thirdProbability, 30)];
    const counts = [integer(s.firstCount, 1), integer(s.secondCount, 3), integer(s.thirdCount, 10)];
    if (probabilities.some((v) => v < 0 || v > 100) || probabilities.reduce((a, b) => a + b, 0) > 100 || counts.some((v) => v < 0 || v > 100000)) return json({ error: '概率或人数设置无效。' }, 400);
    return json({ settings: updateLotterySettings({ enabled: Boolean(s.enabled), mode, firstProbability: probabilities[0], secondProbability: probabilities[1], thirdProbability: probabilities[2], firstCount: counts[0], secondCount: counts[1], thirdCount: counts[2] }) });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    if (error instanceof Error && error.message === 'forbidden') return json({ error: '无权访问抽奖管理。' }, 403);
    if (error instanceof Error && error.message !== 'unauthorized') return json({ error: error.message }, 400);
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};
