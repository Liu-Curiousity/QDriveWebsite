import { registerSerialDropdownOutsideClose, wireSerialDropdown } from './serial-dropdown.ts';

type Direction = 'rx' | 'tx';
type DisplayMode = 'text' | 'hex';
type SendMode = 'text' | 'hex';
type ChecksumMode = 'none' | 'parity' | 'xor' | 'sum' | 'crc8-atm';

type SerialFrame = {
  direction: Direction;
  at: Date;
  bytes: Uint8Array;
  text: string;
};

type StoredSettings = {
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  flowControl?: string;
  lineEnding?: string;
  checksum?: ChecksumMode;
  displayMode?: DisplayMode;
  sendMode?: SendMode;
  timestamp?: boolean;
  localEcho?: boolean;
  showReceive?: boolean;
  cycleEnabled?: boolean;
  cycleInterval?: number;
  cycleCount?: number;
  quickCommands?: string[];
};

const SETTINGS_KEY = 'qdrive.serial-assistant.settings.v1';
const MAX_FRAMES = 5000;
const encoder = new TextEncoder();

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing serial assistant element: ${id}`);
  return element as T;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function serialPortLabel(port: SerialPort): string | null {
  const namedPort = port as SerialPort & Record<string, unknown> & { getName?: () => unknown };
  const info = port.getInfo() as SerialPortInfo & Record<string, unknown>;
  let reportedName: unknown;
  try { reportedName = namedPort.getName?.(); } catch { /* non-standard API may throw */ }
  const candidates = [
    reportedName,
    namedPort.displayName,
    namedPort.productName,
    namedPort.portName,
    namedPort.path,
    namedPort.name,
    info.displayName,
    info.productName,
    info.portName,
    info.path,
    info.name,
  ];
  const label = candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
  return typeof label === 'string' ? label.trim() : null;
}

function readableText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (char) => {
      const code = char.charCodeAt(0);
      return code === 0 ? '␀' : `\\x${code.toString(16).padStart(2, '0').toUpperCase()}`;
    });
}

function parseHex(value: string): Uint8Array {
  const groups = value.trim().split(/\s+/).filter(Boolean);
  if (!groups.length) return new Uint8Array();
  if (groups.some((group) => !/^[0-9a-f]+$/i.test(group))) throw new Error('HEX 数据只能包含 0–9、A–F 和空格。');
  const byteValues: number[] = [];
  for (const group of groups) {
    let index = 0;
    while (index + 1 < group.length) {
      byteValues.push(Number.parseInt(group.slice(index, index + 2), 16));
      index += 2;
    }
    if (index < group.length) byteValues.push(Number.parseInt(`0${group[index]}`, 16));
  }
  return Uint8Array.from(byteValues);
}

function checksumByte(bytes: Uint8Array, mode: ChecksumMode): number | null {
  if (mode === 'none') return null;
  if (mode === 'parity') {
    let ones = 0;
    for (const byte of bytes) {
      let value = byte;
      while (value > 0) {
        ones += value & 1;
        value >>= 1;
      }
    }
    return ones % 2 === 1 ? 0x01 : 0x00;
  }
  if (mode === 'xor') return bytes.reduce((result, byte) => result ^ byte, 0);
  if (mode === 'sum') return bytes.reduce((result, byte) => (result + byte) & 0xff, 0);

  // CRC-8/ATM: poly 0x07, init 0x00, refin/refout false, xorout 0x00.
  let crc = 0x00;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function appendChecksum(bytes: Uint8Array, mode: ChecksumMode): Uint8Array {
  if (!bytes.length) return bytes;
  const checksum = checksumByte(bytes, mode);
  if (checksum === null) return bytes;
  const frame = new Uint8Array(bytes.length + 1);
  frame.set(bytes);
  frame[bytes.length] = checksum;
  return frame;
}

function lineEnding(value: string): string {
  if (value === 'crlf') return '\r\n';
  if (value === 'lf') return '\n';
  if (value === 'cr') return '\r';
  return '';
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotFoundError') return '已取消选择串口。';
  if (error instanceof DOMException && error.name === 'InvalidStateError') return '串口正在被占用，请关闭其他串口软件后重试。';
  if (error instanceof Error && error.message) return error.message;
  return '操作失败，请检查设备连接后重试。';
}

function safeLoadSettings(): StoredSettings {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as StoredSettings;
  } catch {
    return {};
  }
}

export function bootSerialAssistant(): void {
  const noApiEl = byId<HTMLDivElement>('serial-no-api');
  const stateEl = byId<HTMLSpanElement>('serial-state');
  const stateTextEl = stateEl.querySelector('b') as HTMLElement;
  const statusEl = byId<HTMLParagraphElement>('serial-status');
  const connectEl = byId<HTMLButtonElement>('serial-connect');
  const disconnectEl = byId<HTMLButtonElement>('serial-disconnect');
  const baudEl = byId<HTMLInputElement>('serial-baud');
  const dataBitsEl = byId<HTMLInputElement>('serial-data-bits');
  const stopBitsEl = byId<HTMLInputElement>('serial-stop-bits');
  const parityEl = byId<HTMLInputElement>('serial-parity');
  const flowControlEl = byId<HTMLInputElement>('serial-flow-control');
  const dtrEl = byId<HTMLInputElement>('serial-dtr');
  const rtsEl = byId<HTMLInputElement>('serial-rts');
  const logEl = byId<HTMLDivElement>('serial-log');
  const emptyEl = byId<HTMLDivElement>('serial-empty');
  const exportEl = byId<HTMLButtonElement>('serial-export');
  const clearEl = byId<HTMLButtonElement>('serial-clear');
  const displayModeToggleEl = byId<HTMLButtonElement>('serial-display-mode-toggle');
  const timestampEl = byId<HTMLButtonElement>('serial-timestamp');
  const localEchoEl = byId<HTMLButtonElement>('serial-local-echo');
  const showReceiveEl = byId<HTMLButtonElement>('serial-show-receive');
  const formEl = byId<HTMLFormElement>('serial-send-form');
  const sendInputEl = byId<HTMLTextAreaElement>('serial-send-input');
  const sendInputClearEl = byId<HTMLButtonElement>('serial-send-input-clear');
  const sendModeToggleEl = byId<HTMLButtonElement>('serial-send-mode-toggle');
  const fileInputEl = byId<HTMLInputElement>('serial-file-input');
  const fileSendEl = byId<HTMLButtonElement>('serial-file-send');
  const lineEndingEl = byId<HTMLInputElement>('serial-line-ending');
  const lineEndingRootEl = byId<HTMLElement>('serial-line-ending-dd');
  const checksumEl = byId<HTMLInputElement>('serial-checksum');
  const checksumRootEl = byId<HTMLElement>('serial-checksum-dd');
  const checksumLabelEl = checksumRootEl.querySelector<HTMLElement>('.serial-dd-trigger-label') as HTMLElement;
  const checksumTriggerEl = checksumRootEl.querySelector<HTMLButtonElement>('.serial-dd-trigger') as HTMLButtonElement;
  const cycleEnabledEl = byId<HTMLInputElement>('serial-cycle-enabled');
  const cycleIntervalEl = byId<HTMLInputElement>('serial-cycle-interval');
  const cycleCountEl = byId<HTMLInputElement>('serial-cycle-count');
  const sendEl = byId<HTMLButtonElement>('serial-send');
  const sendControlEl = byId<HTMLElement>('serial-send-control');
  const sendToggleEl = byId<HTMLButtonElement>('serial-send-toggle');
  const sendMenuEl = byId<HTMLElement>('serial-send-menu');
  const sendMethodEl = byId<HTMLButtonElement>('serial-send-method');
  const sendLabelEl = byId<HTMLElement>('serial-send-label');
  const quickListEl = byId<HTMLDivElement>('serial-quick-list');
  const configEls: HTMLInputElement[] = [baudEl, dataBitsEl, stopBitsEl, parityEl, flowControlEl];

  let port: SerialPort | null = null;
  let lastPort: SerialPort | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let closing = false;
  let displayMode: DisplayMode = 'text';
  let sendMode: SendMode = 'text';
  let frames: SerialFrame[] = [];
  let cycleTimer: number | null = null;
  let cycleRunning = false;
  let cycleSent = 0;
  let cycleTotal = 0;
  let fileSending = false;
  let history: string[] = [];
  let historyIndex = 0;
  let writeChain: Promise<void> = Promise.resolve();
  let receiveDecoder = new TextDecoder();

  const quickInputs = Array.from(quickListEl.querySelectorAll<HTMLInputElement>('input'));
  const quickButtons = Array.from(quickListEl.querySelectorAll<HTMLButtonElement>('button'));

  const connected = () => writer !== null && port !== null;
  const togglePressed = (button: HTMLButtonElement) => button.getAttribute('aria-pressed') === 'true';
  const setTogglePressed = (button: HTMLButtonElement, pressed: boolean) => button.setAttribute('aria-pressed', String(pressed));

  function syncOptionToggleHint(button: HTMLButtonElement, enabled: boolean, label: string): void {
    const action = enabled ? '隐藏' : '显示';
    button.dataset.tooltip = `${action}${label}`;
    button.setAttribute('aria-label', `${label}：${enabled ? '已显示' : '已隐藏'}，点击${action}`);
  }

  function wireThemedTooltips(): void {
    const tooltip = document.createElement('div');
    tooltip.className = 'serial-assistant-tooltip';
    tooltip.id = 'serial-assistant-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    document.body.append(tooltip);

    let activeTarget: HTMLElement | null = null;
    let showTimer: number | null = null;

    const tooltipText = (target: HTMLElement) => target.dataset.tooltip
      ?? target.getAttribute('aria-label')
      ?? '';

    const positionTooltip = (target: HTMLElement) => {
      const targetRect = target.getBoundingClientRect();
      const tooltipWidth = tooltip.offsetWidth;
      const tooltipHeight = tooltip.offsetHeight;
      const viewportPadding = 10;
      const gap = 9;
      const fitsAbove = targetRect.top >= tooltipHeight + gap + viewportPadding;
      const top = fitsAbove
        ? targetRect.top - tooltipHeight - gap
        : targetRect.bottom + gap;
      const centeredLeft = targetRect.left + targetRect.width / 2 - tooltipWidth / 2;
      const left = Math.min(
        window.innerWidth - tooltipWidth - viewportPadding,
        Math.max(viewportPadding, centeredLeft),
      );
      tooltip.dataset.placement = fitsAbove ? 'top' : 'bottom';
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      tooltip.style.setProperty('--tooltip-anchor-x', `${targetRect.left + targetRect.width / 2 - left}px`);
    };

    const showTooltip = (target: HTMLElement, immediate = false) => {
      const text = tooltipText(target);
      if (!text) return;
      if (showTimer !== null) window.clearTimeout(showTimer);
      const reveal = () => {
        activeTarget = target;
        tooltip.textContent = text;
        tooltip.hidden = false;
        positionTooltip(target);
        requestAnimationFrame(() => tooltip.classList.add('is-visible'));
      };
      if (immediate) {
        showTimer = null;
        reveal();
      } else {
        showTimer = window.setTimeout(reveal, 280);
      }
    };

    const hideTooltip = (target?: HTMLElement) => {
      if (target && activeTarget && target !== activeTarget) return;
      if (showTimer !== null) window.clearTimeout(showTimer);
      showTimer = null;
      activeTarget = null;
      tooltip.classList.remove('is-visible');
      window.setTimeout(() => {
        if (!tooltip.classList.contains('is-visible')) tooltip.hidden = true;
      }, 120);
    };

    document.querySelectorAll<HTMLElement>('.serial-assistant [data-tooltip], .serial-assistant button[aria-label]:not([data-tooltip-disabled])').forEach((target) => {
      target.removeAttribute('title');
      target.setAttribute('aria-describedby', tooltip.id);
      target.addEventListener('pointerenter', () => showTooltip(target));
      target.addEventListener('pointerleave', () => hideTooltip(target));
      target.addEventListener('focus', () => showTooltip(target));
      target.addEventListener('blur', () => hideTooltip(target));
      target.addEventListener('serial-assistant-show-tooltip', () => showTooltip(target, true));
      target.addEventListener('serial-assistant-hide-tooltip', () => hideTooltip(target));
    });
    window.addEventListener('scroll', () => hideTooltip(), true);
    window.addEventListener('resize', () => hideTooltip());
  }

  function setStatus(message: string): void {
    statusEl.textContent = message;
  }

  const cycleIntervalError = () => {
    const value = Number(cycleIntervalEl.value);
    return Number.isFinite(value) && value >= 20 && value <= 86400000
      ? ''
      : '循环间隔需为 20–86400000 ms。';
  };

  const cycleCountError = () => {
    const value = Number(cycleCountEl.value);
    return Number.isInteger(value) && (value === -1 || (value >= 1 && value <= 100000))
      ? ''
      : '发送次数需为 -1（无限）或 1–100000 次的整数。';
  };

  function syncCycleFieldTooltips(): void {
    const intervalError = cycleIntervalError();
    const countError = cycleCountError();
    cycleIntervalEl.dataset.tooltip = intervalError;
    cycleCountEl.dataset.tooltip = countError || '-1 表示无限发送';
    sendEl.dataset.tooltip = '';
    sendEl.dispatchEvent(new Event('serial-assistant-hide-tooltip'));
    if (!intervalError) cycleIntervalEl.dispatchEvent(new Event('serial-assistant-hide-tooltip'));
    if (!countError) cycleCountEl.dispatchEvent(new Event('serial-assistant-hide-tooltip'));
  }

  function showCycleFieldError(input: HTMLInputElement, message: string): void {
    input.dataset.tooltip = message;
    setStatus('循环发送设置有误。');
    const tooltipTarget = sendMenuEl.hidden ? sendEl : input;
    tooltipTarget.dataset.tooltip = message;
    tooltipTarget.dispatchEvent(new Event('serial-assistant-show-tooltip'));
  }

  function setControlDisabled(element: HTMLInputElement, disabled: boolean): void {
    element.disabled = disabled;
    element
      .closest('.serial-dd')
      ?.querySelector<HTMLButtonElement>('.serial-dd-trigger')
      ?.toggleAttribute('disabled', disabled);
  }

  function wireDropdown(rootId: string, valueElement: HTMLInputElement): void {
    const root = byId<HTMLElement>(rootId);
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const syncLabel = () => {
      const selected = items.find((item) => item.dataset.value === valueElement.value);
      const label = root.querySelector<HTMLElement>('.serial-dd-trigger-label');
      if (selected && label) label.textContent = selected.textContent?.trim() ?? valueElement.value;
      items.forEach((item) => item.setAttribute('aria-selected', String(item === selected)));
    };
    wireSerialDropdown(root, (value) => {
      valueElement.value = value;
      syncLabel();
      valueElement.dispatchEvent(new Event('change', { bubbles: true }));
    });
    valueElement.addEventListener('input', syncLabel);
    syncLabel();
  }

  function setConnectionState(state: 'disconnected' | 'connecting' | 'connected'): void {
    stateEl.dataset.state = state;
    stateTextEl.textContent = state === 'connected' ? '已连接' : state === 'connecting' ? '连接中' : '未连接';
    const isConnected = state === 'connected';
    const isBusy = state === 'connecting';
    connectEl.disabled = isConnected || isBusy || !('serial' in navigator);
    disconnectEl.textContent = isConnected ? '断开' : lastPort ? '重连' : '断开';
    disconnectEl.disabled = isBusy || (!isConnected && !lastPort) || !('serial' in navigator);
    sendEl.disabled = !isConnected;
    sendToggleEl.disabled = !isConnected;
    fileSendEl.disabled = !isConnected || fileSending;
    dtrEl.disabled = !isConnected;
    rtsEl.disabled = !isConnected;
    configEls.forEach((element) => { setControlDisabled(element, isConnected || isBusy); });
    quickButtons.forEach((button) => { button.disabled = !isConnected; });
    if (!isConnected) {
      setSendMenu(false);
      stopCycle();
    }
  }

  function selectedChecksumMode(): ChecksumMode {
    return ['none', 'parity', 'xor', 'sum', 'crc8-atm'].includes(checksumEl.value)
      ? checksumEl.value as ChecksumMode
      : 'none';
  }

  function updateChecksumPreview(): void {
    const mode = selectedChecksumMode();
    const selected = checksumRootEl.querySelector<HTMLButtonElement>(`.serial-dd-item[data-value="${mode}"]`);
    const baseLabel = selected?.textContent?.trim() ?? '无校验';
    checksumLabelEl.textContent = baseLabel;
    delete checksumTriggerEl.dataset.tooltip;
    if (sendMode !== 'hex' || mode === 'none') return;
    try {
      const bytes = parseHex(sendInputEl.value);
      if (!bytes.length) return;
      const checksum = checksumByte(bytes, mode);
      if (checksum !== null) checksumLabelEl.textContent = `${baseLabel}(0x${checksum.toString(16).padStart(2, '0').toUpperCase()})`;
    } catch (error) {
      checksumTriggerEl.dataset.tooltip = errorMessage(error);
    }
  }

  function syncSendModeUi(): void {
    const hex = sendMode === 'hex';
    lineEndingRootEl.hidden = hex;
    checksumRootEl.hidden = !hex;
    sendInputEl.placeholder = hex
      ? '输入十六进制字节，例如 AA 01 0D 0A；Ctrl / ⌘ + Enter 发送'
      : '输入要发送的文本；Ctrl / ⌘ + Enter 发送';
    updateChecksumPreview();
  }

  function syncModeToggleUi(button: HTMLButtonElement, mode: DisplayMode | SendMode, label: string): void {
    const current = mode === 'hex' ? 'Hex' : 'Abc';
    const next = mode === 'hex' ? 'Abc' : 'Hex';
    const text = button.querySelector('span');
    if (text) text.textContent = current;
    button.dataset.mode = mode;
    const hint = `${label}：${current}，点击切换为 ${next}`;
    button.setAttribute('aria-label', hint);
    button.dataset.tooltip = hint;
  }

  function syncFormatModeUi(): void {
    syncModeToggleUi(displayModeToggleEl, displayMode, '接收显示格式');
    syncModeToggleUi(sendModeToggleEl, sendMode, '发送数据格式');
  }

  function syncSendInputUi(): void {
    sendInputClearEl.disabled = sendInputEl.value.length === 0;
  }

  function insertHexText(value: string): void {
    const filtered = value.replace(/[^0-9a-f\s]/gi, '').replace(/\s/g, ' ').toUpperCase();
    if (!filtered) return;
    const start = sendInputEl.selectionStart;
    const end = sendInputEl.selectionEnd;
    sendInputEl.setRangeText(filtered, start, end, 'end');
    sendInputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function sanitizeHexInput(): void {
    if (sendMode !== 'hex') return;
    const normalized = sendInputEl.value.replace(/[^0-9a-f\s]/gi, '').replace(/\s/g, ' ').toUpperCase();
    if (normalized === sendInputEl.value) return;
    const selection = sendInputEl.selectionStart;
    const validBeforeSelection = sendInputEl.value.slice(0, selection).replace(/[^0-9a-f\s]/gi, '').length;
    sendInputEl.value = normalized;
    sendInputEl.setSelectionRange(validBeforeSelection, validBeforeSelection);
  }

  function formatHexInput(): void {
    sendInputEl.value = bytesToHex(parseHex(sendInputEl.value));
    sendInputEl.setSelectionRange(sendInputEl.value.length, sendInputEl.value.length);
    updateChecksumPreview();
    syncSendInputUi();
  }

  function saveSettings(): void {
    const settings: StoredSettings = {
      baudRate: Number(baudEl.value),
      dataBits: Number(dataBitsEl.value),
      stopBits: Number(stopBitsEl.value),
      parity: parityEl.value,
      flowControl: flowControlEl.value,
      lineEnding: lineEndingEl.value,
      checksum: selectedChecksumMode(),
      displayMode,
      sendMode,
      timestamp: togglePressed(timestampEl),
      localEcho: togglePressed(localEchoEl),
      showReceive: togglePressed(showReceiveEl),
      cycleEnabled: cycleEnabledEl.checked,
      cycleInterval: Number(cycleIntervalEl.value),
      cycleCount: Number(cycleCountEl.value),
      quickCommands: quickInputs.map((input) => input.value),
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage may be disabled */ }
  }

  function applySettings(): void {
    const settings = safeLoadSettings();
    if (settings.baudRate && settings.baudRate > 0) baudEl.value = String(settings.baudRate);
    if (settings.dataBits === 7 || settings.dataBits === 8) dataBitsEl.value = String(settings.dataBits);
    if (settings.stopBits === 1 || settings.stopBits === 2) stopBitsEl.value = String(settings.stopBits);
    if (['none', 'even', 'odd'].includes(settings.parity ?? '')) parityEl.value = settings.parity!;
    if (['none', 'hardware'].includes(settings.flowControl ?? '')) flowControlEl.value = settings.flowControl!;
    if (['none', 'crlf', 'lf', 'cr'].includes(settings.lineEnding ?? '')) lineEndingEl.value = settings.lineEnding!;
    if (['none', 'parity', 'xor', 'sum', 'crc8-atm'].includes(settings.checksum ?? '')) checksumEl.value = settings.checksum!;
    displayMode = settings.displayMode === 'hex' ? 'hex' : 'text';
    sendMode = settings.sendMode === 'hex' ? 'hex' : 'text';
    setTogglePressed(timestampEl, settings.timestamp ?? true);
    setTogglePressed(localEchoEl, settings.localEcho ?? true);
    setTogglePressed(showReceiveEl, settings.showReceive ?? true);
    syncOptionToggleHint(timestampEl, togglePressed(timestampEl), '时间戳');
    syncOptionToggleHint(localEchoEl, togglePressed(localEchoEl), '发送数据');
    syncOptionToggleHint(showReceiveEl, togglePressed(showReceiveEl), '接收数据');
    cycleEnabledEl.checked = settings.cycleEnabled ?? false;
    if (settings.cycleInterval && settings.cycleInterval >= 20) cycleIntervalEl.value = String(settings.cycleInterval);
    if (settings.cycleCount === -1 || (settings.cycleCount && settings.cycleCount >= 1)) cycleCountEl.value = String(settings.cycleCount);
    settings.quickCommands?.slice(0, quickInputs.length).forEach((value, index) => { quickInputs[index].value = value; });
    syncFormatModeUi();
  }

  function frameText(frame: SerialFrame): string {
    return displayMode === 'hex' ? bytesToHex(frame.bytes) : readableText(frame.text);
  }

  function createFrameElement(frame: SerialFrame): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'serial-assistant-log-line';
    row.dataset.direction = frame.direction;
    const time = document.createElement('time');
    time.dateTime = frame.at.toISOString();
    time.hidden = !togglePressed(timestampEl);
    time.textContent = frame.at.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const direction = document.createElement('span');
    direction.className = 'serial-assistant-log-direction';
    direction.textContent = frame.direction.toUpperCase();
    const data = document.createElement('span');
    data.className = 'serial-assistant-log-data';
    data.textContent = frameText(frame) || '(空数据)';
    row.append(time, direction, data);
    return row;
  }

  function visibleFrames(): SerialFrame[] {
    return frames.filter((frame) => (
      (frame.direction === 'tx' && togglePressed(localEchoEl))
      || (frame.direction === 'rx' && togglePressed(showReceiveEl))
    ));
  }

  function syncEmpty(): void {
    emptyEl.hidden = visibleFrames().length > 0;
  }

  function isLogAtBottom(): boolean {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= 4;
  }

  function scrollToBottom(): void {
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderFrames(): void {
    const followOutput = isLogAtBottom();
    const previousScrollTop = logEl.scrollTop;
    logEl.querySelectorAll('.serial-assistant-log-line').forEach((element) => element.remove());
    const fragment = document.createDocumentFragment();
    visibleFrames().forEach((frame) => fragment.append(createFrameElement(frame)));
    logEl.append(fragment);
    syncEmpty();
    if (followOutput) scrollToBottom();
    else logEl.scrollTop = previousScrollTop;
  }

  function addFrame(direction: Direction, bytes: Uint8Array, text?: string): void {
    const followOutput = isLogAtBottom();
    const frame: SerialFrame = {
      direction,
      at: new Date(),
      bytes: bytes.slice(),
      text: text ?? new TextDecoder().decode(bytes),
    };
    frames.push(frame);
    if (frames.length > MAX_FRAMES) frames = frames.slice(-MAX_FRAMES);
    if ((direction === 'tx' && !togglePressed(localEchoEl)) || (direction === 'rx' && !togglePressed(showReceiveEl))) {
      syncEmpty();
      return;
    }
    logEl.append(createFrameElement(frame));
    while (logEl.querySelectorAll('.serial-assistant-log-line').length > MAX_FRAMES) {
      logEl.querySelector('.serial-assistant-log-line')?.remove();
    }
    syncEmpty();
    if (followOutput) scrollToBottom();
  }

  async function updateSignals(): Promise<void> {
    if (!port) return;
    try {
      const signals = await port.getSignals();
      const values: Record<string, boolean> = {
        cts: signals.clearToSend,
        dsr: signals.dataSetReady,
        dcd: signals.dataCarrierDetect,
        ri: signals.ringIndicator,
      };
      Object.entries(values).forEach(([name, active]) => {
        const element = document.querySelector<HTMLElement>(`[data-signal="${name}"]`);
        if (element) element.dataset.active = String(active);
      });
    } catch (error) {
      setStatus(`读取线路信号失败：${errorMessage(error)}`);
    }
  }

  async function setOutputSignals(): Promise<void> {
    if (!port) return;
    try {
      await port.setSignals({ dataTerminalReady: dtrEl.checked, requestToSend: rtsEl.checked });
      setStatus(`线路信号已更新：DTR ${dtrEl.checked ? 'ON' : 'OFF'}，RTS ${rtsEl.checked ? 'ON' : 'OFF'}。`);
    } catch (error) {
      setStatus(`设置线路信号失败：${errorMessage(error)}`);
    }
  }

  async function readFromPort(activePort: SerialPort): Promise<void> {
    if (!activePort.readable) return;
    reader = activePort.readable.getReader();
    try {
      while (port === activePort) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          addFrame('rx', value, receiveDecoder.decode(value, { stream: true }));
        }
      }
    } catch (error) {
      if (!closing && port === activePort) setStatus(`串口读取中断：${errorMessage(error)}`);
    } finally {
      try { reader?.releaseLock(); } catch { /* already released */ }
      reader = null;
      if (!closing && port === activePort) await disconnect('设备已断开。');
    }
  }

  function validatedBaudRate(): number | null {
    const baudRate = Number(baudEl.value);
    if (!Number.isInteger(baudRate) || baudRate <= 0 || baudRate > 12000000) {
      setStatus('请输入 1–12000000 之间的有效波特率。');
      baudEl.focus();
      return null;
    }
    return baudRate;
  }

  async function openSelectedPort(selected: SerialPort, baudRate: number): Promise<void> {
    await selected.open({
      baudRate,
      dataBits: Number(dataBitsEl.value) as 7 | 8,
      stopBits: Number(stopBitsEl.value) as 1 | 2,
      parity: parityEl.value as 'none' | 'even' | 'odd',
      flowControl: flowControlEl.value as 'none' | 'hardware',
      bufferSize: 65536,
    });
    if (!selected.readable || !selected.writable) throw new Error('串口数据流不可用。');
    port = selected;
    lastPort = selected;
    writer = selected.writable.getWriter();
    receiveDecoder = new TextDecoder();
    closing = false;
    setConnectionState('connected');
    const deviceName = serialPortLabel(selected);
    setStatus(deviceName ? `连接成功：${deviceName}` : '连接成功。');
    saveSettings();
    void readFromPort(selected);
    await updateSignals();
    sendInputEl.focus();
  }

  async function connect(): Promise<void> {
    if (!('serial' in navigator)) return;
    const baudRate = validatedBaudRate();
    if (baudRate === null) return;
    setConnectionState('connecting');
    setStatus('请选择要连接的串口…');
    let selected: SerialPort | null = null;
    try {
      selected = await navigator.serial.requestPort();
      await openSelectedPort(selected, baudRate);
    } catch (error) {
      setStatus(errorMessage(error));
      if (port) await disconnect();
      else {
        try { await selected?.close(); } catch { /* port may not have opened */ }
        setConnectionState('disconnected');
      }
    }
  }

  async function reconnect(): Promise<void> {
    if (!lastPort || connected()) return;
    const baudRate = validatedBaudRate();
    if (baudRate === null) return;
    const selected = lastPort;
    setConnectionState('connecting');
    setStatus('正在重新连接…');
    try {
      await openSelectedPort(selected, baudRate);
    } catch (error) {
      try { await selected.close(); } catch { /* port may not have opened */ }
      port = null;
      writer = null;
      setConnectionState('disconnected');
      setStatus(`重连失败：${errorMessage(error)}`);
    }
  }

  async function disconnect(message = '已断开串口。'): Promise<void> {
    if (closing) return;
    closing = true;
    stopCycle();
    const activePort = port;
    port = null;
    try { await reader?.cancel(); } catch { /* ignore */ }
    try { reader?.releaseLock(); } catch { /* ignore */ }
    reader = null;
    try { writer?.releaseLock(); } catch { /* ignore */ }
    writer = null;
    try { if (activePort) await activePort.close(); } catch { /* unplugged ports may already be closed */ }
    writeChain = Promise.resolve();
    closing = false;
    dtrEl.checked = false;
    rtsEl.checked = false;
    document.querySelectorAll<HTMLElement>('[data-signal]').forEach((element) => { element.dataset.active = 'false'; });
    setConnectionState('disconnected');
    setStatus(message);
  }

  function buildPayload(value: string, mode = sendMode): Uint8Array {
    if (mode === 'hex') return appendChecksum(parseHex(value), selectedChecksumMode());
    return encoder.encode(value + lineEnding(lineEndingEl.value));
  }

  async function sendBytes(bytes: Uint8Array, displayText: string): Promise<void> {
    if (!writer || !bytes.length) return;
    const activeWriter = writer;
    // A failed write must not poison later sends after a transient device error.
    writeChain = writeChain.catch(() => undefined).then(async () => {
      if (writer !== activeWriter) return;
      await activeWriter.write(bytes);
      addFrame('tx', bytes, displayText);
    });
    await writeChain;
  }

  async function sendFile(file: File): Promise<void> {
    if (!connected() || !writer) {
      setStatus('请先连接串口。');
      return;
    }
    if (file.size === 0) {
      setStatus('无法发送空文件。');
      return;
    }

    const activeWriter = writer;
    const reader = file.stream().getReader();
    let sent = 0;
    fileSending = true;
    fileSendEl.disabled = true;
    fileSendEl.setAttribute('aria-busy', 'true');
    setStatus(`正在发送文件：${file.name}（0%）`);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        writeChain = writeChain.catch(() => undefined).then(async () => {
          if (writer !== activeWriter) throw new Error('串口连接已断开。');
          await activeWriter.write(value);
        });
        await writeChain;
        sent += value.byteLength;
        setStatus(`正在发送文件：${file.name}（${Math.min(100, Math.round(sent / file.size * 100))}%）`);
      }
      setStatus(`文件发送完成：${file.name}（${file.size} 字节）`);
    } catch (error) {
      setStatus(`文件发送失败：${errorMessage(error)}`);
    } finally {
      try { await reader.cancel(); } catch { /* stream may already be closed */ }
      fileSending = false;
      fileSendEl.disabled = !connected();
      fileSendEl.removeAttribute('aria-busy');
      fileInputEl.value = '';
    }
  }

  async function sendValue(value: string, mode = sendMode, remember = false): Promise<boolean> {
    if (!connected()) {
      setStatus('请先连接串口。');
      return false;
    }
    if (!value && mode === 'text' && lineEndingEl.value === 'none') {
      setStatus('请输入要发送的数据。');
      return false;
    }
    try {
      const bytes = buildPayload(value, mode);
      if (!bytes.length) throw new Error('请输入要发送的数据。');
      await sendBytes(bytes, mode === 'text' ? value + lineEnding(lineEndingEl.value) : new TextDecoder().decode(bytes));
      if (remember && value && history.at(-1) !== value) {
        history.push(value);
        history = history.slice(-50);
        historyIndex = history.length;
      }
      return true;
    } catch (error) {
      const message = errorMessage(error);
      setStatus(error instanceof Error && !error.message.includes('HEX') && !error.message.includes('输入')
        ? `发送失败：${message}`
        : message);
      return false;
    }
  }

  function setSendMenu(open: boolean): void {
    sendMenuEl.hidden = !open;
    sendToggleEl.setAttribute('aria-expanded', String(open));
  }

  function syncCycleUi(): void {
    sendMethodEl.setAttribute('aria-pressed', String(cycleEnabledEl.checked));
    if (!cycleRunning) {
      sendLabelEl.textContent = cycleEnabledEl.checked ? '循环发送' : '发 送';
    }
  }

  function updateCycleProgress(): void {
    sendLabelEl.textContent = `停止循环 ${cycleSent}/${cycleTotal === -1 ? '∞' : cycleTotal}`;
  }

  function stopCycle(message?: string): void {
    if (cycleTimer !== null) window.clearTimeout(cycleTimer);
    cycleTimer = null;
    const wasRunning = cycleRunning;
    cycleRunning = false;
    cycleSent = 0;
    cycleTotal = 0;
    sendControlEl.dataset.running = 'false';
    cycleIntervalEl.disabled = false;
    cycleCountEl.disabled = false;
    sendToggleEl.disabled = !connected();
    syncCycleUi();
    if (wasRunning && message) setStatus(message);
  }

  async function startCycle(): Promise<void> {
    if (!connected()) return;
    const intervalError = cycleIntervalError();
    if (intervalError) {
      showCycleFieldError(cycleIntervalEl, intervalError);
      return;
    }
    const interval = Number(cycleIntervalEl.value);
    const countError = cycleCountError();
    if (countError) {
      showCycleFieldError(cycleCountEl, countError);
      return;
    }
    const count = Number(cycleCountEl.value);
    try {
      buildPayload(sendInputEl.value, sendMode);
    } catch (error) {
      setStatus(errorMessage(error));
      return;
    }
    cycleRunning = true;
    cycleSent = 0;
    cycleTotal = count;
    sendControlEl.dataset.running = 'true';
    cycleIntervalEl.disabled = true;
    cycleCountEl.disabled = true;
    sendToggleEl.disabled = true;
    setSendMenu(false);
    updateCycleProgress();
    saveSettings();

    const sendNext = async () => {
      if (!cycleRunning) return;
      const succeeded = await sendValue(sendInputEl.value, sendMode, cycleSent === 0);
      if (!cycleRunning) return;
      if (!succeeded) {
        stopCycle('循环发送已因错误停止。');
        return;
      }
      cycleSent += 1;
      updateCycleProgress();
      if (cycleTotal !== -1 && cycleSent >= cycleTotal) {
        const completed = cycleTotal;
        stopCycle(`循环发送完成，共发送 ${completed} 次。`);
        return;
      }
      cycleTimer = window.setTimeout(() => { void sendNext(); }, interval);
    };
    await sendNext();
  }

  function exportLog(): void {
    const shownFrames = visibleFrames();
    if (!shownFrames.length) {
      setStatus('当前没有可导出的日志。');
      return;
    }
    const lines = shownFrames.map((frame) => {
      const time = frame.at.toLocaleString('zh-CN', { hour12: false, fractionalSecondDigits: 3 });
      const data = displayMode === 'hex' ? bytesToHex(frame.bytes) : readableText(frame.text);
      return `[${time}] ${frame.direction.toUpperCase()}  ${data}`;
    });
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    link.href = url;
    link.download = `serial-log-${stamp}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus(`已导出 ${shownFrames.length} 条日志。`);
  }

  applySettings();
  wireDropdown('serial-baud-dd', baudEl);
  wireDropdown('serial-data-bits-dd', dataBitsEl);
  wireDropdown('serial-stop-bits-dd', stopBitsEl);
  wireDropdown('serial-parity-dd', parityEl);
  wireDropdown('serial-flow-control-dd', flowControlEl);
  wireDropdown('serial-line-ending-dd', lineEndingEl);
  wireDropdown('serial-checksum-dd', checksumEl);
  registerSerialDropdownOutsideClose();
  syncSendModeUi();
  syncSendInputUi();
  syncCycleUi();
  wireThemedTooltips();
  const supported = 'serial' in navigator;
  noApiEl.hidden = supported;
  setConnectionState('disconnected');
  if (!supported) setStatus('当前浏览器不支持 Web Serial。');

  connectEl.addEventListener('click', () => { void connect(); });
  disconnectEl.addEventListener('click', () => {
    if (connected()) void disconnect();
    else void reconnect();
  });
  dtrEl.addEventListener('change', () => { void setOutputSignals(); });
  rtsEl.addEventListener('change', () => { void setOutputSignals(); });

  displayModeToggleEl.addEventListener('click', () => {
    displayMode = displayMode === 'text' ? 'hex' : 'text';
    syncFormatModeUi();
    renderFrames();
    saveSettings();
  });
  sendModeToggleEl.addEventListener('click', () => {
    if (sendMode === 'text' && !/^[0-9a-f ]*$/i.test(sendInputEl.value)) {
      sendInputEl.value = bytesToHex(encoder.encode(sendInputEl.value));
    } else if (sendMode === 'text') {
      sendInputEl.value = bytesToHex(parseHex(sendInputEl.value));
    }
    sendMode = sendMode === 'text' ? 'hex' : 'text';
    syncFormatModeUi();
    syncSendModeUi();
    syncSendInputUi();
    saveSettings();
  });
  fileSendEl.addEventListener('click', () => {
    if (!connected()) {
      setStatus('请先连接串口。');
      return;
    }
    fileInputEl.click();
  });
  fileInputEl.addEventListener('change', () => {
    const file = fileInputEl.files?.[0];
    if (file) void sendFile(file);
  });

  exportEl.addEventListener('click', exportLog);
  clearEl.addEventListener('click', () => {
    frames = [];
    renderFrames();
    setStatus('显示日志已清空。');
  });
  timestampEl.addEventListener('click', () => {
    setTogglePressed(timestampEl, !togglePressed(timestampEl));
    syncOptionToggleHint(timestampEl, togglePressed(timestampEl), '时间戳');
    logEl.querySelectorAll<HTMLTimeElement>('time').forEach((time) => { time.hidden = !togglePressed(timestampEl); });
    saveSettings();
  });
  localEchoEl.addEventListener('click', () => {
    setTogglePressed(localEchoEl, !togglePressed(localEchoEl));
    syncOptionToggleHint(localEchoEl, togglePressed(localEchoEl), '发送数据');
    renderFrames();
    saveSettings();
  });
  showReceiveEl.addEventListener('click', () => {
    setTogglePressed(showReceiveEl, !togglePressed(showReceiveEl));
    syncOptionToggleHint(showReceiveEl, togglePressed(showReceiveEl), '接收数据');
    renderFrames();
    saveSettings();
  });

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    if (cycleRunning) {
      stopCycle('循环发送已停止。');
    } else if (cycleEnabledEl.checked) {
      void startCycle();
    } else {
      void sendValue(sendInputEl.value, sendMode, true);
    }
  });
  sendInputEl.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const commandKey = event.ctrlKey || event.metaKey;
    const formatShortcut = sendMode === 'hex' && commandKey && (
      (key === 's' && !event.shiftKey && !event.altKey)
      || (key === 'f' && event.shiftKey && !event.altKey)
      || (key === 'l' && !event.shiftKey && event.altKey)
    );
    if (formatShortcut) {
      event.preventDefault();
      formatHexInput();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      formEl.requestSubmit();
      return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !sendInputEl.value.includes('\n') && history.length) {
      event.preventDefault();
      historyIndex = event.key === 'ArrowUp' ? Math.max(0, historyIndex - 1) : Math.min(history.length, historyIndex + 1);
      sendInputEl.value = historyIndex === history.length ? '' : history[historyIndex];
      updateChecksumPreview();
      syncSendInputUi();
    }
  });
  sendInputEl.addEventListener('beforeinput', (event) => {
    if (sendMode !== 'hex' || !event.inputType.startsWith('insert') || event.data === null) return;
    if (/^[0-9a-f ]*$/i.test(event.data)) return;
    event.preventDefault();
    insertHexText(event.data);
  });
  sendInputEl.addEventListener('paste', (event) => {
    if (sendMode !== 'hex') return;
    event.preventDefault();
    insertHexText(event.clipboardData?.getData('text') ?? '');
  });
  sendInputEl.addEventListener('input', () => {
    sanitizeHexInput();
    updateChecksumPreview();
    syncSendInputUi();
  });
  sendInputClearEl.addEventListener('click', () => {
    sendInputEl.value = '';
    updateChecksumPreview();
    syncSendInputUi();
    sendInputEl.focus();
  });
  sendMethodEl.addEventListener('click', () => {
    cycleEnabledEl.checked = !cycleEnabledEl.checked;
    syncCycleUi();
    saveSettings();
  });
  cycleIntervalEl.addEventListener('input', () => {
    syncCycleUi();
    syncCycleFieldTooltips();
  });
  cycleIntervalEl.addEventListener('change', saveSettings);
  cycleCountEl.addEventListener('input', () => {
    syncCycleUi();
    syncCycleFieldTooltips();
  });
  cycleCountEl.addEventListener('change', saveSettings);
  sendToggleEl.addEventListener('click', () => { setSendMenu(sendMenuEl.hidden); });
  document.addEventListener('pointerdown', (event) => {
    if (!sendMenuEl.hidden && !sendControlEl.contains(event.target as Node)) setSendMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !sendMenuEl.hidden) {
      setSendMenu(false);
      sendToggleEl.focus();
    }
  });
  lineEndingEl.addEventListener('change', saveSettings);
  checksumEl.addEventListener('change', () => {
    queueMicrotask(updateChecksumPreview);
    saveSettings();
  });
  configEls.forEach((element) => element.addEventListener('change', saveSettings));
  quickInputs.forEach((input) => input.addEventListener('change', saveSettings));
  quickButtons.forEach((button, index) => button.addEventListener('click', () => { void sendValue(quickInputs[index].value, 'text'); }));

  if ('serial' in navigator) {
    navigator.serial.addEventListener('disconnect', (event) => {
      if (port && event.target === port) void disconnect('设备已从系统断开。');
    });
  }
  window.addEventListener('pagehide', () => { if (port) void disconnect(); });
}
