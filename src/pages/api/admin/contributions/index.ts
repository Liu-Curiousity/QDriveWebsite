import type { APIRoute } from 'astro';
import { isAdminAuthingUser, verifyAuthingToken } from '../../../../lib/server/authing';
import {
  getUserByAuthingId,
  listAllContributionSubmissions,
  reviewContributionSubmission,
} from '../../../../lib/server/database';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const authorizeAdmin = async (request: Request) => {
  const authorization = request.headers.get('authorization') || '';
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token || token.length > 20_000) {
    throw new Error('unauthorized');
  }
  const profile = await verifyAuthingToken(token);
  if (!isAdminAuthingUser(profile)) throw new Error('forbidden');
  return profile;
};

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
    return json({ submissions: listAllContributionSubmissions() });
  } catch (error) {
    return json(
      { error: error instanceof Error && error.message === 'forbidden' ? '无权访问贡献审核。' : '登录状态无效或已过期。' },
      error instanceof Error && error.message === 'forbidden' ? 403 : 401,
    );
  }
};

export const PATCH: APIRoute = async ({ request }) => {
  try {
    const profile = await authorizeAdmin(request);
    const body = (await request.json()) as {
      id?: unknown;
      status?: unknown;
      points?: unknown;
      note?: unknown;
    };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const status = body.status === 'approved' || body.status === 'rejected' ? body.status : null;
    const points = Number(body.points);
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!id || !status) return json({ error: '审核参数无效。' }, 400);
    if (status === 'approved' && (!Number.isInteger(points) || points < 1 || points > 100_000)) {
      return json({ error: '通过时积分应为 1-100000 的整数。' }, 400);
    }
    if (note.length > 500 || /[<>]/.test(note)) return json({ error: '审核备注不能超过 500 个普通字符。' }, 400);
    const submission = reviewContributionSubmission(id, {
      status,
      points: status === 'approved' ? points : null,
      note: note || null,
      reviewer: getReviewer(profile),
    });
    return json({ submission });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    if (error instanceof Error && error.message === 'forbidden') return json({ error: '无权访问贡献审核。' }, 403);
    if (error instanceof Error && error.message !== 'unauthorized') return json({ error: error.message }, 400);
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};
