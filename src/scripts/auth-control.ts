import {
  AUTHING_APP_ID,
  AUTHING_HOST,
  AUTHING_USER_POOL_ID,
} from '../config/authing';

type AuthingProfile = Record<string, unknown>;
type AuthView = 'login' | 'register' | 'reset';
type AuthMethod = 'password' | 'code';

interface StoredLoginState {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  expireAt: number;
}

interface AuthingResponse<T = Record<string, unknown>> {
  statusCode?: number;
  message?: string;
  data?: T;
}

interface SiteAccountUser {
  username: string | null;
  email: string | null;
  phone: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

const AUTH_SESSION_KEY = `qdrive-auth:${AUTHING_APP_ID}:session`;

const stringValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const getDisplayName = (user: AuthingProfile): string =>
  stringValue(user.displayName) ||
  stringValue(user.name) ||
  stringValue(user.nickname) ||
  stringValue(user.username) ||
  stringValue(user.email) ||
  stringValue(user.phone) ||
  'QDrive 用户';

const getUserMeta = (user: AuthingProfile): string =>
  stringValue(user.email) ||
  stringValue(user.phoneNumber) ||
  stringValue(user.phone) ||
  stringValue(user.username) ||
  '已通过 Authing 安全认证';

const getAvatarUrl = (user: AuthingProfile): string =>
  stringValue(user.avatarUrl) ||
  stringValue(user.photo) ||
  stringValue(user.picture) ||
  stringValue(user.avatar);

const classifyAccount = (account: string) => {
  const normalized = account.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { type: 'email' as const, value: normalized };
  }

  const phone = normalized.replace(/[\s()-]/g, '');
  if (/^(?:\+?86)?1\d{10}$/.test(phone)) {
    return {
      type: 'phone' as const,
      value: phone.replace(/^\+?86/, ''),
      countryCode: '+86',
    };
  }

  return { type: 'username' as const, value: normalized };
};

const getTokenExpiry = (token: string): number => {
  try {
    const payload = token.split('.')[1];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(
      decodeURIComponent(
        atob(normalized)
          .split('')
          .map((character) =>
            `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
          )
          .join(''),
      ),
    ) as { exp?: number };
    return typeof parsed.exp === 'number'
      ? parsed.exp * 1000
      : Date.now() + 60 * 60 * 1000;
  } catch {
    return Date.now() + 60 * 60 * 1000;
  }
};

const saveLoginState = (data: Record<string, unknown>): StoredLoginState => {
  const accessToken = stringValue(data.access_token ?? data.accessToken);
  const idToken = stringValue(data.id_token ?? data.idToken);
  const refreshToken = stringValue(data.refresh_token ?? data.refreshToken);

  if (!accessToken || !idToken) {
    throw new Error('登录成功，但未收到完整的安全凭证。');
  }

  const state: StoredLoginState = {
    accessToken,
    idToken,
    refreshToken: refreshToken || undefined,
    expireAt: getTokenExpiry(accessToken || idToken),
  };
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(state));
  return state;
};

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
    ) {
      localStorage.removeItem(AUTH_SESSION_KEY);
      return null;
    }
    return state as StoredLoginState;
  } catch {
    localStorage.removeItem(AUTH_SESSION_KEY);
    return null;
  }
};

const authingRequest = async <T>(
  endpoint: string,
  body: Record<string, unknown>,
  requireData = true,
): Promise<T> => {
  const response = await fetch(`${AUTHING_HOST}/api/v3/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-authing-app-id': AUTHING_APP_ID,
      'x-authing-userpool-id': AUTHING_USER_POOL_ID,
      'x-authing-request-from': 'qdrive-web',
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as AuthingResponse<T>;

  if (!response.ok || result.statusCode !== 200 || (requireData && !result.data)) {
    throw new Error(result.message || '认证服务暂时不可用，请稍后重试。');
  }
  return (result.data ?? {}) as T;
};

const readProfile = async (loginState: StoredLoginState) => {
  const response = await fetch(`${AUTHING_HOST}/api/v3/get-profile`, {
    headers: {
      Authorization: `Bearer ${loginState.accessToken}`,
      'x-authing-userpool-id': AUTHING_USER_POOL_ID,
      'x-authing-app-id': AUTHING_APP_ID,
    },
  });
  const result = (await response.json()) as AuthingResponse<AuthingProfile>;
  if (!response.ok || result.statusCode !== 200 || !result.data) {
    throw new Error(result.message || '无法获取用户资料。');
  }
  return result.data;
};

function initAuthControl(root: HTMLElement) {
  const trigger = root.querySelector<HTMLButtonElement>('[data-auth-trigger]');
  const label = root.querySelector<HTMLElement>('[data-auth-label]');
  const indicator = root.querySelector<HTMLElement>('[data-auth-indicator]');
  const avatar = root.querySelector<HTMLElement>('[data-auth-avatar]');
  const accountMenu = root.querySelector<HTMLElement>('[data-auth-account-menu]');
  const menuName = root.querySelector<HTMLElement>('[data-auth-menu-name]');
  const menuMeta = root.querySelector<HTMLElement>('[data-auth-menu-meta]');
  const logoutButton = root.querySelector<HTMLButtonElement>('[data-auth-logout]');
  const dialog = root.querySelector<HTMLDialogElement>('[data-auth-dialog]');
  const closeButton = root.querySelector<HTMLButtonElement>('[data-auth-close]');
  const form = root.querySelector<HTMLFormElement>('[data-auth-form]');
  const accountInput = root.querySelector<HTMLInputElement>('[data-auth-account]');
  const passwordInput = root.querySelector<HTMLInputElement>('[data-auth-password]');
  const codeInput = root.querySelector<HTMLInputElement>('[data-auth-code]');
  const passwordField = root.querySelector<HTMLElement>('[data-auth-password-field]');
  const codeField = root.querySelector<HTMLElement>('[data-auth-code-field]');
  const resetPasswordField = root.querySelector<HTMLElement>('[data-auth-reset-password-field]');
  const resetPasswordInput = root.querySelector<HTMLInputElement>('[data-auth-reset-password]');
  const sendCodeButton = root.querySelector<HTMLButtonElement>('[data-auth-send-code]');
  const submitButton = root.querySelector<HTMLButtonElement>('[data-auth-submit]');
  const formTitle = root.querySelector<HTMLElement>('[data-auth-form-title]');
  const formDescription = root.querySelector<HTMLElement>('[data-auth-form-description]');
  const status = root.querySelector<HTMLElement>('[data-auth-status]');
  const viewButtons = root.querySelectorAll<HTMLButtonElement>('[data-auth-view]');
  const methodButtons = root.querySelectorAll<HTMLButtonElement>('[data-auth-method]');
  const switchRow = root.querySelector<HTMLElement>('[data-auth-switch-row]');
  const switchPrefix = root.querySelector<HTMLElement>('[data-auth-switch-prefix]');
  const switchButton = root.querySelector<HTMLButtonElement>('[data-auth-switch-view]');

  if (
    !trigger || !label || !indicator || !avatar || !accountMenu ||
    !menuName || !menuMeta || !logoutButton || !dialog || !closeButton ||
    !form || !accountInput || !passwordInput || !codeInput || !passwordField ||
    !codeField || !resetPasswordField || !resetPasswordInput || !sendCodeButton ||
    !submitButton || !formTitle || !formDescription || !status ||
    !switchRow || !switchPrefix || !switchButton
  ) return;

  let currentUser: AuthingProfile | null = null;
  let currentView: AuthView = 'login';
  let currentMethod: AuthMethod = 'password';
  let requestPending = false;
  let countdownTimer: number | null = null;

  const setStatus = (message = '', isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const setMenuOpen = (open: boolean) => {
    accountMenu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };

  const setAnonymous = () => {
    currentUser = null;
    root.dataset.authState = 'anonymous';
    label.textContent = '登录';
    trigger.setAttribute('aria-label', '登录 QDrive Tech');
    indicator.hidden = false;
    avatar.hidden = true;
    avatar.textContent = '';
    avatar.style.removeProperty('background-image');
    setMenuOpen(false);
  };

  const setAuthenticated = (user: AuthingProfile) => {
    currentUser = user;
    const displayName = getDisplayName(user);
    const avatarUrl = getAvatarUrl(user);
    root.dataset.authState = 'authenticated';
    label.textContent = displayName;
    trigger.setAttribute('aria-label', `${displayName}，打开账户菜单`);
    indicator.hidden = true;
    avatar.hidden = false;
    avatar.textContent = avatarUrl ? '' : displayName.slice(0, 1).toUpperCase();
    avatar.style.backgroundImage = avatarUrl
      ? `url("${avatarUrl.replaceAll('"', '%22')}")`
      : '';
    menuName.textContent = displayName;
    menuMeta.textContent = getUserMeta(user);
  };

  const syncBackend = async (loginState: StoredLoginState) => {
    for (const token of [loginState.accessToken, loginState.idToken]) {
      try {
        const response = await fetch('/api/auth/sync', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) return true;
      } catch {
        // Try the other signed token when available.
      }
    }
    return false;
  };

  const mergeSiteAccount = async (
    loginState: StoredLoginState,
    profile: AuthingProfile,
  ): Promise<AuthingProfile> => {
    try {
      const response = await fetch('/api/account', {
        headers: { Authorization: `Bearer ${loginState.accessToken}` },
      });
      if (!response.ok) return profile;
      const result = (await response.json()) as { user?: SiteAccountUser };
      if (!result.user) return profile;
      const user = result.user;
      return {
        ...profile,
        displayName: user.displayName || getDisplayName(profile),
        avatarUrl: user.avatarUrl || getAvatarUrl(profile),
        email: user.email || stringValue(profile.email),
        phone: user.phone || stringValue(profile.phoneNumber) || stringValue(profile.phone),
        username: user.username || stringValue(profile.username),
      };
    } catch {
      return profile;
    }
  };

  const finishLogin = async (loginState: StoredLoginState) => {
    const profile = await readProfile(loginState);
    setAuthenticated(profile);
    setStatus('登录成功，正在同步本站账户…');
    const synced = await syncBackend(loginState);
    setAuthenticated(await mergeSiteAccount(loginState, profile));
    setStatus(synced ? '' : '已登录，但本站账户同步暂时失败。', !synced);
    if (synced) window.setTimeout(() => dialog.close(), 220);
  };

  const updateForm = () => {
    const isLogin = currentView === 'login';
    const isReset = currentView === 'reset';
    const usesCode = currentMethod === 'code';
    viewButtons.forEach((button) => {
      const active = button.dataset.authView === currentView;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    methodButtons.forEach((button) => {
      button.hidden = isReset;
      const active = !isReset && button.dataset.authMethod === currentMethod;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    passwordField.hidden = isReset || usesCode;
    codeField.hidden = isReset ? false : !usesCode;
    resetPasswordField.hidden = !isReset;
    passwordInput.required = !isReset && !usesCode;
    codeInput.required = isReset || usesCode;
    resetPasswordInput.required = isReset;
    passwordInput.autocomplete = isLogin ? 'current-password' : 'new-password';
    passwordInput.placeholder = isLogin ? '请输入登录密码' : '至少 6 位密码';
    accountInput.placeholder = isReset || usesCode ? '手机号 / 邮箱' : '手机号 / 邮箱 / 用户名';
    formTitle.textContent = isLogin ? '登录账户' : isReset ? '找回密码' : '创建账户';
    formDescription.textContent = isLogin
      ? '使用手机号、邮箱或用户名继续。'
      : isReset
        ? '通过绑定的手机号或邮箱重置密码。'
        : usesCode
          ? '验证手机号或邮箱后创建账户。'
          : '使用邮箱或用户名创建账户。';
    submitButton.textContent = isLogin ? '登录' : isReset ? '重置密码' : '注册';
    switchRow.hidden = isReset;
    switchPrefix.textContent = isLogin ? '没有账号？' : '已有账号？';
    switchButton.textContent = isLogin ? '点击注册' : '直接登录';
    switchButton.dataset.authSwitchView = isLogin ? 'register' : 'login';
    setStatus();
  };

  const buildCredentialPayload = (
    account: ReturnType<typeof classifyAccount>,
    passwordOrCode: string,
  ) => {
    if (currentMethod === 'password') {
      return {
        connection: 'PASSWORD',
        passwordPayload: {
          [account.type]: account.value,
          password: passwordOrCode,
        },
        options: {
          passwordEncryptType: 'none',
          scope: 'openid profile email phone',
        },
      };
    }
    if (account.type === 'username') {
      throw new Error('验证码方式仅支持手机号或邮箱。');
    }
    return {
      connection: 'PASSCODE',
      passCodePayload: {
        [account.type]: account.value,
        ...(account.type === 'phone' ? { phoneCountryCode: account.countryCode } : {}),
        passCode: passwordOrCode,
      },
      options: { scope: 'openid profile email phone' },
    };
  };

  const login = async () => {
    const account = classifyAccount(accountInput.value);
    const secret = currentMethod === 'password' ? passwordInput.value : codeInput.value;
    const payload = buildCredentialPayload(account, secret);
    const data = await authingRequest<Record<string, unknown>>('signin', payload);
    await finishLogin(saveLoginState(data));
  };

  const register = async () => {
    const account = classifyAccount(accountInput.value);
    const secret = currentMethod === 'password' ? passwordInput.value : codeInput.value;
    if (currentMethod === 'password' && account.type === 'phone') {
      throw new Error('手机号注册需要使用验证码方式。');
    }
    await authingRequest<Record<string, unknown>>('signup', {
      ...buildCredentialPayload(account, secret),
      profile: {},
    });
    if (currentMethod === 'password') {
      currentView = 'login';
      updateForm();
      setStatus('注册成功，正在登录…');
      await login();
      return;
    }
    currentView = 'login';
    updateForm();
    codeInput.value = '';
    setStatus('注册成功，请获取新的验证码登录。');
  };

  const resetPassword = async () => {
    const account = classifyAccount(accountInput.value);
    if (account.type === 'username') throw new Error('找回密码仅支持绑定的手机号或邮箱。');
    const passCode = codeInput.value.trim();
    const newPassword = resetPasswordInput.value;
    if (!/^\d{4,8}$/.test(passCode)) throw new Error('请输入正确的验证码。');
    if (newPassword.length < 6) throw new Error('新密码至少需要 6 位。');
    const verifyPayload = account.type === 'email'
      ? { verifyMethod: 'EMAIL_PASSCODE', emailPassCodePayload: { email: account.value, passCode } }
      : {
          verifyMethod: 'PHONE_PASSCODE',
          phonePassCodePayload: {
            phoneNumber: account.value,
            phoneCountryCode: account.countryCode,
            passCode,
          },
        };
    const verified = await authingRequest<{ passwordResetToken?: string }>(
      'verify-reset-password-request',
      verifyPayload,
    );
    if (!verified.passwordResetToken) throw new Error('验证码验证成功，但未收到重置凭证。');
    await authingRequest('reset-password', {
      password: newPassword,
      passwordResetToken: verified.passwordResetToken,
      passwordEncryptType: 'none',
    }, false);
    currentView = 'login';
    currentMethod = 'password';
    form.reset();
    updateForm();
    setStatus('密码已重置，请使用新密码登录。');
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (requestPending) return;
    const account = accountInput.value.trim();
    const secret = currentView === 'reset'
      ? codeInput.value.trim()
      : currentMethod === 'password' ? passwordInput.value : codeInput.value.trim();
    if (!account || !secret || (currentView === 'reset' && !resetPasswordInput.value)) {
      setStatus('请完整填写账号信息。', true);
      return;
    }
    if (currentView !== 'reset' && currentMethod === 'password' && secret.length < 6) {
      setStatus('密码至少需要 6 位。', true);
      return;
    }
    if (currentMethod === 'code' && !/^\d{4,8}$/.test(secret)) {
      setStatus('请输入正确的验证码。', true);
      return;
    }

    requestPending = true;
    submitButton.disabled = true;
    submitButton.textContent = currentView === 'login' ? '正在登录…' : '正在注册…';
    setStatus();
    try {
      await (currentView === 'login' ? login() : currentView === 'reset' ? resetPassword() : register());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '操作未完成，请重试。', true);
    } finally {
      passwordInput.value = '';
      requestPending = false;
      submitButton.disabled = false;
      if (!currentUser) submitButton.textContent = currentView === 'login' ? '登录' : currentView === 'reset' ? '重置密码' : '注册';
    }
  });

  sendCodeButton.addEventListener('click', async () => {
    if (requestPending || countdownTimer) return;
    const account = classifyAccount(accountInput.value);
    if (account.type === 'username') {
      setStatus('请输入有效的手机号或邮箱。', true);
      accountInput.focus();
      return;
    }

    requestPending = true;
    sendCodeButton.disabled = true;
    setStatus('正在发送验证码…');
    try {
      const channel = currentView === 'login'
        ? 'CHANNEL_LOGIN'
        : currentView === 'reset' ? 'CHANNEL_RESET_PASSWORD' : 'CHANNEL_REGISTER';
      if (account.type === 'phone') {
        await authingRequest('send-sms', {
          channel,
          phoneNumber: account.value,
          phoneCountryCode: account.countryCode,
        }, false);
      } else {
        await authingRequest('send-email', { channel, email: account.value }, false);
      }

      setStatus('验证码已发送，请注意查收。');
      let seconds = 60;
      sendCodeButton.textContent = `${seconds}s`;
      countdownTimer = window.setInterval(() => {
        seconds -= 1;
        sendCodeButton.textContent = seconds > 0 ? `${seconds}s` : '重新发送';
        if (seconds <= 0 && countdownTimer) {
          window.clearInterval(countdownTimer);
          countdownTimer = null;
          sendCodeButton.disabled = false;
        }
      }, 1000);
    } catch (error) {
      sendCodeButton.disabled = false;
      setStatus(error instanceof Error ? error.message : '验证码发送失败。', true);
    } finally {
      requestPending = false;
    }
  });

  viewButtons.forEach((button) => {
    button.addEventListener('click', () => {
      currentView = button.dataset.authView as AuthView;
      form.reset();
      updateForm();
    });
  });

  switchButton.addEventListener('click', () => {
    currentView = switchButton.dataset.authSwitchView as AuthView;
    currentMethod = 'password';
    form.reset();
    updateForm();
  });

  methodButtons.forEach((button) => {
    button.addEventListener('click', () => {
      currentMethod = button.dataset.authMethod as AuthMethod;
      passwordInput.value = '';
      codeInput.value = '';
      updateForm();
    });
  });

  trigger.addEventListener('click', () => {
    if (currentUser) {
      setMenuOpen(accountMenu.hidden);
      return;
    }
    setMenuOpen(false);
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => accountInput.focus(), 80);
  });

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  logoutButton.addEventListener('click', () => {
    localStorage.removeItem(AUTH_SESSION_KEY);
    setAnonymous();
    window.location.reload();
  });

  document.addEventListener('click', (event) => {
    if (!root.contains(event.target as Node)) setMenuOpen(false);
  });

  root.addEventListener('qdrive:profile-updated', (event) => {
    if (!currentUser || !(event instanceof CustomEvent)) return;
    currentUser = { ...currentUser, ...(event.detail as AuthingProfile) };
    setAuthenticated(currentUser);
  });

  updateForm();
  void (async () => {
    const loginState = readLoginState();
    if (!loginState) {
      setAnonymous();
      return;
    }
    try {
      const profile = await readProfile(loginState);
      setAuthenticated(profile);
      await syncBackend(loginState);
      setAuthenticated(await mergeSiteAccount(loginState, profile));
    } catch {
      localStorage.removeItem(AUTH_SESSION_KEY);
      setAnonymous();
    }
  })();
}

document.querySelectorAll<HTMLElement>('[data-auth-root]').forEach(initAuthControl);
