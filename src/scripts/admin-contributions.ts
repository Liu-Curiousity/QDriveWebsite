import { AUTHING_APP_ID } from '../config/authing';

interface StoredLoginState {
  accessToken: string;
  expireAt: number;
}

interface ContributionSubmission {
  id: string;
  userName: string;
  content: string;
  status: 'pending' | 'approved' | 'rejected';
  awardedPoints: number | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  attachments: Array<{ id: string; name: string; mime: string; size: number }>;
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

function initContributionAdmin(root: HTMLElement) {
  const status = root.querySelector<HTMLElement>('[data-contribution-admin-status]');
  const list = root.querySelector<HTMLElement>('[data-contribution-admin-list]');
  if (!status || !list) return;
  const objectUrls: string[] = [];

  const setStatus = (message = '', isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const fetchAttachment = async (id: string, token: string) => {
    const response = await fetch(`/api/contributions/attachment/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error('附件读取失败');
    const url = URL.createObjectURL(await response.blob());
    objectUrls.push(url);
    return url;
  };

  const formatFileSize = (size: number) => size >= 1_000_000
    ? `${(size / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1_000))} KB`;

  const review = async (
    submission: ContributionSubmission,
    reviewStatus: 'approved' | 'rejected',
    pointsInput: HTMLInputElement,
    noteInput: HTMLTextAreaElement,
    buttons: HTMLButtonElement[],
  ) => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    const points = Number(pointsInput.value);
    if (reviewStatus === 'approved' && (!Number.isInteger(points) || points < 1)) {
      throw new Error('请输入大于 0 的整数积分。');
    }
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch('/api/admin/contributions', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${state.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: submission.id,
          status: reviewStatus,
          points,
          note: noteInput.value.trim(),
        }),
      });
      await readJson<{ submission: ContributionSubmission }>(response);
      setStatus(reviewStatus === 'approved' ? '审核已通过，积分已发放。' : '投稿已驳回。');
      await load();
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  };

  const render = (submissions: ContributionSubmission[], token: string) => {
    objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
    list.replaceChildren();
    if (!submissions.length) {
      const empty = document.createElement('p');
      empty.className = 'contribution-admin__empty';
      empty.textContent = '目前没有贡献投稿。';
      list.append(empty);
      return;
    }
    const labels = { pending: '待审核', approved: '已通过', rejected: '已驳回' } as const;
    submissions.forEach((submission) => {
      const card = document.createElement('article');
      card.className = 'contribution-admin__card';
      const meta = document.createElement('div');
      meta.className = 'contribution-admin__meta';
      const identity = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = submission.userName;
      const time = document.createElement('time');
      time.dateTime = submission.createdAt;
      time.textContent = ` · ${new Date(submission.createdAt).toLocaleString('zh-CN')}`;
      identity.append(name, time);
      const badge = document.createElement('span');
      badge.className = 'contribution-admin__badge';
      badge.textContent = submission.status === 'approved'
        ? `${labels[submission.status]} · ${submission.awardedPoints || 0} 积分`
        : labels[submission.status];
      meta.append(identity, badge);
      const content = document.createElement('p');
      content.className = 'contribution-admin__content';
      content.textContent = submission.content;
      card.append(meta, content);

      if (submission.attachments.length) {
        const gallery = document.createElement('div');
        gallery.className = 'contribution-admin__gallery';
        const files = document.createElement('div');
        files.className = 'contribution-admin__files';
        submission.attachments.forEach((attachment) => {
          if (attachment.mime.startsWith('image/')) {
            const figure = document.createElement('figure');
            const image = document.createElement('img');
            image.alt = attachment.name;
            image.loading = 'lazy';
            const caption = document.createElement('figcaption');
            caption.textContent = attachment.name;
            figure.append(image, caption);
            gallery.append(figure);
            void fetchAttachment(attachment.id, token)
              .then((url) => { image.src = url; })
              .catch(() => { image.alt = `${attachment.name}（读取失败）`; });
            return;
          }
          const link = document.createElement('a');
          link.className = 'contribution-admin__file';
          link.textContent = `${attachment.name} · ${formatFileSize(attachment.size)}`;
          link.download = attachment.name;
          link.setAttribute('aria-disabled', 'true');
          files.append(link);
          void fetchAttachment(attachment.id, token)
            .then((url) => {
              link.href = url;
              link.removeAttribute('aria-disabled');
            })
            .catch(() => { link.textContent = `${attachment.name} · 读取失败`; });
        });
        if (gallery.childElementCount) card.append(gallery);
        if (files.childElementCount) card.append(files);
      }

      if (submission.status === 'pending') {
        const reviewForm = document.createElement('div');
        reviewForm.className = 'contribution-admin__review';
        const pointsLabel = document.createElement('label');
        pointsLabel.textContent = '发放积分';
        const pointsInput = document.createElement('input');
        pointsInput.type = 'number';
        pointsInput.min = '1';
        pointsInput.max = '100000';
        pointsInput.step = '1';
        pointsInput.value = '10';
        pointsLabel.append(pointsInput);
        const noteLabel = document.createElement('label');
        noteLabel.textContent = '审核备注（可选）';
        const noteInput = document.createElement('textarea');
        noteInput.maxLength = 500;
        noteInput.placeholder = '说明通过或驳回原因';
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
        approve.textContent = '通过并发放积分';
        const buttons = [reject, approve];
        reject.addEventListener('click', () => {
          void review(submission, 'rejected', pointsInput, noteInput, buttons).catch((error) => {
            setStatus(error instanceof Error ? error.message : '审核失败。', true);
          });
        });
        approve.addEventListener('click', () => {
          void review(submission, 'approved', pointsInput, noteInput, buttons).catch((error) => {
            setStatus(error instanceof Error ? error.message : '审核失败。', true);
          });
        });
        actions.append(reject, approve);
        reviewForm.append(pointsLabel, noteLabel, actions);
        card.append(reviewForm);
      } else {
        const reviewed = document.createElement('p');
        reviewed.className = 'contribution-admin__reviewed';
        reviewed.textContent = submission.reviewNote
          ? `审核备注：${submission.reviewNote}`
          : '审核已完成。';
        card.append(reviewed);
      }
      list.append(card);
    });
  };

  const load = async () => {
    const state = readLoginState();
    if (!state) throw new Error('请先登录管理员账户。');
    const response = await fetch('/api/admin/contributions', {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    const result = await readJson<{ submissions: ContributionSubmission[] }>(response);
    render(result.submissions, state.accessToken);
    setStatus();
  };

  void load().catch((error) => {
    setStatus(error instanceof Error ? error.message : '无法读取贡献投稿。', true);
  });
}

document.querySelectorAll<HTMLElement>('[data-contribution-admin-root]').forEach(initContributionAdmin);
