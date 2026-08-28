import type { APIRoute } from 'astro';
import { getUserAvatar } from '../../../../lib/server/database';

export const prerender = false;

export const GET: APIRoute = ({ params }) => {
  const id = params.id || '';
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) {
    return new Response('Not found', { status: 404 });
  }

  const avatar = getUserAvatar(id);
  if (!avatar) return new Response('Not found', { status: 404 });

  // Copy into an ArrayBuffer backed by regular memory. Node's database API
  // exposes ArrayBufferLike here, while the Fetch Response type requires a
  // concrete BodyInit.
  const body = Uint8Array.from(avatar.data).buffer;
  return new Response(body, {
    headers: {
      'Content-Type': avatar.mime,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
