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

function formatFileSize(size?: number): string | null {
  if (!Number.isFinite(size) || !size || size < 1) return null;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
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
    li.className = 'resource-item';

    const info = document.createElement('div');
    info.className = 'resource-info';

    const name = item.label ?? item.version ?? item.file ?? '未命名固件';
    const heading = document.createElement('div');
    heading.className = 'resource-heading-row';
    appendText(heading, 'resource-title', name);
    if (item.latest) appendText(heading, 'resource-latest', '最新');
    info.appendChild(heading);

    const meta = [item.date, formatFileSize(item.size)].filter(Boolean).join(' · ');
    if (meta) appendText(info, 'resource-meta', meta);

    if (item.notes?.length) {
      const notes = document.createElement('ul');
      notes.className = 'resource-notes';
      for (const note of item.notes) {
        const entry = document.createElement('li');
        entry.className = 'resource-note';
        entry.textContent = note;
        notes.appendChild(entry);
      }
      info.appendChild(notes);
    }

    const link = document.createElement('a');
    link.className = 'pill-action';
    link.href = href;
    link.download = item.file ?? '';
    link.textContent = '下载固件';
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
