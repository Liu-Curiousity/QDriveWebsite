import { AUTHING_APP_ID } from '../config/authing';

interface StoredLoginState {
  accessToken: string;
  idToken: string;
  expireAt: number;
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
  const submit = root.querySelector<HTMLButtonElement>('[data-anniversary-lottery-submit]');
  if (!open || !dialog || !cancelButtons.length || !form || !content || !recipient || !phone || !address || !attachments || !files || !status || !submit) return;

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

  const loadSettings = async () => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    const response = await fetch('/api/lotteries', { headers: { Authorization: `Bearer ${state.accessToken}` } });
    const result = await readJson<{
      submissions: Array<{ status: 'pending' | 'approved' | 'rejected' }>;
      settings: { enabled: boolean };
    }>(response);
    const activeSubmission = result.submissions.find((submission) =>
      submission.status === 'pending' || submission.status === 'approved');
    submit.disabled = !result.settings.enabled || Boolean(activeSubmission);
    if (!result.settings.enabled) {
      setStatus('本期活动暂未开放，请留意首页活动通知。', true);
    } else if (activeSubmission?.status === 'pending') {
      setStatus('你已提交过报名，当前正在审核中。', true);
    } else if (activeSubmission?.status === 'approved') {
      setStatus('你已经有一条通过审核的报名，不能重复参与。', true);
    }
  };

  const closeDialog = () => { if (dialog.open) dialog.close(); };

  open.addEventListener('click', async () => {
    if (!readLoginState()) {
      document.querySelector<HTMLButtonElement>('[data-auth-trigger]')?.click();
      return;
    }
    submit.disabled = false;
    setStatus();
    if (!dialog.open) dialog.showModal();
    try {
      await loadSettings();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法读取活动记录。', true);
    }
  });

  cancelButtons.forEach((button) => button.addEventListener('click', closeDialog));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
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
      await readJson<{ submission: { id: string } }>(response);
      form.reset();
      selectedFiles = [];
      renderFiles();
      setStatus();
      closeDialog();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '活动申请提交失败。', true);
    } finally {
      submit.disabled = false;
      submit.textContent = '提交活动申请';
    }
  });
};

document.querySelectorAll<HTMLElement>('[data-anniversary-lottery-root]').forEach(initAnniversaryLottery);
