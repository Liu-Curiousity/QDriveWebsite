import type { APIRoute } from 'astro';
import { verifyAuthingToken } from '../../../lib/server/authing';
import {
  createPointMallOrder,
  getPointMallBalance,
  getUserByAuthingId,
  listActivePointMallProducts,
  listUserPointMallOrders,
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

const getMemberState = (authingUserId: string) => ({
  ...getPointMallBalance(authingUserId),
  orders: listUserPointMallOrders(authingUserId),
});

export const GET: APIRoute = async ({ request }) => {
  const products = listActivePointMallProducts();
  if (!request.headers.get('authorization')) {
    return json({ products, authenticated: false, points: null, availablePoints: null, orders: [] });
  }
  try {
    const profile = await authorize(request);
    getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    return json({ products, authenticated: true, ...getMemberState(profile.sub) });
  } catch {
    return json({ error: '登录状态无效或已过期。' }, 401);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    if (Number(request.headers.get('content-length') || 0) > 50_000) {
      return json({ error: '提交的数据过大。' }, 413);
    }
    const profile = await authorize(request);
    const body = (await request.json()) as Record<string, unknown>;
    const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
    const quantity = Number(body.quantity);
    const recipientName = typeof body.recipientName === 'string' ? body.recipientName.trim() : '';
    const recipientPhone = typeof body.recipientPhone === 'string' ? body.recipientPhone.trim() : '';
    const shippingAddress = typeof body.shippingAddress === 'string' ? body.shippingAddress.trim() : '';
    const customerNote = typeof body.customerNote === 'string' ? body.customerNote.trim() : '';

    if (!productId || productId.length > 80) return json({ error: '请选择要兑换的商品。' }, 400);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return json({ error: '兑换数量应为 1–10 的整数。' }, 400);
    }
    if (recipientName.length < 2 || recipientName.length > 30 || /[<>\r\n]/.test(recipientName)) {
      return json({ error: '请输入 2–30 个字符的收货人姓名。' }, 400);
    }
    if (recipientPhone.length < 6 || recipientPhone.length > 30 || !/^[\d+()\s-]+$/.test(recipientPhone)) {
      return json({ error: '请输入有效的联系电话。' }, 400);
    }
    if (shippingAddress.length < 5 || shippingAddress.length > 200 || /[<>]/.test(shippingAddress)) {
      return json({ error: '请输入 5–200 个字符的收货地址。' }, 400);
    }
    if (customerNote.length > 200 || /[<>]/.test(customerNote)) {
      return json({ error: '订单备注不能超过 200 个普通字符。' }, 400);
    }

    getUserByAuthingId(profile.sub) || upsertAuthingUser(profile);
    const order = createPointMallOrder(profile.sub, {
      productId,
      quantity,
      recipientName,
      recipientPhone,
      shippingAddress,
      customerNote: customerNote || null,
    });
    return json({ order, products: listActivePointMallProducts(), ...getMemberState(profile.sub) }, 201);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: '请求内容无效。' }, 400);
    if (error instanceof Error && error.message !== 'unauthorized') return json({ error: error.message }, 400);
    return json({ error: '请先登录后再兑换商品。' }, 401);
  }
};
