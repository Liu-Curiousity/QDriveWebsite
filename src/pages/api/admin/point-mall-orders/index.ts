import type { APIRoute } from 'astro';
import { authorizeAdminRequest } from '../../../../lib/server/authing';
import {
  getUserByAuthingId,
  listAllPointMallOrders,
  updatePointMallOrderStatus,
  type PointMallOrderStatus,
} from '../../../../lib/server/database';

export const prerender = false;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const authorizeAdmin = authorizeAdminRequest;

export const GET: APIRoute = async ({ request }) => {
  try {
    await authorizeAdmin(request);
    return json({ orders: listAllPointMallOrders() });
  } catch (error) {
    const forbidden = error instanceof Error && error.message === 'forbidden';
    return json({ error: forbidden ? '当前账户没有管理员权限。' : '请先登录管理员账户。' }, forbidden ? 403 : 401);
  }
};

export const PATCH: APIRoute = async ({ request }) => {
  try {
    const profile = await authorizeAdmin(request);
    const body = (await request.json()) as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const allowedStatuses: Array<Exclude<PointMallOrderStatus, 'pending'>> = ['processing', 'shipped', 'completed', 'cancelled'];
    const status = allowedStatuses.find((value) => value === body.status);
    const logisticsNumber = typeof body.logisticsNumber === 'string' ? body.logisticsNumber.trim() : '';
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!id || !status) return json({ error: '订单处理参数无效。' }, 400);
    if (logisticsNumber.length > 100 || /[<>\r\n]/.test(logisticsNumber)) return json({ error: '物流单号不能超过 100 个普通字符。' }, 400);
    if (status === 'shipped' && !logisticsNumber) return json({ error: '确认发货时请填写物流单号。' }, 400);
    if (note.length > 500 || /[<>]/.test(note)) return json({ error: '处理备注不能超过 500 个普通字符。' }, 400);
    const user = getUserByAuthingId(profile.sub);
    const profileName = [profile.nickname, profile.name, profile.username, profile.email]
      .find((value) => typeof value === 'string' && value.trim());
    const order = updatePointMallOrderStatus(id, {
      status,
      logisticsNumber: logisticsNumber || null,
      note: note || null,
      operator: {
        authingUserId: profile.sub,
        name: user?.displayName || (typeof profileName === 'string' ? profileName.trim() : '') || '管理员',
      },
    });
    return json({ order });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    if (error instanceof Error && error.message === 'forbidden') return json({ error: '当前账户没有管理员权限。' }, 403);
    if (error instanceof Error && error.message !== 'unauthorized') return json({ error: error.message }, 400);
    return json({ error: '请先登录管理员账户。' }, 401);
  }
};
