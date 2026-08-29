import { AUTHING_APP_ID } from '../config/authing';

interface StoredLoginState {
  accessToken: string;
  expireAt: number;
}

interface PointRedemption {
  id: string;
  userName: string;
  taobaoAccount: string;
  requestedPoints: number;
  currentPoints: number;
  status: 'pending' | 'approved' | 'rejected';
  remainingPoints: number | null;
  reviewNote: string | null;
  reviewerName: string | null;
  createdAt: string;
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
  if (!response.ok) throw new Error(result.error || '请求未完成。');
  return result;
};

function initRedemptionAdmin(root: HTMLElement) {
  const status = root.querySelector<HTMLElement>('[data-redemption-admin-status]');
  const list = root.querySelector<HTMLElement>('[data-redemption-admin-list]');
  if (!status || !list) return;

  const setStatus = (message = '', isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const review = async (
    redemption: PointRedemption,
    reviewStatus: 'approved' | 'rejected',
    remainingInput: HTMLInputElement,
    noteInput: HTMLTextAreaElement,
    buttons: HTMLButtonElement[],
  ) => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    const remainingPoints = Number(remainingInput.value);
    if (reviewStatus === 'approved' && (
      !Number.isInteger(remainingPoints) || remainingPoints < 0 || remainingPoints > redemption.currentPoints
    )) throw new Error('积分余量必须是 0 到当前积分之间的整数。');
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch('/api/admin/redemptions', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${state.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: redemption.id,
          status: reviewStatus,
          remainingPoints,
          note: noteInput.value.trim(),
        }),
      });
      await readJson<{ redemption: PointRedemption }>(response);
      setStatus(reviewStatus === 'approved' ? '兑换已处理，积分余额和用户消息已更新。' : '兑换申请已驳回。');
      await load();
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  };

  const render = (redemptions: PointRedemption[]) => {
    list.replaceChildren();
    if (!redemptions.length) {
      const empty = document.createElement('p');
      empty.className = 'contribution-admin__empty';
      empty.textContent = '目前没有积分兑换申请。';
      list.append(empty);
      return;
    }
    const labels = { pending: '待处理', approved: '已完成', rejected: '已驳回' } as const;
    redemptions.forEach((redemption) => {
      const card = document.createElement('article');
      card.className = 'contribution-admin__card';
      const meta = document.createElement('div');
      meta.className = 'contribution-admin__meta';
      const identity = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = redemption.userName;
      const time = document.createElement('time');
      time.dateTime = redemption.createdAt;
      time.textContent = ` · ${new Date(redemption.createdAt).toLocaleString('zh-CN')}`;
      identity.append(name, time);
      const badge = document.createElement('span');
      badge.className = 'contribution-admin__badge';
      badge.textContent = labels[redemption.status];
      meta.append(identity, badge);
      const details = document.createElement('dl');
      details.className = 'redemption-admin__details';
      details.innerHTML = `
        <div><dt>淘宝账号</dt><dd></dd></div>
        <div><dt>申请兑换</dt><dd>${redemption.requestedPoints} 积分</dd></div>
        <div><dt>当前积分</dt><dd>${redemption.currentPoints} 积分</dd></div>
      `;
      const taobaoValue = details.querySelector('dd');
      if (taobaoValue) taobaoValue.textContent = redemption.taobaoAccount;
      card.append(meta, details);

      if (redemption.status === 'pending') {
        const reviewForm = document.createElement('div');
        reviewForm.className = 'contribution-admin__review';
        const remainingLabel = document.createElement('label');
        remainingLabel.textContent = '处理后积分余量';
        const remainingInput = document.createElement('input');
        remainingInput.type = 'number';
        remainingInput.min = '0';
        remainingInput.max = String(redemption.currentPoints);
        remainingInput.step = '1';
        remainingInput.value = String(Math.max(0, redemption.currentPoints - redemption.requestedPoints));
        remainingLabel.append(remainingInput);
        const noteLabel = document.createElement('label');
        noteLabel.textContent = '处理备注（可填写优惠券发放说明）';
        const noteInput = document.createElement('textarea');
        noteInput.maxLength = 500;
        noteInput.placeholder = '例如：优惠券已发放至该淘宝账号';
        noteLabel.append(noteInput);
        const actions = document.createElement('div');
        actions.className = 'contribution-admin__actions';
        const reject = document.createElement('button');
        reject.type = 'button';
        reject.dataset.reviewStatus = 'rejected';
        reject.textContent = '驳回';
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.dataset.reviewStatus = 'approved';
        approve.textContent = '确认发放并更新积分';
        const buttons = [reject, approve];
        reject.addEventListener('click', () => {
          void review(redemption, 'rejected', remainingInput, noteInput, buttons)
            .catch((error) => setStatus(error instanceof Error ? error.message : '处理失败。', true));
        });
        approve.addEventListener('click', () => {
          void review(redemption, 'approved', remainingInput, noteInput, buttons)
            .catch((error) => setStatus(error instanceof Error ? error.message : '处理失败。', true));
        });
        actions.append(reject, approve);
        reviewForm.append(remainingLabel, noteLabel, actions);
        card.append(reviewForm);
      } else {
        const reviewed = document.createElement('p');
        reviewed.className = 'contribution-admin__reviewed';
        const reviewer = redemption.reviewerName || '历史记录未保存审核人';
        reviewed.textContent = redemption.status === 'approved'
          ? `审核人：${reviewer} · 处理后积分余量：${redemption.remainingPoints ?? redemption.currentPoints}${redemption.reviewNote ? ` · ${redemption.reviewNote}` : ''}`
          : `审核人：${reviewer} · 兑换申请已驳回${redemption.reviewNote ? ` · ${redemption.reviewNote}` : ''}`;
        card.append(reviewed);
      }
      list.append(card);
    });
  };

  const load = async () => {
    const state = readLoginState();
    if (!state) throw new Error('请先登录管理员账户。');
    const response = await fetch('/api/admin/redemptions', {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    const result = await readJson<{ redemptions: PointRedemption[] }>(response);
    render(result.redemptions);
    setStatus();
  };

  void load().catch((error) => {
    setStatus(error instanceof Error ? error.message : '无法读取兑换申请。', true);
  });
}

document.querySelectorAll<HTMLElement>('[data-redemption-admin-root]').forEach(initRedemptionAdmin);
