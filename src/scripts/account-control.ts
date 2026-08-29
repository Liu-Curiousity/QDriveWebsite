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
  points: number;
}

interface ContributionSubmission {
  id: string;
  content: string;
  status: 'pending' | 'approved' | 'rejected';
  awardedPoints: number | null;
  reviewNote: string | null;
  createdAt: string;
  attachments: Array<{ id: string; name: string; mime: string; size: number }>;
}

interface PointRedemption {
  id: string;
  taobaoAccount: string;
  requestedPoints: number;
  status: 'pending' | 'approved' | 'rejected';
  remainingPoints: number | null;
  reviewNote: string | null;
  createdAt: string;
}

interface UserMessage {
  id: string;
  type: string;
  title: string;
  content: string;
  readAt: string | null;
  createdAt: string;
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
  const cropDialog = root.querySelector<HTMLDialogElement>('[data-account-crop-dialog]');
  const cropCanvas = root.querySelector<HTMLCanvasElement>('[data-account-crop-canvas]');
  const cropApply = root.querySelector<HTMLButtonElement>('[data-account-crop-apply]');
  const cropCancelButtons = root.querySelectorAll<HTMLButtonElement>('[data-account-crop-cancel]');
  const profileSave = root.querySelector<HTMLButtonElement>('[data-account-profile-save]');
  const accountName = root.querySelector<HTMLElement>('[data-account-name]');
  const accountMeta = root.querySelector<HTMLElement>('[data-account-meta]');
  const accountIdentity = root.querySelector<HTMLElement>('[data-account-identity]');
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
  const sideLinks = root.querySelectorAll<HTMLAnchorElement>('[data-account-side-link]');
  const pointsValue = root.querySelector<HTMLElement>('[data-account-points]');
  const adminLink = root.querySelector<HTMLAnchorElement>('[data-account-admin-link]');
  const redemptionAdminLink = root.querySelector<HTMLAnchorElement>('[data-account-redemption-admin-link]');
  const messageBadge = root.querySelector<HTMLElement>('[data-account-message-badge]');
  const messageList = root.querySelector<HTMLElement>('[data-account-message-list]');
  const messagesReadAll = root.querySelector<HTMLButtonElement>('[data-account-messages-read-all]');
  const contributionOpen = root.querySelector<HTMLButtonElement>('[data-account-contribution-open]');
  const contributionDialog = root.querySelector<HTMLDialogElement>('[data-account-contribution-dialog]');
  const contributionCancelButtons = root.querySelectorAll<HTMLButtonElement>('[data-account-contribution-cancel]');
  const contributionForm = root.querySelector<HTMLFormElement>('[data-account-contribution-form]');
  const contributionContent = root.querySelector<HTMLTextAreaElement>('[data-account-contribution-content]');
  const contributionAttachments = root.querySelector<HTMLInputElement>('[data-account-contribution-attachments]');
  const contributionFiles = root.querySelector<HTMLElement>('[data-account-contribution-files]');
  const contributionStatus = root.querySelector<HTMLElement>('[data-account-contribution-status]');
  const contributionSubmit = root.querySelector<HTMLButtonElement>('[data-account-contribution-submit]');
  const contributionList = root.querySelector<HTMLElement>('[data-account-contribution-list]');
  const redemptionOpen = root.querySelector<HTMLButtonElement>('[data-account-redemption-open]');
  const redemptionDialog = root.querySelector<HTMLDialogElement>('[data-account-redemption-dialog]');
  const redemptionCancelButtons = root.querySelectorAll<HTMLButtonElement>('[data-account-redemption-cancel]');
  const redemptionForm = root.querySelector<HTMLFormElement>('[data-account-redemption-form]');
  const redemptionModes = root.querySelectorAll<HTMLInputElement>('[data-account-redemption-mode]');
  const redemptionPoints = root.querySelector<HTMLInputElement>('[data-account-redemption-points]');
  const redemptionTaobao = root.querySelector<HTMLInputElement>('[data-account-redemption-taobao]');
  const redemptionAvailable = root.querySelector<HTMLElement>('[data-account-redemption-available]');
  const redemptionStatus = root.querySelector<HTMLElement>('[data-account-redemption-status]');
  const redemptionSubmit = root.querySelector<HTMLButtonElement>('[data-account-redemption-submit]');
  const redemptionList = root.querySelector<HTMLElement>('[data-account-redemption-list]');

  if (
    !status || !profileForm || !nicknameInput || !usernameInput ||
    !usernameText || !usernameHint || !avatarInput ||
    !cropDialog || !cropCanvas || !cropApply || !cropCancelButtons.length ||
    !profileSave || !accountName || !accountMeta || !accountIdentity ||
    !emailForm || !phoneForm || !emailInput || !emailCode || !emailSend ||
    !emailState || !emailCurrent || !emailUnbindPanel || !emailUnbindCode ||
    !emailUnbindSend || !emailUnbindSubmit || !phoneInput || !phoneCode || !phoneSend ||
    !phoneState || !phoneCurrent || !phoneUnbindPanel || !phoneUnbindCode ||
    !phoneUnbindSend || !phoneUnbindSubmit || !pointsValue || !adminLink || !redemptionAdminLink ||
    !messageBadge || !messageList || !messagesReadAll ||
    !contributionOpen || !contributionDialog || !contributionCancelButtons.length ||
    !contributionForm || !contributionContent || !contributionAttachments ||
    !contributionFiles || !contributionStatus || !contributionSubmit || !contributionList ||
    !redemptionOpen || !redemptionDialog || !redemptionCancelButtons.length ||
    !redemptionForm || !redemptionModes.length || !redemptionPoints || !redemptionTaobao ||
    !redemptionAvailable || !redemptionStatus || !redemptionSubmit || !redemptionList
  ) return;

  let authingProfile: Record<string, unknown> | null = null;
  let pendingAvatar: string | null | undefined;
  let cropImage: HTMLImageElement | null = null;
  let cropImageZoom = 1;
  let cropPanX = 0;
  let cropPanY = 0;
  let cropRadius = 100;
  let cropPointerId: number | null = null;
  let cropPointerX = 0;
  let cropPointerY = 0;
  let currentPoints = 0;
  let availableRedemptionPoints = 0;
  const countdowns = new Map<HTMLButtonElement, number>();
  const cropContext = cropCanvas.getContext('2d');
  const cropCenterX = cropCanvas.width / 2;
  const cropCenterY = cropCanvas.height / 2;

  const setStatus = (message = '', isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const syncSideLink = () => {
    const activeHref = window.location.hash === '#account-messages-title'
      ? '#account-messages-title'
      : window.location.hash === '#account-points-title'
        ? '#account-points-title'
        : '#account-bindings-title';
    sideLinks.forEach((link) => {
      const active = link.getAttribute('href') === activeHref;
      link.classList.toggle('is-active', active);
      link.toggleAttribute('aria-current', active);
    });
  };

  sideLinks.forEach((link) => link.addEventListener('click', () => {
    window.setTimeout(syncSideLink, 0);
  }));
  window.addEventListener('hashchange', syncSideLink);
  syncSideLink();

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

  const applyAccountData = (
    profile: Record<string, unknown>,
    user: SiteUser,
    isAdmin = false,
  ) => {
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

    const siteNickname = user.customDisplayName || 'QDrive 用户';
    nicknameInput.value = siteNickname;
    const hasUsername = Boolean(username);
    usernameText.hidden = !hasUsername || root.matches('[data-account-root]');
    usernameText.textContent = username || '未设置用户名';
    usernameInput.hidden = hasUsername || root.matches('[data-account-root]');
    usernameInput.readOnly = hasUsername;
    usernameInput.value = hasUsername ? username : '';
    usernameHint.textContent = hasUsername
      ? '用户名由 Authing 管理。'
      : '暂未设置用户名，请在 Authing 注册资料中设置。';
    accountName.textContent = siteNickname;
    const accountContact = username || phone || email || '暂未绑定联系方式';
    accountMeta.textContent = accountContact;
    accountIdentity.textContent = accountContact;
    currentPoints = user.points || 0;
    pointsValue.textContent = String(currentPoints);
    adminLink.hidden = !isAdmin;
    redemptionAdminLink.hidden = !isAdmin;
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
    return readJson<{ user: SiteUser; isAdmin: boolean }>(response);
  };

  const refreshAccount = async () => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    const [profile, account] = await Promise.all([
      getAuthingProfile(state.accessToken),
      getSiteAccount(state),
    ]);
    applyAccountData(profile, account.user, account.isAdmin);
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

  const getCropImageRect = () => {
    if (!cropImage) return null;
    const scale = Math.min(
      cropCanvas.width / cropImage.naturalWidth,
      cropCanvas.height / cropImage.naturalHeight,
    ) * cropImageZoom;
    const width = cropImage.naturalWidth * scale;
    const height = cropImage.naturalHeight * scale;
    const centeredX = (cropCanvas.width - width) / 2;
    const centeredY = (cropCanvas.height - height) / 2;
    return {
      x: centeredX + cropPanX,
      y: centeredY + cropPanY,
      width,
      height,
      scale,
      centeredX,
      centeredY,
    };
  };

  const constrainCropImage = () => {
    const imageRect = getCropImageRect();
    if (!imageRect) return null;
    const minPanX = cropCenterX + cropRadius - (imageRect.centeredX + imageRect.width);
    const maxPanX = cropCenterX - cropRadius - imageRect.centeredX;
    const minPanY = cropCenterY + cropRadius - (imageRect.centeredY + imageRect.height);
    const maxPanY = cropCenterY - cropRadius - imageRect.centeredY;
    cropPanX = Math.max(minPanX, Math.min(maxPanX, cropPanX));
    cropPanY = Math.max(minPanY, Math.min(maxPanY, cropPanY));
    return {
      ...imageRect,
      x: imageRect.centeredX + cropPanX,
      y: imageRect.centeredY + cropPanY,
    };
  };

  const drawCropPreview = () => {
    if (!cropImage || !cropContext) return;
    const imageRect = constrainCropImage();
    if (!imageRect) return;
    cropContext.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
    cropContext.fillStyle = '#050508';
    cropContext.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
    cropContext.drawImage(
      cropImage,
      imageRect.x,
      imageRect.y,
      imageRect.width,
      imageRect.height,
    );
    cropContext.save();
    cropContext.beginPath();
    cropContext.rect(0, 0, cropCanvas.width, cropCanvas.height);
    cropContext.arc(cropCenterX, cropCenterY, cropRadius, 0, Math.PI * 2, true);
    cropContext.fillStyle = 'rgba(5, 5, 8, 0.64)';
    cropContext.fill('evenodd');
    cropContext.restore();
    cropContext.beginPath();
    cropContext.arc(cropCenterX, cropCenterY, cropRadius, 0, Math.PI * 2);
    cropContext.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    cropContext.lineWidth = 3;
    cropContext.stroke();
  };

  const closeCropDialog = () => {
    if (cropDialog.open) cropDialog.close();
    cropImage = null;
    cropPointerId = null;
    avatarInput.value = '';
  };

  const openCropDialog = async (dataUrl: string) => {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('无法解析所选图片。'));
      image.src = dataUrl;
    });
    cropImage = image;
    cropImageZoom = 1;
    const scale = Math.min(
      cropCanvas.width / image.naturalWidth,
      cropCanvas.height / image.naturalHeight,
    );
    const imageWidth = image.naturalWidth * scale;
    const imageHeight = image.naturalHeight * scale;
    cropPanX = 0;
    cropPanY = 0;
    cropRadius = Math.max(24, Math.min(imageWidth, imageHeight) / 2 - 2);
    drawCropPreview();
    if (!cropDialog.open) cropDialog.showModal();
  };

  const setContributionStatus = (message = '', isError = false) => {
    contributionStatus.textContent = message;
    contributionStatus.classList.toggle('is-error', isError);
  };

  const formatFileSize = (size: number) => size >= 1_000_000
    ? `${(size / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1_000))} KB`;

  const renderSelectedContributionFiles = () => {
    const files = Array.from(contributionAttachments.files || []);
    contributionFiles.replaceChildren();
    if (!files.length) {
      const empty = document.createElement('li');
      empty.className = 'is-empty';
      empty.textContent = '尚未选择附件';
      contributionFiles.append(empty);
      return;
    }
    files.forEach((file, index) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${index + 1}. ${file.name}`;
      const size = document.createElement('small');
      size.textContent = formatFileSize(file.size);
      item.append(name, size);
      contributionFiles.append(item);
    });
  };

  const renderContributionList = (submissions: ContributionSubmission[]) => {
    contributionList.replaceChildren();
    if (!submissions.length) {
      const empty = document.createElement('p');
      empty.className = 'account-contribution-history__empty';
      empty.textContent = '暂时没有提交记录。';
      contributionList.append(empty);
      return;
    }
    const statusLabels = { pending: '审核中', approved: '已通过', rejected: '未通过' } as const;
    submissions.forEach((submission) => {
      const item = document.createElement('article');
      item.className = 'account-contribution-history__item';
      const heading = document.createElement('div');
      heading.className = 'account-contribution-history__heading';
      const date = document.createElement('time');
      date.dateTime = submission.createdAt;
      date.textContent = new Date(submission.createdAt).toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      const badge = document.createElement('span');
      badge.className = `is-${submission.status}`;
      badge.textContent = submission.status === 'approved'
        ? `${statusLabels[submission.status]} · +${submission.awardedPoints || 0} 积分`
        : statusLabels[submission.status];
      heading.append(date, badge);
      const content = document.createElement('p');
      content.textContent = submission.content;
      item.append(heading, content);
      if (submission.attachments.length) {
        const attachments = document.createElement('small');
        attachments.textContent = `附件：${submission.attachments.map((attachment) => attachment.name).join('、')}`;
        item.append(attachments);
      }
      if (submission.reviewNote) {
        const note = document.createElement('small');
        note.textContent = `审核备注：${submission.reviewNote}`;
        item.append(note);
      }
      contributionList.append(item);
    });
  };

  const loadContributionList = async () => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    const response = await fetch('/api/contributions', {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    const result = await readJson<{ submissions: ContributionSubmission[] }>(response);
    renderContributionList(result.submissions);
  };

  const closeContributionDialog = () => {
    if (contributionDialog.open) contributionDialog.close();
  };

  contributionOpen.addEventListener('click', async () => {
    if (!readLoginState()) {
      setStatus('请先登录后再提交开发贡献。', true);
      return;
    }
    if (!contributionDialog.open) contributionDialog.showModal();
    setContributionStatus();
    contributionList.innerHTML = '<p class="account-contribution-history__empty">正在读取…</p>';
    try {
      await loadContributionList();
    } catch (error) {
      setContributionStatus(error instanceof Error ? error.message : '无法读取提交记录。', true);
    }
  });

  contributionCancelButtons.forEach((button) => button.addEventListener('click', closeContributionDialog));
  contributionDialog.addEventListener('click', (event) => {
    if (event.target === contributionDialog) closeContributionDialog();
  });
  contributionDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeContributionDialog();
  });

  contributionAttachments.addEventListener('change', renderSelectedContributionFiles);

  contributionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const state = readLoginState();
    if (!state) {
      setContributionStatus('登录状态已过期，请重新登录。', true);
      return;
    }
    const content = contributionContent.value.trim();
    if (content.length < 10) {
      setContributionStatus('请至少填写 10 个字符的贡献说明。', true);
      return;
    }
    const files = Array.from(contributionAttachments.files || []);
    if (files.length > 5) {
      setContributionStatus('最多可以上传 5 个附件。', true);
      return;
    }
    if (files.some((file) => file.size > 8_000_000)) {
      setContributionStatus('单个附件不能超过 8 MB。', true);
      return;
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > 20_000_000) {
      setContributionStatus('附件总大小不能超过 20 MB。', true);
      return;
    }
    contributionSubmit.disabled = true;
    contributionSubmit.textContent = '正在提交…';
    setContributionStatus();
    try {
      const attachments = await Promise.all(files.map(async (file) => ({
        name: file.name,
        mime: file.type || 'application/octet-stream',
        dataUrl: await readFileAsDataUrl(file),
      })));
      const response = await fetch('/api/contributions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${state.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, attachments }),
      });
      await readJson<{ submission: ContributionSubmission }>(response);
      contributionForm.reset();
      renderSelectedContributionFiles();
      setContributionStatus('贡献已提交，等待审核。');
      await loadContributionList();
    } catch (error) {
      setContributionStatus(error instanceof Error ? error.message : '贡献提交失败。', true);
    } finally {
      contributionSubmit.disabled = false;
      contributionSubmit.textContent = '提交审核';
    }
  });

  const setRedemptionStatus = (message = '', isError = false) => {
    redemptionStatus.textContent = message;
    redemptionStatus.classList.toggle('is-error', isError);
  };

  const selectedRedemptionMode = () =>
    Array.from(redemptionModes).find((mode) => mode.checked)?.value || 'all';

  const syncRedemptionMode = () => {
    const custom = selectedRedemptionMode() === 'custom';
    redemptionPoints.disabled = !custom;
    redemptionPoints.max = String(availableRedemptionPoints);
    if (!custom) redemptionPoints.value = String(availableRedemptionPoints);
  };

  const renderRedemptionList = (redemptions: PointRedemption[]) => {
    redemptionList.replaceChildren();
    if (!redemptions.length) {
      const empty = document.createElement('p');
      empty.className = 'account-contribution-history__empty';
      empty.textContent = '暂时没有兑换记录。';
      redemptionList.append(empty);
      return;
    }
    const labels = { pending: '处理中', approved: '已完成', rejected: '未通过' } as const;
    redemptions.forEach((redemption) => {
      const item = document.createElement('article');
      item.className = 'account-contribution-history__item';
      const heading = document.createElement('div');
      heading.className = 'account-contribution-history__heading';
      const time = document.createElement('time');
      time.dateTime = redemption.createdAt;
      time.textContent = new Date(redemption.createdAt).toLocaleString('zh-CN');
      const badge = document.createElement('span');
      badge.className = `is-${redemption.status}`;
      badge.textContent = labels[redemption.status];
      heading.append(time, badge);
      const content = document.createElement('p');
      content.textContent = `申请兑换 ${redemption.requestedPoints} 积分 · 淘宝账号：${redemption.taobaoAccount}`;
      item.append(heading, content);
      if (redemption.status === 'approved' && redemption.remainingPoints !== null) {
        const balance = document.createElement('small');
        balance.textContent = `处理后积分余量：${redemption.remainingPoints}`;
        item.append(balance);
      }
      if (redemption.reviewNote) {
        const note = document.createElement('small');
        note.textContent = `处理备注：${redemption.reviewNote}`;
        item.append(note);
      }
      redemptionList.append(item);
    });
  };

  const loadRedemptions = async () => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    const response = await fetch('/api/redemptions', {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    const result = await readJson<{
      redemptions: PointRedemption[];
      points: number;
      availablePoints: number;
    }>(response);
    currentPoints = result.points;
    pointsValue.textContent = String(currentPoints);
    availableRedemptionPoints = result.availablePoints;
    redemptionAvailable.textContent = String(availableRedemptionPoints);
    renderRedemptionList(result.redemptions);
    syncRedemptionMode();
  };

  const closeRedemptionDialog = () => {
    if (redemptionDialog.open) redemptionDialog.close();
  };

  redemptionOpen.addEventListener('click', async () => {
    if (!readLoginState()) {
      setStatus('请先登录后再兑换积分。', true);
      return;
    }
    if (!redemptionDialog.open) redemptionDialog.showModal();
    setRedemptionStatus();
    redemptionList.innerHTML = '<p class="account-contribution-history__empty">正在读取…</p>';
    try {
      await loadRedemptions();
    } catch (error) {
      setRedemptionStatus(error instanceof Error ? error.message : '无法读取兑换记录。', true);
    }
  });

  redemptionModes.forEach((mode) => mode.addEventListener('change', syncRedemptionMode));
  redemptionCancelButtons.forEach((button) => button.addEventListener('click', closeRedemptionDialog));
  redemptionDialog.addEventListener('click', (event) => {
    if (event.target === redemptionDialog) closeRedemptionDialog();
  });
  redemptionDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeRedemptionDialog();
  });

  redemptionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const state = readLoginState();
    if (!state) {
      setRedemptionStatus('登录状态已过期，请重新登录。', true);
      return;
    }
    const taobaoAccount = redemptionTaobao.value.trim();
    const points = selectedRedemptionMode() === 'all'
      ? availableRedemptionPoints
      : Number(redemptionPoints.value);
    if (taobaoAccount.length < 2) {
      setRedemptionStatus('请填写用于接收优惠券的淘宝账号。', true);
      return;
    }
    if (!Number.isInteger(points) || points < 1 || points > availableRedemptionPoints) {
      setRedemptionStatus('兑换数量不能超过当前可兑换积分。', true);
      return;
    }
    redemptionSubmit.disabled = true;
    redemptionSubmit.textContent = '正在提交…';
    setRedemptionStatus();
    try {
      const response = await fetch('/api/redemptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${state.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ taobaoAccount, points }),
      });
      const result = await readJson<{
        redemptions: PointRedemption[];
        points: number;
        availablePoints: number;
      }>(response);
      currentPoints = result.points;
      availableRedemptionPoints = result.availablePoints;
      pointsValue.textContent = String(currentPoints);
      redemptionAvailable.textContent = String(availableRedemptionPoints);
      renderRedemptionList(result.redemptions);
      syncRedemptionMode();
      setRedemptionStatus('兑换申请已提交，等待管理员处理。');
    } catch (error) {
      setRedemptionStatus(error instanceof Error ? error.message : '兑换申请提交失败。', true);
    } finally {
      redemptionSubmit.disabled = false;
      redemptionSubmit.textContent = '提交兑换申请';
    }
  });

  const updateMessageBadge = (unreadCount: number) => {
    messageBadge.textContent = String(unreadCount);
    messageBadge.hidden = unreadCount < 1;
    messagesReadAll.disabled = unreadCount < 1;
  };

  const markMessagesRead = async (id?: string) => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    const response = await fetch('/api/messages', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${state.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(id ? { id } : {}),
    });
    const result = await readJson<{ messages: UserMessage[]; unreadCount: number }>(response);
    renderMessages(result.messages);
    updateMessageBadge(result.unreadCount);
  };

  const renderMessages = (messages: UserMessage[]) => {
    messageList.replaceChildren();
    if (!messages.length) {
      const empty = document.createElement('p');
      empty.className = 'account-contribution-history__empty';
      empty.textContent = '暂时没有消息。';
      messageList.append(empty);
      return;
    }
    messages.forEach((message) => {
      const item = document.createElement('article');
      item.className = `account-message-item${message.readAt ? '' : ' is-unread'}`;
      const heading = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = message.title;
      const time = document.createElement('time');
      time.dateTime = message.createdAt;
      time.textContent = new Date(message.createdAt).toLocaleString('zh-CN');
      heading.append(title, time);
      const content = document.createElement('p');
      content.textContent = message.content;
      item.append(heading, content);
      if (!message.readAt) {
        const readButton = document.createElement('button');
        readButton.type = 'button';
        readButton.textContent = '标记已读';
        readButton.addEventListener('click', () => {
          readButton.disabled = true;
          void markMessagesRead(message.id).catch(() => { readButton.disabled = false; });
        });
        item.append(readButton);
      }
      messageList.append(item);
    });
  };

  const loadMessages = async () => {
    const state = readLoginState();
    if (!state) throw new Error('登录状态已过期，请重新登录。');
    const response = await fetch('/api/messages', {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    const result = await readJson<{ messages: UserMessage[]; unreadCount: number }>(response);
    renderMessages(result.messages);
    updateMessageBadge(result.unreadCount);
  };

  messagesReadAll.addEventListener('click', () => {
    messagesReadAll.disabled = true;
    void markMessagesRead().catch(() => { messagesReadAll.disabled = false; });
  });

  openButton?.addEventListener('click', async () => {
    if (menu) menu.hidden = true;
    authTrigger?.setAttribute('aria-expanded', 'false');
    if (dialog && !dialog.open) dialog.showModal();
    setStatus('正在读取账户资料…');
    try {
      await refreshAccount();
      pendingAvatar = undefined;
      setStatus();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法读取账户资料。', true);
    }
  });

  closeButton?.addEventListener('click', () => dialog?.close());
  dialog?.addEventListener('click', (event) => {
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
      await openCropDialog(await readFileAsDataUrl(file));
      setStatus();
    } catch (error) {
      avatarInput.value = '';
      setStatus(error instanceof Error ? error.message : '无法读取头像。', true);
    }
  });

  cropCanvas.addEventListener('pointerdown', (event) => {
    if (!cropImage) return;
    const rect = cropCanvas.getBoundingClientRect();
    const scale = cropCanvas.width / rect.width;
    const pointerX = (event.clientX - rect.left) * scale;
    const pointerY = (event.clientY - rect.top) * scale;
    if (Math.hypot(pointerX - cropCenterX, pointerY - cropCenterY) > cropRadius) return;
    cropPointerId = event.pointerId;
    cropPointerX = event.clientX;
    cropPointerY = event.clientY;
    cropCanvas.setPointerCapture(event.pointerId);
    cropCanvas.classList.add('is-dragging');
  });

  cropCanvas.addEventListener('pointermove', (event) => {
    if (cropPointerId !== event.pointerId) {
      const rect = cropCanvas.getBoundingClientRect();
      const scale = cropCanvas.width / rect.width;
      const pointerX = (event.clientX - rect.left) * scale;
      const pointerY = (event.clientY - rect.top) * scale;
      cropCanvas.classList.toggle(
        'is-over-crop',
        Math.hypot(pointerX - cropCenterX, pointerY - cropCenterY) <= cropRadius,
      );
      return;
    }
    const rect = cropCanvas.getBoundingClientRect();
    const scale = cropCanvas.width / rect.width;
    cropPanX += (event.clientX - cropPointerX) * scale;
    cropPanY += (event.clientY - cropPointerY) * scale;
    cropPointerX = event.clientX;
    cropPointerY = event.clientY;
    drawCropPreview();
  });

  const stopCropDrag = (event: PointerEvent) => {
    if (cropPointerId !== event.pointerId) return;
    cropPointerId = null;
    cropCanvas.classList.remove('is-dragging');
    if (cropCanvas.hasPointerCapture(event.pointerId)) {
      cropCanvas.releasePointerCapture(event.pointerId);
    }
  };
  cropCanvas.addEventListener('pointerup', stopCropDrag);
  cropCanvas.addEventListener('pointercancel', stopCropDrag);
  cropCanvas.addEventListener('pointerleave', () => {
    if (cropPointerId === null) cropCanvas.classList.remove('is-over-crop');
  });
  cropCanvas.addEventListener('wheel', (event) => {
    if (!cropImage) return;
    event.preventDefault();
    const zoomFactor = Math.exp(-event.deltaY * 0.0015);
    const previousZoom = cropImageZoom;
    cropImageZoom = Math.max(1, Math.min(4, cropImageZoom * zoomFactor));
    const appliedFactor = cropImageZoom / previousZoom;
    cropPanX *= appliedFactor;
    cropPanY *= appliedFactor;
    drawCropPreview();
  }, { passive: false });

  cropCancelButtons.forEach((button) => button.addEventListener('click', closeCropDialog));
  cropDialog.addEventListener('click', (event) => {
    if (event.target === cropDialog) closeCropDialog();
  });
  cropDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeCropDialog();
  });

  cropApply.addEventListener('click', () => {
    if (!cropImage) return;
    const outputSize = 512;
    const output = document.createElement('canvas');
    output.width = outputSize;
    output.height = outputSize;
    const context = output.getContext('2d');
    const imageRect = constrainCropImage();
    if (!context || !imageRect) {
      setStatus('头像裁切失败，请重新选择图片。', true);
      return;
    }
    context.drawImage(
      cropImage,
      (cropCenterX - cropRadius - imageRect.x) / imageRect.scale,
      (cropCenterY - cropRadius - imageRect.y) / imageRect.scale,
      (cropRadius * 2) / imageRect.scale,
      (cropRadius * 2) / imageRect.scale,
      0,
      0,
      outputSize,
      outputSize,
    );
    pendingAvatar = output.toDataURL('image/webp', 0.9);
    setAvatars(pendingAvatar, nicknameInput.value || 'QDrive 用户');
    closeCropDialog();
    setStatus('正在保存新头像…');
    profileForm.requestSubmit();
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
      if (authingProfile) applyAccountData(authingProfile, result.user, !adminLink.hidden);
      setStatus('个人资料已保存。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '资料保存失败。', true);
    } finally {
      profileSave.disabled = false;
      profileSave.textContent = '保存更改';
    }
  });

  nicknameInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    profileForm.requestSubmit();
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

  if (root.matches('[data-account-root]')) {
    setStatus('正在读取账户资料…');
    void refreshAccount()
      .then(() => {
        pendingAvatar = undefined;
        setStatus();
      })
      .catch((error) => {
        setStatus(error instanceof Error ? error.message : '无法读取账户资料。', true);
      });
    void loadMessages().catch(() => {
      messageList.innerHTML = '<p class="account-contribution-history__empty">暂时无法读取消息。</p>';
    });
  }

}

const initializedAccountRoots = new WeakSet<HTMLElement>();

const mountAccountControls = () => {
  document.querySelectorAll<HTMLElement>('[data-account-root]').forEach((root) => {
    if (initializedAccountRoots.has(root)) return;
    initializedAccountRoots.add(root);
    initAccountControl(root);
  });
};

mountAccountControls();
document.addEventListener('astro:page-load', mountAccountControls);
