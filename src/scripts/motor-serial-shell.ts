import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const encoder = new TextEncoder();

const CTRL_MODE_SUBCMD: Record<string, string> = {
  current: 'current',
  speed: 'speed',
  low_speed: 'low_speed',
  angle: 'angle',
  step_angle: 'step_angle',
};

const CTRL_MODE_UI: Record<string, { label: string; placeholder: string }> = {
  current: { label: '数值(A)', placeholder: '如 0.1' },
  speed: { label: '数值(rpm)', placeholder: '如 10' },
  low_speed: { label: '数值(rpm)', placeholder: '如 3' },
  angle: { label: '数值(rad)', placeholder: '如 1.57' },
  step_angle: { label: '数值(rad)', placeholder: '如 0.5' },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 去掉常见 ANSI 转义，便于解析固件纯文本 */
function stripAnsi(input: string): string {
  return input.replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[-/]*[@-~])/gm, '');
}

/** 固件要求输入 y/n 时常见文案；储存 / 恢复默认 / 校准均在匹配到后才弹窗（无此类提示则不弹窗） */
const FIRMWARE_YN_PROMPT_RE =
  /\(\s*y\s*\/\s*n\s*\)|\[\s*y\s*\/\s*n\s*\]|（\s*y\s*\/\s*n\s*）/i;

type DeviceKvRow = { key: string; value: string };

/** 去掉误解析的 shell 提示（如 QDrive: /$） */
function shouldDropParsedRow(key: string, value: string): boolean {
  const k = key.trim();
  const v = value.trim();
  if (!/^qdrive$/i.test(k)) return false;
  if (v === '/$' || v === '$' || v === '/' || v === '/ $') return true;
  if (v.length <= 4 && /^[/\\\s$]+$/.test(v)) return true;
  return false;
}

/** 解析 `config --list` 文本，得到键 → 值（键名与固件一致，如 pid.speed.kp） */
function parseConfigListOutput(raw: string): Map<string, string> {
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

/**
 * 固件 `config --list` 常在数值后带单位（如 1000 rpm），输入框只应填纯数值。
 */
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

/** 固件列表里可能出现 1'000'000 形式千分位 */
function stripApostropheThousands(value: string): string {
  return value.replace(/'/g, '');
}

function normalizeConfigValueForInput(raw: string): string {
  return stripApostropheThousands(stripTrailingConfigUnit(raw));
}

/** `version` / `info` 常见英文字段 → 面板中文标签（不区分大小写匹配） */
const DEVICE_LABEL_ZH: Record<string, string> = {
  'Software version': '软件版本',
  'Hardware version': '硬件版本',
  'Firmware version': '固件版本',
  'Bootloader version': '引导程序版本',
  'Git version': 'Git 版本',
  'Git hash': 'Git 提交',
  'Build date': '编译日期',
  'Build time': '编译时间',
  'Serial number': '序列号',
  'Device name': '设备名称',
  'Product name': '产品名称',
  Model: '型号',
  'Motor type': '电机类型',
  'KV rating': 'KV值',
  'Nominal voltage': '额定电压',
  'Max voltage': '最大电压',
  'Supply voltage': '供电电压',
  'Bus voltage': '母线电压',
  'Nominal current': '额定电流',
  'Max current': '最大电流',
  'Peak current': '峰值电流',
  'Pole pairs': '极对数',
  Encoder: '编码器',
  'Encoder type': '编码器类型',
  'Encoder CPR': '编码器线数',
  'Encoder resolution': '编码器分辨率',
  'Torque constant': '转矩常数',
  Kt: '转矩常数',
  'Phase resistance': '相电阻',
  Resistance: '电阻',
  'Phase inductance': '相电感',
  Inductance: '电感',
  Inertia: '转动惯量',
  'Max velocity': '最高转速',
  'Max speed': '最高转速',
  'Rated speed': '额定转速',
  'CAN ID': 'CAN 节点 ID',
  'Node ID': '节点 ID',
  Temperature: '温度',
  'MCU temperature': 'MCU 温度',
  'MOSFET temperature': 'MOSFET 温度',
  Fault: '故障',
  Uptime: '运行时间',
  'HW version': '硬件版本',
  'SW version': '软件版本',
};

const DEVICE_LABEL_ZH_LOOKUP = new Map<string, string>();
for (const [en, zh] of Object.entries(DEVICE_LABEL_ZH)) {
  DEVICE_LABEL_ZH_LOOKUP.set(en.trim().toLowerCase(), zh);
}

function displayDeviceLabel(key: string): string {
  const t = key.trim();
  return DEVICE_LABEL_ZH_LOOKUP.get(t.toLowerCase()) ?? t;
}

function applyConfigMapToInputs(map: Map<string, string>): number {
  let n = 0;
  document.querySelectorAll<HTMLInputElement>('[data-config-key]').forEach((input) => {
    const k = input.dataset.configKey;
    if (!k || !map.has(k)) return;
    input.value = normalizeConfigValueForInput(map.get(k) ?? '');
    n += 1;
  });
  return n;
}

function parseDeviceBlock(raw: string, cmd: 'version' | 'info'): DeviceKvRow[] {
  const rows: DeviceKvRow[] = [];
  const seen = new Set<string>();
  const plain = stripAnsi(raw).replace(/\0/g, '');
  const skipEcho =
    cmd === 'version'
      ? /^(version|.*>\s*version)\s*$/i
      : /^(info|.*>\s*info)\s*$/i;
  for (let line of plain.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (skipEcho.test(line)) continue;
    if (/^>\s*$/.test(line)) continue;
    if (/^#\s*$/.test(line)) continue;
    if (/^[^\s<]{0,32}>\s*$/.test(line)) continue;

    const kv = line.match(/^(.+?)\s*[:：=]\s*(.+)$/);
    if (kv) {
      const k = kv[1].trim();
      const v = kv[2].trim();
      if (k && v && !seen.has(k)) {
        seen.add(k);
        rows.push({ key: k, value: v });
      }
      continue;
    }

    const mSoft = line.match(/^software\s+version\s*:?\s*(.+)$/i);
    if (mSoft && !seen.has('Software version')) {
      seen.add('Software version');
      rows.push({ key: 'Software version', value: mSoft[1].trim() });
      continue;
    }
    const mHw = line.match(/^hardware\s+version\s*:?\s*(.+)$/i);
    if (mHw && !seen.has('Hardware version')) {
      seen.add('Hardware version');
      rows.push({ key: 'Hardware version', value: mHw[1].trim() });
      continue;
    }

    const twoCol = line.match(/^([\w.\u4e00-\u9fff]+)\s{2,}(.+)$/);
    if (twoCol) {
      const k = twoCol[1].trim();
      const v = twoCol[2].trim();
      if (k && v && !seen.has(k)) {
        seen.add(k);
        rows.push({ key: k, value: v });
      }
    }
  }
  return rows.filter((r) => !shouldDropParsedRow(r.key, r.value));
}

function renderDeviceRows(dl: HTMLDListElement, rows: DeviceKvRow[], fallbackRaw: string): void {
  dl.replaceChildren();
  dl.classList.toggle('device-info-dl--raw', rows.length === 0);
  if (rows.length === 0) {
    const t = stripAnsi(fallbackRaw).trim();
    const display = t || '—';
    const isLoading = display === '读取中…' || display === '读取中...';
    if (isLoading) {
      const el = document.createElement('div');
      el.className = 'device-info-loading';
      el.textContent = display;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      dl.appendChild(el);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'device-info-pre';
      pre.textContent = display;
      dl.appendChild(pre);
    }
    return;
  }
  for (const { key, value } of rows) {
    const dt = document.createElement('dt');
    dt.textContent = displayDeviceLabel(key);
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
}

function wireSerialDropdown(
  root: HTMLElement,
  onPick: (value: string, labelText: string) => void,
): void {
  const trigger = root.querySelector<HTMLButtonElement>('.serial-dd-trigger');
  const menu = root.querySelector<HTMLElement>('.serial-dd-menu');
  const labelEl = root.querySelector<HTMLElement>('.serial-dd-trigger-label');
  if (!trigger || !menu || !labelEl) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.hidden;
    if (opening) {
      document.querySelectorAll<HTMLElement>('.serial-dd-menu').forEach((m) => {
        if (m === menu) return;
        if (!m.hidden) {
          m.hidden = true;
          m.closest('.serial-dd')
            ?.querySelector<HTMLButtonElement>('.serial-dd-trigger')
            ?.setAttribute('aria-expanded', 'false');
        }
      });
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    } else {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  });

  menu.querySelectorAll<HTMLButtonElement>('[role="option"]').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const value = item.dataset.value ?? '';
      const labelText = item.textContent?.trim() ?? '';
      onPick(value, labelText);
      labelEl.textContent = labelText;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    });
  });
}

function registerSerialDropdownOutsideClose(): void {
  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    document.querySelectorAll<HTMLElement>('.serial-dd').forEach((root) => {
      if (root.contains(t)) return;
      const menu = root.querySelector<HTMLElement>('.serial-dd-menu');
      const tr = root.querySelector<HTMLButtonElement>('.serial-dd-trigger');
      if (menu && !menu.hidden) {
        menu.hidden = true;
        tr?.setAttribute('aria-expanded', 'false');
      }
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll<HTMLElement>('.serial-dd-menu').forEach((menu) => {
      if (menu.hidden) return;
      menu.hidden = true;
      menu
        .closest('.serial-dd')
        ?.querySelector<HTMLButtonElement>('.serial-dd-trigger')
        ?.setAttribute('aria-expanded', 'false');
    });
  });
}

function serialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

function termTheme(dark: boolean) {
  return dark
    ? {
        background: '#111111',
        foreground: '#f9fafb',
        cursor: '#f9fafb',
        selectionBackground: 'rgba(249, 250, 251, 0.25)',
      }
    : {
        background: '#ffffff',
        foreground: '#111827',
        cursor: '#111827',
        selectionBackground: 'rgba(17, 24, 39, 0.12)',
      };
}

/** xterm 默认 viewport 背景为黑；fit 后画布下方会露底，与 theme 对齐（CSS 若未命中则由这里兜底） */
function syncXtermChrome(term: Terminal, wrapEl: HTMLElement | null): void {
  const th = term.options.theme;
  const bg =
    th && typeof th === 'object' && 'background' in th && typeof (th as { background?: unknown }).background === 'string'
      ? (th as { background: string }).background
      : '#ffffff';
  const viewport = term.element?.querySelector<HTMLElement>('.xterm-viewport');
  viewport?.style.setProperty('background-color', bg, 'important');
  if (wrapEl) wrapEl.style.backgroundColor = bg;
}

export function bootMotorSerialShell(): void {
  const banner = document.getElementById('serial-no-api');
  const connectBtn = document.getElementById('serial-connect') as HTMLButtonElement | null;
  const disconnectBtn = document.getElementById('serial-disconnect') as HTMLButtonElement | null;
  const baudHidden = document.getElementById('serial-baud') as HTMLInputElement | null;
  const baudTrigger = document.getElementById('serial-baud-trigger') as HTMLButtonElement | null;
  const statusEl = document.getElementById('serial-status');
  const terminalEl = document.getElementById('terminal');

  if (!terminalEl || !connectBtn || !disconnectBtn || !statusEl) return;

  const baudRoot = document.getElementById('serial-baud-dd');
  if (baudRoot) {
    wireSerialDropdown(baudRoot, (value) => {
      if (baudHidden) baudHidden.value = value || '115200';
    });
  }
  registerSerialDropdownOutsideClose();

  const ctrlModeRoot = document.getElementById('ctrl-mode-dd');
  const ctrlModeHidden = document.getElementById('ctrl-mode') as HTMLInputElement | null;

  function syncCtrlModeFormUi(): void {
    const inp = document.getElementById('gui-ctrl-value') as HTMLInputElement | null;
    const lab = document.getElementById('ctrl-value-label');
    if (!ctrlModeHidden || !inp || !lab) return;
    const ui = CTRL_MODE_UI[ctrlModeHidden.value] ?? CTRL_MODE_UI.current;
    lab.textContent = ui.label;
    inp.placeholder = ui.placeholder;
  }

  if (ctrlModeRoot && ctrlModeHidden) {
    wireSerialDropdown(ctrlModeRoot, (value) => {
      ctrlModeHidden.value = value || 'current';
      syncCtrlModeFormUi();
    });
    syncCtrlModeFormUi();
  }

  const statusLine = statusEl;

  if (!serialSupported()) {
    banner?.removeAttribute('hidden');
    connectBtn.disabled = true;
    statusLine.textContent = '当前浏览器不支持 Web Serial（请使用 Chrome / Edge 等 Chromium 内核浏览器）。';
    return;
  }

  banner?.setAttribute('hidden', '');

  const fitAddon = new FitAddon();
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: termTheme(window.matchMedia('(prefers-color-scheme: dark)').matches),
  });
  term.loadAddon(fitAddon);
  term.open(terminalEl);
  const terminalWrapEl = terminalEl.closest('.serial-terminal-wrap') as HTMLElement | null;
  fitAddon.fit();
  syncXtermChrome(term, terminalWrapEl);

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => {
    term.options.theme = termTheme(mq.matches);
    syncXtermChrome(term, terminalWrapEl);
  };
  mq.addEventListener('change', onScheme);

  const ro = new ResizeObserver(() => {
    try {
      fitAddon.fit();
      syncXtermChrome(term, terminalWrapEl);
    } catch {
      /* ignore */
    }
  });
  ro.observe(terminalEl.parentElement ?? terminalEl);

  let port: SerialPort | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let rxDecoder = new TextDecoder();
  let readLoopActive = false;
  let serialRxCapture: ((chunk: string) => void) | null = null;

  const SERIAL_YN_BUF_MAX = 4096;
  const SERIAL_YN_TIMEOUT_MS = 45000;
  type SerialYnSource = 'calibrate' | 'store' | 'restore';
  let serialYnListener: {
    source: SerialYnSource;
    buffer: string;
    timeoutId: ReturnType<typeof setTimeout>;
  } | null = null;

  function stopSerialYnListener(): void {
    if (!serialYnListener) return;
    clearTimeout(serialYnListener.timeoutId);
    serialYnListener = null;
  }

  let feedSerialYnListener: (chunk: string) => void = () => {};

  const driveStateEl = document.getElementById('serial-drive-state');
  const driveStateTextEl = driveStateEl?.querySelector<HTMLElement>('.serial-drive-state-text');

  type DriveStateUi = 'disconnected' | 'unknown' | 'on' | 'off';

  function setDriveStateUi(s: DriveStateUi): void {
    if (!driveStateEl || !driveStateTextEl) return;
    driveStateEl.dataset.state = s;
    const labels: Record<DriveStateUi, string> = {
      disconnected: '未连接',
      unknown: '状态未知',
      on: '已使能',
      off: '已失能',
    };
    driveStateTextEl.textContent = labels[s];
    driveStateEl.setAttribute('aria-label', `驱动状态：${labels[s]}`);
  }

  const setConnected = (connected: boolean) => {
    connectBtn.disabled = connected;
    disconnectBtn.disabled = !connected;
    if (baudTrigger) baudTrigger.disabled = connected;
    statusLine.textContent = connected
      ? '已连接。'
      : '未连接。请点击「连接串口」按钮。';
 
    setDriveStateUi(connected ? 'unknown' : 'disconnected');
  };

  setConnected(false);

  async function sendRaw(data: string): Promise<void> {
    if (!writer) return;
    await writer.write(encoder.encode(data));
  }

  async function sendLine(line: string): Promise<void> {
    await sendRaw(line + '\n');
  }

  async function captureUntilIdle(
    runSend: () => Promise<void>,
    idleMs = 70,
    maxMs = 2000,
  ): Promise<string> {
    let buf = '';
    serialRxCapture = (chunk: string) => {
      buf += chunk;
    };
    try {
      await runSend();
      const start = Date.now();
      let lastLen = 0;
      let stableAt = Date.now();
      while (Date.now() - start < maxMs) {
        await sleep(45);
        if (buf.length !== lastLen) {
          lastLen = buf.length;
          stableAt = Date.now();
        } else if (Date.now() - stableAt >= idleMs) {
          break;
        }
      }
      return buf;
    } finally {
      serialRxCapture = null;
    }
  }

  async function readConfigListIntoInputs(): Promise<void> {
    if (!writer) return;
    const readCfgBtn = document.getElementById('serial-read-config') as HTMLButtonElement | null;
    if (readCfgBtn) readCfgBtn.disabled = true;
    statusLine.textContent = '正在读取参数…';
    try {
      const raw = await captureUntilIdle(() => sendLine('config --list'), 280, 8000);
      const map = parseConfigListOutput(raw);
      const filled = applyConfigMapToInputs(map);
      statusLine.textContent =
        filled > 0 ? `已连接。已根据列表填入 ${filled} 个字段。` : '已连接。未匹配到可填入字段，请对照终端原文核对格式。';
    } catch {
      statusLine.textContent = '读取参数失败，请重试。';
    } finally {
      if (readCfgBtn) readCfgBtn.disabled = false;
      term.focus();
    }
  }

  term.onData((data) => {
    void sendRaw(data);
  });

  async function stopIo(): Promise<void> {
    stopSerialYnListener();
    closeSerialConfirmDialog();
    readLoopActive = false;
    try {
      await reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      reader?.releaseLock();
    } catch {
      /* ignore */
    }
    reader = null;
    try {
      await writer?.close();
    } catch {
      /* ignore */
    }
    writer = null;
    try {
      if (port) await port.close();
    } catch {
      /* ignore */
    }
    port = null;
  }

  async function readLoop(): Promise<void> {
    if (!reader) return;
    readLoopActive = true;
    let unexpectedDisconnect = false;
    let wroteDisconnectBannerInCatch = false;
    try {
      while (readLoopActive && reader) {
        const { value, done } = await reader.read();
        if (done) {
          const tail = rxDecoder.decode();
          if (tail) {
            term.write(tail);
            serialRxCapture?.(tail);
            feedSerialYnListener(tail);
          }
          if (readLoopActive) {
            unexpectedDisconnect = true;
          }
          break;
        }
        if (value && value.byteLength > 0) {
          const chunk = rxDecoder.decode(value, { stream: true });
          if (chunk) {
            term.write(chunk);
            serialRxCapture?.(chunk);
            feedSerialYnListener(chunk);
          }
        }
      }
    } catch {
      if (readLoopActive) {
        unexpectedDisconnect = true;
        wroteDisconnectBannerInCatch = true;
        term.write('\r\n\x1b[33m[串口读取结束]\x1b[0m\r\n');
      }
    } finally {
      if (unexpectedDisconnect) {
        if (!wroteDisconnectBannerInCatch) {
          term.write('\r\n\x1b[33m[串口读取结束]\x1b[0m\r\n');
        }
        await stopIo();
        setConnected(false);
      }
    }
  }

  connectBtn.addEventListener('click', async () => {
    if (!navigator.serial) return;
    try {
      await stopIo();
      setConnected(false);
      const selected = await navigator.serial.requestPort();
      const baudRate = baudHidden ? Number(baudHidden.value) || 115200 : 115200;
      await selected.open({
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 65536,
      });
      port = selected;
      if (!port.readable || !port.writable) {
        await stopIo();
        setConnected(false);
        statusLine.textContent = '串口流不可用，请重试或重新插拔设备。';
        return;
      }
      rxDecoder = new TextDecoder();
      writer = port.writable.getWriter();
      reader = port.readable.getReader();
      setConnected(true);
      term.focus();
      void readLoop();
      term.writeln('');
      term.writeln('\x1b[90m── 已打开串口 ──\x1b[0m');
      term.writeln('');
    } catch (e) {
      if ((e as Error).name === 'NotFoundError') {
        statusLine.textContent = '未选择串口，已取消。';
      } else {
        statusLine.textContent = `连接失败：${(e as Error).message ?? e}`;
      }
      await stopIo();
      setConnected(false);
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    await stopIo();
    setConnected(false);
    term.writeln('');
    term.writeln('\x1b[90m── 串口已断开 ──\x1b[0m');
    term.writeln('');
  });

  function wireSend(selector: string, line: string) {
    document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      el.addEventListener('click', () => {
        if (!writer) {
          statusLine.textContent = '请先连接串口后再发送命令。';
          return;
        }
        void sendLine(line);
        term.focus();
      });
    });
  }

  document.querySelectorAll<HTMLElement>('[data-serial-cmd="clear"]').forEach((el) => {
    el.addEventListener('click', () => {
      term.clear();
      term.focus();
    });
  });
  wireSend('[data-serial-cmd="status"]', 'status');

  document.getElementById('serial-cmd-enable')?.addEventListener('click', () => {
    if (!writer) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    const enableBtn = document.getElementById('serial-cmd-enable') as HTMLButtonElement | null;
    void (async () => {
      if (enableBtn) enableBtn.disabled = true;
      try {
        const raw = await captureUntilIdle(() => sendLine('enable'));
        const plain = stripAnsi(raw).replace(/\0/g, '');
        if (!/failed/i.test(plain)) {
          setDriveStateUi('on');
        }
      } catch {
        /* 读取失败：不改动驱动状态显示 */
      } finally {
        if (enableBtn) enableBtn.disabled = false;
        term.focus();
      }
    })();
  });
  document.getElementById('serial-cmd-disable')?.addEventListener('click', () => {
    if (!writer) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    void sendLine('disable');
    setDriveStateUi('off');
    term.focus();
  });
  document.querySelectorAll<HTMLElement>('[data-serial-cmd="reboot"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!writer) {
        statusLine.textContent = '请先连接串口后再发送命令。';
        return;
      }
      void sendLine('reboot');
      setDriveStateUi('unknown');
      term.focus();
    });
  });

  const serialConfirmDialog = document.getElementById('serial-confirm-dialog');
  const serialConfirmTitle = document.getElementById('serial-confirm-title');
  const serialConfirmDesc = document.getElementById('serial-confirm-desc');
  const serialConfirmOk = document.getElementById('serial-confirm-ok') as HTMLButtonElement | null;
  const serialConfirmCancel = document.getElementById('serial-confirm-cancel') as HTMLButtonElement | null;

  type SerialConfirmKind = 'store_yn' | 'restore_yn' | 'calibrate_yn';

  let serialConfirmPending: SerialConfirmKind | null = null;

  function serialConfirmSendsNOnDismiss(kind: SerialConfirmKind | null): boolean {
    return kind === 'store_yn' || kind === 'restore_yn' || kind === 'calibrate_yn';
  }
  let serialConfirmEscapeHandler: ((e: KeyboardEvent) => void) | null = null;

  function closeSerialConfirmDialog(): void {
    if (!serialConfirmDialog) return;
    serialConfirmDialog.classList.remove('open');
    serialConfirmDialog.setAttribute('aria-hidden', 'true');
    serialConfirmPending = null;
    if (serialConfirmEscapeHandler) {
      document.removeEventListener('keydown', serialConfirmEscapeHandler);
      serialConfirmEscapeHandler = null;
    }
  }

  function openSerialConfirmDialog(kind: SerialConfirmKind): void {
    if (!serialConfirmDialog || !serialConfirmTitle || !serialConfirmDesc || !serialConfirmOk) return;
    serialConfirmPending = kind;
    if (kind === 'store_yn') {
      serialConfirmTitle.textContent = '写入到设备？';
      serialConfirmDesc.textContent = '设备请求确认后再保存当前参数，请选择。';
    } else if (kind === 'restore_yn') {
      serialConfirmTitle.textContent = '恢复出厂默认？';
      serialConfirmDesc.textContent = '设备请求确认后再恢复默认参数，请选择。';
    } else {
      serialConfirmTitle.textContent = '是否继续？';
      serialConfirmDesc.textContent = '设备请求确认后再继续当前步骤，请选择。';
    }
    serialConfirmDialog.classList.add('open');
    serialConfirmDialog.setAttribute('aria-hidden', 'false');
    serialConfirmOk.focus();
    serialConfirmEscapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        const was = serialConfirmPending;
        closeSerialConfirmDialog();
        if (serialConfirmSendsNOnDismiss(was) && writer) void sendLine('n');
        term.focus();
      }
    };
    document.addEventListener('keydown', serialConfirmEscapeHandler);
  }

  serialConfirmDialog?.addEventListener('click', (e) => {
    if (e.target === serialConfirmDialog) {
      const was = serialConfirmPending;
      closeSerialConfirmDialog();
      if (serialConfirmSendsNOnDismiss(was) && writer) void sendLine('n');
      term.focus();
    }
  });

  serialConfirmCancel?.addEventListener('click', () => {
    const was = serialConfirmPending;
    closeSerialConfirmDialog();
    if (serialConfirmSendsNOnDismiss(was) && writer) void sendLine('n');
    term.focus();
  });

  serialConfirmOk?.addEventListener('click', () => {
    if (!writer || !serialConfirmPending) return;
    const kind = serialConfirmPending;
    closeSerialConfirmDialog();
    void (async () => {
      await sendLine('y');
      if (kind === 'restore_yn') {
        await sleep(1500);
        await readConfigListIntoInputs();
      } else {
        term.focus();
      }
    })();
  });

  const SERIAL_YN_WAIT_STATUS: Record<SerialYnSource, string> = {
    calibrate: '校准已发送，正在等待设备…',
    store: '储存已发送，正在等待设备…',
    restore: '恢复默认已发送，正在等待设备…',
  };

  function startSerialYnListener(source: SerialYnSource): void {
    stopSerialYnListener();
    const timeoutId = window.setTimeout(() => {
      if (serialYnListener !== null && serialYnListener.timeoutId === timeoutId) {
        serialYnListener = null;
        statusLine.textContent = '已连接。';
      }
    }, SERIAL_YN_TIMEOUT_MS);
    serialYnListener = { source, buffer: '', timeoutId };
    statusLine.textContent = SERIAL_YN_WAIT_STATUS[source];
  }

  function ynDialogKindForSource(source: SerialYnSource): SerialConfirmKind {
    if (source === 'store') return 'store_yn';
    if (source === 'restore') return 'restore_yn';
    return 'calibrate_yn';
  }

  feedSerialYnListener = (chunk: string) => {
    if (!serialYnListener) return;
    const plain = stripAnsi(chunk).replace(/\0/g, '');
    serialYnListener.buffer = (serialYnListener.buffer + plain).slice(-SERIAL_YN_BUF_MAX);
    if (!FIRMWARE_YN_PROMPT_RE.test(serialYnListener.buffer)) return;
    clearTimeout(serialYnListener.timeoutId);
    const { source } = serialYnListener;
    serialYnListener = null;
    statusLine.textContent = '已连接。';
    openSerialConfirmDialog(ynDialogKindForSource(source));
  };

  function canStartSerialYnFlow(): boolean {
    if (!writer) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return false;
    }
    if (serialConfirmDialog?.classList.contains('open')) {
      statusLine.textContent = '请先关闭当前确认框。';
      return false;
    }
    if (serialYnListener) {
      statusLine.textContent = '正在等待设备响应，请稍候。';
      return false;
    }
    return true;
  }

  document.querySelectorAll<HTMLElement>('[data-serial-cmd="store"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!canStartSerialYnFlow()) return;
      void sendLine('store');
      startSerialYnListener('store');
      term.focus();
    });
  });
  document.querySelectorAll<HTMLElement>('[data-serial-cmd="restore"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!canStartSerialYnFlow()) return;
      void sendLine('restore');
      startSerialYnListener('restore');
      term.focus();
    });
  });

  document.querySelectorAll<HTMLElement>('[data-serial-cmd="calibrate"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!canStartSerialYnFlow()) return;
      void sendLine('calibrate');
      startSerialYnListener('calibrate');
      term.focus();
    });
  });
  wireSend('[data-serial-cmd="upgrade"]', 'upgrade');

  const ctrlValueInput = document.getElementById('gui-ctrl-value') as HTMLInputElement | null;
  const ctrlSendBtn = document.getElementById('serial-ctrl-send') as HTMLButtonElement | null;

  ctrlSendBtn?.addEventListener('click', () => {
    if (!writer) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    if (!ctrlModeHidden || !ctrlValueInput) return;
    const sub = CTRL_MODE_SUBCMD[ctrlModeHidden.value];
    if (!sub) return;
    const v = ctrlValueInput.value.trim();
    if (!v) {
      statusLine.textContent = '请填写控制量后再发送。';
      return;
    }
    void sendLine(`ctrl ${sub} ${v}`);
    term.focus();
  });

  wireSend('[data-serial-cmd="set-zero-pos"]', 'config zero_pos');

  const pidConfigSendGapMs = 50;

  const configPanel = document.getElementById('serial-config-panel');
  const configApplyAllBtn = document.getElementById('serial-config-apply') as HTMLButtonElement | null;

  configApplyAllBtn?.addEventListener('click', () => {
    if (!writer) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    const inputs = configPanel?.querySelectorAll<HTMLInputElement>('[data-config-key]') ?? [];
    void (async () => {
      const entries: { key: string; val: string }[] = [];
      for (const input of inputs) {
        const key = input.dataset.configKey?.trim();
        const val = input.value.trim();
        if (key && val) entries.push({ key, val });
      }
      if (entries.length === 0) {
        statusLine.textContent = '请至少填写一项后再设置。';
        term.focus();
        return;
      }
      for (let i = 0; i < entries.length; i += 1) {
        await sendLine(`config ${entries[i].key} ${entries[i].val}`);
        if (i < entries.length - 1) await sleep(pidConfigSendGapMs);
      }
      statusLine.textContent = '已连接。';
      term.focus();
    })();
  });

  const readDeviceBtn = document.getElementById('serial-read-device') as HTMLButtonElement | null;
  const deviceInfoPanel = document.getElementById('device-info-panel');
  const deviceInfoVersionDl = document.getElementById('device-info-version') as HTMLDListElement | null;
  const deviceInfoMotorDl = document.getElementById('device-info-motor') as HTMLDListElement | null;

  readDeviceBtn?.addEventListener('click', () => {
    if (!writer) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    if (!deviceInfoPanel || !deviceInfoVersionDl || !deviceInfoMotorDl) return;

    void (async () => {
      readDeviceBtn.disabled = true;
      deviceInfoPanel.hidden = false;
      renderDeviceRows(deviceInfoVersionDl, [], '读取中…');
      renderDeviceRows(deviceInfoMotorDl, [], '读取中…');
      statusLine.textContent = '正在读取 version / info…';
      try {
        const rawVersion = await captureUntilIdle(() => sendLine('version'));
        const rawInfo = await captureUntilIdle(() => sendLine('info'));
        const vRows = parseDeviceBlock(rawVersion, 'version');
        const iRows = parseDeviceBlock(rawInfo, 'info');
        renderDeviceRows(deviceInfoVersionDl, vRows, rawVersion);
        renderDeviceRows(deviceInfoMotorDl, iRows, rawInfo);
        statusLine.textContent = '已连接。';
      } catch {
        statusLine.textContent = '读取设备信息失败，请重试。';
      } finally {
        readDeviceBtn.disabled = false;
        term.focus();
      }
    })();
  });

  const readConfigBtn = document.getElementById('serial-read-config') as HTMLButtonElement | null;
  readConfigBtn?.addEventListener('click', () => {
    if (!writer) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    void readConfigListIntoInputs();
  });
}
