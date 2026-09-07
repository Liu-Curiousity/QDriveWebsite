import {
  AUTHING_APP_ID,
  AUTHING_HOST,
  AUTHING_USER_POOL_ID,
} from '../config/authing';
import { MAX_ACCOUNT_LEVEL } from '../lib/experience';

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
  experience: number;
  level: number;
  experienceIntoLevel: number;
  experienceForNextLevel: number | null;
  levelProgress: number;
  usageSeconds: number;
}

const AUTH_SESSION_KEY = `qdrive-auth:${AUTHING_APP_ID}:session`;

type LevelTier = 'foundation' | 'copper' | 'silver' | 'gold' | 'signature';

const getLevelTier = (level: number): LevelTier => {
  if (level >= 81) return 'signature';
  if (level >= 61) return 'gold';
  if (level >= 41) return 'silver';
  if (level >= 21) return 'copper';
  return 'foundation';
};

const stringValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const getDisplayName = (user: AuthingProfile): string =>
  stringValue(user.displayName) ||
  stringValue(user.name) ||
  stringValue(user.nickname) ||
  stringValue(user.username) ||
  stringValue(user.email) ||
  'QDrive 用户';

const getUserMeta = (user: AuthingProfile): string =>
  stringValue(user.email) ||
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
  const levelBadge = root.querySelector<HTMLElement>('[data-auth-level]');
  const accountMenu = root.querySelector<HTMLElement>('[data-auth-account-menu]');
  const menuName = root.querySelector<HTMLElement>('[data-auth-menu-name]');
  const menuMeta = root.querySelector<HTMLElement>('[data-auth-menu-meta]');
  const menuLevelPanel = root.querySelector<HTMLElement>('[data-auth-level-panel]');
  const menuLevel = root.querySelector<HTMLElement>('[data-auth-menu-level]');
  const menuExperience = root.querySelector<HTMLElement>('[data-auth-menu-experience]');
  const menuProgress = root.querySelector<HTMLElement>('[data-auth-menu-progress]');
  const logoutButton = root.querySelector<HTMLButtonElement>('[data-auth-logout]');
  const dialog = root.querySelector<HTMLDialogElement>('[data-auth-dialog]');
  const closeButton = root.querySelector<HTMLButtonElement>('[data-auth-close]');
  const form = root.querySelector<HTMLFormElement>('[data-auth-form]');
  const accountInput = root.querySelector<HTMLInputElement>('[data-auth-account]');
  const accountLabel = root.querySelector<HTMLElement>('[data-auth-account-label]');
  const usernameHint = root.querySelector<HTMLElement>('[data-auth-username-hint]');
  const passwordInput = root.querySelector<HTMLInputElement>('[data-auth-password]');
  const codeInput = root.querySelector<HTMLInputElement>('[data-auth-code]');
  const passwordField = root.querySelector<HTMLElement>('[data-auth-password-field]');
  const codeField = root.querySelector<HTMLElement>('[data-auth-code-field]');
  const codeLabel = root.querySelector<HTMLElement>('[data-auth-code-label]');
  const resetPasswordField = root.querySelector<HTMLElement>('[data-auth-reset-password-field]');
  const resetPasswordInput = root.querySelector<HTMLInputElement>('[data-auth-reset-password]');
  const sendCodeButton = root.querySelector<HTMLButtonElement>('[data-auth-send-code]');
  const submitButton = root.querySelector<HTMLButtonElement>('[data-auth-submit]');
  const formTitle = root.querySelector<HTMLElement>('[data-auth-form-title]');
  const formDescription = root.querySelector<HTMLElement>('[data-auth-form-description]');
  const status = root.querySelector<HTMLElement>('[data-auth-status]');
  const viewButtons = root.querySelectorAll<HTMLButtonElement>('[data-auth-view]');
  const methodsRow = root.querySelector<HTMLElement>('[data-auth-methods]');
  const methodButtons = root.querySelectorAll<HTMLButtonElement>('[data-auth-method]');
  const forgotButton = root.querySelector<HTMLButtonElement>('[data-auth-view="reset"]');
  const switchRow = root.querySelector<HTMLElement>('[data-auth-switch-row]');
  const switchPrefix = root.querySelector<HTMLElement>('[data-auth-switch-prefix]');
  const switchButton = root.querySelector<HTMLButtonElement>('[data-auth-switch-view]');

  if (
    !trigger || !label || !indicator || !avatar || !levelBadge || !accountMenu ||
    !menuName || !menuMeta || !menuLevelPanel || !menuLevel || !menuExperience ||
    !menuProgress || !logoutButton || !dialog || !closeButton ||
    !form || !accountInput || !accountLabel || !usernameHint || !passwordInput || !codeInput || !passwordField ||
    !codeField || !codeLabel || !resetPasswordField || !resetPasswordInput || !sendCodeButton ||
    !submitButton || !formTitle || !formDescription || !status ||
    !methodsRow || !forgotButton || !switchRow || !switchPrefix || !switchButton
  ) return;

  let currentUser: AuthingProfile | null = null;
  let currentView: AuthView = 'login';
  let currentMethod: AuthMethod = 'password';
  let showForgotPassword = false;
  let requestPending = false;
  let countdownTimer: number | null = null;
  let usageTimer: number | null = null;
  let usageLoginState: StoredLoginState | null = null;
  let usageRequestPending = false;

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
    levelBadge.hidden = true;
    menuLevelPanel.hidden = true;
    setMenuOpen(false);
    document.dispatchEvent(new CustomEvent('qdrive:admin-state', { detail: { isAdmin: false } }));
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
    document.dispatchEvent(new CustomEvent('qdrive:admin-state', {
      detail: { isAdmin: user.qdriveIsAdmin === true },
    }));
    const level = Number(user.level);
    const hasLevel = Number.isInteger(level) && level >= 1;
    levelBadge.hidden = !hasLevel;
    menuLevelPanel.hidden = !hasLevel;
    if (hasLevel) {
      levelBadge.textContent = `Lv.${level}`;
      menuLevel.textContent = `Lv.${level}`;
      const levelTier = getLevelTier(Math.min(MAX_ACCOUNT_LEVEL, level));
      levelBadge.dataset.levelTier = levelTier;
      menuLevel.dataset.levelTier = levelTier;
      menuLevelPanel.dataset.levelTier = levelTier;
      levelBadge.setAttribute('aria-label', `等级 ${level}`);
      const intoLevel = Math.max(0, Number(user.experienceIntoLevel) || 0);
      const forNextLevel = Number(user.experienceForNextLevel);
      menuExperience.textContent = level >= MAX_ACCOUNT_LEVEL || !Number.isFinite(forNextLevel)
        ? '已达到最高等级'
        : `${intoLevel} / ${forNextLevel} 经验`;
      const progress = Math.max(0, Math.min(1, Number(user.levelProgress) || 0));
      menuProgress.style.width = `${progress * 100}%`;
    }
  };

  const sendUsageHeartbeat = async () => {
    if (!usageLoginState || usageRequestPending || document.visibilityState !== 'visible') return;
    usageRequestPending = true;
    try {
      const response = await fetch('/api/account/experience/usage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${usageLoginState.accessToken}` },
      });
      if (!response.ok) return;
      const result = (await response.json()) as { user?: SiteAccountUser; isAdmin?: boolean };
      if (!result.user || !currentUser) return;
      currentUser = { ...currentUser, ...result.user };
      setAuthenticated(currentUser);
      document.dispatchEvent(new CustomEvent('qdrive:experience-updated', {
        detail: result.user,
      }));
    } catch {
      // Usage tracking is best-effort and must not interrupt the signed-in UI.
    } finally {
      usageRequestPending = false;
    }
  };

  const startUsageTracking = (loginState: StoredLoginState) => {
    usageLoginState = loginState;
    if (usageTimer !== null) window.clearInterval(usageTimer);
    void sendUsageHeartbeat();
    usageTimer = window.setInterval(() => { void sendUsageHeartbeat(); }, 30_000);
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
      const result = (await response.json()) as { user?: SiteAccountUser; isAdmin?: boolean };
      if (!result.user) return profile;
      const user = result.user;
      return {
        ...profile,
        displayName: user.displayName || getDisplayName(profile),
        avatarUrl: user.avatarUrl || getAvatarUrl(profile),
        email: user.email || stringValue(profile.email),
        phone: user.phone || stringValue(profile.phoneNumber) || stringValue(profile.phone),
        username: user.username || stringValue(profile.username),
        qdriveIsAdmin: result.isAdmin === true,
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
    startUsageTracking(loginState);
    setStatus(synced ? '' : '已登录，但本站账户同步暂时失败。', !synced);
    if (synced) window.setTimeout(() => dialog.close(), 220);
  };

  const updateForm = () => {
    const isLogin = currentView === 'login';
    const isRegister = currentView === 'register';
    const isReset = currentView === 'reset';
    const usesCode = currentMethod === 'code';
    viewButtons.forEach((button) => {
      const active = button.dataset.authView === currentView;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    methodsRow.hidden = !isLogin;
    methodButtons.forEach((button) => {
      button.hidden = false;
      const active = isLogin && button.dataset.authMethod === currentMethod;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    forgotButton.hidden = !(isLogin && !usesCode && showForgotPassword);
    // Registration is a single verified-email flow: email, password and the
    // email passcode are collected together instead of being separate modes.
    passwordField.hidden = isReset || (isLogin && usesCode);
    codeField.hidden = isLogin && !usesCode;
    resetPasswordField.hidden = !isReset;
    passwordInput.required = isRegister || (isLogin && !usesCode);
    codeInput.required = isRegister || isReset || (isLogin && usesCode);
    resetPasswordInput.required = isReset;
    usernameHint.hidden = true;
    accountLabel.textContent = isLogin ? '账号' : '邮箱';
    codeLabel.textContent = '邮箱验证码';
    passwordInput.autocomplete = isLogin ? 'current-password' : 'new-password';
    passwordInput.placeholder = isLogin ? '请输入登录密码' : '至少 6 位密码';
    accountInput.autocomplete = isLogin ? 'username' : 'email';
    accountInput.inputMode = isLogin ? 'text' : 'email';
    accountInput.placeholder = isLogin && !usesCode ? '邮箱 / 用户名' : '请输入邮箱';
    formTitle.textContent = isLogin ? '登录账户' : isReset ? '重置登录密码' : '通过邮箱注册账户';
    formDescription.textContent = isLogin
      ? usesCode
        ? '使用邮箱验证码登录。'
        : '使用邮箱或用户名和密码继续。'
      : isReset
        ? '验证注册邮箱后设置新的登录密码。'
        : '验证邮箱并设置密码，完成账户注册。';
    submitButton.textContent = isLogin ? '登录' : isReset ? '重置密码' : '注册';
    switchRow.hidden = false;
    switchPrefix.textContent = isLogin ? '没有账号？' : isReset ? '想起密码了？' : '已有账号？';
    switchButton.textContent = isLogin ? '通过邮箱注册' : '返回登录';
    switchButton.dataset.authSwitchView = isLogin ? 'register' : 'login';
    setStatus();
  };

  const buildCredentialPayload = (
    account: ReturnType<typeof classifyAccount>,
    passwordOrCode: string,
  ) => {
    if (account.type === 'phone') {
      throw new Error('该账号格式不受支持，请使用邮箱或用户名。');
    }
    if (currentMethod === 'password') {
      return {
        connection: 'PASSWORD',
        passwordPayload: {
          [account.type]: account.value,
          password: passwordOrCode,
        },
        options: {
          passwordEncryptType: 'none',
          scope: 'openid profile email',
          // Never let a password login create an account implicitly.  An
          // unknown email is routed through the verified registration flow.
          ...(currentView === 'login' ? { autoRegister: false } : {}),
        },
      };
    }
    if (account.type !== 'email') {
      throw new Error('登录和注册的验证码方式仅支持邮箱。');
    }
    return {
      connection: 'PASSCODE',
      passCodePayload: {
        [account.type]: account.value,
        passCode: passwordOrCode,
      },
      options: { scope: 'openid profile email' },
    };
  };

  const checkEmailExists = async (email: string): Promise<boolean | null> => {
    try {
      const result = await authingRequest<{ exists?: unknown }>('is-user-exists', { email });
      return result.exists === true;
    } catch {
      // Some Authing deployments do not expose this management-style endpoint
      // to browser clients.  The signin request still has autoRegister=false,
      // so falling back is safe and cannot create an account implicitly.
      return null;
    }
  };

  const isUnregisteredMessage = (message: string) =>
    /用户不存在|账号不存在|账户不存在|邮箱.*(?:未注册|不存在)|user(?:\s+|_)?not\s+(?:found|exist)|does not exist/i.test(message);

  const isWrongPasswordMessage = (message: string) =>
    /密码.*(?:错误|不正确|无效)|(?:wrong|incorrect|invalid)\s*password|invalid\s*credentials|账号或密码|用户名或密码|account or password/i.test(message);

  const login = async () => {
    const account = classifyAccount(accountInput.value);
    const secret = currentMethod === 'password' ? passwordInput.value : codeInput.value;
    if (currentMethod === 'password' && account.type === 'email') {
      const exists = await checkEmailExists(account.value);
      if (exists === false) {
        throw new Error('该邮箱未注册。');
      }
    }
    const payload = buildCredentialPayload(account, secret);
    try {
      const data = await authingRequest<Record<string, unknown>>('signin', payload);
      await finishLogin(saveLoginState(data));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (account.type === 'email' && isUnregisteredMessage(message)) {
        throw new Error('该邮箱未注册。');
      }
      if (account.type === 'email' && currentMethod === 'password' && isWrongPasswordMessage(message)) {
        showForgotPassword = true;
        updateForm();
        throw new Error('密码错误，请重新输入或使用“忘记密码”重置。');
      }
      throw error;
    }
  };

  const register = async () => {
    const account = classifyAccount(accountInput.value);
    const secret = passwordInput.value;
    if (account.type !== 'email') throw new Error('请使用有效的邮箱注册账户。');
    const exists = await checkEmailExists(account.value);
    if (exists === true) throw new Error('该邮箱已注册，请直接登录。');
    const signupPayload = {
      ...buildCredentialPayload(account, secret),
      profile: {},
    } as Record<string, unknown>;
    const passCode = codeInput.value.trim();
    if (!/^\d{4,8}$/.test(passCode)) {
      throw new Error('请输入正确的邮箱验证码。');
    }
    signupPayload.options = {
      ...(signupPayload.options as Record<string, unknown>),
      emailPassCodeForInformationCompletion: passCode,
    };
    try {
      await authingRequest<Record<string, unknown>>('signup', signupPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/已存在|已注册|already\s+(?:exists|registered)|duplicate/i.test(message)) {
        throw new Error('该邮箱已注册，请直接登录。');
      }
      throw error;
    }
    currentView = 'login';
    currentMethod = 'password';
    showForgotPassword = false;
    updateForm();
    setStatus('注册成功，正在登录…');
    accountInput.value = account.value;
    passwordInput.value = secret;
    await login();
  };

  const resetPassword = async () => {
    const account = classifyAccount(accountInput.value);
    if (account.type !== 'email') throw new Error('找回密码仅支持绑定的邮箱。');
    const exists = await checkEmailExists(account.value);
    if (exists === false) throw new Error('该邮箱未注册。');
    const passCode = codeInput.value.trim();
    const newPassword = resetPasswordInput.value;
    if (!/^\d{4,8}$/.test(passCode)) throw new Error('请输入正确的验证码。');
    if (newPassword.length < 6) throw new Error('新密码至少需要 6 位。');
    const verifyPayload = {
      verifyMethod: 'EMAIL_PASSCODE',
      emailPassCodePayload: { email: account.value, passCode },
    };
    let verified: { passwordResetToken?: string };
    try {
      verified = await authingRequest<{ passwordResetToken?: string }>(
        'verify-reset-password-request',
        verifyPayload,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (isUnregisteredMessage(message)) throw new Error('该邮箱未注册。');
      if (/验证码|pass\s*code|verification\s*code/i.test(message)) {
        throw new Error('邮箱验证码错误或已失效。');
      }
      throw error;
    }
    if (!verified.passwordResetToken) throw new Error('验证码验证成功，但未收到重置凭证。');
    await authingRequest('reset-password', {
      password: newPassword,
      passwordResetToken: verified.passwordResetToken,
      passwordEncryptType: 'none',
    }, false);
    currentView = 'login';
    currentMethod = 'password';
    showForgotPassword = false;
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
    if (
      currentView === 'register' &&
      currentMethod === 'password' &&
      classifyAccount(account).type === 'email' &&
      !/^\d{4,8}$/.test(codeInput.value.trim())
    ) {
      setStatus('邮箱注册必须先完成验证码验证。', true);
      return;
    }

    requestPending = true;
    submitButton.disabled = true;
    submitButton.textContent = currentView === 'login'
      ? '正在登录…'
      : currentView === 'reset' ? '正在重置…' : '正在注册…';
    setStatus();
    try {
      await (currentView === 'login' ? login() : currentView === 'reset' ? resetPassword() : register());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '操作未完成，请重试。', true);
    } finally {
      // Keep a failed registration password in place so the user can correct
      // the email code without having to enter the password again.
      if (currentView !== 'register' || !passwordInput.value) passwordInput.value = '';
      requestPending = false;
      submitButton.disabled = false;
      if (!currentUser) submitButton.textContent = currentView === 'login' ? '登录' : currentView === 'reset' ? '重置密码' : '注册';
    }
  });

  sendCodeButton.addEventListener('click', async () => {
    if (requestPending || countdownTimer) return;
    const account = classifyAccount(accountInput.value);
    if (account.type !== 'email') {
      setStatus('请输入有效的邮箱地址。', true);
      accountInput.focus();
      return;
    }

    requestPending = true;
    sendCodeButton.disabled = true;
    setStatus('正在发送验证码…');
    try {
      const exists = await checkEmailExists(account.value);
      if (currentView === 'register' && exists === true) {
        throw new Error('该邮箱已注册，请直接登录。');
      }
      if (currentView !== 'register' && exists === false) {
        throw new Error('该邮箱未注册。');
      }
      const accountType = classifyAccount(accountInput.value).type;
      const channel = currentView === 'login'
        ? 'CHANNEL_LOGIN'
        : currentView === 'reset'
          ? 'CHANNEL_RESET_PASSWORD'
          : currentMethod === 'password' && accountType === 'email'
            // PASSWORD signup verifies the email as information completion;
            // Authing uses a separate mail scene from PASSCODE registration.
            ? 'CHANNEL_COMPLETE_EMAIL'
            : 'CHANNEL_REGISTER';
      await authingRequest('send-email', { channel, email: account.value }, false);

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
      const message = error instanceof Error ? error.message : '';
      setStatus(isUnregisteredMessage(message) ? '该邮箱未注册。' : message || '验证码发送失败。', true);
    } finally {
      requestPending = false;
    }
  });

  viewButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const email = classifyAccount(accountInput.value).type === 'email' ? accountInput.value.trim() : '';
      currentView = button.dataset.authView as AuthView;
      currentMethod = 'password';
      showForgotPassword = false;
      form.reset();
      accountInput.value = email;
      updateForm();
    });
  });

  switchButton.addEventListener('click', () => {
    currentView = switchButton.dataset.authSwitchView as AuthView;
    currentMethod = 'password';
    showForgotPassword = false;
    form.reset();
    updateForm();
  });

  methodButtons.forEach((button) => {
    button.addEventListener('click', () => {
      currentMethod = button.dataset.authMethod as AuthMethod;
      showForgotPassword = false;
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
    if (usageTimer !== null) window.clearInterval(usageTimer);
    usageLoginState = null;
    localStorage.removeItem(AUTH_SESSION_KEY);
    sessionStorage.removeItem(`qdrive-admin-verification:${AUTHING_APP_ID}`);
    // Keep the user-bound, short-lived admin verification cookie until its
    // one-hour expiry. A bearer token is still required for every admin
    // request, so signing out never leaves the admin API accessible.
    if (window.location.pathname === '/account') {
      window.location.replace('/');
      return;
    }
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
      startUsageTracking(loginState);
    } catch {
      localStorage.removeItem(AUTH_SESSION_KEY);
      setAnonymous();
    }
  })();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void sendUsageHeartbeat();
  });

  accountInput.addEventListener('input', () => {
    if (currentView === 'login' && showForgotPassword) {
      showForgotPassword = false;
      forgotButton.hidden = true;
    }
  });
}

const initializedAuthRoots = new WeakSet<HTMLElement>();

const mountAuthControls = () => {
  document.querySelectorAll<HTMLElement>('[data-auth-root]').forEach((root) => {
    if (initializedAuthRoots.has(root)) return;
    initializedAuthRoots.add(root);
    initAuthControl(root);
  });
};

mountAuthControls();
document.addEventListener('astro:page-load', mountAuthControls);
