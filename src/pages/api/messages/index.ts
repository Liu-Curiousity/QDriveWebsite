import type { APIRoute } from 'astro';
import { verifyAuthingToken } from '../../../lib/server/authing';
import {
  getUserByAuthingId,
  listUserMessages,
  markUserMessagesRead,
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

export const GET: APIRoute = async ({ request }) => {
  try {
    const profile = await authorize(request);
    getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    const messages = listUserMessages(profile.sub);
    return json({ messages, unreadCount: messages.filter((message) => !message.readAt).length });
  } catch {
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};

export const PATCH: APIRoute = async ({ request }) => {
  try {
    const profile = await authorize(request);
    const body = (await request.json()) as { id?: unknown };
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined;
    const messages = markUserMessagesRead(profile.sub, id);
    return json({ messages, unreadCount: messages.filter((message) => !message.readAt).length });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    if (error instanceof Error && error.message !== 'unauthorized') return json({ error: error.message }, 400);
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};
