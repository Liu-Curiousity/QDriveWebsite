import { createSerialConfirmController, type SerialConfirmController, type SerialConfirmKind } from './serial-confirm.ts';
import { createDfuUpdateController } from './dfu-update.ts';
import { applyConfigMapToInputs, collectConfigEntries, parseConfigListOutput } from './serial-config.ts';
import { registerSerialDropdownOutsideClose, wireSerialDropdown } from './serial-dropdown.ts';
import { createSerialTerminal } from './serial-terminal.ts';
import {
  POST_CONNECT_KEY_DELAY_MS,
  POST_CONNECT_KEY_SEQ,
  SerialTransport,
  serialSupported,
  sleep,
  stripAnsi,
} from './serial-transport.ts';

export { normalizeScientificNotation } from './serial-config.ts';
export { stripAnsi } from './serial-transport.ts';

export const CTRL_MODE_SUBCMD: Record<string, string> = {
  current: 'current',
  speed: 'speed',
  low_speed: 'low_speed',
  angle: 'angle',
  step_angle: 'step_angle',
};

export const CTRL_MODE_UI: Record<string, { label: string; placeholder: string }> = {
  current: { label: '数值(A)', placeholder: '如 0.1' },
  speed: { label: '数值(rpm)', placeholder: '如 10' },
  low_speed: { label: '数值(rpm)', placeholder: '如 3' },
  angle: { label: '数值(rad)', placeholder: '如 1.57' },
  step_angle: { label: '数值(rad)', placeholder: '如 0.5' },
};

/** 各品类实现：模式切换时 UI、发送按钮与快捷键（公共模块只负责调用） */
export type WebHostControlContext = {
  ctrlModeHidden: HTMLInputElement | null;
  isSerialConnected: () => boolean;
  sendLine: (line: string) => Promise<void>;
  setStatus: (text: string) => void;
  /** 是否在发送后把焦点交回终端 */
  focusTerminal: (focusTerminalAfter?: boolean) => void;
};

export type WebHostControlBinding = {
  /** 模式下拉未带值时的回退 */
  ctrlModeFallback: string;
  syncCtrlModeFormUi: () => void;
  attachCtrlSend: (ctx: WebHostControlContext) => void;
};

/** 云台等多路状态：由品类脚本实现解析与 DOM 更新 */
export type DriveStateBinding = {
  onDisconnected: () => void;
  onConnectedUnknown: () => void;
  onStatusRaw: (raw: string) => void;
  /** 主路 `enable` 捕获回显后更新 UI（不发 status，与电机一致） */
  onMainEnableCapture?: (plain: string) => void;
  /** 主路 `disable` 后更新 UI（不发 status） */
  onMainDisable?: () => void;
};

export type WebHostSerialReadyContext = {
  sendLine: (line: string) => Promise<void>;
  /** Low-priority polling write that must not delay or pause user commands. */
  sendPollingLine: (line: string) => Promise<void>;
  captureUntilIdle: (
    runSend: () => Promise<void>,
    idleMs?: number,
    maxMs?: number,
    options?: { silent?: boolean; isComplete?: (buffer: string) => boolean },
  ) => Promise<string>;
  isSerialConnected: () => boolean;
  setStatusLine: (text: string) => void;
  focusTerminal: () => void;
  subscribeToUserCommands: (listener: () => void) => () => void;
  setTerminalInputEnabled: (enabled: boolean) => void;
};

export type WebHostSerialOptions = {
  deviceInfoExtraDlId: string;
  controls: WebHostControlBinding;
  /** 多路状态（如云台三路）；未传时沿用单元素 `#serial-drive-state` 电机逻辑 */
  driveState?: DriveStateBinding;
  /** 串口与终端就绪后绑定品类专属命令按钮等 */
  afterSerialReady?: (ctx: WebHostSerialReadyContext) => void;
};

/** 固件要求输入 y/n 时常见文案；储存 / 恢复默认 / 校准均在匹配到后才弹窗（无此类提示则不弹窗） */
const FIRMWARE_YN_PROMPT_RE =
  /\(\s*y\s*\/\s*n\s*\)|\[\s*y\s*\/\s*n\s*\]|（\s*y\s*\/\s*n\s*）/i;

/**
 * 从 `status` 命令返回文本中解析电机使能行（如 `Status : disabled` / `Status = enabled`），
 * 按行匹配，避免整段正则漏匹配或误匹配 `Motor Status:` 标题行。
 */
function parseStatusCommandDriveState(raw: string): 'on' | 'off' | null {
  const plain = stripAnsi(raw).replace(/\0/g, '').replace(/\u00a0/g, ' ');
  for (const line of plain.split(/\r?\n/)) {
    const t = line.trim();
    if (!/^status\b/i.test(t)) continue;
    // 排除仅作标题的 "Motor Status:" 等（行首已是 Status 且紧跟分隔符）
    const m = t.match(/^status\s*[:：=]\s*(.+)$/i);
    if (!m) continue;
    const token =
      m[1]
        .trim()
        .split(/\s+/)[0]
        ?.replace(/[,;]$/, '')
        .toLowerCase() ?? '';
    if (!token) continue;
    if (token === 'enabled' || token === 'enable' || token === 'on' || token === 'true' || token === '1') {
      return 'on';
    }
    if (
      token === 'disabled' ||
      token === 'disable' ||
      token === 'off' ||
      token === 'false' ||
      token === '0'
    ) {
      return 'off';
    }
  }
  return null;
}

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
    const display = t || '--';
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

export function bootWebHostSerialShell(options: WebHostSerialOptions): void {
  const driveBinding = options.driveState;
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
    options.controls.syncCtrlModeFormUi();
  }

  if (ctrlModeRoot && ctrlModeHidden) {
    wireSerialDropdown(ctrlModeRoot, (value) => {
      ctrlModeHidden.value = value || options.controls.ctrlModeFallback;
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

  const { term, serialShellInertRoot } = createSerialTerminal(terminalEl);
  const dfuUpdateController = createDfuUpdateController();

  const SERIAL_YN_BUF_MAX = 2048;
  const SERIAL_YN_TIMEOUT_MS = 1000;
  type SerialYnSource = 'calibrate' | 'store' | 'restore' | 'upgrade';
  let serialYnListener: {
    source: SerialYnSource;
    buffer: string;
    timeoutId: number;
  } | null = null;
  let serialYnSendPending = false;

  function stopSerialYnListener(): void {
    if (!serialYnListener) return;
    clearTimeout(serialYnListener.timeoutId);
    serialYnListener = null;
  }

  let feedSerialYnListener: (chunk: string) => void = () => {};
  let serialConfirmController: SerialConfirmController | null = null;
  let transport: SerialTransport;
  let connectionGeneration = 0;
  const userCommandListeners = new Set<() => void>();
  const notifyUserCommand = () => {
    userCommandListeners.forEach((listener) => listener());
  };
  const driveStateEl = driveBinding ? null : document.getElementById('serial-drive-state');
  const driveStateTextEl =
    driveStateEl?.querySelector<HTMLElement>('.serial-drive-state-text') ?? null;

  type DriveStateUi = 'disconnected' | 'unknown' | 'on' | 'off';

  function setDriveStateUi(s: DriveStateUi): void {
    if (driveBinding) return;
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
    if (!connected) connectionGeneration += 1;
    connectBtn.disabled = connected;
    disconnectBtn.disabled = !connected;
    if (baudTrigger) baudTrigger.disabled = connected;
    document.querySelectorAll<HTMLButtonElement>('[data-serial-cmd="upgrade"]').forEach((button) => {
      button.textContent = connected ? '进入升级模式' : '升级固件';
    });
    statusLine.textContent = connected
      ? '已连接。'
      : '未连接。请点击「连接设备」按钮。';
 
    if (driveBinding) {
      if (connected) driveBinding.onConnectedUnknown();
      else driveBinding.onDisconnected();
    } else {
      setDriveStateUi(connected ? 'unknown' : 'disconnected');
    }
  };

  setConnected(false);

  const isSerialConnected = () => transport.isConnected();

  transport = new SerialTransport({
    onChunk(chunk) {
      term.write(chunk);
      feedSerialYnListener(chunk);
    },
    onBeforeStop() {
      stopSerialYnListener();
      serialYnSendPending = false;
      serialConfirmController?.close();
    },
    onUnexpectedDisconnect() {
      term.write('\r\n\x1b[33m[串口读取结束]\x1b[0m\r\n');
      setConnected(false);
    },
    onReadError() {
      term.write('\r\n\x1b[33m[串口读取结束]\x1b[0m\r\n');
      setConnected(false);
    },
  });

  async function sendRaw(data: string): Promise<void> {
    await transport.sendRaw(data);
  }

  async function sendLine(line: string): Promise<void> {
    notifyUserCommand();
    if (!transport.isCaptureActive()) await transport.waitForCapture();
    await transport.sendLine(line);
  }

  async function sendPollingLine(line: string): Promise<void> {
    await transport.sendLine(line);
  }

  async function captureUntilIdle(
    runSend: () => Promise<void>,
    idleMs = 35,
    maxMs = 1000,
    options: { silent?: boolean; isComplete?: (buffer: string) => boolean } = {},
  ): Promise<string> {
    return transport.captureUntilIdle(runSend, idleMs, maxMs, options);
  }
  async function readConfigListIntoInputs(): Promise<void> {
    if (!isSerialConnected()) return;
    const readCfgBtn = document.getElementById('serial-read-config') as HTMLButtonElement | null;
    if (readCfgBtn) readCfgBtn.disabled = true;
    statusLine.textContent = '正在读取参数…';
    try {
      const raw = await captureUntilIdle(() => sendLine('config --list'), 28, 1000);
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
    notifyUserCommand();
    void (async () => {
      // Do not interleave terminal input with a captured command response: the
      // additional device output would otherwise corrupt the parser's buffer.
      await transport.waitForCapture();
      await sendRaw(data);
    })().catch(() => {
      // A disconnect while the input is queued is handled by SerialTransport.
    });
  });

  connectBtn.addEventListener('click', async () => {
    if (!navigator.serial) return;
    try {
      await transport.stop();
      setConnected(false);
      const baudRate = baudHidden ? Number(baudHidden.value) || 115200 : 115200;
      await transport.connect(baudRate);
      setConnected(true);
      term.focus();
      term.writeln('');
      term.writeln('\x1b[90m── 已打开串口 ──\x1b[0m');
      term.writeln('');
      window.setTimeout(() => {
        if (isSerialConnected()) void sendRaw(POST_CONNECT_KEY_SEQ);
      }, POST_CONNECT_KEY_DELAY_MS);
    } catch (e) {
      if ((e as Error).name === 'NotFoundError') {
        statusLine.textContent = '未选择串口，已取消。';
      } else {
        const message = (e as Error).message ?? String(e);
        statusLine.textContent = `连接失败：${message}`;
      }
      await transport.stop();
      setConnected(false);
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    await transport.stop();
    setConnected(false);
    term.writeln('');
    term.writeln('\x1b[90m── 串口已断开 ──\x1b[0m');
    term.writeln('');
  });
  function wireSend(selector: string, line: string) {
    document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      el.addEventListener('click', () => {
        if (!isSerialConnected()) {
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
  document.querySelectorAll<HTMLElement>('[data-serial-cmd="status"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!isSerialConnected()) {
        statusLine.textContent = '请先连接串口后再发送命令。';
        return;
      }
      void (async () => {
        try {
          const raw = await captureUntilIdle(() => sendLine('status'));
          if (driveBinding) {
            driveBinding.onStatusRaw(raw);
          } else {
            const st = parseStatusCommandDriveState(raw);
            if (st) setDriveStateUi(st);
          }
        } catch {
          /* Output is still written by the transport read stream. */
        }
        term.focus();
      })();
    });
  });

  document.getElementById('serial-cmd-enable')?.addEventListener('click', () => {
    if (!isSerialConnected()) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    const enableBtn = document.getElementById('serial-cmd-enable') as HTMLButtonElement | null;
    void (async () => {
      if (enableBtn) enableBtn.disabled = true;
      try {
        const raw = await captureUntilIdle(() => sendLine('enable'));
        const plain = stripAnsi(raw).replace(/\0/g, '');
        if (driveBinding) {
          driveBinding.onMainEnableCapture?.(plain);
        } else if (!/failed/i.test(plain)) {
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
    if (!isSerialConnected()) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    void sendLine('disable');
    if (driveBinding) {
      driveBinding.onMainDisable?.();
    } else {
      setDriveStateUi('off');
    }
    term.focus();
  });
  document.querySelectorAll<HTMLElement>('[data-serial-cmd="reboot"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!isSerialConnected()) {
        statusLine.textContent = '请先连接串口后再发送命令。';
        return;
      }
      void sendLine('reboot');
      if (driveBinding) {
        driveBinding.onConnectedUnknown();
      } else {
        setDriveStateUi('unknown');
      }
      term.focus();
    });
  });

  serialConfirmController = createSerialConfirmController({
    inertRoot: serialShellInertRoot,
    isConnected: isSerialConnected,
    sendLine,
    focusTerminal: () => term.focus(),
    onRestoreConfirmed: readConfigListIntoInputs,
    onUpgradeConfirmed: async () => {
      await sleep(250);
      await transport.stop();
      setConnected(false);
      term.writeln('');
      term.writeln('\x1b[90m── 已进入固件升级流程，串口已释放 ──\x1b[0m');
      term.writeln('');
      dfuUpdateController.open();
    },
  });
  const SERIAL_YN_WAIT_STATUS: Record<SerialYnSource, string> = {
    calibrate: '校准已发送，正在等待设备…',
    store: '储存已发送，正在等待设备…',
    restore: '恢复默认已发送，正在等待设备…',
    upgrade: '升级固件已发送，正在等待设备…',
  };
  const SERIAL_YN_COMMAND: Record<SerialYnSource, string> = {
    calibrate: 'calibrate',
    store: 'store',
    restore: 'restore',
    upgrade: 'upgrade',
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
    if (source === 'upgrade') return 'upgrade_yn';
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
    serialConfirmController?.open(ynDialogKindForSource(source));
  };

  function canStartSerialYnFlow(): boolean {
    if (!isSerialConnected()) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return false;
    }
    if (serialConfirmController?.isOpen()) {
      statusLine.textContent = '请先关闭当前确认框。';
      return false;
    }
    if (serialYnListener || serialYnSendPending) {
      statusLine.textContent = '正在等待设备响应，请稍候。';
      return false;
    }
    return true;
  }

  async function sendSerialYnCommand(source: SerialYnSource): Promise<void> {
    // User commands must yield to an in-progress capture. Arm the confirmation
    // listener only after that wait, immediately before writing the command, so
    // its timeout covers the device response instead of time spent in the queue.
    serialYnSendPending = true;
    const requestedConnectionGeneration = connectionGeneration;
    try {
      notifyUserCommand();
      await transport.waitForCapture();
      if (!isSerialConnected() || requestedConnectionGeneration !== connectionGeneration) {
        statusLine.textContent = '串口已断开，请重新连接后再发送命令。';
        return;
      }

      startSerialYnListener(source);
      serialYnSendPending = false;
      await transport.sendLine(SERIAL_YN_COMMAND[source]);
    } catch {
      stopSerialYnListener();
      statusLine.textContent = '命令发送失败，请重试。';
    } finally {
      serialYnSendPending = false;
    }
  }

  document.querySelectorAll<HTMLElement>('[data-serial-cmd="store"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!canStartSerialYnFlow()) return;
      void sendSerialYnCommand('store');
      term.focus();
    });
  });
  document.querySelectorAll<HTMLElement>('[data-serial-cmd="restore"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!canStartSerialYnFlow()) return;
      void sendSerialYnCommand('restore');
      term.focus();
    });
  });

  document.querySelectorAll<HTMLElement>('[data-serial-cmd="calibrate"]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!canStartSerialYnFlow()) return;
      void sendSerialYnCommand('calibrate');
      term.focus();
    });
  });
  document.querySelectorAll<HTMLElement>('[data-serial-cmd="upgrade"]').forEach((el) => {
    el.addEventListener('click', () => {
      // 未通过串口进入 Bootloader 时，也允许用户在已手动进入 DFU 模式后直接升级。
      if (!isSerialConnected()) {
        dfuUpdateController.open();
        return;
      }
      if (!canStartSerialYnFlow()) return;
      void sendSerialYnCommand('upgrade');
      term.focus();
    });
  });

  options.controls.attachCtrlSend({
    ctrlModeHidden,
    isSerialConnected: () => isSerialConnected(),
    sendLine,
    setStatus: (text) => {
      statusLine.textContent = text;
    },
    focusTerminal: (focusTerminalAfter = true) => {
      if (focusTerminalAfter) term.focus();
    },
  });

  wireSend('[data-serial-cmd="set-zero-pos"]', 'config zero_pos');
  wireSend('[data-serial-cmd="reset-imu"]', 'config zero_pos --imu');

  const pidConfigSendGapMs = 50;

  const configPanel = document.getElementById('serial-config-panel');
  const configApplyAllBtn = document.getElementById('serial-config-apply') as HTMLButtonElement | null;

  function sendSingleConfigInput(input: HTMLInputElement): void {
    if (!isSerialConnected()) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    const [entry] = collectConfigEntries([input]);
    if (!entry) {
      statusLine.textContent = '请填写参数值后再设置。';
      return;
    }
    void (async () => {
      await sendLine(`config ${entry.key} ${entry.val}`);
      statusLine.textContent = '已连接。';
    })();
  }

  configPanel?.querySelectorAll<HTMLInputElement>('[data-config-key]').forEach((input) => {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      sendSingleConfigInput(input);
    });
  });

  configApplyAllBtn?.addEventListener('click', () => {
    if (!isSerialConnected()) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    const inputs = configPanel?.querySelectorAll<HTMLInputElement>('[data-config-key]') ?? [];
    void (async () => {
      const entries = collectConfigEntries(inputs);
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
  const deviceInfoExtraDl = document.getElementById(options.deviceInfoExtraDlId) as HTMLDListElement | null;

  readDeviceBtn?.addEventListener('click', () => {
    if (!isSerialConnected()) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    if (!deviceInfoPanel || !deviceInfoVersionDl || !deviceInfoExtraDl) return;

    void (async () => {
      readDeviceBtn.disabled = true;
      deviceInfoPanel.hidden = false;
      renderDeviceRows(deviceInfoVersionDl, [], '读取中…');
      renderDeviceRows(deviceInfoExtraDl, [], '读取中…');
      statusLine.textContent = '正在读取 version / info…';
      try {
        const rawVersion = await captureUntilIdle(() => sendLine('version'));
        const rawInfo = await captureUntilIdle(() => sendLine('info'));
        const vRows = parseDeviceBlock(rawVersion, 'version');
        const iRows = parseDeviceBlock(rawInfo, 'info');
        renderDeviceRows(deviceInfoVersionDl, vRows, rawVersion);
        renderDeviceRows(deviceInfoExtraDl, iRows, rawInfo);
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
    if (!isSerialConnected()) {
      statusLine.textContent = '请先连接串口后再发送命令。';
      return;
    }
    void readConfigListIntoInputs();
  });

  options.afterSerialReady?.({
    sendLine,
    sendPollingLine,
    captureUntilIdle,
    isSerialConnected: () => isSerialConnected(),
    setStatusLine: (text) => {
      statusLine.textContent = text;
    },
    focusTerminal: () => {
      term.focus();
    },
    subscribeToUserCommands: (listener) => {
      userCommandListeners.add(listener);
      return () => userCommandListeners.delete(listener);
    },
    setTerminalInputEnabled: (enabled) => {
      term.options.disableStdin = !enabled;
    },
  });
}
