import { registerSerialDropdownOutsideClose, wireSerialDropdown } from './serial-dropdown';

const GS_USB_BREQ_HOST_FORMAT = 0;
const GS_USB_BREQ_BITTIMING = 1;
const GS_USB_BREQ_MODE = 2;
const GS_USB_BREQ_BT_CONST = 4;
const GS_USB_BREQ_DEVICE_CONFIG = 5;
const GS_USB_BREQ_SET_TERMINATION = 12;
const GS_USB_BREQ_GET_TERMINATION = 13;

const GS_CAN_MODE_RESET = 0;
const GS_CAN_MODE_START = 1;
const GS_CAN_FEATURE_LISTEN_ONLY = 1 << 0;
const GS_CAN_FEATURE_LOOP_BACK = 1 << 1;
const GS_CAN_FEATURE_TERMINATION = 1 << 11;
const GS_CAN_FEATURE_BERR_REPORTING = 1 << 12;

const CAN_EFF_FLAG = 0x80000000;
const CAN_RTR_FLAG = 0x40000000;
const CAN_ERR_FLAG = 0x20000000;
const RX_ECHO_ID = 0xffffffff;
const CLASSIC_FRAME_SIZE = 20;
const MAX_LOGS = 2000;

type UsbDevice = any;
type UsbManager = {
  requestDevice(options: { filters: Array<Record<string, number>> }): Promise<UsbDevice>;
  addEventListener(type: 'disconnect', listener: (event: any) => void): void;
};

type BitTimingConstants = {
  feature: number;
  clock: number;
  tseg1Min: number;
  tseg1Max: number;
  tseg2Min: number;
  tseg2Max: number;
  sjwMax: number;
  brpMin: number;
  brpMax: number;
  brpInc: number;
};

type BitTiming = {
  propSeg: number;
  phaseSeg1: number;
  phaseSeg2: number;
  sjw: number;
  brp: number;
  actualBitrate: number;
  samplePoint: number;
};

type ChannelInfo = {
  constants: BitTimingConstants;
  features: number;
  terminationEnabled: boolean;
};

type CanFrame = {
  timestamp: Date;
  direction: 'rx' | 'tx';
  id: number;
  extended: boolean;
  rtr: boolean;
  error: boolean;
  data: number[];
};

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少页面元素 #${id}`);
  return element as T;
};

const hex = (value: number, width: number) => value.toString(16).toUpperCase().padStart(width, '0');
const writeU32 = (view: DataView, offset: number, value: number) => view.setUint32(offset, value >>> 0, true);

function formatVersion(value: number): string {
  const major = (value >>> 24) & 0xff;
  const minor = (value >>> 16) & 0xff;
  const patch = value & 0xffff;
  return major || minor ? `${major}.${minor}.${patch}` : `0x${hex(value, 8)}`;
}

function formatTime(date: Date): string {
  return `${date.toLocaleTimeString('zh-CN', { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function parseHexBytes(raw: string): number[] {
  const normalized = raw.trim().replace(/,/g, ' ');
  if (!normalized) return [];
  const compact = normalized.replace(/\s+/g, '').replace(/0x/gi, '');
  const tokens = /\s|,/.test(normalized)
    ? normalized.split(/[\s,]+/).filter(Boolean).map((token) => token.replace(/^0x/i, ''))
    : compact.length % 2 === 0 && compact.length > 2
      ? compact.match(/.{2}/g) ?? []
      : [compact];
  if (tokens.length > 8) throw new Error('经典 CAN 数据最多为 8 字节。');
  if (tokens.some((token) => !/^[0-9a-fA-F]{1,2}$/.test(token))) {
    throw new Error('数据必须是 00–FF 的十六进制字节，可用空格分隔。');
  }
  return tokens.map((token) => Number.parseInt(token, 16));
}

function parseCanId(raw: string, extended: boolean): number {
  const text = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(text)) throw new Error('CAN ID 必须是十六进制数字。');
  const value = Number.parseInt(text, 16);
  const max = extended ? 0x1fffffff : 0x7ff;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(extended ? '扩展帧 ID 范围为 00000000–1FFFFFFF。' : '标准帧 ID 范围为 000–7FF。');
  }
  return value;
}

function calculateBitTiming(constants: BitTimingConstants, bitrate: number): BitTiming {
  const targetSamplePoint = bitrate > 800000 ? 0.75 : bitrate > 500000 ? 0.8 : 0.875;
  let best: (BitTiming & { bitrateError: number; sampleError: number }) | null = null;
  const brpInc = Math.max(1, constants.brpInc);

  for (let brp = constants.brpMin; brp <= constants.brpMax; brp += brpInc) {
    for (let tseg1 = constants.tseg1Min; tseg1 <= constants.tseg1Max; tseg1 += 1) {
      for (let tseg2 = constants.tseg2Min; tseg2 <= constants.tseg2Max; tseg2 += 1) {
        const actualBitrate = constants.clock / (brp * (1 + tseg1 + tseg2));
        const bitrateError = Math.abs(actualBitrate - bitrate) / bitrate;
        const samplePoint = (1 + tseg1) / (1 + tseg1 + tseg2);
        const sampleError = Math.abs(samplePoint - targetSamplePoint);
        if (!best || bitrateError < best.bitrateError || (bitrateError === best.bitrateError && sampleError < best.sampleError)) {
          const propSeg = Math.floor(tseg1 / 2);
          best = {
            propSeg,
            phaseSeg1: tseg1 - propSeg,
            phaseSeg2: tseg2,
            sjw: Math.max(1, Math.min(constants.sjwMax, tseg2)),
            brp,
            actualBitrate,
            samplePoint,
            bitrateError,
            sampleError,
          };
        }
      }
    }
  }

  if (!best || best.bitrateError > 0.05) throw new Error('该设备无法生成所选 CAN 波特率，请选择其他速率。');
  return best;
}

class GsUsbTransport {
  device: UsbDevice | null = null;
  private usb: UsbManager;
  private interfaceNumber = 0;
  private endpointIn = 0;
  private endpointOut = 0;
  private readActive = false;
  private generation = 0;
  private echoId = 0;
  private channel = 0;
  private features = 0;
  private channelRunning = false;
  private featuresByChannel = new Map<number, number>();
  onFrame: (frame: CanFrame) => void = () => {};
  onDisconnect: (message: string) => void = () => {};

  constructor(usb: UsbManager) {
    this.usb = usb;
    usb.addEventListener('disconnect', (event) => {
      if (event.device !== this.device) return;
      this.readActive = false;
      this.channelRunning = false;
      this.device = null;
      this.onDisconnect('USB 设备已拔出。');
    });
  }

  async connect(): Promise<{
    channels: number; swVersion: number; hwVersion: number; channelInfo: ChannelInfo;
  }> {
    const device = await this.usb.requestDevice({
      filters: [
        { vendorId: 0x1d50, productId: 0x606f },
        { vendorId: 0x1209, productId: 0x2323 },
        { vendorId: 0x1cd2, productId: 0x606f },
        { vendorId: 0x16d0, productId: 0x10b8 },
        { vendorId: 0x16d0, productId: 0x0f30 },
        { vendorId: 0x1209, productId: 0xca01 },
        { classCode: 0xff },
      ],
    });
    this.device = device;

    try {
      if (!device.opened) await device.open();
      if (!device.configuration) await device.selectConfiguration(1);
      const found = this.findBulkInterface(device);
      this.interfaceNumber = found.interfaceNumber;
      this.endpointIn = found.endpointIn;
      this.endpointOut = found.endpointOut;
      await device.claimInterface(this.interfaceNumber);
      if (found.alternateSetting !== 0) await device.selectAlternateInterface(this.interfaceNumber, found.alternateSetting);

      const hostFormat = new DataView(new ArrayBuffer(4));
      writeU32(hostFormat, 0, 0x0000beef);
      await this.controlOut(GS_USB_BREQ_HOST_FORMAT, 1, this.interfaceNumber, hostFormat);

      const config = await this.controlIn(GS_USB_BREQ_DEVICE_CONFIG, 1, this.interfaceNumber, 12);
      const channels = config.getUint8(3) + 1;
      const swVersion = config.getUint32(4, true);
      const hwVersion = config.getUint32(8, true);
      this.featuresByChannel.clear();
      this.channelRunning = false;
      const channelInfo = await this.getChannelInfo(0);
      this.readActive = true;
      const generation = ++this.generation;
      void this.readLoop(generation);
      return { channels, swVersion, hwVersion, channelInfo };
    } catch (error) {
      await this.closeDevice();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try { await this.stopChannel(); } catch { /* Device may already be gone. */ }
    this.readActive = false;
    this.channelRunning = false;
    this.generation += 1;
    await this.closeDevice();
  }

  isRunning(): boolean {
    return this.channelRunning;
  }

  async getChannelInfo(channel: number): Promise<ChannelInfo> {
    if (!this.device?.opened) throw new Error('请先连接 USB 设备。');
    const constants = await this.readBitTimingConstants(channel);
    let features = constants.feature;
    let terminationEnabled = false;
    if (features & GS_CAN_FEATURE_TERMINATION) {
      try {
        terminationEnabled = (await this.controlIn(GS_USB_BREQ_GET_TERMINATION, channel, 0, 4)).getUint32(0, true) === 1;
      } catch {
        features &= ~GS_CAN_FEATURE_TERMINATION;
      }
    }
    this.featuresByChannel.set(channel, features);
    return { constants: { ...constants, feature: features }, features, terminationEnabled };
  }

  async startChannel(channel: number, bitrate: number, mode: string, termination: boolean): Promise<{
    timing: BitTiming; features: number; terminationEnabled: boolean;
  }> {
    const info = await this.getChannelInfo(channel);
    const timing = calculateBitTiming(info.constants, bitrate);
    let flags = info.features & GS_CAN_FEATURE_BERR_REPORTING;
    if (mode === 'listen') flags |= GS_CAN_FEATURE_LISTEN_ONLY;
    if (mode === 'loopback') flags |= GS_CAN_FEATURE_LOOP_BACK;
    if ((flags & ~info.features) !== 0) throw new Error('设备固件不支持所选工作模式。');

    await this.stopChannel();
    this.channel = channel;
    this.features = info.features;
    await this.setMode(GS_CAN_MODE_RESET, 0);
    await this.setBitTiming(timing);
    if (this.features & GS_CAN_FEATURE_TERMINATION) await this.setTermination(termination, channel);
    await this.setMode(GS_CAN_MODE_START, flags);
    this.channelRunning = true;
    return { timing, features: this.features, terminationEnabled: termination };
  }

  async stopChannel(): Promise<void> {
    if (!this.channelRunning) return;
    try {
      await this.setMode(GS_CAN_MODE_RESET, 0);
    } finally {
      this.channelRunning = false;
    }
  }

  async setTermination(enabled: boolean, channel = this.channel): Promise<void> {
    if (!((this.featuresByChannel.get(channel) ?? 0) & GS_CAN_FEATURE_TERMINATION)) {
      throw new Error('设备不支持软件控制终端电阻。');
    }
    const state = new DataView(new ArrayBuffer(4));
    writeU32(state, 0, enabled ? 1 : 0);
    await this.controlOut(GS_USB_BREQ_SET_TERMINATION, channel, 0, state);
  }

  async send(id: number, extended: boolean, rtr: boolean, data: number[]): Promise<void> {
    if (!this.device?.opened || !this.channelRunning) throw new Error('请先启动 CAN 通道。');
    const frame = new DataView(new ArrayBuffer(CLASSIC_FRAME_SIZE));
    writeU32(frame, 0, this.echoId++ % 10);
    let canId = id;
    if (extended) canId = (canId | CAN_EFF_FLAG) >>> 0;
    if (rtr) canId = (canId | CAN_RTR_FLAG) >>> 0;
    writeU32(frame, 4, canId);
    frame.setUint8(8, data.length);
    frame.setUint8(9, this.channel);
    data.forEach((byte, index) => frame.setUint8(12 + index, byte));
    const result = await this.device.transferOut(this.endpointOut, frame.buffer);
    if (result.status !== 'ok') throw new Error(`USB 写入失败：${result.status}`);
  }

  private findBulkInterface(device: UsbDevice): { interfaceNumber: number; alternateSetting: number; endpointIn: number; endpointOut: number } {
    for (const usbInterface of device.configuration?.interfaces ?? []) {
      for (const alternate of usbInterface.alternates ?? []) {
        const endpointIn = alternate.endpoints?.find((endpoint: any) => endpoint.direction === 'in' && endpoint.type === 'bulk');
        const endpointOut = alternate.endpoints?.find((endpoint: any) => endpoint.direction === 'out' && endpoint.type === 'bulk');
        if (endpointIn && endpointOut) {
          return {
            interfaceNumber: usbInterface.interfaceNumber,
            alternateSetting: alternate.alternateSetting,
            endpointIn: endpointIn.endpointNumber,
            endpointOut: endpointOut.endpointNumber,
          };
        }
      }
    }
    throw new Error('未找到 gs_usb 所需的 Bulk IN / OUT 端点。');
  }

  private async readBitTimingConstants(channel: number): Promise<BitTimingConstants> {
    const bt = await this.controlIn(GS_USB_BREQ_BT_CONST, channel, 0, 40);
    return {
      feature: bt.getUint32(0, true), clock: bt.getUint32(4, true),
      tseg1Min: bt.getUint32(8, true), tseg1Max: bt.getUint32(12, true),
      tseg2Min: bt.getUint32(16, true), tseg2Max: bt.getUint32(20, true),
      sjwMax: bt.getUint32(24, true), brpMin: bt.getUint32(28, true),
      brpMax: bt.getUint32(32, true), brpInc: bt.getUint32(36, true),
    };
  }

  private async setBitTiming(timing: BitTiming): Promise<void> {
    const value = new DataView(new ArrayBuffer(20));
    [timing.propSeg, timing.phaseSeg1, timing.phaseSeg2, timing.sjw, timing.brp]
      .forEach((field, index) => writeU32(value, index * 4, field));
    await this.controlOut(GS_USB_BREQ_BITTIMING, this.channel, 0, value);
  }

  private async setMode(mode: number, flags: number): Promise<void> {
    const value = new DataView(new ArrayBuffer(8));
    writeU32(value, 0, mode);
    writeU32(value, 4, flags);
    await this.controlOut(GS_USB_BREQ_MODE, this.channel, 0, value);
  }

  private async controlOut(request: number, value: number, index: number, data: DataView): Promise<void> {
    const result = await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request, value, index }, data.buffer);
    if (result.status !== 'ok') throw new Error(`gs_usb 控制请求 ${request} 失败：${result.status}`);
  }

  private async controlIn(request: number, value: number, index: number, length: number): Promise<DataView> {
    const result = await this.device.controlTransferIn({ requestType: 'vendor', recipient: 'interface', request, value, index }, length);
    if (result.status !== 'ok' || !result.data || result.data.byteLength < length) {
      throw new Error(`gs_usb 控制请求 ${request} 返回无效数据。`);
    }
    return result.data;
  }

  private async readLoop(generation: number): Promise<void> {
    while (this.readActive && generation === this.generation && this.device?.opened) {
      try {
        const result = await this.device.transferIn(this.endpointIn, 64);
        if (result.status !== 'ok' || !result.data) continue;
        for (let offset = 0; offset + CLASSIC_FRAME_SIZE <= result.data.byteLength; offset += CLASSIC_FRAME_SIZE) {
          this.parseFrame(result.data, offset);
        }
      } catch {
        if (this.readActive && generation === this.generation) {
          this.readActive = false;
          void this.closeDevice();
          this.onDisconnect('USB 读取中断，请检查设备连接或驱动占用。');
        }
        return;
      }
    }
  }

  private parseFrame(view: DataView, offset: number): void {
    const echoId = view.getUint32(offset, true);
    if (echoId !== RX_ECHO_ID) return;
    if (view.getUint8(offset + 9) !== this.channel) return;
    const rawId = view.getUint32(offset + 4, true);
    const dlc = Math.min(8, view.getUint8(offset + 8));
    const data = Array.from({ length: dlc }, (_, index) => view.getUint8(offset + 12 + index));
    this.onFrame({
      timestamp: new Date(), direction: 'rx', id: rawId & 0x1fffffff,
      extended: Boolean(rawId & CAN_EFF_FLAG), rtr: Boolean(rawId & CAN_RTR_FLAG),
      error: Boolean(rawId & CAN_ERR_FLAG), data,
    });
  }

  private async closeDevice(): Promise<void> {
    const device = this.device;
    this.device = null;
    if (!device?.opened) return;
    try { await device.releaseInterface(this.interfaceNumber); } catch { /* ignore */ }
    try { await device.close(); } catch { /* ignore */ }
  }
}

export function bootCanTool(): void {
  const usb = (navigator as Navigator & { usb?: UsbManager }).usb;
  const noApi = byId<HTMLElement>('can-no-api');
  const connectButton = byId<HTMLButtonElement>('can-connect');
  const disconnectButton = byId<HTMLButtonElement>('can-disconnect');
  const sendButton = byId<HTMLButtonElement>('can-send');
  const state = byId<HTMLElement>('can-state');
  const status = byId<HTMLElement>('can-status');
  const sendStatus = byId<HTMLElement>('can-send-status');
  const bitrateSelect = byId<HTMLInputElement>('can-bitrate');
  const channelSelect = byId<HTMLInputElement>('can-channel');
  const modeSelect = byId<HTMLInputElement>('can-mode');
  const bitrateDropdown = byId<HTMLElement>('can-bitrate-dd');
  const channelDropdown = byId<HTMLElement>('can-channel-dd');
  const modeDropdown = byId<HTMLElement>('can-mode-dd');
  const bitrateTrigger = bitrateDropdown.querySelector<HTMLButtonElement>('.serial-dd-trigger')!;
  const channelTrigger = channelDropdown.querySelector<HTMLButtonElement>('.serial-dd-trigger')!;
  const modeTrigger = modeDropdown.querySelector<HTMLButtonElement>('.serial-dd-trigger')!;
  const termination = byId<HTMLInputElement>('can-termination');
  const terminationNote = byId<HTMLElement>('can-termination-note');
  const deviceInfo = byId<HTMLElement>('can-device');
  const actualBitrate = byId<HTMLElement>('can-actual-bitrate');
  const logElement = byId<HTMLElement>('can-log');
  const empty = byId<HTMLElement>('can-empty');
  const tableWrap = byId<HTMLElement>('can-table-wrap');
  const filterInput = byId<HTMLInputElement>('can-filter');
  const directionFilter = byId<HTMLInputElement>('can-direction-filter');
  const directionDropdown = byId<HTMLElement>('can-direction-dd');
  const autoScroll = byId<HTMLInputElement>('can-auto-scroll');
  const pauseButton = byId<HTMLButtonElement>('can-pause');
  const sendForm = byId<HTMLFormElement>('can-send-form');
  const cycleCheckbox = byId<HTMLInputElement>('can-cycle');
  const intervalInput = byId<HTMLInputElement>('can-cycle-interval');
  const logs: CanFrame[] = [];
  let transport: GsUsbTransport | null = null;
  let usbConnected = false;
  let canRunning = false;
  let busy = false;
  let supportsTermination = false;
  let appliedConfig: { channel: number; bitrate: string; mode: string; termination: boolean } | null = null;
  let paused = false;
  let renderPending = false;
  let forceRender = true;
  let pendingFrames: CanFrame[] = [];
  let cycleRunning = false;
  let cycleTimer = 0;
  let cycleTarget = 0;
  const stats = { rx: 0, tx: 0, rxBytes: 0, errors: 0 };

  if (!usb) {
    noApi.hidden = false;
    connectButton.disabled = true;
    status.textContent = 'WebUSB 不可用。';
    return;
  }

  transport = new GsUsbTransport(usb);

  const setState = (next: 'disconnected' | 'connecting' | 'ready' | 'connected', label: string) => {
    state.dataset.state = next;
    const labelElement = state.querySelector('b');
    if (labelElement) labelElement.textContent = label;
  };

  const dropdownLabel = (root: HTMLElement): string =>
    root.querySelector<HTMLElement>('.serial-dd-trigger-label')?.textContent?.trim() ?? '';

  const setDropdownValue = (root: HTMLElement, input: HTMLInputElement, value: string) => {
    input.value = value;
    const item = root.querySelector<HTMLButtonElement>(`[role="option"][data-value="${CSS.escape(value)}"]`);
    const label = root.querySelector<HTMLElement>('.serial-dd-trigger-label');
    if (item && label) label.textContent = item.textContent?.trim() ?? value;
  };

  const populateChannelOptions = (count: number) => {
    const menu = channelDropdown.querySelector<HTMLElement>('.serial-dd-menu');
    if (!menu) return;
    menu.replaceChildren(...Array.from({ length: count }, (_, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'serial-dd-item';
      button.setAttribute('role', 'option');
      button.dataset.value = String(index);
      button.textContent = `CAN ${index}`;
      item.append(button);
      return item;
    }));
    setDropdownValue(channelDropdown, channelSelect, '0');
  };

  const syncState = () => {
    if (!usbConnected) setState('disconnected', '未连接');
    else if (canRunning) setState('connected', 'CAN 运行中');
    else setState('ready', 'USB 已连接');
  };

  const updateControls = () => {
    connectButton.disabled = busy || usbConnected;
    disconnectButton.disabled = busy || !usbConnected;
    sendButton.disabled = busy || !canRunning;
    bitrateTrigger.disabled = busy;
    channelTrigger.disabled = busy || !usbConnected;
    modeTrigger.disabled = busy;
    termination.disabled = busy || !usbConnected || !supportsTermination;
  };

  const applyChannelInfo = (info: Pick<ChannelInfo, 'features' | 'terminationEnabled'>) => {
    supportsTermination = Boolean(info.features & GS_CAN_FEATURE_TERMINATION);
    termination.checked = info.terminationEnabled;
    terminationNote.textContent = supportsTermination ? '设备支持软件切换' : '该通道不支持软件切换';
    const listenOption = modeDropdown.querySelector<HTMLButtonElement>('[role="option"][data-value="listen"]');
    const loopbackOption = modeDropdown.querySelector<HTMLButtonElement>('[role="option"][data-value="loopback"]');
    if (listenOption) listenOption.disabled = !(info.features & GS_CAN_FEATURE_LISTEN_ONLY);
    if (loopbackOption) loopbackOption.disabled = !(info.features & GS_CAN_FEATURE_LOOP_BACK);
    const selectedMode = modeDropdown.querySelector<HTMLButtonElement>(`[role="option"][data-value="${CSS.escape(modeSelect.value)}"]`);
    if (selectedMode?.disabled) setDropdownValue(modeDropdown, modeSelect, 'normal');
  };

  const applyConfiguration = async (refreshChannelCapabilities = false): Promise<void> => {
    if (!transport || !usbConnected || busy) return;
    busy = true;
    stopCycle();
    setState('connecting', '配置中');
    updateControls();
    status.textContent = '正在重启 CAN 通道并应用新配置…';
    try {
      const channel = Number(channelSelect.value);
      if (refreshChannelCapabilities) {
        terminationNote.textContent = '正在读取通道能力…';
        applyChannelInfo(await transport.getChannelInfo(channel));
      }
      const result = await transport.startChannel(
        channel, Number(bitrateSelect.value), modeSelect.value, termination.checked,
      );
      canRunning = true;
      applyChannelInfo(result);
      appliedConfig = {
        channel,
        bitrate: bitrateSelect.value,
        mode: modeSelect.value,
        termination: termination.checked,
      };
      actualBitrate.textContent = `${Math.round(result.timing.actualBitrate).toLocaleString('zh-CN')} bps · SP ${(result.timing.samplePoint * 100).toFixed(1)}%`;
      status.textContent = `CAN ${channelSelect.value} · ${dropdownLabel(bitrateDropdown)} · ${dropdownLabel(modeDropdown)} 已自动应用。`;
    } catch (error) {
      canRunning = transport.isRunning();
      let message = error instanceof Error ? error.message : 'CAN 配置应用失败。';
      if (canRunning && appliedConfig) {
        setDropdownValue(channelDropdown, channelSelect, String(appliedConfig.channel));
        setDropdownValue(bitrateDropdown, bitrateSelect, appliedConfig.bitrate);
        setDropdownValue(modeDropdown, modeSelect, appliedConfig.mode);
        try { applyChannelInfo(await transport.getChannelInfo(appliedConfig.channel)); } catch { /* Keep the last known capabilities. */ }
        termination.checked = appliedConfig.termination;
        message += '；界面已恢复到当前运行配置。';
      } else {
        actualBitrate.textContent = '未启动';
      }
      status.textContent = message;
    } finally {
      busy = false;
      syncState();
      updateControls();
    }
  };

  const updateStats = () => {
    byId('can-rx-count').textContent = String(stats.rx);
    byId('can-tx-count').textContent = String(stats.tx);
    byId('can-rx-bytes').textContent = String(stats.rxBytes);
    byId('can-error-count').textContent = String(stats.errors);
  };

  const matchesFilter = (frame: CanFrame): boolean => {
    const direction = directionFilter.value;
    if (direction === 'error' && !frame.error) return false;
    if ((direction === 'rx' || direction === 'tx') && frame.direction !== direction) return false;
    const query = filterInput.value.trim().toUpperCase().replace(/^0X/, '');
    if (!query) return true;
    const id = hex(frame.id, frame.extended ? 8 : 3);
    const data = frame.data.map((byte) => hex(byte, 2)).join(' ');
    return id.includes(query) || data.includes(query);
  };

  const createRow = (frame: CanFrame): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'can-table can-row';
      row.dataset.direction = frame.direction;
      row.dataset.error = String(frame.error);
      const frameType = frame.error ? '错误帧' : `${frame.extended ? '扩展' : '标准'}${frame.rtr ? ' · RTR' : ''}`;
      const data = frame.rtr ? 'Remote request' : frame.data.map((byte) => hex(byte, 2)).join(' ') || '—';
      const values = [formatTime(frame.timestamp), frame.error ? 'ERR' : frame.direction.toUpperCase(), `0x${hex(frame.id, frame.extended ? 8 : 3)}`, frameType, String(frame.data.length), data];
      values.forEach((value, index) => {
        const cell = index === 0 ? document.createElement('time') : document.createElement('span');
        cell.textContent = value;
        if (index === 1) cell.className = 'can-direction';
        if (index === 3) cell.className = 'can-frame-kind';
        if (index === 5) cell.className = 'can-frame-data';
        row.append(cell);
      });
      return row;
  };

  const render = () => {
    renderPending = false;
    if (paused) return;
    if (forceRender) {
      const visible = logs.filter(matchesFilter).slice(-1000);
      const fragment = document.createDocumentFragment();
      visible.forEach((frame) => fragment.append(createRow(frame)));
      logElement.replaceChildren(fragment);
      pendingFrames = [];
      forceRender = false;
    } else if (pendingFrames.length > 0) {
      const batch = pendingFrames;
      pendingFrames = [];
      const fragment = document.createDocumentFragment();
      batch.filter(matchesFilter).forEach((frame) => fragment.append(createRow(frame)));
      logElement.append(fragment);
      while (logElement.childElementCount > 1000) logElement.firstElementChild?.remove();
    }
    empty.hidden = logElement.childElementCount > 0;
    if (autoScroll.checked) tableWrap.scrollLeft = 0;
    if (autoScroll.checked) logElement.scrollTop = logElement.scrollHeight;
  };

  const scheduleRender = () => {
    if (renderPending || paused) return;
    renderPending = true;
    requestAnimationFrame(render);
  };

  const addFrame = (frame: CanFrame) => {
    logs.push(frame);
    pendingFrames.push(frame);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    if (frame.direction === 'rx') {
      stats.rx += 1;
      stats.rxBytes += frame.data.length;
      if (frame.error) stats.errors += 1;
    } else {
      stats.tx += 1;
    }
    updateStats();
    scheduleRender();
  };

  transport.onFrame = addFrame;
  transport.onDisconnect = (message) => {
    usbConnected = false;
    canRunning = false;
    busy = false;
    supportsTermination = false;
    appliedConfig = null;
    stopCycle();
    deviceInfo.hidden = true;
    syncState();
    updateControls();
    status.textContent = message;
  };

  connectButton.addEventListener('click', async () => {
    if (!transport) return;
    busy = true;
    setState('connecting', '连接中');
    updateControls();
    status.textContent = '正在打开 USB 设备、读取 gs_usb 配置并启动 CAN…';
    try {
      const result = await transport.connect();
      populateChannelOptions(result.channels);
      const device = transport.device;
      byId('can-device-name').textContent = device?.productName || device?.manufacturerName || 'gs_usb 设备';
      byId('can-device-id').textContent = `${hex(device?.vendorId ?? 0, 4)} / ${hex(device?.productId ?? 0, 4)}`;
      byId('can-device-version').textContent = `${formatVersion(result.swVersion)} / ${formatVersion(result.hwVersion)}`;
      actualBitrate.textContent = '未启动';
      deviceInfo.hidden = false;
      applyChannelInfo(result.channelInfo);
      usbConnected = true;
      try {
        const started = await transport.startChannel(
          0, Number(bitrateSelect.value), modeSelect.value, termination.checked,
        );
        canRunning = true;
        applyChannelInfo(started);
        appliedConfig = {
          channel: 0,
          bitrate: bitrateSelect.value,
          mode: modeSelect.value,
          termination: termination.checked,
        };
        actualBitrate.textContent = `${Math.round(started.timing.actualBitrate).toLocaleString('zh-CN')} bps · SP ${(started.timing.samplePoint * 100).toFixed(1)}%`;
        status.textContent = `USB 已连接，CAN 0 · ${dropdownLabel(bitrateDropdown)} · ${dropdownLabel(modeDropdown)} 已启动。`;
      } catch (error) {
        canRunning = transport.isRunning();
        actualBitrate.textContent = '未启动';
        status.textContent = error instanceof Error ? `USB 已连接，但 CAN 启动失败：${error.message}` : 'USB 已连接，但 CAN 启动失败。';
      }
    } catch (error) {
      usbConnected = false;
      canRunning = false;
      status.textContent = error instanceof Error ? error.message : '连接失败。';
    } finally {
      busy = false;
      syncState();
      updateControls();
    }
  });

  disconnectButton.addEventListener('click', async () => {
    busy = true;
    setState('connecting', '断开中');
    updateControls();
    status.textContent = '正在停止 CAN 并关闭 USB 设备…';
    stopCycle();
    try {
      await transport?.disconnect();
    } finally {
      usbConnected = false;
      canRunning = false;
      supportsTermination = false;
      appliedConfig = null;
      busy = false;
      deviceInfo.hidden = true;
      actualBitrate.textContent = '—';
      syncState();
      updateControls();
      status.textContent = '已断开 USB 设备。';
    }
  });

  termination.addEventListener('change', async () => {
    if (!usbConnected) return;
    termination.disabled = true;
    try {
      await transport?.setTermination(termination.checked, Number(channelSelect.value));
      if (appliedConfig?.channel === Number(channelSelect.value)) appliedConfig.termination = termination.checked;
      status.textContent = `CAN ${channelSelect.value} 的 120 Ω 终端电阻已${termination.checked ? '启用' : '关闭'}。`;
    } catch (error) {
      termination.checked = !termination.checked;
      status.textContent = error instanceof Error ? error.message : '终端电阻设置失败。';
    } finally {
      updateControls();
    }
  });

  const sendOnce = async (): Promise<void> => {
    const extended = byId<HTMLInputElement>('can-extended').checked;
    const rtr = byId<HTMLInputElement>('can-rtr').checked;
    const id = parseCanId(byId<HTMLInputElement>('can-send-id').value, extended);
    const data = rtr ? [] : parseHexBytes(byId<HTMLInputElement>('can-send-data').value);
    await transport?.send(id, extended, rtr, data);
    addFrame({ timestamp: new Date(), direction: 'tx', id, extended, rtr, error: false, data });
    sendStatus.dataset.error = 'false';
    sendStatus.textContent = `已发送 0x${hex(id, extended ? 8 : 3)}，DLC ${data.length}。`;
  };

  const runCycle = async () => {
    if (!cycleRunning) return;
    try {
      await sendOnce();
    } catch (error) {
      sendStatus.dataset.error = 'true';
      sendStatus.textContent = error instanceof Error ? error.message : '发送失败。';
      stopCycle();
      return;
    }
    const interval = Math.max(10, Number(intervalInput.value) || 1000);
    cycleTarget += interval;
    cycleTimer = window.setTimeout(runCycle, Math.max(0, cycleTarget - performance.now()));
  };

  function stopCycle(): void {
    cycleRunning = false;
    window.clearTimeout(cycleTimer);
    sendButton.dataset.running = 'false';
    sendButton.textContent = '发送帧';
  }

  sendForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (cycleRunning) {
      stopCycle();
      sendStatus.textContent = '循环发送已停止。';
      return;
    }
    try {
      if (cycleCheckbox.checked) {
        const interval = Math.max(10, Number(intervalInput.value) || 1000);
        intervalInput.value = String(interval);
        cycleRunning = true;
        cycleTarget = performance.now();
        sendButton.dataset.running = 'true';
        sendButton.textContent = '停止循环';
        await runCycle();
      } else {
        await sendOnce();
      }
    } catch (error) {
      sendStatus.dataset.error = 'true';
      sendStatus.textContent = error instanceof Error ? error.message : '发送失败。';
    }
  });

  pauseButton.addEventListener('click', () => {
    paused = !paused;
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.querySelector('span')!.textContent = paused ? '继续' : '暂停';
    if (!paused) {
      forceRender = true;
      pendingFrames = [];
      scheduleRender();
    }
  });

  const refreshFilter = () => {
    forceRender = true;
    pendingFrames = [];
    scheduleRender();
  };
  filterInput.addEventListener('input', refreshFilter);

  wireSerialDropdown(bitrateDropdown, (value) => {
    bitrateSelect.value = value;
    void applyConfiguration();
  });
  wireSerialDropdown(channelDropdown, (value) => {
    channelSelect.value = value;
    void applyConfiguration(true);
  });
  wireSerialDropdown(modeDropdown, (value) => {
    modeSelect.value = value;
    void applyConfiguration();
  });
  wireSerialDropdown(directionDropdown, (value) => {
    directionFilter.value = value;
    refreshFilter();
  });
  registerSerialDropdownOutsideClose();

  byId('can-clear').addEventListener('click', () => {
    logs.length = 0;
    pendingFrames = [];
    forceRender = true;
    stats.rx = 0; stats.tx = 0; stats.rxBytes = 0; stats.errors = 0;
    updateStats();
    paused = false;
    pauseButton.setAttribute('aria-pressed', 'false');
    pauseButton.querySelector('span')!.textContent = '暂停';
    render();
  });

  byId('can-export').addEventListener('click', () => {
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [['time', 'direction', 'can_id', 'frame_type', 'dlc', 'data_hex'], ...logs.map((frame) => [
      frame.timestamp.toISOString(), frame.direction.toUpperCase(), `0x${hex(frame.id, frame.extended ? 8 : 3)}`,
      frame.error ? 'error' : frame.extended ? (frame.rtr ? 'extended-rtr' : 'extended') : (frame.rtr ? 'standard-rtr' : 'standard'),
      String(frame.data.length), frame.data.map((byte) => hex(byte, 2)).join(' '),
    ])];
    const csv = `\uFEFF${rows.map((row) => row.map(escape).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `qdrive-can-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`; link.click();
    URL.revokeObjectURL(url);
  });

  window.addEventListener('pagehide', () => { void transport?.disconnect(); });
}
