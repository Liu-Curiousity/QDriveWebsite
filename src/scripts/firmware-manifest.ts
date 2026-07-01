type FirmwareManifest = {
  baseUrl?: string;
  items?: FirmwareManifestItem[];
  versions?: FirmwareManifestItem[];
};

type FirmwareManifestItem = {
  version?: string;
  label?: string;
  date?: string;
  file?: string;
  href?: string;
  url?: string;
  latest?: boolean;
  notes?: string[];
  size?: number;
  sha256?: string;
};

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

function resolveHref(item: FirmwareManifestItem, baseUrl: string): string | null {
  const explicit = item.url ?? item.href;
  if (explicit) return explicit;
  if (!item.file) return null;
  return `${baseUrl}${encodePath(item.file)}`;
}

function normalizeItems(manifest: FirmwareManifest): FirmwareManifestItem[] {
  return manifest.items ?? manifest.versions ?? [];
}

function renderFirmwareList(
  list: HTMLElement,
  items: FirmwareManifestItem[],
  baseUrl: string,
): void {
  const fragment = document.createDocumentFragment();

  for (const item of items) {
    const href = resolveHref(item, baseUrl);
    if (!href) continue;

    const li = document.createElement('li');
    li.className = 'fw-version-item';

    const info = document.createElement('div');
    info.className = 'fw-version-info';

    const name = item.label ?? item.version ?? item.file ?? '未命名固件';
    appendText(info, 'fw-version-name', `${name}${item.latest ? '（最新）' : ''}`);

    if (item.date) {
      appendText(info, 'fw-version-date', item.date);
    }

    for (const note of item.notes ?? []) {
      appendText(info, 'fw-version-note', note);
    }

    const link = document.createElement('a');
    link.className = 'fw-version-dl';
    link.href = href;
    link.download = item.file ?? '';
    link.textContent = '下载';
    link.setAttribute('aria-label', `下载固件 ${item.version ?? name}`);

    li.append(info, link);
    fragment.appendChild(li);
  }

  if (!fragment.childNodes.length) return;
  list.replaceChildren(fragment);
}

async function loadFirmwareManifest(list: HTMLElement): Promise<void> {
  const manifestUrl = list.dataset.manifestUrl;
  if (!manifestUrl || list.dataset.manifestLoaded === 'true') return;

  try {
    const res = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const manifest = (await res.json()) as FirmwareManifest;
    const items = normalizeItems(manifest);
    if (!Array.isArray(items) || items.length === 0) return;

    const baseUrl =
      list.dataset.baseUrl ??
      manifest.baseUrl ??
      manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);

    renderFirmwareList(list, items, baseUrl);
    list.dataset.manifestLoaded = 'true';
  } catch (err) {
    list.dataset.manifestLoaded = 'fallback';
  }
}

export function bootFirmwareManifestLists(): void {
  document
    .querySelectorAll<HTMLElement>('[data-firmware-manifest]')
    .forEach((list) => {
      void loadFirmwareManifest(list);
    });
}
