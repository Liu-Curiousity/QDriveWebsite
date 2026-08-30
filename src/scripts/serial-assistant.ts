import { registerSerialDropdownOutsideClose, wireSerialDropdown } from './serial-dropdown.ts';
import { wireAssistantTooltips } from './assistant-tooltip.ts';

type Direction = 'rx' | 'tx';
type DisplayMode = 'text' | 'hex';
type SendMode = 'text' | 'hex';
type ChecksumMode = 'none' | 'parity' | 'xor' | 'sum' | 'crc8-atm';

type SerialFrame = {
  direction: Direction;
  at: Date;
  lastChunkAtMs: number;
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
  quickModes?: SendMode[];
};

const SETTINGS_KEY = 'qdrive.serial-assistant.settings.v1';
const MAX_FRAMES = 5000;
const MAX_QUICK_COMMANDS = 20;
const encoder = new TextEncoder();

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing serial assistant element: ${id}`);
  return element as T;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left);
  merged.set(right, left.byteLength);
  return merged;
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

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
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
  const composerResizerEl = byId<HTMLDivElement>('serial-composer-resizer');
  const sendInputEl = byId<HTMLTextAreaElement>('serial-send-input');
  const sendInputClearEl = byId<HTMLButtonElement>('serial-send-input-clear');
  const sendModeToggleEl = byId<HTMLButtonElement>('serial-send-mode-toggle');
  const fileInputEl = byId<HTMLInputElement>('serial-file-input');
  const fileSendEl = byId<HTMLButtonElement>('serial-file-send');
  const sendToolsEl = sendModeToggleEl.closest<HTMLDivElement>('.serial-assistant-send-tools') as HTMLDivElement;
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
  const quickAddEl = byId<HTMLButtonElement>('serial-quick-add');
  const quickEmptyEl = byId<HTMLParagraphElement>('serial-quick-empty');
  const configEls: HTMLInputElement[] = [baudEl, dataBitsEl, stopBitsEl, parityEl, flowControlEl];

  let port: SerialPort | null = null;
  let lastPort: SerialPort | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let closing = false;
  let displayMode: DisplayMode = 'text';
  let sendMode: SendMode = 'text';
  let frames: SerialFrame[] = [];
  let pendingRenderedFrames: SerialFrame[] = [];
  let frameRenderId: number | null = null;
  let renderedFrameCount = 0;
  let lastRenderedFrame: SerialFrame | null = null;
  let lastRenderedFrameElement: HTMLDivElement | null = null;
  let lastProcessedFrame: SerialFrame | null = null;
  let cycleTimer: number | null = null;
  let cycleRunning = false;
  let cycleRunId = 0;
  let cycleSent = 0;
  let cycleTotal = 0;
  let fileSending = false;
  let history: string[] = [];
  let historyIndex = 0;
  let writeChain: Promise<void> = Promise.resolve();
  let receiveDecoder = new TextDecoder();
  let wireThemedTooltipTarget: ((target: HTMLElement) => void) | null = null;
  let composerResizePointerId: number | null = null;
  let composerResizeStartY = 0;
  let composerResizeStartHeight = 0;

  const initialQuickRow = quickListEl.querySelector<HTMLElement>('.serial-assistant-quick-row');
  if (!initialQuickRow) throw new Error('Missing quick command row template.');
  const quickRowTemplate = initialQuickRow.cloneNode(true) as HTMLElement;

  const connected = () => writer !== null && port !== null;
  const togglePressed = (button: HTMLButtonElement) => button.getAttribute('aria-pressed') === 'true';
  const setTogglePressed = (button: HTMLButtonElement, pressed: boolean) => button.setAttribute('aria-pressed', String(pressed));

  function composerInputHeightLimits(): { min: number; max: number } {
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return { min: rootFontSize * 2, max: composerExpandedThreshold() };
  }

  function composerExpandedThreshold(): number {
    const styles = getComputedStyle(sendToolsEl);
    const gap = Number.parseFloat(styles.rowGap || styles.gap) || 0;
    return sendModeToggleEl.getBoundingClientRect().height + fileSendEl.getBoundingClientRect().height + gap;
  }

  function setComposerInputHeight(height: number): void {
    const { min, max } = composerInputHeightLimits();
    const threshold = composerExpandedThreshold();
    const wasExpanded = formEl.classList.contains('is-input-expanded');
    let nextHeight = Math.min(max, Math.max(min, height));
    if (!wasExpanded && nextHeight >= threshold && nextHeight - threshold <= 8) nextHeight = threshold;
    sendInputEl.style.height = `${nextHeight}px`;
    formEl.classList.toggle('is-input-expanded', nextHeight >= threshold);
    composerResizerEl.setAttribute('aria-valuemin', String(Math.round(min)));
    composerResizerEl.setAttribute('aria-valuemax', String(Math.round(max)));
    composerResizerEl.setAttribute('aria-valuenow', String(Math.round(nextHeight)));
  }

  function finishComposerResize(): void {
    if (composerResizePointerId !== null && composerResizerEl.hasPointerCapture(composerResizePointerId)) {
      composerResizerEl.releasePointerCapture(composerResizePointerId);
    }
    composerResizePointerId = null;
    composerResizerEl.classList.remove('is-resizing');
    document.body.classList.remove('serial-assistant-is-resizing');
  }

  function syncOptionToggleHint(button: HTMLButtonElement, enabled: boolean, label: string): void {
    const action = enabled ? '隐藏' : '显示';
    button.dataset.tooltip = `${action}${label}`;
    button.setAttribute('aria-label', `${label}：${enabled ? '已显示' : '已隐藏'}，点击${action}`);
  }

  function setStatus(message: string): void {
    statusEl.textContent = message;
  }

  const cycleIntervalError = () => {
    const value = Number(cycleIntervalEl.value);
    return Number.isFinite(value) && value >= 10 && value <= 86400000
      ? ''
      : '循环间隔需为 10–86400000 ms。';
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
    quickListEl.querySelectorAll<HTMLButtonElement>('.serial-assistant-quick-send').forEach((button) => { button.disabled = !isConnected; });
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

  function quickRows(): HTMLElement[] {
    return Array.from(quickListEl.querySelectorAll<HTMLElement>('.serial-assistant-quick-row'));
  }

  function quickRowInput(row: HTMLElement): HTMLInputElement {
    return row.querySelector<HTMLInputElement>('input') as HTMLInputElement;
  }

  function quickRowModeButton(row: HTMLElement): HTMLButtonElement {
    return row.querySelector<HTMLButtonElement>('.serial-assistant-quick-mode') as HTMLButtonElement;
  }

  function quickModeForRow(row: HTMLElement): SendMode {
    return quickRowModeButton(row).dataset.mode === 'hex' ? 'hex' : 'text';
  }

  function syncQuickModeUi(button: HTMLButtonElement, index: number): void {
    const mode = button.dataset.mode === 'hex' ? 'hex' : 'text';
    const current = mode === 'hex' ? 'Hex' : 'Abc';
    const next = mode === 'hex' ? 'Abc' : 'Hex';
    const row = button.closest<HTMLElement>('.serial-assistant-quick-row');
    const input = row ? quickRowInput(row) : null;
    const text = button.querySelector('span');
    if (text) text.textContent = mode === 'hex' ? 'H' : 'A';
    if (input) {
      input.placeholder = mode === 'hex'
        ? '输入十六进制字节'
        : '输入文本';
    }
    button.dataset.mode = mode;
    button.setAttribute('aria-label', `快捷指令 ${index + 1}：${current}，点击切换为 ${next}`);
    button.dataset.tooltip = `${current}，点击切换为 ${next}`;
  }

  function createQuickRow(value = '', mode: SendMode = 'text'): HTMLElement {
    const row = quickRowTemplate.cloneNode(true) as HTMLElement;
    quickRowInput(row).value = value;
    quickRowModeButton(row).dataset.mode = mode;
    row.querySelectorAll<HTMLElement>('[data-tooltip], button[aria-label]').forEach((target) => wireThemedTooltipTarget?.(target));
    return row;
  }

  function syncQuickRowsUi(): void {
    const rows = quickRows();
    rows.forEach((row, index) => {
      const input = quickRowInput(row);
      const modeButton = quickRowModeButton(row);
      const sendButton = row.querySelector<HTMLButtonElement>('.serial-assistant-quick-send') as HTMLButtonElement;
      const deleteButton = row.querySelector<HTMLButtonElement>('.serial-assistant-quick-delete') as HTMLButtonElement;
      input.setAttribute('aria-label', `快捷指令 ${index + 1}`);
      sendButton.setAttribute('aria-label', `发送快捷指令 ${index + 1}`);
      sendButton.disabled = !connected();
      deleteButton.setAttribute('aria-label', `删除快捷指令 ${index + 1}`);
      syncQuickModeUi(modeButton, index);
    });
    quickEmptyEl.hidden = rows.length > 0;
    quickAddEl.disabled = rows.length >= MAX_QUICK_COMMANDS;
  }

  function syncSendInputUi(): void {
    sendInputClearEl.disabled = sendInputEl.value.length === 0;
  }

  function insertHexTextInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const filtered = value.replace(/[^0-9a-f\s]/gi, '').replace(/\s/g, ' ').toUpperCase();
    if (!filtered) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.setRangeText(filtered, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function insertHexText(value: string): void {
    insertHexTextInto(sendInputEl, value);
  }

  function sanitizeHexElement(input: HTMLInputElement | HTMLTextAreaElement): void {
    const normalized = input.value.replace(/[^0-9a-f\s]/gi, '').replace(/\s/g, ' ').toUpperCase();
    if (normalized === input.value) return;
    const selection = input.selectionStart ?? input.value.length;
    const validBeforeSelection = input.value.slice(0, selection).replace(/[^0-9a-f\s]/gi, '').length;
    input.value = normalized;
    input.setSelectionRange(validBeforeSelection, validBeforeSelection);
  }

  function sanitizeHexInput(): void {
    if (sendMode !== 'hex') return;
    sanitizeHexElement(sendInputEl);
  }

  function textValueToHex(value: string): string {
    return /^[0-9a-f ]*$/i.test(value)
      ? bytesToHex(parseHex(value))
      : bytesToHex(encoder.encode(value));
  }

  function formatHexElement(input: HTMLInputElement | HTMLTextAreaElement): void {
    input.value = bytesToHex(parseHex(input.value));
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function formatHexInput(): void {
    formatHexElement(sendInputEl);
    updateChecksumPreview();
    syncSendInputUi();
  }

  function saveSettings(): void {
    const rows = quickRows();
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
      quickCommands: rows.map((row) => quickRowInput(row).value),
      quickModes: rows.map(quickModeForRow),
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
    if (settings.cycleInterval && settings.cycleInterval >= 10) cycleIntervalEl.value = String(settings.cycleInterval);
    if (settings.cycleCount === -1 || (settings.cycleCount && settings.cycleCount >= 1)) cycleCountEl.value = String(settings.cycleCount);
    if (Array.isArray(settings.quickCommands)) {
      quickRows().forEach((row) => row.remove());
      settings.quickCommands.slice(0, MAX_QUICK_COMMANDS).forEach((value, index) => {
        const mode = settings.quickModes?.[index] === 'hex' ? 'hex' : 'text';
        quickListEl.insertBefore(createQuickRow(value, mode), quickEmptyEl);
      });
    } else {
      quickRows().forEach((row, index) => {
        quickRowModeButton(row).dataset.mode = settings.quickModes?.[index] === 'hex' ? 'hex' : 'text';
      });
    }
    syncQuickRowsUi();
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

  function frameIsVisible(frame: SerialFrame): boolean {
    return (
      (frame.direction === 'tx' && togglePressed(localEchoEl))
      || (frame.direction === 'rx' && togglePressed(showReceiveEl))
    );
  }

  function cloneFrame(frame: SerialFrame): SerialFrame {
    return { ...frame, bytes: frame.bytes.slice() };
  }

  function shouldMergeRxFrames(
    displayedFrame: SerialFrame | null,
    frame: SerialFrame,
    previousRawFrame: SerialFrame | null,
  ): displayedFrame is SerialFrame {
    if (frame.direction !== 'rx' || displayedFrame?.direction !== 'rx' || previousRawFrame?.direction !== 'rx') {
      return false;
    }
    if (togglePressed(timestampEl)) return displayedFrame.at.getTime() === frame.at.getTime();
    const gapMs = frame.at.getTime() - displayedFrame.lastChunkAtMs;
    return gapMs >= 0 && gapMs <= 3;
  }

  function mergeDisplayedFrame(target: SerialFrame, source: SerialFrame): void {
    target.bytes = concatBytes(target.bytes, source.bytes);
    target.text += source.text;
    target.lastChunkAtMs = source.lastChunkAtMs;
  }

  function visibleFrames(): SerialFrame[] {
    const result: SerialFrame[] = [];
    let previousRawFrame: SerialFrame | null = null;
    frames.forEach((frame) => {
      if (frameIsVisible(frame)) {
        const displayedFrame = result.at(-1) ?? null;
        if (shouldMergeRxFrames(displayedFrame, frame, previousRawFrame)) {
          mergeDisplayedFrame(displayedFrame, frame);
        } else {
          result.push(cloneFrame(frame));
        }
      }
      previousRawFrame = frame;
    });
    return result;
  }

  function syncEmpty(): void {
    emptyEl.hidden = renderedFrameCount > 0;
  }

  function syncExportState(): void {
    exportEl.disabled = visibleFrames().length === 0;
  }

  function isLogAtBottom(): boolean {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= 4;
  }

  function scrollToBottom(): void {
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderFrames(): void {
    if (frameRenderId !== null) window.cancelAnimationFrame(frameRenderId);
    frameRenderId = null;
    pendingRenderedFrames = [];
    const followOutput = isLogAtBottom();
    const previousScrollTop = logEl.scrollTop;
    logEl.querySelectorAll('.serial-assistant-log-line').forEach((element) => element.remove());
    const fragment = document.createDocumentFragment();
    const shownFrames = visibleFrames();
    lastRenderedFrameElement = null;
    shownFrames.forEach((frame) => {
      const element = createFrameElement(frame);
      fragment.append(element);
      lastRenderedFrameElement = element;
    });
    logEl.append(fragment);
    renderedFrameCount = shownFrames.length;
    lastRenderedFrame = shownFrames.at(-1) ?? null;
    lastProcessedFrame = frames.at(-1) ?? null;
    syncEmpty();
    syncExportState();
    if (followOutput) scrollToBottom();
    else logEl.scrollTop = previousScrollTop;
  }

  function flushPendingFrames(): void {
    frameRenderId = null;
    const framesToRender = pendingRenderedFrames;
    pendingRenderedFrames = [];
    if (!framesToRender.length) return;

    const followOutput = isLogAtBottom();
    const fragment = document.createDocumentFragment();
    framesToRender.forEach((frame) => {
      if (frameIsVisible(frame)) {
        if (shouldMergeRxFrames(lastRenderedFrame, frame, lastProcessedFrame)) {
          mergeDisplayedFrame(lastRenderedFrame, frame);
          const dataElement = lastRenderedFrameElement?.querySelector<HTMLElement>('.serial-assistant-log-data');
          if (dataElement) dataElement.textContent = frameText(lastRenderedFrame) || '(空数据)';
        } else {
          lastRenderedFrame = cloneFrame(frame);
          lastRenderedFrameElement = createFrameElement(lastRenderedFrame);
          fragment.append(lastRenderedFrameElement);
          renderedFrameCount += 1;
        }
      }
      lastProcessedFrame = frame;
    });
    logEl.append(fragment);
    while (renderedFrameCount > MAX_FRAMES) {
      logEl.querySelector('.serial-assistant-log-line')?.remove();
      renderedFrameCount -= 1;
    }
    syncEmpty();
    syncExportState();
    if (followOutput) scrollToBottom();
  }

  function scheduleFrameRender(frame: SerialFrame): void {
    pendingRenderedFrames.push(frame);
    if (pendingRenderedFrames.length > MAX_FRAMES) {
      pendingRenderedFrames = pendingRenderedFrames.slice(-MAX_FRAMES);
    }
    if (frameRenderId !== null) return;
    frameRenderId = window.requestAnimationFrame(flushPendingFrames);
  }

  function addFrame(direction: Direction, bytes: Uint8Array, text?: string): void {
    const at = new Date();
    const atMs = at.getTime();
    const frameTextValue = text ?? new TextDecoder().decode(bytes);
    const frame: SerialFrame = {
      direction,
      at,
      lastChunkAtMs: atMs,
      bytes: bytes.slice(),
      text: frameTextValue,
    };
    frames.push(frame);
    if (frames.length > MAX_FRAMES) frames = frames.slice(-MAX_FRAMES);
    scheduleFrameRender(frame);
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

  async function sendQuickValue(value: string, mode: SendMode): Promise<void> {
    if (!connected()) {
      setStatus('请先连接串口。');
      return;
    }
    try {
      const bytes = mode === 'hex' ? parseHex(value) : encoder.encode(value);
      if (!bytes.length) throw new Error('请输入要发送的数据。');
      await sendBytes(bytes, mode === 'text' ? value : new TextDecoder().decode(bytes));
    } catch (error) {
      setStatus(errorMessage(error));
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
    cycleRunId += 1;
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
    const runId = ++cycleRunId;
    cycleSent = 0;
    cycleTotal = count;
    sendControlEl.dataset.running = 'true';
    cycleIntervalEl.disabled = true;
    cycleCountEl.disabled = true;
    sendToggleEl.disabled = true;
    setSendMenu(false);
    updateCycleProgress();
    saveSettings();

    let nextSendAt = performance.now();
    const sendNext = async () => {
      if (!cycleRunning || cycleRunId !== runId) return;
      const succeeded = await sendValue(sendInputEl.value, sendMode, cycleSent === 0);
      if (!cycleRunning || cycleRunId !== runId) return;
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
      nextSendAt += interval;
      const delay = Math.max(0, nextSendAt - performance.now());
      cycleTimer = window.setTimeout(() => { void sendNext(); }, delay);
    };
    await sendNext();
  }

  function exportLog(): void {
    const shownFrames = visibleFrames();
    if (!shownFrames.length) {
      setStatus('当前没有可导出的日志。');
      return;
    }
    const rows = shownFrames.map((frame) => {
      const time = frame.at.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hourCycle: 'h23',
      });
      const data = displayMode === 'hex' ? bytesToHex(frame.bytes) : readableText(frame.text);
      // CSV cannot declare an Excel number format. Returning the safe, generated
      // timestamp as text prevents Excel from hiding milliseconds on open.
      const excelTime = `="${time}"`;
      return [excelTime, frame.direction.toUpperCase(), data].map(csvCell).join(',');
    });
    const csv = [`时间,方向,数据`, ...rows].join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    link.href = url;
    link.download = `serial-log-${stamp}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus(`已导出 ${shownFrames.length} 条 CSV 日志。`);
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
  setComposerInputHeight(sendInputEl.getBoundingClientRect().height);
  wireThemedTooltipTarget = wireAssistantTooltips(document.querySelector('.serial-assistant') ?? document);
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
    if (sendMode === 'text') sendInputEl.value = textValueToHex(sendInputEl.value);
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
    renderFrames();
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

  composerResizerEl.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    composerResizePointerId = event.pointerId;
    composerResizeStartY = event.clientY;
    composerResizeStartHeight = sendInputEl.getBoundingClientRect().height;
    composerResizerEl.setPointerCapture(event.pointerId);
    composerResizerEl.classList.add('is-resizing');
    document.body.classList.add('serial-assistant-is-resizing');
  });
  composerResizerEl.addEventListener('pointermove', (event) => {
    if (event.pointerId !== composerResizePointerId) return;
    setComposerInputHeight(composerResizeStartHeight + composerResizeStartY - event.clientY);
  });
  composerResizerEl.addEventListener('pointerup', finishComposerResize);
  composerResizerEl.addEventListener('pointercancel', finishComposerResize);
  composerResizerEl.addEventListener('lostpointercapture', finishComposerResize);
  composerResizerEl.addEventListener('dblclick', () => setComposerInputHeight(composerInputHeightLimits().min));
  composerResizerEl.addEventListener('keydown', (event) => {
    const { min, max } = composerInputHeightLimits();
    const currentHeight = sendInputEl.getBoundingClientRect().height;
    const step = event.shiftKey ? 24 : 8;
    let nextHeight: number | null = null;
    if (event.key === 'ArrowUp') nextHeight = currentHeight + step;
    else if (event.key === 'ArrowDown') nextHeight = currentHeight - step;
    else if (event.key === 'Home') nextHeight = min;
    else if (event.key === 'End') nextHeight = max;
    if (nextHeight === null) return;
    event.preventDefault();
    setComposerInputHeight(nextHeight);
  });
  window.addEventListener('resize', () => setComposerInputHeight(sendInputEl.getBoundingClientRect().height));

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
  [cycleIntervalEl, cycleCountEl].forEach((input) => {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
    });
  });
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
  quickAddEl.addEventListener('click', () => {
    if (quickRows().length >= MAX_QUICK_COMMANDS) {
      setStatus(`最多可添加 ${MAX_QUICK_COMMANDS} 条快捷指令。`);
      return;
    }
    const row = createQuickRow();
    quickListEl.insertBefore(row, quickEmptyEl);
    syncQuickRowsUi();
    saveSettings();
    quickListEl.scrollTop = quickListEl.scrollHeight;
    requestAnimationFrame(() => quickRowInput(row).focus());
  });
  quickListEl.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('button') as HTMLButtonElement | null;
    const row = button?.closest('.serial-assistant-quick-row') as HTMLElement | null;
    if (!button || !row) return;
    const input = quickRowInput(row);
    const index = quickRows().indexOf(row);
    if (button.classList.contains('serial-assistant-quick-mode')) {
      const mode = quickModeForRow(row);
      if (mode === 'text') input.value = textValueToHex(input.value);
      button.dataset.mode = mode === 'text' ? 'hex' : 'text';
      syncQuickModeUi(button, index);
      saveSettings();
      input.focus();
      return;
    }
    if (button.classList.contains('serial-assistant-quick-send')) {
      void sendQuickValue(input.value, quickModeForRow(row));
      return;
    }
    if (button.classList.contains('serial-assistant-quick-delete')) {
      button.dispatchEvent(new Event('serial-assistant-hide-tooltip'));
      row.remove();
      const remainingRows = quickRows();
      syncQuickRowsUi();
      saveSettings();
      const nextRow = remainingRows[Math.min(index, remainingRows.length - 1)];
      if (nextRow) quickRowInput(nextRow).focus();
      else quickAddEl.focus();
    }
  });
  quickListEl.addEventListener('keydown', (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const row = input?.closest('.serial-assistant-quick-row') as HTMLElement | null;
    if (!input || !row) return;
    const key = event.key.toLowerCase();
    const commandKey = event.ctrlKey || event.metaKey;
    const formatShortcut = quickModeForRow(row) === 'hex' && commandKey && (
      (key === 's' && !event.shiftKey && !event.altKey)
      || (key === 'f' && event.shiftKey && !event.altKey)
      || (key === 'l' && !event.shiftKey && event.altKey)
    );
    if (formatShortcut) {
      event.preventDefault();
      formatHexElement(input);
      saveSettings();
      return;
    }
    if (event.key === 'Enter' && commandKey) {
      event.preventDefault();
      void sendQuickValue(input.value, quickModeForRow(row));
    }
  });
  quickListEl.addEventListener('beforeinput', (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const row = input?.closest('.serial-assistant-quick-row') as HTMLElement | null;
    if (!input || !row || quickModeForRow(row) !== 'hex' || !event.inputType.startsWith('insert') || event.data === null) return;
    if (/^[0-9a-f ]*$/i.test(event.data)) return;
    event.preventDefault();
    insertHexTextInto(input, event.data);
  });
  quickListEl.addEventListener('paste', (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const row = input?.closest('.serial-assistant-quick-row') as HTMLElement | null;
    if (!input || !row || quickModeForRow(row) !== 'hex') return;
    event.preventDefault();
    insertHexTextInto(input, event.clipboardData?.getData('text') ?? '');
  });
  quickListEl.addEventListener('input', (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const row = input?.closest('.serial-assistant-quick-row') as HTMLElement | null;
    if (input && row && quickModeForRow(row) === 'hex') sanitizeHexElement(input);
  });
  quickListEl.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement) saveSettings();
  });

  if ('serial' in navigator) {
    navigator.serial.addEventListener('disconnect', (event) => {
      if (port && event.target === port) void disconnect('设备已从系统断开。');
    });
  }
  window.addEventListener('pagehide', () => { if (port) void disconnect(); });
}
