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
  autoScroll?: boolean;
  localEcho?: boolean;
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

function byteSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
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
  const compact = value.replace(/0x/gi, '').replace(/[\s,;:_-]+/g, '');
  if (!compact) return new Uint8Array();
  if (!/^[0-9a-f]+$/i.test(compact)) throw new Error('HEX 数据只能包含 0–9、A–F。');
  if (compact.length % 2 !== 0) throw new Error('HEX 数据必须由完整字节组成，例如 AA 01 FF。');
  const bytes = new Uint8Array(compact.length / 2);
  for (let index = 0; index < compact.length; index += 2) {
    bytes[index / 2] = Number.parseInt(compact.slice(index, index + 2), 16);
  }
  return bytes;
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
  const pauseEl = byId<HTMLButtonElement>('serial-pause');
  const exportEl = byId<HTMLButtonElement>('serial-export');
  const clearEl = byId<HTMLButtonElement>('serial-clear');
  const timestampEl = byId<HTMLInputElement>('serial-timestamp');
  const autoScrollEl = byId<HTMLInputElement>('serial-auto-scroll');
  const localEchoEl = byId<HTMLInputElement>('serial-local-echo');
  const resetCountersEl = byId<HTMLButtonElement>('serial-reset-counters');
  const rxCountEl = byId<HTMLElement>('serial-rx-count');
  const txCountEl = byId<HTMLElement>('serial-tx-count');
  const formEl = byId<HTMLFormElement>('serial-send-form');
  const sendInputEl = byId<HTMLTextAreaElement>('serial-send-input');
  const lineEndingEl = byId<HTMLInputElement>('serial-line-ending');
  const lineEndingRootEl = byId<HTMLElement>('serial-line-ending-dd');
  const checksumEl = byId<HTMLInputElement>('serial-checksum');
  const checksumRootEl = byId<HTMLElement>('serial-checksum-dd');
  const suffixLabelEl = byId<HTMLElement>('serial-suffix-label');
  const checksumResultEl = byId<HTMLElement>('serial-checksum-result');
  const cycleEnabledEl = byId<HTMLInputElement>('serial-cycle-enabled');
  const cycleIntervalEl = byId<HTMLInputElement>('serial-cycle-interval');
  const sendErrorEl = byId<HTMLSpanElement>('serial-send-error');
  const sendEl = byId<HTMLButtonElement>('serial-send');
  const quickListEl = byId<HTMLDivElement>('serial-quick-list');
  const configEls: HTMLInputElement[] = [baudEl, dataBitsEl, stopBitsEl, parityEl, flowControlEl];

  let port: SerialPort | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let closing = false;
  let displayMode: DisplayMode = 'text';
  let sendMode: SendMode = 'text';
  let paused = false;
  let frames: SerialFrame[] = [];
  let rxBytes = 0;
  let txBytes = 0;
  let cycleTimer: number | null = null;
  let history: string[] = [];
  let historyIndex = 0;
  let writeChain: Promise<void> = Promise.resolve();
  let receiveDecoder = new TextDecoder();

  const quickInputs = Array.from(quickListEl.querySelectorAll<HTMLInputElement>('input'));
  const quickButtons = Array.from(quickListEl.querySelectorAll<HTMLButtonElement>('button'));

  const connected = () => writer !== null && port !== null;

  function setStatus(message: string): void {
    statusEl.textContent = message;
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
    disconnectEl.disabled = !isConnected;
    sendEl.disabled = !isConnected;
    dtrEl.disabled = !isConnected;
    rtsEl.disabled = !isConnected;
    configEls.forEach((element) => { setControlDisabled(element, isConnected || isBusy); });
    quickButtons.forEach((button) => { button.disabled = !isConnected; });
    if (!isConnected) stopCycle();
  }

  function selectedChecksumMode(): ChecksumMode {
    return ['none', 'parity', 'xor', 'sum', 'crc8-atm'].includes(checksumEl.value)
      ? checksumEl.value as ChecksumMode
      : 'none';
  }

  function updateChecksumPreview(): void {
    checksumResultEl.hidden = sendMode !== 'hex';
    if (sendMode !== 'hex') return;

    checksumResultEl.dataset.error = 'false';
    checksumResultEl.removeAttribute('title');
    try {
      const bytes = parseHex(sendInputEl.value);
      if (!bytes.length) {
        checksumResultEl.textContent = '—';
        return;
      }
      const mode = selectedChecksumMode();
      const checksum = checksumByte(bytes, mode);
      checksumResultEl.textContent = checksum === null ? '—' : `0x${checksum.toString(16).padStart(2, '0').toUpperCase()}`;
    } catch (error) {
      checksumResultEl.textContent = '格式错误';
      checksumResultEl.title = errorMessage(error);
      checksumResultEl.dataset.error = 'true';
    }
  }

  function syncSendModeUi(): void {
    const hex = sendMode === 'hex';
    suffixLabelEl.textContent = hex ? '校验' : '行尾';
    lineEndingRootEl.hidden = hex;
    checksumRootEl.hidden = !hex;
    sendInputEl.placeholder = hex
      ? '输入十六进制字节，例如 AA 01 0D 0A'
      : '输入要发送的文本；Ctrl / ⌘ + Enter 快速发送';
    updateChecksumPreview();
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
      timestamp: timestampEl.checked,
      autoScroll: autoScrollEl.checked,
      localEcho: localEchoEl.checked,
      quickCommands: quickInputs.map((input) => input.value),
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage may be disabled */ }
  }

  function activateSegment(selector: string, value: string, dataKey: 'displayMode' | 'sendMode'): void {
    document.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => {
      const active = button.dataset[dataKey] === value;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
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
    timestampEl.checked = settings.timestamp ?? true;
    autoScrollEl.checked = settings.autoScroll ?? true;
    localEchoEl.checked = settings.localEcho ?? true;
    settings.quickCommands?.slice(0, quickInputs.length).forEach((value, index) => { quickInputs[index].value = value; });
    activateSegment('[data-display-mode]', displayMode, 'displayMode');
    activateSegment('[data-send-mode]', sendMode, 'sendMode');
  }

  function updateCounters(): void {
    rxCountEl.textContent = byteSize(rxBytes);
    txCountEl.textContent = byteSize(txBytes);
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
    time.hidden = !timestampEl.checked;
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
    return localEchoEl.checked ? frames : frames.filter((frame) => frame.direction === 'rx');
  }

  function syncEmpty(): void {
    emptyEl.hidden = visibleFrames().length > 0;
  }

  function scrollToBottom(): void {
    if (autoScrollEl.checked) logEl.scrollTop = logEl.scrollHeight;
  }

  function renderFrames(): void {
    logEl.querySelectorAll('.serial-assistant-log-line').forEach((element) => element.remove());
    const fragment = document.createDocumentFragment();
    visibleFrames().forEach((frame) => fragment.append(createFrameElement(frame)));
    logEl.append(fragment);
    syncEmpty();
    scrollToBottom();
  }

  function addFrame(direction: Direction, bytes: Uint8Array, text?: string): void {
    const frame: SerialFrame = {
      direction,
      at: new Date(),
      bytes: bytes.slice(),
      text: text ?? new TextDecoder().decode(bytes),
    };
    frames.push(frame);
    if (frames.length > MAX_FRAMES) frames = frames.slice(-MAX_FRAMES);
    if (paused || (direction === 'tx' && !localEchoEl.checked)) {
      syncEmpty();
      return;
    }
    logEl.append(createFrameElement(frame));
    while (logEl.querySelectorAll('.serial-assistant-log-line').length > MAX_FRAMES) {
      logEl.querySelector('.serial-assistant-log-line')?.remove();
    }
    syncEmpty();
    scrollToBottom();
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
          rxBytes += value.byteLength;
          updateCounters();
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

  async function connect(): Promise<void> {
    if (!('serial' in navigator)) return;
    const baudRate = Number(baudEl.value);
    if (!Number.isInteger(baudRate) || baudRate <= 0 || baudRate > 12000000) {
      setStatus('请输入 1–12000000 之间的有效波特率。');
      baudEl.focus();
      return;
    }
    setConnectionState('connecting');
    setStatus('请选择要连接的串口…');
    try {
      const selected = await navigator.serial.requestPort();
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
      writer = selected.writable.getWriter();
      receiveDecoder = new TextDecoder();
      closing = false;
      setConnectionState('connected');
      const info = selected.getInfo();
      const usb = info.usbVendorId == null
        ? ''
        : `（VID ${info.usbVendorId.toString(16).padStart(4, '0').toUpperCase()}${info.usbProductId == null ? '' : ` / PID ${info.usbProductId.toString(16).padStart(4, '0').toUpperCase()}`}）`;
      setStatus(`连接成功 ${usb}`.trim());
      saveSettings();
      void readFromPort(selected);
      await updateSignals();
      syncCycle();
      sendInputEl.focus();
    } catch (error) {
      setStatus(errorMessage(error));
      if (port) await disconnect();
      else setConnectionState('disconnected');
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
      txBytes += bytes.byteLength;
      updateCounters();
      addFrame('tx', bytes, displayText);
    });
    await writeChain;
  }

  async function sendValue(value: string, mode = sendMode, remember = false): Promise<void> {
    sendErrorEl.textContent = '';
    if (!connected()) {
      sendErrorEl.textContent = '请先连接串口。';
      return;
    }
    if (!value && mode === 'text' && lineEndingEl.value === 'none') {
      sendErrorEl.textContent = '请输入要发送的数据。';
      return;
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
    } catch (error) {
      sendErrorEl.textContent = errorMessage(error);
      if (connected() && error instanceof Error && !error.message.includes('HEX') && !error.message.includes('输入')) {
        setStatus(`发送失败：${errorMessage(error)}`);
      }
    }
  }

  function stopCycle(): void {
    if (cycleTimer !== null) window.clearInterval(cycleTimer);
    cycleTimer = null;
  }

  function syncCycle(): void {
    stopCycle();
    if (!cycleEnabledEl.checked || !connected()) return;
    const interval = Number(cycleIntervalEl.value);
    if (!Number.isFinite(interval) || interval < 20 || interval > 86400000) {
      sendErrorEl.textContent = '循环间隔需为 20–86400000 ms。';
      cycleEnabledEl.checked = false;
      return;
    }
    cycleTimer = window.setInterval(() => { void sendValue(sendInputEl.value); }, interval);
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
  const supported = 'serial' in navigator;
  noApiEl.hidden = supported;
  setConnectionState('disconnected');
  if (!supported) setStatus('当前浏览器不支持 Web Serial。');

  connectEl.addEventListener('click', () => { void connect(); });
  disconnectEl.addEventListener('click', () => { void disconnect(); });
  dtrEl.addEventListener('change', () => { void setOutputSignals(); });
  rtsEl.addEventListener('change', () => { void setOutputSignals(); });

  document.querySelectorAll<HTMLButtonElement>('[data-display-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      displayMode = button.dataset.displayMode === 'hex' ? 'hex' : 'text';
      activateSegment('[data-display-mode]', displayMode, 'displayMode');
      renderFrames();
      saveSettings();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-send-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      sendMode = button.dataset.sendMode === 'hex' ? 'hex' : 'text';
      activateSegment('[data-send-mode]', sendMode, 'sendMode');
      syncSendModeUi();
      sendErrorEl.textContent = '';
      saveSettings();
    });
  });

  pauseEl.addEventListener('click', () => {
    paused = !paused;
    pauseEl.setAttribute('aria-pressed', String(paused));
    pauseEl.textContent = paused ? '继续显示' : '暂停显示';
    logEl.classList.toggle('is-paused', paused);
    if (!paused) renderFrames();
  });
  exportEl.addEventListener('click', exportLog);
  clearEl.addEventListener('click', () => {
    frames = [];
    renderFrames();
    setStatus('显示日志已清空。');
  });
  timestampEl.addEventListener('change', () => {
    logEl.querySelectorAll<HTMLTimeElement>('time').forEach((time) => { time.hidden = !timestampEl.checked; });
    saveSettings();
  });
  autoScrollEl.addEventListener('change', () => { saveSettings(); if (autoScrollEl.checked) scrollToBottom(); });
  localEchoEl.addEventListener('change', () => { renderFrames(); saveSettings(); });
  resetCountersEl.addEventListener('click', () => { rxBytes = 0; txBytes = 0; updateCounters(); setStatus('收发计数已重置。'); });

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendValue(sendInputEl.value, sendMode, true);
  });
  sendInputEl.addEventListener('keydown', (event) => {
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
    }
  });
  sendInputEl.addEventListener('input', updateChecksumPreview);
  cycleEnabledEl.addEventListener('change', syncCycle);
  cycleIntervalEl.addEventListener('change', syncCycle);
  lineEndingEl.addEventListener('change', saveSettings);
  checksumEl.addEventListener('change', () => {
    updateChecksumPreview();
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
