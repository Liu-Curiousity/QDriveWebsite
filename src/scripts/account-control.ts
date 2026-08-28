import {
  AUTHING_APP_ID,
  AUTHING_HOST,
  AUTHING_USER_POOL_ID,
} from '../config/authing';

interface StoredLoginState {
  accessToken: string;
  idToken: string;
  expireAt: number;
}

interface AuthingResponse<T = Record<string, unknown>> {
  statusCode?: number;
  message?: string;
  data?: T;
}

interface SiteUser {
  id: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  customDisplayName: string | null;
  hasCustomAvatar: boolean;
}

const AUTH_SESSION_KEY = `qdrive-auth:${AUTHING_APP_ID}:session`;

const stringValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const readLoginState = (): StoredLoginState | null => {
  try {
    const value = localStorage.getItem(AUTH_SESSION_KEY);
    if (!value) return null;
    const state = JSON.parse(value) as Partial<StoredLoginState>;
    if (
      typeof state.accessToken !== 'string' ||
      typeof state.idToken !== 'string' ||
      typeof state.expireAt !== 'number' ||
      state.expireAt <= Date.now()
    ) return null;
    return state as StoredLoginState;
  } catch {
    return null;
  }
};

const readJson = async <T>(response: Response): Promise<T> => {
  const result = (await response.json()) as T & { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(result.error || result.message || '请求未完成，请稍后重试。');
  }
  return result;
};

const authingRequest = async <T>(
  endpoint: string,
  body: Record<string, unknown>,
  accessToken: string,
  requireData = false,
): Promise<T> => {
  const response = await fetch(`${AUTHING_HOST}/api/v3/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-authing-app-id': AUTHING_APP_ID,
      'x-authing-userpool-id': AUTHING_USER_POOL_ID,
      'x-authing-request-from': 'qdrive-web',
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as AuthingResponse<T>;
  if (!response.ok || result.statusCode !== 200 || (requireData && !result.data)) {
    throw new Error(result.message || 'Authing 暂时无法完成此操作。');
  }
  return (result.data ?? {}) as T;
};

const getAuthingProfile = async (accessToken: string) => {
  const response = await fetch(`${AUTHING_HOST}/api/v3/get-profile`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-authing-app-id': AUTHING_APP_ID,
      'x-authing-userpool-id': AUTHING_USER_POOL_ID,
    },
  });
  const result = (await response.json()) as AuthingResponse<Record<string, unknown>>;
  if (!response.ok || result.statusCode !== 200 || !result.data) {
    throw new Error(result.message || '无法读取 Authing 账户资料。');
  }
  return result.data;
};

function initAccountControl(root: HTMLElement) {
  const openButton = root.querySelector<HTMLButtonElement>('[data-auth-profile-open]');
  const menu = root.querySelector<HTMLElement>('[data-auth-account-menu]');
  const authTrigger = root.querySelector<HTMLElement>('[data-auth-trigger]');
  const dialog = root.querySelector<HTMLDialogElement>('[data-account-dialog]');
  const closeButton = root.querySelector<HTMLButtonElement>('[data-account-close]');
  const status = root.querySelector<HTMLElement>('[data-account-status]');
  const sectionButtons = root.querySelectorAll<HTMLButtonElement>('[data-account-section]');
  const views = root.querySelectorAll<HTMLElement>('[data-account-view]');
  const profileForm = root.querySelector<HTMLFormElement>('[data-account-profile-form]');
  const nicknameInput = root.querySelector<HTMLInputElement>('[data-account-nickname]');
  const usernameInput = root.querySelector<HTMLInputElement>('[data-account-username]');
  const usernameText = root.querySelector<HTMLElement>('[data-account-username-text]');
  const usernameHint = root.querySelector<HTMLElement>('[data-account-username-hint]');
  const avatarInput = root.querySelector<HTMLInputElement>('[data-account-avatar-input]');
  const avatarRemove = root.querySelector<HTMLButtonElement>('[data-account-avatar-remove]');
  const profileSave = root.querySelector<HTMLButtonElement>('[data-account-profile-save]');
  const accountName = root.querySelector<HTMLElement>('[data-account-name]');
  const accountMeta = root.querySelector<HTMLElement>('[data-account-meta]');
  const avatarElements = root.querySelectorAll<HTMLElement>('[data-account-avatar]');
  const emailForm = root.querySelector<HTMLFormElement>('[data-account-binding="email"]');
  const phoneForm = root.querySelector<HTMLFormElement>('[data-account-binding="phone"]');
  const emailInput = root.querySelector<HTMLInputElement>('[data-account-email]');
  const emailCode = root.querySelector<HTMLInputElement>('[data-account-email-code]');
  const emailSend = root.querySelector<HTMLButtonElement>('[data-account-email-send]');
  const emailState = root.querySelector<HTMLElement>('[data-account-email-state]');
  const emailCurrent = root.querySelector<HTMLElement>('[data-account-email-current]');
  const emailUnbindPanel = root.querySelector<HTMLElement>('[data-account-email-unbind-panel]');
  const emailUnbindCode = root.querySelector<HTMLInputElement>('[data-account-email-unbind-code]');
  const emailUnbindSend = root.querySelector<HTMLButtonElement>('[data-account-email-unbind-send]');
  const emailUnbindSubmit = root.querySelector<HTMLButtonElement>('[data-account-email-unbind-submit]');
  const phoneInput = root.querySelector<HTMLInputElement>('[data-account-phone]');
  const phoneCode = root.querySelector<HTMLInputElement>('[data-account-phone-code]');
  const phoneSend = root.querySelector<HTMLButtonElement>('[data-account-phone-send]');
  const phoneState = root.querySelector<HTMLElement>('[data-account-phone-state]');
  const phoneCurrent = root.querySelector<HTMLElement>('[data-account-phone-current]');
  const phoneUnbindPanel = root.querySelector<HTMLElement>('[data-account-phone-unbind-panel]');
  const phoneUnbindCode = root.querySelector<HTMLInputElement>('[data-account-phone-unbind-code]');
  const phoneUnbindSend = root.querySelector<HTMLButtonElement>('[data-account-phone-unbind-send]');
  const phoneUnbindSubmit = root.querySelector<HTMLButtonElement>('[data-account-phone-unbind-submit]');

  if (
    !openButton || !menu || !authTrigger || !dialog || !closeButton || !status ||
    !profileForm || !nicknameInput || !usernameInput || !usernameText || !usernameHint || !avatarInput ||
    !avatarRemove || !profileSave || !accountName || !accountMeta ||
    !emailForm || !phoneForm || !emailInput || !emailCode || !emailSend ||
    !emailState || !emailCurrent || !emailUnbindPanel || !emailUnbindCode ||
    !emailUnbindSend || !emailUnbindSubmit || !phoneInput || !phoneCode || !phoneSend ||
    !phoneState || !phoneCurrent || !phoneUnbindPanel || !phoneUnbindCode ||
    !phoneUnbindSend || !phoneUnbindSubmit
  ) return;

  let authingProfile: Record<string, unknown> | null = null;
  let pendingAvatar: string | null | undefined;
  const countdowns = new Map<HTMLButtonElement, number>();

  const setStatus = (message = '', isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const setAvatars = (url: string, displayName: string) => {
    avatarElements.forEach((element) => {
      element.style.backgroundImage = url ? `url("${url.replaceAll('"', '%22')}")` : '';
      element.textContent = url ? '' : (displayName.slice(0, 1).toUpperCase() || 'Q');
    });
  };

  const setBindingState = (
    formElement: HTMLFormElement,
    stateElement: HTMLElement,
    currentElement: HTMLElement,
    value: string,
    emptyMessage: string,
  ) => {
    const bound = Boolean(value);
    formElement.classList.toggle('is-bound', bound);
    stateElement.classList.toggle('is-bound', bound);
    stateElement.textContent = bound ? '已绑定' : '未绑定';
    currentElement.textContent = bound ? value : emptyMessage;
    const fields = formElement.querySelector<HTMLElement>('[data-account-binding-fields]');
    const bindSubmit = formElement.querySelector<HTMLButtonElement>('[data-account-bind-submit]');
    const unbindPanel = formElement.querySelector<HTMLElement>('[data-account-unbind-panel]');
    if (fields) fields.hidden = bound;
    if (bindSubmit) bindSubmit.hidden = bound;
    if (unbindPanel) unbindPanel.hidden = !bound;
    fields?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')
      .forEach((element) => { element.disabled = bound; });
    unbindPanel?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')
      .forEach((element) => { element.disabled = !bound; });
  };

  const applyAccountData = (profile: Record<string, unknown>, user: SiteUser) => {
    authingProfile = profile;
    const username = stringValue(profile.username) || user.username || '';
    const email = stringValue(profile.email) || user.email || '';
    const phone =
      stringValue(profile.phoneNumber) ||
      stringValue(profile.phone) ||
      stringValue(profile.phone_number) ||
      user.phone ||
      '';
    const displayName =
      user.displayName ||
      stringValue(profile.nickname) ||
      stringValue(profile.name) ||
      username ||
      'QDrive 用户';
    const avatarUrl = user.avatarUrl || stringValue(profile.photo) || stringValue(profile.picture);

    nicknameInput.value = user.customDisplayName || displayName;
    const hasUsername = Boolean(username);
    usernameText.hidden = !hasUsername;
    usernameText.textContent = username || '未设置用户名';
    usernameInput.hidden = hasUsername;
    usernameInput.readOnly = hasUsername;
    usernameInput.value = hasUsername ? username : '';
    usernameHint.textContent = hasUsername
      ? '用户名由 Authing 管理。'
      : '暂未设置用户名，请在 Authing 注册资料中设置。';
    accountName.textContent = displayName;
    accountMeta.textContent = email || phone || username;
    setAvatars(avatarUrl || '', displayName);
    setBindingState(
      emailForm,
      emailState,
      emailCurrent,
      email,
      '绑定后可使用邮箱验证码登录。',
    );
    setBindingState(
      phoneForm,
      phoneState,
      phoneCurrent,
      phone,
      '当前仅支持中国大陆 +86 手机号。',
    );
    root.dispatchEvent(new CustomEvent('qdrive:profile-updated', {
      detail: { displayName, avatarUrl, email, phone, username },
    }));
  };

  const getSiteAccount = async (state: StoredLoginState) => {
    const response = await fetch('/api/account', {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    return readJson<{ user: SiteUser }>(response);
  };

  const refreshAccount = async () => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    const [profile, account] = await Promise.all([
      getAuthingProfile(state.accessToken),
      getSiteAccount(state),
    ]);
    applyAccountData(profile, account.user);
    return state;
  };

  const syncBackend = async (state: StoredLoginState) => {
    await fetch('/api/auth/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
  };

  const startCountdown = (button: HTMLButtonElement) => {
    let seconds = 60;
    button.disabled = true;
    button.textContent = `${seconds}s`;
    const timer = window.setInterval(() => {
      seconds -= 1;
      button.textContent = seconds > 0 ? `${seconds}s` : '重新发送';
      if (seconds <= 0) {
        window.clearInterval(timer);
        countdowns.delete(button);
        button.disabled = false;
      }
    }, 1000);
    countdowns.set(button, timer);
  };

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('无法读取头像文件。'));
      reader.onerror = () => reject(new Error('无法读取头像文件。'));
      reader.readAsDataURL(file);
    });

  openButton.addEventListener('click', async () => {
    menu.hidden = true;
    authTrigger.setAttribute('aria-expanded', 'false');
    if (!dialog.open) dialog.showModal();
    setStatus('正在读取账户资料…');
    try {
      await refreshAccount();
      pendingAvatar = undefined;
      setStatus();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法读取账户资料。', true);
    }
  });

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  sectionButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const section = button.dataset.accountSection;
      sectionButtons.forEach((item) => {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.toggleAttribute('aria-current', active);
      });
      views.forEach((view) => {
        view.hidden = view.dataset.accountView !== section;
      });
      setStatus();
    });
  });

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setStatus('头像仅支持 PNG、JPEG 或 WebP 格式。', true);
      avatarInput.value = '';
      return;
    }
    if (file.size > 1_500_000) {
      setStatus('头像文件不能超过 1.5 MB。', true);
      avatarInput.value = '';
      return;
    }
    try {
      pendingAvatar = await readFileAsDataUrl(file);
      setAvatars(pendingAvatar, nicknameInput.value || 'QDrive 用户');
      setStatus('头像已选择，点击“保存资料”后生效。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法读取头像。', true);
    }
  });

  avatarRemove.addEventListener('click', () => {
    pendingAvatar = null;
    avatarInput.value = '';
    setAvatars('', nicknameInput.value || 'QDrive 用户');
    setStatus('头像将在保存后移除。');
  });

  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const state = readLoginState();
    if (!state) {
      setStatus('登录状态已过期，请重新登录。', true);
      return;
    }
    const displayName = nicknameInput.value.trim();
    if (!displayName || displayName.length > 32 || /[\r\n<>]/.test(displayName)) {
      setStatus('昵称应为 1–32 个普通字符。', true);
      return;
    }

    profileSave.disabled = true;
    profileSave.textContent = '正在保存…';
    setStatus();
    try {
      const body: Record<string, unknown> = { displayName };
      if (pendingAvatar !== undefined) body.avatarDataUrl = pendingAvatar;
      const response = await fetch('/api/account', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${state.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const result = await readJson<{ user: SiteUser }>(response);
      pendingAvatar = undefined;
      if (authingProfile) applyAccountData(authingProfile, result.user);
      setStatus('个人资料已保存。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '资料保存失败。', true);
    } finally {
      profileSave.disabled = false;
      profileSave.textContent = '保存资料';
    }
  });

  const sendBindingCode = async (kind: 'email' | 'phone') => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    if (kind === 'email') {
      const email = emailInput.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('请输入有效的邮箱地址。');
      }
      await authingRequest('send-email', {
        channel: 'CHANNEL_BIND_EMAIL',
        email,
      }, state.accessToken);
      startCountdown(emailSend);
    } else {
      const phone = phoneInput.value.replace(/[\s()-]/g, '').replace(/^\+?86/, '');
      if (!/^1\d{10}$/.test(phone)) throw new Error('请输入有效的中国大陆手机号。');
      await authingRequest('send-sms', {
        channel: 'CHANNEL_BIND_PHONE',
        phoneNumber: phone,
        phoneCountryCode: '+86',
      }, state.accessToken);
      startCountdown(phoneSend);
    }
    setStatus('验证码已发送，请注意查收。');
  };

  emailSend.addEventListener('click', async () => {
    emailSend.disabled = true;
    try {
      await sendBindingCode('email');
    } catch (error) {
      emailSend.disabled = false;
      setStatus(error instanceof Error ? error.message : '验证码发送失败。', true);
    }
  });

  phoneSend.addEventListener('click', async () => {
    phoneSend.disabled = true;
    try {
      await sendBindingCode('phone');
    } catch (error) {
      phoneSend.disabled = false;
      setStatus(error instanceof Error ? error.message : '验证码发送失败。', true);
    }
  });

  const bindAccount = async (kind: 'email' | 'phone') => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    if (kind === 'email') {
      const email = emailInput.value.trim();
      const passCode = emailCode.value.trim();
      if (!email || !/^\d{4,8}$/.test(passCode)) throw new Error('请填写邮箱和验证码。');
      await authingRequest('bind-email', { email, passCode }, state.accessToken);
    } else {
      const phoneNumber = phoneInput.value.replace(/[\s()-]/g, '').replace(/^\+?86/, '');
      const passCode = phoneCode.value.trim();
      if (!/^1\d{10}$/.test(phoneNumber) || !/^\d{4,8}$/.test(passCode)) {
        throw new Error('请填写手机号和验证码。');
      }
      await authingRequest('bind-phone', {
        phoneNumber,
        phoneCountryCode: '+86',
        passCode,
      }, state.accessToken);
    }

    await syncBackend(state);
    await refreshAccount();
    setStatus(kind === 'email' ? '邮箱绑定成功。' : '手机号绑定成功。');
  };

  const sendUnbindCode = async (kind: 'email' | 'phone') => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    if (kind === 'email') {
      const email = emailCurrent.textContent?.trim() || '';
      if (!email || !email.includes('@')) throw new Error('当前邮箱资料无效。');
      await authingRequest('send-email', {
        channel: 'CHANNEL_UNBIND_EMAIL',
        email,
      }, state.accessToken, false);
      startCountdown(emailUnbindSend);
    } else {
      const phone = (phoneCurrent.textContent || '').replace(/[\s()-]/g, '').replace(/^\+?86/, '');
      if (!/^1\d{10}$/.test(phone)) throw new Error('当前手机号资料无效。');
      await authingRequest('send-sms', {
        channel: 'CHANNEL_UNBIND_PHONE',
        phoneNumber: phone,
        phoneCountryCode: '+86',
      }, state.accessToken, false);
      startCountdown(phoneUnbindSend);
    }
    setStatus('解除绑定验证码已发送，请注意查收。');
  };

  const unbindAccount = async (kind: 'email' | 'phone') => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    const passCode = (kind === 'email' ? emailUnbindCode : phoneUnbindCode).value.trim();
    if (!/^\d{4,8}$/.test(passCode)) throw new Error('请输入正确的解除验证码。');
    await authingRequest(kind === 'email' ? 'unbind-email' : 'unbind-phone', { passCode }, state.accessToken, false);
    await syncBackend(state);
    await refreshAccount();
    setStatus(kind === 'email' ? '邮箱已解除绑定。' : '手机号已解除绑定。');
  };

  emailForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = emailForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!submit) return;
    submit.disabled = true;
    submit.textContent = '正在绑定…';
    try {
      await bindAccount('email');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '邮箱绑定失败。', true);
    } finally {
      submit.disabled = emailForm.classList.contains('is-bound');
      submit.textContent = '绑定邮箱';
    }
  });

  phoneForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = phoneForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!submit) return;
    submit.disabled = true;
    submit.textContent = '正在绑定…';
    try {
      await bindAccount('phone');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '手机号绑定失败。', true);
    } finally {
      submit.disabled = phoneForm.classList.contains('is-bound');
      submit.textContent = '绑定手机号';
    }
  });

  emailUnbindSend.addEventListener('click', async () => {
    emailUnbindSend.disabled = true;
    try { await sendUnbindCode('email'); }
    catch (error) {
      emailUnbindSend.disabled = false;
      setStatus(error instanceof Error ? error.message : '验证码发送失败。', true);
    }
  });

  phoneUnbindSend.addEventListener('click', async () => {
    phoneUnbindSend.disabled = true;
    try { await sendUnbindCode('phone'); }
    catch (error) {
      phoneUnbindSend.disabled = false;
      setStatus(error instanceof Error ? error.message : '验证码发送失败。', true);
    }
  });

  const attachUnbind = (kind: 'email' | 'phone', button: HTMLButtonElement) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = '正在解除…';
      try { await unbindAccount(kind); }
      catch (error) { setStatus(error instanceof Error ? error.message : '解除绑定失败。', true); }
      finally {
        button.disabled = false;
        button.textContent = '解除绑定';
      }
    });
  };
  attachUnbind('email', emailUnbindSubmit);
  attachUnbind('phone', phoneUnbindSubmit);

}

document.querySelectorAll<HTMLElement>('[data-auth-root]').forEach(initAccountControl);
