import { AUTHING_APP_ID } from '../config/authing';

interface StoredLoginState {
  accessToken: string;
  expireAt: number;
}

interface UserPointsResult {
  id: string;
  username: string | null;
  email: string | null;
  displayName: string | null;
  points: number;
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

document.querySelectorAll<HTMLElement>('[data-user-points-admin-root]').forEach((root) => {
  const form = root.querySelector<HTMLFormElement>('[data-user-points-search-form]');
  const queryInput = root.querySelector<HTMLInputElement>('[data-user-points-query]');
  const submit = root.querySelector<HTMLButtonElement>('[data-user-points-search-submit]');
  const status = root.querySelector<HTMLElement>('[data-user-points-status]');
  const results = root.querySelector<HTMLElement>('[data-user-points-results]');
  if (!form || !queryInput || !submit || !status || !results) return;

  const setStatus = (message = '', isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const render = (users: UserPointsResult[]) => {
    results.replaceChildren();
    if (!users.length) {
      const empty = document.createElement('p');
      empty.className = 'contribution-admin__empty';
      empty.textContent = '没有找到匹配的用户。';
      results.append(empty);
      return;
    }
    users.forEach((user) => {
      const card = document.createElement('article');
      card.className = 'user-points-admin__card';
      const identity = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = user.displayName || user.username || user.email || 'QDrive 用户';
      const meta = document.createElement('p');
      meta.textContent = [user.username ? `用户名：${user.username}` : '', user.email ? `邮箱：${user.email}` : '']
        .filter(Boolean).join(' · ');
      identity.append(name, meta);
      const points = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = '剩余积分';
      const value = document.createElement('strong');
      value.textContent = String(user.points);
      points.append(label, value);
      card.append(identity, points);
      results.append(card);
    });
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const state = readLoginState();
    if (!state) {
      setStatus('请先登录管理员账户。', true);
      return;
    }
    const query = queryInput.value.trim();
    if (query.length < 2) {
      setStatus('请输入至少 2 个字符的用户名或邮箱。', true);
      return;
    }
    submit.disabled = true;
    submit.textContent = '正在查询…';
    setStatus();
    try {
      const response = await fetch(`/api/admin/users?query=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${state.accessToken}` },
      });
      const result = await readJson<{ users: UserPointsResult[] }>(response);
      render(result.users);
      setStatus(`找到 ${result.users.length} 个匹配账户。`);
    } catch (error) {
      results.replaceChildren();
      setStatus(error instanceof Error ? error.message : '查询失败。', true);
    } finally {
      submit.disabled = false;
      submit.textContent = '查询积分';
    }
  });
});
