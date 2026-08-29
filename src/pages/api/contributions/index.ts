import type { APIRoute } from 'astro';
import { verifyAuthingToken } from '../../../lib/server/authing';
import {
  createContributionSubmission,
  getUserByAuthingId,
  listUserContributionSubmissions,
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

const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_SIZE = 8_000_000;
const MAX_TOTAL_ATTACHMENT_SIZE = 20_000_000;

const decodeAttachment = (value: unknown) => {
  if (!value || typeof value !== 'object') throw new Error('附件内容无效。');
  const input = value as { name?: unknown; mime?: unknown; dataUrl?: unknown };
  const rawName = typeof input.name === 'string' ? input.name : '';
  const name = (rawName.split(/[\\/]/).pop() || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 180);
  if (!name) throw new Error('附件文件名无效。');

  if (typeof input.dataUrl !== 'string') throw new Error(`无法读取附件“${name}”。`);
  const match = input.dataUrl.match(/^data:([^;,]*);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error(`附件“${name}”内容无效。`);
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > MAX_ATTACHMENT_SIZE) {
    throw new Error(`附件“${name}”不能超过 8 MB。`);
  }

  const declaredMime = (match[1] || (typeof input.mime === 'string' ? input.mime : '')).toLowerCase();
  let mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(declaredMime)
    ? declaredMime
    : 'application/octet-stream';
  const imageChecks: Record<string, boolean> = {
    'image/png': data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    'image/jpeg': data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
    'image/webp': data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP',
    'image/gif': ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii')),
  };
  if (mime.startsWith('image/') && !imageChecks[mime]) {
    mime = 'application/octet-stream';
  }
  return { name, mime, data };
};

export const GET: APIRoute = async ({ request }) => {
  try {
    const profile = await authorize(request);
    getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    return json({ submissions: listUserContributionSubmissions(profile.sub) });
  } catch {
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const profile = await authorize(request);
    if (Number(request.headers.get('content-length') || 0) > 28_000_000) {
      return json({ error: '提交的数据过大。' }, 413);
    }
    const body = (await request.json()) as { content?: unknown; attachments?: unknown };
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (content.length < 10 || content.length > 2_000 || /[<>]/.test(content)) {
      return json({ error: '贡献说明应为 10–2000 个普通字符。' }, 400);
    }
    if (!Array.isArray(body.attachments) || body.attachments.length > MAX_ATTACHMENT_COUNT) {
      return json({ error: '最多可以上传 5 个附件。' }, 400);
    }
    const attachments = body.attachments.map(decodeAttachment);
    const totalSize = attachments.reduce((sum, attachment) => sum + attachment.data.length, 0);
    if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
      return json({ error: '附件总大小不能超过 20 MB。' }, 400);
    }
    getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    const submission = createContributionSubmission(profile.sub, content, attachments);
    return json({ submission }, 201);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    if (error instanceof Error && error.message !== 'unauthorized') {
      return json({ error: error.message }, 400);
    }
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};
