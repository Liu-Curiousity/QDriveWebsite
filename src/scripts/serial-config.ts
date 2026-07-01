import { stripAnsi } from './serial-transport.ts';

export function parseConfigListOutput(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const plain = stripAnsi(raw).replace(/\0/g, '');
  const skipEcho = /^(config\s*--list|.*>\s*config\s*--list)\s*$/i;
  for (let line of plain.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (skipEcho.test(line)) continue;
    if (/^>\s*$/.test(line)) continue;
    if (/^#\s*$/.test(line)) continue;
    if (/^[^\s<]{0,32}>\s*$/.test(line)) continue;
    if (/^[-=]{4,}\s*$/.test(line)) continue;
    if (/^(key|name|param|parameter)\s+[:：]?\s*value$/i.test(line)) continue;
    if (/^current configuration\s*:?\s*$/i.test(line)) continue;

    let m = line.match(/^([\w.]+)\s*=\s*(.+)$/);
    if (m) {
      map.set(m[1], m[2].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    m = line.match(/^([\w.]+)\s*[:：]\s*(.+)$/);
    if (m) {
      map.set(m[1], m[2].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    m = line.match(/^([\w.]+)\s{2,}(.+)$/);
    if (m) {
      map.set(m[1], m[2].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return map;
}

function stripTrailingConfigUnit(raw: string): string {
  let v = raw.trim().replace(/^["']|["']$/g, '');
  if (!v) return v;

  const stripOnce = (s: string): string =>
    s
      .replace(/\s+rpm\/V\s*$/i, '')
      .replace(/\s+Nm\/A\s*$/i, '')
      .replace(/\s+rpm\s*$/i, '')
      .replace(/\s+bps\s*$/i, '')
      .replace(/\s+rad\s*$/i, '')
      .replace(/\s+mH\s*$/i, '')
      .replace(/\s+mΩ\s*$/i, '')
      .replace(/\s+Ω\s*$/gi, '')
      .replace(/\s+ohm\s*$/i, '')
      .replace(/\s+kHz\s*$/i, '')
      .replace(/\s+Hz\s*$/i, '')
      .replace(/\s+ms\s*$/i, '')
      .replace(/\s+V\s*$/, '')
      .replace(/\s+A\s*$/, '')
      .replace(/rpm$/i, '')
      .replace(/bps$/i, '')
      .replace(/rad$/i, '')
      .trim();

  let prev = '';
  while (v !== prev) {
    prev = v;
    v = stripOnce(v);
  }
  return v;
}

function stripApostropheThousands(value: string): string {
  return value.replace(/'/g, '');
}

export function normalizeConfigValueForInput(raw: string): string {
  return stripApostropheThousands(stripTrailingConfigUnit(raw));
}

export function normalizeScientificNotation(raw: string): string {
  const v = raw.trim();
  const m = v.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))[eE]([+-]?\d+)$/);
  if (!m) return v;

  const sign = m[1] ?? '';
  const intPart = m[2] ?? '';
  const fracPart = (m[3] ?? m[4] ?? '').replace(/_/g, '');
  let digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
  if (!digits || /^0+$/.test(digits)) return '0';

  const exp = Number.parseInt(m[5] ?? '0', 10);
  if (!Number.isFinite(exp)) return v;
  const decimalPos = intPart.length + exp;

  let plain = '';
  if (decimalPos <= 0) {
    plain = `0.${'0'.repeat(-decimalPos)}${digits}`;
  } else if (decimalPos >= digits.length) {
    plain = `${digits}${'0'.repeat(decimalPos - digits.length)}`;
  } else {
    plain = `${digits.slice(0, decimalPos)}.${digits.slice(decimalPos)}`;
  }

  const [rawInt, rawFrac = ''] = plain.split('.');
  const cleanInt = rawInt.replace(/^0+(?=\d)/, '') || '0';
  const cleanFrac = rawFrac.replace(/0+$/, '');
  const normalized = cleanFrac ? `${cleanInt}.${cleanFrac}` : cleanInt;
  if (normalized === '0') return '0';
  return sign === '-' ? `-${normalized}` : normalized;
}

export function applyConfigMapToInputs(map: Map<string, string>): number {
  let n = 0;
  document.querySelectorAll<HTMLInputElement>('[data-config-key]').forEach((input) => {
    const k = input.dataset.configKey;
    if (!k || !map.has(k)) return;
    input.value = normalizeConfigValueForInput(map.get(k) ?? '');
    n += 1;
  });
  return n;
}

export function collectConfigEntries(inputs: Iterable<HTMLInputElement>): { key: string; val: string }[] {
  const entries: { key: string; val: string }[] = [];
  const seenKeys = new Set<string>();
  for (const input of inputs) {
    const key = input.dataset.configKey?.trim();
    const val = normalizeScientificNotation(input.value);
    if (!key || !val || seenKeys.has(key)) continue;
    seenKeys.add(key);
    entries.push({ key, val });
  }
  return entries;
}
