import { AUTHING_APP_ID } from '../config/authing';

interface StoredLoginState {
  accessToken: string;
  idToken?: string;
  expireAt: number;
}

interface PointMallProduct {
  id: string;
  name: string;
  category: string;
  pointsCost: number;
  stock: number;
}

interface PointMallOrder {
  id: string;
  productName: string;
  quantity: number;
  totalPoints: number;
  recipientName: string;
  shippingAddress: string;
  status: 'pending' | 'processing' | 'shipped' | 'completed' | 'cancelled';
  adminNote: string | null;
  createdAt: string;
}

interface PointMallState {
  products: PointMallProduct[];
  authenticated?: boolean;
  points: number | null;
  availablePoints: number | null;
  orders: PointMallOrder[];
}

const AUTH_SESSION_KEY = `qdrive-auth:${AUTHING_APP_ID}:session`;

const readLoginState = (): StoredLoginState | null => {
  try {
    const state = JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || '') as Partial<StoredLoginState>;
    return typeof state.accessToken === 'string' && typeof state.expireAt === 'number' && state.expireAt > Date.now()
      ? state as StoredLoginState
      : null;
  } catch {
    return null;
  }
};

const readJson = async <T>(response: Response): Promise<T> => {
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || '请求未完成，请稍后重试。');
  return result;
};

const formatPoints = (value: number) => value.toLocaleString('zh-CN');

function initPointMall(root: HTMLElement) {
  const balance = root.querySelector<HTMLElement>('[data-mall-balance]');
  const balanceNote = root.querySelector<HTMLElement>('[data-mall-balance-note]');
  const orderList = root.querySelector<HTMLElement>('[data-mall-order-list]');
  const orderCount = root.querySelector<HTMLElement>('[data-mall-order-count]');
  const notice = root.querySelector<HTMLElement>('[data-mall-notice]');
  const dialog = root.querySelector<HTMLDialogElement>('[data-mall-dialog]');
  const form = root.querySelector<HTMLFormElement>('[data-mall-order-form]');
  const selectedCategory = root.querySelector<HTMLElement>('[data-mall-selected-category]');
  const selectedName = root.querySelector<HTMLElement>('[data-mall-selected-name]');
  const selectedCost = root.querySelector<HTMLElement>('[data-mall-selected-cost]');
  const quantity = root.querySelector<HTMLInputElement>('[data-mall-quantity]');
  const total = root.querySelector<HTMLElement>('[data-mall-total]');
  const shippingInfo = root.querySelector<HTMLTextAreaElement>('[data-mall-shipping-info]');
  const customerNote = root.querySelector<HTMLTextAreaElement>('[data-mall-note]');
  const dialogStatus = root.querySelector<HTMLElement>('[data-mall-dialog-status]');
  const submit = root.querySelector<HTMLButtonElement>('[data-mall-submit]');
  if (!balance || !balanceNote || !orderList || !orderCount || !notice || !dialog || !form ||
    !selectedCategory || !selectedName || !selectedCost || !quantity || !total || !shippingInfo ||
    !customerNote || !dialogStatus || !submit) return;

  let products = new Map<string, PointMallProduct>();
  let availablePoints = 0;
  let authenticated = false;
  let selectedProduct: PointMallProduct | null = null;
  let noticeTimer = 0;

  root.querySelectorAll<HTMLElement>('[data-product-card]').forEach((card) => {
    const id = card.dataset.productId || '';
    if (!id) return;
    products.set(id, {
      id,
      name: card.dataset.productName || '积分商品',
      category: card.dataset.productCategory || '积分商品',
      pointsCost: Number(card.dataset.productCost || 0),
      stock: Number(card.dataset.productStock || 0),
    });
  });

  const showNotice = (message: string, isError = false) => {
    window.clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.classList.toggle('is-error', isError);
    notice.hidden = false;
    noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 4200);
  };

  const setDialogStatus = (message = '', isError = false) => {
    dialogStatus.textContent = message;
    dialogStatus.classList.toggle('is-error', isError);
  };

  const syncProductCards = (nextProducts: PointMallProduct[]) => {
    nextProducts.forEach((product) => {
      products.set(product.id, product);
      const card = root.querySelector<HTMLElement>(`[data-product-card][data-product-id="${CSS.escape(product.id)}"]`);
      if (!card) return;
      card.dataset.productCost = String(product.pointsCost);
      card.dataset.productStock = String(product.stock);
      const stockLabel = card.querySelector<HTMLElement>('[data-product-stock-label]');
      const button = card.querySelector<HTMLButtonElement>('[data-mall-redeem]');
      if (stockLabel) stockLabel.textContent = product.stock > 0 ? `库存 ${product.stock}` : '已兑完';
      if (button) {
        button.disabled = product.stock <= 0;
        button.textContent = product.stock > 0 ? '立即兑换' : '暂时缺货';
      }
    });
  };

  const renderOrders = (orders: PointMallOrder[], authenticated: boolean) => {
    orderList.replaceChildren();
    if (!orders.length) {
      const empty = document.createElement('div');
      empty.className = 'point-mall__empty';
      const title = document.createElement('strong');
      title.textContent = '还没有兑换记录';
      const copy = document.createElement('span');
      copy.textContent = authenticated ? '选一件喜欢的商品，开始第一次积分兑换吧。' : '登录后，你的商品兑换进度会显示在这里。';
      empty.append(title, copy);
      orderList.append(empty);
      orderCount.textContent = authenticated ? '0 笔订单' : '登录后查看记录';
      return;
    }
    const labels: Record<PointMallOrder['status'], string> = {
      pending: '待处理', processing: '备货中', shipped: '已发货', completed: '已完成', cancelled: '已取消',
    };
    orders.forEach((order) => {
      const item = document.createElement('article');
      item.className = 'point-order';
      const body = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = `${order.productName} × ${order.quantity}`;
      const meta = document.createElement('p');
      meta.textContent = `${formatPoints(order.totalPoints)} 积分 · ${new Date(order.createdAt).toLocaleString('zh-CN')} · 收货人：${order.recipientName}`;
      const destination = document.createElement('p');
      destination.textContent = `配送至：${order.shippingAddress}`;
      body.append(title, meta, destination);
      if (order.adminNote) {
        const note = document.createElement('p');
        note.textContent = `处理备注：${order.adminNote}`;
        body.append(note);
      }
      const status = document.createElement('span');
      status.className = `point-order__status is-${order.status}`;
      status.textContent = labels[order.status];
      item.append(body, status);
      orderList.append(item);
    });
    orderCount.textContent = `${orders.length} 笔订单`;
  };

  const updateTotal = () => {
    if (!selectedProduct) return;
    const maxQuantity = Math.max(1, Math.min(10, selectedProduct.stock, Math.floor(availablePoints / selectedProduct.pointsCost)));
    const value = Math.max(1, Math.min(maxQuantity, Math.floor(Number(quantity.value) || 1)));
    quantity.max = String(maxQuantity);
    quantity.value = String(value);
    total.textContent = formatPoints(value * selectedProduct.pointsCost);
  };

  const parseShippingInfo = (value: string) => {
    const normalized = value.trim().replace(/^收货信息\s*[:：]?\s*/i, '').replace(/\r/g, '');
    const phoneMatch = normalized.match(/(?:^|\s)(1\d{10}|(?:0\d{2,3}[-\s]?)?\d{7,8})(?=\s|$)/);
    if (!phoneMatch) return null;
    const phone = phoneMatch[1].trim();
    const remainder = `${normalized.slice(0, phoneMatch.index)} ${normalized.slice((phoneMatch.index || 0) + phoneMatch[0].length)}`.trim();
    const parts = remainder.split(/\s+/).filter(Boolean);
    const recipientName = parts.shift() || '';
    const shippingAddress = parts.join(' ').trim();
    if (recipientName.length < 2 || shippingAddress.length < 5) return null;
    return { recipientName, recipientPhone: phone, shippingAddress };
  };

  const loadState = async () => {
    const state = readLoginState();
    const tokens = state ? [...new Set([state.accessToken, state.idToken].filter((token): token is string => Boolean(token)))] : [];
    let response = await fetch('/api/point-mall', { headers: tokens[0] ? { Authorization: `Bearer ${tokens[0]}` } : {} });
    if (response.status === 401 && tokens[1]) {
      response = await fetch('/api/point-mall', { headers: { Authorization: `Bearer ${tokens[1]}` } });
    }
    if (response.status === 401 && state) response = await fetch('/api/point-mall');
    const result = await readJson<PointMallState>(response);
    syncProductCards(result.products);
    authenticated = Boolean(state && result.authenticated);
    availablePoints = authenticated ? Number(result.availablePoints || 0) : 0;
    balance.textContent = authenticated ? formatPoints(availablePoints) : '--';
    balanceNote.textContent = authenticated
      ? result.points !== result.availablePoints ? `账户积分 ${formatPoints(Number(result.points || 0))}，部分积分已用于待处理申请` : '当前可直接兑换的积分'
      : '登录后查看可用积分';
    renderOrders(result.orders, authenticated);
  };

  const openDialog = async (productId: string) => {
    const state = readLoginState();
    if (!state) {
      showNotice('请先登录 QDrive Tech 账户，再兑换积分商品。');
      document.querySelector<HTMLButtonElement>('[data-auth-trigger]')?.click();
      return;
    }
    try {
      await loadState();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '无法读取积分信息。', true);
      return;
    }
    if (!authenticated) {
      localStorage.removeItem(AUTH_SESSION_KEY);
      sessionStorage.setItem('qdrive:point-mall:open-login', '1');
      window.location.reload();
      return;
    }
    const product = products.get(productId);
    if (!product || product.stock <= 0) {
      showNotice('这件商品暂时没有库存。', true);
      return;
    }
    if (availablePoints < product.pointsCost) {
      showNotice(`可用积分不足，还需要 ${formatPoints(product.pointsCost - availablePoints)} 积分。`, true);
      return;
    }
    selectedProduct = product;
    selectedCategory.textContent = product.category;
    selectedName.textContent = product.name;
    selectedCost.textContent = formatPoints(product.pointsCost);
    quantity.value = '1';
    setDialogStatus();
    updateTotal();
    if (!dialog.open) dialog.showModal();
  };

  root.querySelectorAll<HTMLButtonElement>('[data-mall-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      const filter = button.dataset.mallFilter || '全部';
      root.querySelectorAll<HTMLButtonElement>('[data-mall-filter]').forEach((item) => item.classList.toggle('is-active', item === button));
      root.querySelectorAll<HTMLElement>('[data-product-card]').forEach((card) => {
        card.hidden = filter !== '全部' && card.dataset.productCategory !== filter;
      });
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-mall-redeem]').forEach((button) => {
    button.addEventListener('click', () => void openDialog(button.dataset.productId || ''));
  });

  root.querySelectorAll<HTMLButtonElement>('[data-mall-dialog-close]').forEach((button) => {
    button.addEventListener('click', () => { if (dialog.open) dialog.close(); });
  });
  quantity.addEventListener('input', updateTotal);
  root.querySelector<HTMLButtonElement>('[data-mall-quantity-minus]')?.addEventListener('click', () => {
    quantity.value = String(Math.max(1, Number(quantity.value || 1) - 1));
    updateTotal();
  });
  root.querySelector<HTMLButtonElement>('[data-mall-quantity-plus]')?.addEventListener('click', () => {
    quantity.value = String(Number(quantity.value || 1) + 1);
    updateTotal();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedProduct || !form.reportValidity()) return;
    const state = readLoginState();
    if (!state) {
      setDialogStatus('登录状态已过期，请重新登录。', true);
      return;
    }
    const requestedQuantity = Number(quantity.value);
    const shipping = parseShippingInfo(shippingInfo.value);
    if (!shipping) {
      setDialogStatus('请填写完整收货信息，包括姓名、联系电话、省市及详细地址。', true);
      return;
    }
    submit.disabled = true;
    submit.textContent = '正在兑换…';
    setDialogStatus();
    try {
      const payload = JSON.stringify({
        productId: selectedProduct.id,
        quantity: requestedQuantity,
        recipientName: shipping.recipientName,
        recipientPhone: shipping.recipientPhone,
        shippingAddress: shipping.shippingAddress,
        customerNote: customerNote.value.trim(),
      });
      const tokens = [...new Set([state.accessToken, state.idToken].filter((token): token is string => Boolean(token)))];
      const send = (token: string) => fetch('/api/point-mall', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: payload,
      });
      let response = await send(tokens[0]);
      if (response.status === 401 && tokens[1]) response = await send(tokens[1]);
      const result = await readJson<PointMallState & { order: PointMallOrder }>(response);
      availablePoints = Number(result.availablePoints || 0);
      balance.textContent = formatPoints(availablePoints);
      balanceNote.textContent = '当前可直接兑换的积分';
      syncProductCards(result.products);
      renderOrders(result.orders, true);
      form.reset();
      dialog.close();
      document.querySelector('[data-mall-orders-section]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      setDialogStatus(error instanceof Error ? error.message : '兑换失败，请稍后重试。', true);
    } finally {
      submit.disabled = false;
      submit.textContent = '确认兑换';
    }
  });

  const shouldOpenLogin = sessionStorage.getItem('qdrive:point-mall:open-login') === '1';
  if (shouldOpenLogin) sessionStorage.removeItem('qdrive:point-mall:open-login');
  void loadState()
    .then(() => {
      if (shouldOpenLogin) window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-auth-trigger]')?.click(), 0);
    })
    .catch((error) => {
      balance.textContent = '--';
      balanceNote.textContent = '积分信息暂时无法读取';
      showNotice(error instanceof Error ? error.message : '无法读取积分商城。', true);
    });
}

document.querySelectorAll<HTMLElement>('[data-point-mall-root]').forEach(initPointMall);
