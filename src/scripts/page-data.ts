type PageData = {
  specifications?: SpecificationItem[];
  downloads?: DownloadItem[];
  downloadsEmptyMessage?: string;
  linkLists?: Record<string, LinkList>;
};

type SpecificationItem = {
  label?: string;
  value?: string;
};

type DownloadItem = {
  type?: 'link' | 'button';
  id?: string;
  icon?: string;
  title?: string;
  description?: string;
  href?: string;
  file?: string;
  target?: string;
  rel?: string;
  download?: boolean;
  ariaLabel?: string;
};

type LinkList = {
  baseUrl?: string;
  items?: LinkListItem[];
};

type LinkListItem = {
  title?: string;
  note?: string;
  href?: string;
  file?: string;
  target?: string;
  rel?: string;
  download?: boolean;
  ariaLabel?: string;
};

const pageDataCache = new Map<string, Promise<PageData | null>>();

function appendText(parent: HTMLElement, className: string, text: string): void {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  parent.appendChild(el);
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function resolveHref(item: DownloadItem | LinkListItem, baseUrl = ''): string | null {
  if (item.href) return item.href;
  if (!item.file) return null;
  return `${baseUrl}${encodePath(item.file)}`;
}

function setLinkAttrs(el: HTMLAnchorElement, item: DownloadItem | LinkListItem): void {
  if (item.target) el.target = item.target;
  if (item.rel) el.rel = item.rel;
  if (item.download) el.download = item.file ?? '';
}

function renderSpecs(tbody: HTMLElement, specs: SpecificationItem[]): void {
  const fragment = document.createDocumentFragment();

  for (const spec of specs) {
    if (!spec.label || !spec.value) continue;

    const tr = document.createElement('tr');
    const th = document.createElement('th');
    const td = document.createElement('td');

    th.textContent = spec.label;
    td.textContent = spec.value;
    tr.append(th, td);
    fragment.appendChild(tr);
  }

  if (fragment.childNodes.length) tbody.replaceChildren(fragment);
}

function renderDownloadCard(item: DownloadItem): HTMLElement | null {
  if (!item.title) return null;

  const isButton = item.type === 'button';
  const card = isButton ? document.createElement('button') : document.createElement('a');
  card.className = 'download-card';

  if (isButton) {
    const button = card as HTMLButtonElement;
    button.type = 'button';
    if (item.id) button.id = item.id;
  } else {
    const link = card as HTMLAnchorElement;
    const href = resolveHref(item);
    if (!href) return null;
    link.href = href;
    setLinkAttrs(link, item);
  }

  if (item.ariaLabel) card.setAttribute('aria-label', item.ariaLabel);
  appendText(card, 'download-card-icon', item.icon ?? '');
  appendText(card, 'download-card-title', item.title);
  appendText(card, 'download-card-desc', item.description ?? '');

  return card;
}

function renderDownloads(container: HTMLElement, downloads: DownloadItem[]): void {
  const fragment = document.createDocumentFragment();

  for (const item of downloads) {
    const card = renderDownloadCard(item);
    if (card) fragment.appendChild(card);
  }

  if (fragment.childNodes.length) container.replaceChildren(fragment);
}

function renderDownloadsEmpty(container: HTMLElement, message: string): void {
  const empty = document.createElement('p');
  empty.className = 'download-empty';
  empty.textContent = message;
  container.replaceChildren(empty);
}

function renderLinkList(list: HTMLElement, linkList: LinkList): void {
  const fragment = document.createDocumentFragment();

  for (const item of linkList.items ?? []) {
    const href = resolveHref(item, linkList.baseUrl);
    if (!href || !item.title) continue;

    const li = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'resource-item resource-item--link';
    link.href = href;
    setLinkAttrs(link, item);
    link.setAttribute('aria-label', item.ariaLabel ?? item.title);

    const info = document.createElement('div');
    info.className = 'resource-info';
    appendText(info, 'resource-title', item.title);
    if (item.note) appendText(info, 'resource-note', item.note);

    link.appendChild(info);
    li.appendChild(link);
    fragment.appendChild(li);
  }

  if (fragment.childNodes.length) list.replaceChildren(fragment);
}

async function loadPageData(url: string): Promise<PageData | null> {
  if (!pageDataCache.has(url)) {
    pageDataCache.set(
      url,
      fetch(url, { cache: 'no-cache' })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<PageData>;
        })
        .catch(() => null),
    );
  }

  return pageDataCache.get(url) ?? null;
}

async function hydrateElement(el: HTMLElement): Promise<void> {
  const dataUrl = el.dataset.pageDataUrl;
  if (!dataUrl || el.dataset.pageDataLoaded === 'true') return;

  const data = await loadPageData(dataUrl);
  if (!data) {
    if (el.hasAttribute('data-page-downloads')) {
      renderDownloadsEmpty(el, el.dataset.pageEmptyMessage ?? '敬请期待');
    }
    el.dataset.pageDataLoaded = 'fallback';
    return;
  }

  if (el.hasAttribute('data-page-specs')) {
    renderSpecs(el, data.specifications ?? []);
  } else if (el.hasAttribute('data-page-downloads')) {
    const downloads = data.downloads ?? [];
    if (downloads.length > 0) {
      renderDownloads(el, downloads);
    } else {
      const message = data.downloadsEmptyMessage ?? el.dataset.pageEmptyMessage;
      if (message) renderDownloadsEmpty(el, message);
    }
  } else if (el.dataset.pageLinkList) {
    renderLinkList(el, data.linkLists?.[el.dataset.pageLinkList] ?? {});
  }

  el.dataset.pageDataLoaded = 'true';
}

export function bootPageDataSections(): void {
  document
    .querySelectorAll<HTMLElement>('[data-page-data-url]')
    .forEach((el) => {
      void hydrateElement(el);
    });
}
