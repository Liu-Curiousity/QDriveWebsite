import { AUTHING_APP_ID } from '../config/authing';

interface StoredLoginState {
  accessToken: string;
  expireAt: number;
}

interface VerificationResponse {
  error?: string;
  code?: string;
  email?: string;
  verified?: boolean;
  retryAfter?: number;
  expiresIn?: number;
}

const AUTH_SESSION_KEY = `qdrive-auth:${AUTHING_APP_ID}:session`;
const ADMIN_VERIFICATION_CACHE_KEY = `qdrive-admin-verification:${AUTHING_APP_ID}`;

interface CachedVerificationState {
  expiresAt: number;
  tokenFingerprint: string;
}

const readLoginState = (): StoredLoginState | null => {
  try {
    const value = localStorage.getItem(AUTH_SESSION_KEY);
    if (!value) return null;
    const state = JSON.parse(value) as Partial<StoredLoginState>;
    if (
      typeof state.accessToken !== 'string' ||
      typeof state.expireAt !== 'number' ||
      state.expireAt <= Date.now()
    ) return null;
    return state as StoredLoginState;
  } catch {
    return null;
  }
};

const tokenFingerprint = (accessToken: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < accessToken.length; index += 1) {
    hash ^= accessToken.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const readCachedVerification = (loginState: StoredLoginState) => {
  try {
    const value = sessionStorage.getItem(ADMIN_VERIFICATION_CACHE_KEY);
    if (!value) return 0;
    const state = JSON.parse(value) as Partial<CachedVerificationState>;
    const isCurrent =
      typeof state.expiresAt === 'number' &&
      state.expiresAt > Date.now() &&
      state.tokenFingerprint === tokenFingerprint(loginState.accessToken);
    if (!isCurrent) sessionStorage.removeItem(ADMIN_VERIFICATION_CACHE_KEY);
    return isCurrent && typeof state.expiresAt === 'number'
      ? Math.ceil((state.expiresAt - Date.now()) / 1000)
      : 0;
  } catch {
    return 0;
  }
};

const cacheVerification = (loginState: StoredLoginState, expiresIn = 60 * 60) => {
  try {
    sessionStorage.setItem(ADMIN_VERIFICATION_CACHE_KEY, JSON.stringify({
      expiresAt: Date.now() + Math.max(1, expiresIn) * 1000,
      tokenFingerprint: tokenFingerprint(loginState.accessToken),
    } satisfies CachedVerificationState));
  } catch {
    // Storage can be unavailable in strict privacy modes; server verification
    // remains the source of truth in that case.
  }
};

const clearCachedVerification = () => {
  try {
    sessionStorage.removeItem(ADMIN_VERIFICATION_CACHE_KEY);
  } catch {
    // Nothing else is required when session storage is unavailable.
  }
};

const initAdminVerification = (gate: HTMLElement) => {
  const protectedContent = document.querySelector<HTMLElement>('[data-admin-protected]');
  const title = gate.querySelector<HTMLElement>('[data-admin-verification-title]');
  const description = gate.querySelector<HTMLElement>('[data-admin-verification-description]');
  const identity = gate.querySelector<HTMLElement>('[data-admin-verification-identity]');
  const email = gate.querySelector<HTMLElement>('[data-admin-verification-email]');
  const sendButton = gate.querySelector<HTMLButtonElement>('[data-admin-verification-send]');
  const accountLink = gate.querySelector<HTMLAnchorElement>('[data-admin-verification-account]');
  const form = gate.querySelector<HTMLFormElement>('[data-admin-verification-form]');
  const codeInput = gate.querySelector<HTMLInputElement>('[data-admin-verification-code]');
  const submitButton = gate.querySelector<HTMLButtonElement>('[data-admin-verification-submit]');
  const status = gate.querySelector<HTMLElement>('[data-admin-verification-status]');
  if (
    !protectedContent || !title || !description || !identity || !email ||
    !sendButton || !accountLink || !form || !codeInput || !submitButton || !status
  ) return;

  let requestPending = false;
  let countdownTimer: number | null = null;
  let expiryTimer: number | null = null;

  const setStatus = (message = '', isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const setLocked = () => {
    protectedContent.inert = true;
    protectedContent.setAttribute('aria-hidden', 'true');
    protectedContent.hidden = true;
    gate.hidden = true;
  };

  const unlock = (expiresIn = 60 * 60) => {
    gate.hidden = true;
    protectedContent.hidden = false;
    protectedContent.inert = false;
    protectedContent.removeAttribute('aria-hidden');
    if (expiryTimer !== null) window.clearTimeout(expiryTimer);
    expiryTimer = window.setTimeout(
      () => window.location.reload(),
      Math.max(30, expiresIn + 1) * 1000,
    );
  };

  const showDenied = (kind: 'anonymous' | 'forbidden') => {
    setLocked();
    clearCachedVerification();
    gate.hidden = false;
    gate.dataset.state = 'denied';
    title.textContent = kind === 'anonymous' ? '请先登录管理员账户' : '当前账户没有管理员权限';
    description.textContent = kind === 'anonymous'
      ? '管理员中心仅向已登录的管理员开放。'
      : '此入口已为普通用户隐藏，当前账户不能访问后台。';
    identity.hidden = true;
    sendButton.hidden = true;
    form.hidden = true;
    accountLink.hidden = false;
    setStatus();
  };

  const api = async (method: 'GET' | 'POST', body?: Record<string, unknown>) => {
    const loginState = readLoginState();
    if (!loginState) throw new Error('anonymous');
    const response = await fetch('/api/admin/verification', {
      method,
      credentials: 'same-origin',
      headers: {
        Authorization: `Bearer ${loginState.accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = (await response.json()) as VerificationResponse;
    if (!response.ok) {
      const error = new Error(result.error || '安全验证未完成。');
      Object.assign(error, { responseCode: result.code, retryAfter: result.retryAfter });
      throw error;
    }
    return result;
  };

  const showChallenge = (result: VerificationResponse) => {
    setLocked();
    clearCachedVerification();
    gate.hidden = false;
    gate.dataset.state = 'challenge';
    title.textContent = '验证管理员身份';
    description.textContent = '进入后台前，请使用当前账户绑定邮箱完成一次安全验证。';
    email.textContent = result.email || '当前管理员邮箱';
    identity.hidden = false;
    sendButton.hidden = false;
    accountLink.hidden = true;
    form.hidden = false;
    setStatus('请先获取验证码。');
  };

  const startCountdown = (seconds = 60) => {
    if (countdownTimer !== null) window.clearInterval(countdownTimer);
    let remaining = Math.max(1, seconds);
    sendButton.disabled = true;
    sendButton.textContent = `${remaining}s 后可重新发送`;
    countdownTimer = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (countdownTimer !== null) window.clearInterval(countdownTimer);
        countdownTimer = null;
        sendButton.disabled = false;
        sendButton.textContent = '重新发送验证码';
      } else {
        sendButton.textContent = `${remaining}s 后可重新发送`;
      }
    }, 1000);
  };

  sendButton.addEventListener('click', async () => {
    if (requestPending || sendButton.disabled) return;
    requestPending = true;
    sendButton.disabled = true;
    setStatus('正在发送验证码…');
    try {
      const result = await api('POST', { action: 'send' });
      if (result.email) email.textContent = result.email;
      startCountdown(result.retryAfter || 60);
      setStatus('验证码已发送，请检查邮箱。');
      codeInput.focus();
    } catch (error) {
      const retryAfter = Number((error as Error & { retryAfter?: unknown }).retryAfter);
      if (Number.isFinite(retryAfter) && retryAfter > 0) startCountdown(retryAfter);
      else sendButton.disabled = false;
      setStatus(error instanceof Error ? error.message : '验证码发送失败。', true);
    } finally {
      requestPending = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (requestPending) return;
    const passCode = codeInput.value.trim();
    if (!/^\d{4,8}$/.test(passCode)) {
      setStatus('请输入 4–8 位数字验证码。', true);
      codeInput.focus();
      return;
    }
    requestPending = true;
    submitButton.disabled = true;
    submitButton.textContent = '正在验证…';
    setStatus();
    try {
      const result = await api('POST', { action: 'verify', passCode });
      const loginState = readLoginState();
      if (loginState) cacheVerification(loginState, result.expiresIn);
      gate.dataset.state = 'success';
      title.textContent = '身份验证成功';
      description.textContent = '正在安全进入管理员中心。';
      identity.hidden = true;
      sendButton.hidden = true;
      form.hidden = true;
      setStatus('验证通过，即将进入后台。');
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      codeInput.select();
      setStatus(error instanceof Error ? error.message : '验证码验证失败。', true);
      submitButton.disabled = false;
      submitButton.textContent = '验证并进入后台';
    } finally {
      requestPending = false;
    }
  });

  setLocked();
  const loginState = readLoginState();
  if (!loginState) {
    showDenied('anonymous');
    return;
  }

  // The cache is only a paint optimization. Every page still revalidates the
  // signed HttpOnly cookie and bearer token before its admin API can return data.
  const cachedSeconds = readCachedVerification(loginState);
  if (cachedSeconds > 0) unlock(cachedSeconds);

  void api('GET')
    .then((result) => {
      if (result.verified) {
        cacheVerification(loginState, result.expiresIn);
        unlock(result.expiresIn);
      }
      else showChallenge(result);
    })
    .catch((error: Error & { responseCode?: string }) => {
      showDenied(error.responseCode === 'forbidden' ? 'forbidden' : 'anonymous');
    });
};

const initializedGates = new WeakSet<HTMLElement>();

const mountAdminVerification = () => {
  document.querySelectorAll<HTMLElement>('[data-admin-verification-gate]').forEach((gate) => {
    if (initializedGates.has(gate)) return;
    initializedGates.add(gate);
    initAdminVerification(gate);
  });
};

mountAdminVerification();
document.addEventListener('astro:page-load', mountAdminVerification);
