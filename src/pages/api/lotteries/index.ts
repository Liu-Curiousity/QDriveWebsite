import type { APIRoute } from 'astro';
import { verifyAuthingToken } from '../../../lib/server/authing';
import {
  createLotterySubmission,
  getLotterySettings,
  getUserByAuthingId,
  listUserLotterySubmissions,
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

const MAX_COUNT = 5;
const MAX_SIZE = 8_000_000;
const MAX_TOTAL = 20_000_000;

const decodeAttachment = (value: unknown) => {
  if (!value || typeof value !== 'object') throw new Error('附件内容无效。');
  const input = value as { name?: unknown; mime?: unknown; dataUrl?: unknown };
  const name = (typeof input.name === 'string' ? input.name : '').split(/[\\/]/).pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180) || '';
  if (!name) throw new Error('附件文件名无效。');
  if (typeof input.dataUrl !== 'string') throw new Error(`无法读取附件“${name}”。`);
  const match = input.dataUrl.match(/^data:([^;,]*);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error(`附件“${name}”内容无效。`);
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > MAX_SIZE) throw new Error(`附件“${name}”不能超过 8 MB。`);
  const declaredMime = (match[1] || (typeof input.mime === 'string' ? input.mime : '')).toLowerCase();
  const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(declaredMime) ? declaredMime : 'application/octet-stream';
  return { name, mime, data };
};

export const GET: APIRoute = async ({ request }) => {
  try {
    const profile = await authorize(request);
    getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    return json({ submissions: listUserLotterySubmissions(profile.sub), settings: getLotterySettings() });
  } catch {
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const profile = await authorize(request);
    if (!getLotterySettings().enabled) return json({ error: '当前抽奖尚未开启，请留意活动通知。' }, 400);
    if (Number(request.headers.get('content-length') || 0) > 28_000_000) return json({ error: '提交的数据过大。' }, 413);
    const body = (await request.json()) as { content?: unknown; shippingAddress?: unknown; attachments?: unknown };
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const shippingAddress = typeof body.shippingAddress === 'string' ? body.shippingAddress.trim() : '';
    if (content.length > 2_000 || /[<>]/.test(content)) return json({ error: '活动凭证应为不超过 2000 个普通字符。' }, 400);
    const shippingMatch = shippingAddress.match(/^收货人：([^\n]{1,50})\n联系电话：([0-9+\-\s()]{7,30})\n收货地址：([\s\S]{5,400})$/);
    if (!shippingMatch || /[<>]/.test(shippingAddress)) return json({ error: '请填写收货人姓名、有效联系电话和完整收货地址。' }, 400);
    if (!Array.isArray(body.attachments) || body.attachments.length > MAX_COUNT) return json({ error: '最多可以上传 5 个附件。' }, 400);
    const attachments = body.attachments.map(decodeAttachment);
    if (attachments.reduce((sum, attachment) => sum + attachment.data.length, 0) > MAX_TOTAL) return json({ error: '附件总大小不能超过 20 MB。' }, 400);
    getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    return json({ submission: createLotterySubmission(profile.sub, content, shippingAddress, attachments) }, 201);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    if (error instanceof Error && error.message !== 'unauthorized') return json({ error: error.message }, 400);
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};
