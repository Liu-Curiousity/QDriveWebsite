import type { APIRoute } from 'astro';
import { authorizeAdminRequest, verifyAuthingToken } from '../../../../lib/server/authing';
import { getContributionAttachment } from '../../../../lib/server/database';

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const authorization = request.headers.get('authorization') || '';
    const [scheme, token] = authorization.split(/\s+/, 2);
    if (scheme?.toLowerCase() !== 'bearer' || !token || token.length > 20_000) {
      return new Response('Unauthorized', { status: 401 });
    }
    const profile = await verifyAuthingToken(token);
    const attachment = params.id ? getContributionAttachment(params.id) : undefined;
    if (!attachment) return new Response('Not found', { status: 404 });
    if (attachment.authing_user_id !== profile.sub) {
      try {
        await authorizeAdminRequest(request);
      } catch {
        return new Response('Forbidden', { status: 403 });
      }
    }
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
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }
};
