import type { APIRoute } from 'astro';
import { getDatabaseStatus } from '../../lib/server/database';

export const prerender = false;

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify({
      status: 'ok',
      database: getDatabaseStatus(),
    }),
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  );
