import type { APIRoute } from 'astro';
import { verifyAuthingToken } from '../../../../lib/server/authing';
import { getLotteryAttachment } from '../../../../lib/server/database';

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const [scheme, token] = (request.headers.get('authorization') || '').split(/\s+/, 2);
    if (scheme?.toLowerCase() !== 'bearer' || !token) return new Response('Unauthorized', { status: 401 });
    const profile = await verifyAuthingToken(token);
    const attachment = getLotteryAttachment(params.id || '');
    if (!attachment || attachment.authing_user_id !== profile.sub) return new Response('Not found', { status: 404 });
    return new Response(Buffer.from(attachment.data), { headers: { 'Content-Type': attachment.mime, 'Content-Disposition': `inline; filename="${attachment.name.replace(/"/g, '')}"`, 'Cache-Control': 'private, max-age=60' } });
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }
};
