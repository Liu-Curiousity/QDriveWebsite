import type { APIRoute } from 'astro';
import { authorizeAdminRequest } from '../../../../../lib/server/authing';
import { getLotteryAttachment } from '../../../../../lib/server/database';

export const prerender = false;
export const GET: APIRoute = async ({ request, params }) => {
  try {
    await authorizeAdminRequest(request);
    const attachment = getLotteryAttachment(params.id || '');
    if (!attachment) return new Response('Not found', { status: 404 });
    const encodedName = encodeURIComponent(attachment.name)
      .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(Buffer.from(attachment.data), {
      headers: {
        'Content-Type': attachment.mime,
        'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch { return new Response('Unauthorized', { status: 401 }); }
};
