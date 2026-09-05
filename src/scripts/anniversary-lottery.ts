import { AUTHING_APP_ID } from '../config/authing';

interface StoredLoginState {
  accessToken: string;
  idToken: string;
  expireAt: number;
}

interface LotterySubmission {
  id: string;
  content: string;
  shippingAddress: string;
  status: 'pending' | 'approved' | 'rejected';
  prizeLevel: 'first' | 'second' | 'third' | null;
  reviewNote: string | null;
  createdAt: string;
  attachments: Array<{ id: string; name: string; mime: string; size: number }>;
}

const AUTH_SESSION_KEY = `qdrive-auth:${AUTHING_APP_ID}:session`;

const readLoginState = (): StoredLoginState | null => {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as Partial<StoredLoginState>;
    if (!state.accessToken || !state.idToken || !state.expireAt || state.expireAt <= Date.now()) return null;
    return state as StoredLoginState;
  } catch {
    return null;
  }
};

const readJson = async <T>(response: Response): Promise<T> => {
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || '请求失败，请稍后重试。');
  return payload;
};

const readFileAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(new Error(`无法读取附件“${file.name}”。`));
  reader.readAsDataURL(file);
});

const formatFileSize = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const initAnniversaryLottery = (root: HTMLElement) => {
  const open = root.querySelector<HTMLButtonElement>('[data-anniversary-lottery-open]');
  const dialog = root.querySelector<HTMLDialogElement>('[data-anniversary-lottery-dialog]');
  const cancelButtons = root.querySelectorAll<HTMLButtonElement>('[data-anniversary-lottery-cancel]');
  const form = root.querySelector<HTMLFormElement>('[data-anniversary-lottery-form]');
  const content = root.querySelector<HTMLTextAreaElement>('[data-anniversary-lottery-content]');
  const recipient = root.querySelector<HTMLInputElement>('[data-anniversary-lottery-recipient]');
  const phone = root.querySelector<HTMLInputElement>('[data-anniversary-lottery-phone]');
  const address = root.querySelector<HTMLTextAreaElement>('[data-anniversary-lottery-address]');
  const attachments = root.querySelector<HTMLInputElement>('[data-anniversary-lottery-attachments]');
  const files = root.querySelector<HTMLElement>('[data-anniversary-lottery-files]');
  const status = root.querySelector<HTMLElement>('[data-anniversary-lottery-status]');
  const notice = root.querySelector<HTMLElement>('[data-anniversary-lottery-notice]');
  const submit = root.querySelector<HTMLButtonElement>('[data-anniversary-lottery-submit]');
  const list = root.querySelector<HTMLElement>('[data-anniversary-lottery-list]');
  if (!open || !dialog || !cancelButtons.length || !form || !content || !recipient || !phone || !address || !attachments || !files || !status || !notice || !submit || !list) return;

  let selectedFiles: File[] = [];

  const setStatus = (message = '', isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const renderFiles = () => {
    files.replaceChildren();
    if (!selectedFiles.length) {
      const empty = document.createElement('li');
      empty.className = 'is-empty';
      empty.textContent = '尚未选择附件';
      files.append(empty);
      return;
    }
    selectedFiles.forEach((file, index) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${index + 1}. ${file.name}`;
      const meta = document.createElement('span');
      meta.className = 'account-contribution-dialog__file-meta';
      const size = document.createElement('small');
      size.textContent = formatFileSize(file.size);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `移除附件 ${file.name}`);
      remove.addEventListener('click', () => {
        selectedFiles.splice(index, 1);
        renderFiles();
      });
      meta.append(size, remove);
      item.append(name, meta);
      files.append(item);
    });
  };

  const renderList = (submissions: LotterySubmission[]) => {
    list.replaceChildren();
    if (!submissions.length) {
      const empty = document.createElement('p');
      empty.className = 'account-contribution-history__empty';
      empty.textContent = '还没有参与记录，提交后可在这里查看进度。';
      list.append(empty);
      return;
    }
    const labels = { pending: '审核中', approved: '已通过', rejected: '未通过' } as const;
    const prizeLabels = { first: '一等奖', second: '二等奖', third: '三等奖' } as const;
    submissions.forEach((submission) => {
      const item = document.createElement('article');
      item.className = 'account-contribution-history__item';
      const heading = document.createElement('div');
      heading.className = 'account-contribution-history__heading';
      const date = document.createElement('time');
      date.dateTime = submission.createdAt;
      date.textContent = new Date(submission.createdAt).toLocaleString('zh-CN');
      const badge = document.createElement('span');
      badge.className = `is-${submission.status}`;
      badge.textContent = labels[submission.status];
      heading.append(date, badge);
      const summary = document.createElement('p');
      summary.textContent = `活动凭证：${submission.content || '未填写'}`;
      item.append(heading, summary);
      const shipping = document.createElement('small');
      shipping.textContent = `收货信息：${submission.shippingAddress}`;
      item.append(shipping);
      if (submission.attachments.length) {
        const attached = document.createElement('small');
        attached.textContent = `附件：${submission.attachments.map((attachment) => attachment.name).join('、')}`;
        item.append(attached);
      }
      if (submission.reviewNote) {
        const note = document.createElement('small');
        note.textContent = `审核备注：${submission.reviewNote}`;
        item.append(note);
      }
      if (submission.prizeLevel) {
        const prize = document.createElement('small');
        prize.textContent = `中奖等级：${prizeLabels[submission.prizeLevel]}`;
        item.append(prize);
      }
      list.append(item);
    });
  };

  const loadEntries = async () => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    const response = await fetch('/api/lotteries', { headers: { Authorization: `Bearer ${state.accessToken}` } });
    const result = await readJson<{ submissions: LotterySubmission[]; settings: { enabled: boolean } }>(response);
    renderList(result.submissions);
    submit.disabled = !result.settings.enabled;
    if (!result.settings.enabled) setStatus('本期活动暂未开放，请留意首页活动通知。', true);
  };

  const closeDialog = () => { if (dialog.open) dialog.close(); };

  open.addEventListener('click', async () => {
    if (!readLoginState()) {
      notice.textContent = '参与活动前请先登录账户。';
      document.querySelector<HTMLButtonElement>('[data-auth-trigger]')?.click();
      return;
    }
    notice.textContent = '';
    submit.disabled = false;
    setStatus();
    list.innerHTML = '<p class="account-contribution-history__empty">正在读取…</p>';
    if (!dialog.open) dialog.showModal();
    try {
      await loadEntries();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法读取活动记录。', true);
    }
  });

  cancelButtons.forEach((button) => button.addEventListener('click', closeDialog));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog();
  });

  attachments.addEventListener('change', () => {
    const merged = [...selectedFiles];
    Array.from(attachments.files || []).forEach((file) => {
      if (!merged.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) merged.push(file);
    });
    selectedFiles = merged.slice(0, 5);
    attachments.value = '';
    renderFiles();
    if (merged.length > 5) setStatus('最多可以上传 5 个附件。', true);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const state = readLoginState();
    if (!state) {
      setStatus('登录状态已过期，请重新登录。', true);
      return;
    }
    const description = content.value.trim();
    const recipientName = recipient.value.trim();
    const recipientPhone = phone.value.trim();
    const detailedAddress = address.value.trim();
    if (!recipientName) return setStatus('请填写收货人姓名。', true);
    if (!/^[0-9+\-\s()]{7,30}$/.test(recipientPhone)) return setStatus('请填写有效的联系电话。', true);
    if (detailedAddress.length < 5) return setStatus('请填写完整的详细地址。', true);
    const shippingAddress = `收货人：${recipientName}\n联系电话：${recipientPhone}\n收货地址：${detailedAddress}`;
    if (selectedFiles.some((file) => file.size > 8_000_000) || selectedFiles.reduce((sum, file) => sum + file.size, 0) > 20_000_000) return setStatus('附件大小不能超过限制。', true);

    submit.disabled = true;
    submit.textContent = '正在提交…';
    setStatus();
    try {
      const encodedAttachments = await Promise.all(selectedFiles.map(async (file) => ({
        name: file.name,
        mime: file.type || 'application/octet-stream',
        dataUrl: await readFileAsDataUrl(file),
      })));
      const response = await fetch('/api/lotteries', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: description, shippingAddress, attachments: encodedAttachments }),
      });
      await readJson<{ submission: LotterySubmission }>(response);
      form.reset();
      selectedFiles = [];
      renderFiles();
      setStatus('参与申请已提交，审核结果会发送到你的账户消息。');
      await loadEntries();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '活动申请提交失败。', true);
    } finally {
      submit.disabled = false;
      submit.textContent = '提交活动申请';
    }
  });
};

document.querySelectorAll<HTMLElement>('[data-anniversary-lottery-root]').forEach(initAnniversaryLottery);
