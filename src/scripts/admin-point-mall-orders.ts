import { AUTHING_APP_ID } from '../config/authing';

interface StoredLoginState { accessToken: string; expireAt: number }
type OrderStatus = 'pending' | 'processing' | 'shipped' | 'completed' | 'cancelled';
interface MallOrder {
  id: string;
  userName: string;
  productName: string;
  quantity: number;
  totalPoints: number;
  recipientName: string;
  recipientPhone: string;
  shippingAddress: string;
  customerNote: string | null;
  status: OrderStatus;
  logisticsNumber: string | null;
  adminNote: string | null;
  operatorName: string | null;
  createdAt: string;
}

const AUTH_SESSION_KEY = `qdrive-auth:${AUTHING_APP_ID}:session`;
const readLoginState = (): StoredLoginState | null => {
  try {
    const state = JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || '') as Partial<StoredLoginState>;
    return typeof state.accessToken === 'string' && typeof state.expireAt === 'number' && state.expireAt > Date.now() ? state as StoredLoginState : null;
  } catch { return null; }
};
const readJson = async <T>(response: Response): Promise<T> => {
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || '请求未完成。');
  return result;
};

function initMallAdmin(root: HTMLElement) {
  const status = root.querySelector<HTMLElement>('[data-mall-admin-status]');
  const list = root.querySelector<HTMLElement>('[data-mall-admin-list]');
  const filters = root.querySelector<HTMLFormElement>('[data-mall-admin-filters]');
  const userFilter = root.querySelector<HTMLInputElement>('[data-filter-user]');
  const keywordFilter = root.querySelector<HTMLInputElement>('[data-filter-keyword]');
  const statusFilter = root.querySelector<HTMLSelectElement>('[data-filter-status]');
  if (!status || !list || !filters || !userFilter || !keywordFilter || !statusFilter) return;
  let orders: MallOrder[] = [];
  const labels: Record<OrderStatus, string> = { pending: '待处理', processing: '备货中', shipped: '已发货', completed: '已完成', cancelled: '已取消' };

  const setStatus = (message = '', isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const updateOrder = async (
    order: MallOrder,
    nextStatus: Exclude<OrderStatus, 'pending'>,
    logisticsNumber: string,
    note: string,
    buttons: HTMLButtonElement[],
  ) => {
    const state = readLoginState();
    if (!state) throw new Error('请先登录管理员账户。');
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch('/api/admin/point-mall-orders', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${state.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: order.id, status: nextStatus, logisticsNumber, note }),
      });
      await readJson<{ order: MallOrder }>(response);
      setStatus(nextStatus === 'cancelled' ? '订单已取消，积分和库存均已退回。' : `订单已更新为“${labels[nextStatus]}”。`);
      await load();
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  };

  const makeDetail = (label: string, value: string) => {
    const wrap = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    wrap.append(term, description);
    return wrap;
  };

  const makeShippingDetail = (order: MallOrder) => {
    const wrap = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = '收货信息';
    const description = document.createElement('dd');
    const value = `收货信息 ${order.recipientName} ${order.recipientPhone} ${order.shippingAddress}`;
    const text = document.createElement('span');
    text.textContent = value;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'mall-admin__copy';
    copy.textContent = '复制';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        copy.textContent = '已复制';
        window.setTimeout(() => { copy.textContent = '复制'; }, 1600);
      } catch {
        setStatus('复制失败，请手动复制收货信息。', true);
      }
    });
    description.append(text, copy);
    wrap.append(term, description);
    return wrap;
  };

  const render = () => {
    const userQuery = userFilter.value.trim().toLocaleLowerCase();
    const keyword = keywordFilter.value.trim().toLocaleLowerCase();
    const wantedStatus = statusFilter.value;
    const filtered = orders.filter((order) => {
      const text = [order.productName, order.recipientName, order.recipientPhone, order.shippingAddress, order.logisticsNumber || '', order.customerNote || '', order.adminNote || ''].join(' ').toLocaleLowerCase();
      return (!userQuery || order.userName.toLocaleLowerCase().includes(userQuery)) && (!keyword || text.includes(keyword)) && (!wantedStatus || order.status === wantedStatus);
    });
    list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'contribution-admin__empty';
      empty.textContent = orders.length ? '没有符合筛选条件的商城订单。' : '目前没有商城兑换订单。';
      list.append(empty);
      return;
    }
    filtered.forEach((order) => {
      const card = document.createElement('article');
      card.className = 'contribution-admin__card';
      const meta = document.createElement('div');
      meta.className = 'contribution-admin__meta';
      const identity = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = order.userName;
      const time = document.createElement('time');
      time.dateTime = order.createdAt;
      time.textContent = ` · ${new Date(order.createdAt).toLocaleString('zh-CN')}`;
      identity.append(name, time);
      const badge = document.createElement('span');
      badge.className = 'contribution-admin__badge';
      badge.textContent = labels[order.status];
      meta.append(identity, badge);
      const details = document.createElement('dl');
      details.className = 'redemption-admin__details mall-admin__details';
      details.append(
        makeDetail('兑换商品', `${order.productName} × ${order.quantity}`),
        makeDetail('扣除积分', `${order.totalPoints.toLocaleString('zh-CN')} 积分`),
        makeShippingDetail(order),
      );
      card.append(meta, details);
      if (order.customerNote) {
        const customerNote = document.createElement('p');
        customerNote.className = 'contribution-admin__reviewed';
        customerNote.textContent = `用户备注：${order.customerNote}`;
        card.append(customerNote);
      }
      if (order.status !== 'completed' && order.status !== 'cancelled') {
        const review = document.createElement('div');
        review.className = 'contribution-admin__review';
        const logisticsLabel = document.createElement('label');
        logisticsLabel.textContent = '物流单号';
        const logisticsNumber = document.createElement('input');
        logisticsNumber.type = 'text';
        logisticsNumber.maxLength = 100;
        logisticsNumber.value = order.logisticsNumber || '';
        logisticsNumber.placeholder = '确认发货时必填';
        logisticsLabel.append(logisticsNumber);
        const noteLabel = document.createElement('label');
        noteLabel.textContent = '处理备注（选填）';
        const note = document.createElement('textarea');
        note.maxLength = 500;
        note.value = order.adminNote || '';
        note.placeholder = '例如：请留意物流动态';
        noteLabel.append(note);
        const actions = document.createElement('div');
        actions.className = 'contribution-admin__actions';
        const buttons: HTMLButtonElement[] = [];
        const addAction = (label: string, nextStatus: Exclude<OrderStatus, 'pending'>) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.dataset.orderStatus = nextStatus;
          button.addEventListener('click', () => void updateOrder(order, nextStatus, logisticsNumber.value.trim(), note.value.trim(), buttons)
            .catch((error) => setStatus(error instanceof Error ? error.message : '订单处理失败。', true)));
          buttons.push(button);
          actions.append(button);
        };
        if (order.status === 'pending') addAction('开始备货', 'processing');
        if (order.status === 'pending' || order.status === 'processing') addAction('取消并退回积分', 'cancelled');
        if (order.status === 'processing') addAction('标记已发货', 'shipped');
        if (order.status === 'shipped') addAction('标记已完成', 'completed');
        review.append(logisticsLabel, noteLabel, actions);
        card.append(review);
      } else {
        const completed = document.createElement('p');
        completed.className = 'contribution-admin__reviewed';
        completed.textContent = `${order.operatorName ? `处理人：${order.operatorName}` : '已处理'}${order.logisticsNumber ? ` · 物流单号：${order.logisticsNumber}` : ''}${order.adminNote ? ` · 处理备注：${order.adminNote}` : ''}`;
        card.append(completed);
      }
      list.append(card);
    });
    if (filtered.length !== orders.length) setStatus(`筛选出 ${filtered.length} 条，共 ${orders.length} 条。`);
  };

  const load = async () => {
    const state = readLoginState();
    if (!state) throw new Error('请先登录管理员账户。');
    const response = await fetch('/api/admin/point-mall-orders', { headers: { Authorization: `Bearer ${state.accessToken}` } });
    const result = await readJson<{ orders: MallOrder[] }>(response);
    orders = result.orders;
    render();
    if (!userFilter.value && !keywordFilter.value && !statusFilter.value) setStatus();
  };
  [userFilter, keywordFilter, statusFilter].forEach((input) => { input.addEventListener('input', render); input.addEventListener('change', render); });
  filters.addEventListener('reset', () => window.setTimeout(() => { setStatus(); render(); }, 0));
  void load().catch((error) => setStatus(error instanceof Error ? error.message : '无法读取商城订单。', true));
}

document.querySelectorAll<HTMLElement>('[data-mall-admin-root]').forEach(initMallAdmin);
