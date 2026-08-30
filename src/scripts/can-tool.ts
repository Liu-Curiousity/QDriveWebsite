import { registerSerialDropdownOutsideClose, wireSerialDropdown } from './serial-dropdown';
import { wireAssistantTooltips } from './assistant-tooltip';

const GS_USB_BREQ_HOST_FORMAT = 0;
const GS_USB_BREQ_BITTIMING = 1;
const GS_USB_BREQ_MODE = 2;
const GS_USB_BREQ_BT_CONST = 4;
const GS_USB_BREQ_DEVICE_CONFIG = 5;
const GS_USB_BREQ_SET_TERMINATION = 12;
const GS_USB_BREQ_GET_TERMINATION = 13;
const GS_USB_BREQ_GET_STATE = 14;

const GS_CAN_MODE_RESET = 0;
const GS_CAN_MODE_START = 1;
const GS_CAN_FEATURE_LISTEN_ONLY = 1 << 0;
const GS_CAN_FEATURE_LOOP_BACK = 1 << 1;
const GS_CAN_FEATURE_ONE_SHOT = 1 << 3;
const GS_CAN_FEATURE_TERMINATION = 1 << 11;
const GS_CAN_FEATURE_BERR_REPORTING = 1 << 12;

const CAN_EFF_FLAG = 0x80000000;
const CAN_RTR_FLAG = 0x40000000;
const CAN_ERR_FLAG = 0x20000000;
// Linux SocketCAN error-class bits carried in the CAN ID of a gs_usb error frame.
const CAN_ERR_TX_TIMEOUT = 0x00000001;
const CAN_ERR_LOSTARB = 0x00000002;
const CAN_ERR_CRTL = 0x00000004;
const CAN_ERR_PROT = 0x00000008;
const CAN_ERR_TRX = 0x00000010;
const CAN_ERR_ACK = 0x00000020;
const CAN_ERR_BUSOFF = 0x00000040;
const CAN_ERR_BUSERROR = 0x00000080;
const CAN_ERR_RESTARTED = 0x00000100;
const CAN_ERR_CNT = 0x00000200;
const CAN_ERR_CLASS_MASK = 0x000003ff;
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

type DeviceState = {
  state: number;
  rxerr: number;
  txerr: number;
};

type CanFrame = {
  timestamp: Date;
  direction: 'rx' | 'tx';
  id: number;
  extended: boolean;
  rtr: boolean;
  error: boolean;
  dlc: number;
  data: number[];
};

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少页面元素 #${id}`);
  return element as T;
};

const hex = (value: number, width: number) => value.toString(16).toUpperCase().padStart(width, '0');
const writeU32 = (view: DataView, offset: number, value: number) => view.setUint32(offset, value >>> 0, true);

function formatTime(date: Date): string {
  return `${date.toLocaleTimeString('zh-CN', { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function parseHexBytes(raw: string): number[] {
  const groups = raw.trim().split(/\s+/).filter(Boolean);
  if (!groups.length) return [];
  if (groups.some((group) => !/^[0-9a-f]+$/i.test(group))) {
    throw new Error('HEX 数据只能包含 0–9、A–F 和空格。');
  }
  const bytes: number[] = [];
  for (const group of groups) {
    let index = 0;
    while (index + 1 < group.length) {
      bytes.push(Number.parseInt(group.slice(index, index + 2), 16));
      index += 2;
    }
    if (index < group.length) bytes.push(Number.parseInt(`0${group[index]}`, 16));
  }
  return bytes;
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

const CAN_ERR_CRTL_BITS: Array<[number, string]> = [
  [0x01, '接收缓冲区溢出'], [0x02, '发送缓冲区溢出'],
  [0x04, '接收达到警告级别'], [0x08, '发送达到警告级别'],
  [0x10, '接收错误被动'], [0x20, '发送错误被动'], [0x40, '恢复错误主动'],
];
const CAN_ERR_PROT_BITS: Array<[number, string]> = [
  [0x01, '单 bit 错误'], [0x02, '帧格式错误'], [0x04, '位填充错误'],
  [0x08, '无法发送显性位'], [0x10, '无法发送隐性位'],
  [0x20, '总线过载'], [0x40, '主动错误通告'], [0x80, '发送时发生'],
];
const CAN_ERR_PROT_LOCATIONS: Record<number, string> = {
  0x03: '帧起始（SOF）', 0x02: 'ID28–21', 0x06: 'ID20–18', 0x04: '替代 RTR（SRTR）',
  0x05: '标识符扩展（IDE）', 0x07: 'ID17–13', 0x0f: 'ID12–5', 0x0e: 'ID4–0',
  0x0c: 'RTR', 0x0d: '保留位 1', 0x09: '保留位 0', 0x0b: 'DLC', 0x0a: '数据段',
  0x08: 'CRC 序列', 0x18: 'CRC 分隔符', 0x19: 'ACK 槽', 0x1b: 'ACK 分隔符',
  0x1a: '帧结束（EOF）', 0x12: '帧间隔（intermission）',
};
const CAN_ERR_TRX_VALUES: Record<number, string> = {
  0x04: 'CANH 无连接', 0x05: 'CANH 短路到电池', 0x06: 'CANH 短路到 VCC', 0x07: 'CANH 短路到 GND',
  0x40: 'CANL 无连接', 0x50: 'CANL 短路到电池', 0x60: 'CANL 短路到 VCC', 0x70: 'CANL 短路到 GND',
  0x80: 'CANL 短路到 CANH',
};

/** Decode the SocketCAN error-frame mask and the eight protocol-specific bytes. */
function decodeCanError(mask: number, data: number[]): string[] {
  const byte = (index: number) => data[index] ?? 0;
  const details: string[] = [];
  const classes = mask & CAN_ERR_CLASS_MASK;
  const unknown = (mask & ~CAN_ERR_CLASS_MASK) >>> 0;

  if (classes === 0) details.push('错误类型未指定');
  if (classes & CAN_ERR_BUSERROR) details.push('总线错误');
  if (classes & CAN_ERR_TX_TIMEOUT) details.push('发送超时');
  if (classes & CAN_ERR_LOSTARB) details.push(`仲裁丢失：${byte(0) ? `位 ${byte(0)}` : '位号未指定'}`);
  if (classes & (CAN_ERR_PROT | CAN_ERR_ACK)) {
    const protocolDetails: string[] = [];
    if (classes & CAN_ERR_PROT) {
      const protocol = CAN_ERR_PROT_BITS.filter(([bit]) => byte(2) & bit).map(([, label]) => label);
      const protocolText = protocol.length ? protocol.join('、') : '';
      const location = CAN_ERR_PROT_LOCATIONS[byte(3)] ?? (byte(3) ? `未知位置（0x${hex(byte(3), 2)}）` : '');
      if (protocolText) protocolDetails.push(protocolText);
      if (location) protocolDetails.push(`位置：${location}`);
    }
    if (classes & CAN_ERR_ACK) protocolDetails.push('ACK 错误');
    details.push(protocolDetails.length ? `协议：${protocolDetails.join('；')}` : '协议');
  }
  if (classes & CAN_ERR_CRTL) {
    const state = CAN_ERR_CRTL_BITS.filter(([bit]) => byte(1) & bit).map(([, label]) => label);
    const unknownState = byte(1) & ~0x7f;
    details.push(`控制器：${state.length ? state.join('、') : '未指定'}${unknownState ? `；未知标志 0x${hex(unknownState, 2)}` : ''}`);
  }
  if (classes & CAN_ERR_TRX) {
    details.push(`收发器错误：${CAN_ERR_TRX_VALUES[byte(4)] ?? (byte(4) ? `未知状态（0x${hex(byte(4), 2)}）` : '未指定')}`);
  }
  if (classes & CAN_ERR_BUSOFF) details.push('总线关闭（BUS-OFF）');
  if (classes & CAN_ERR_RESTARTED) details.push('控制器已重启');
  if (classes & CAN_ERR_CNT) {
    details.push(`TEC: ${data.length > 6 ? byte(6) : '未提供'} REC: ${data.length > 7 ? byte(7) : '未提供'}`);
  }
  if (unknown) details.push(`未识别错误掩码：0x${hex(unknown, 8)}`);
  return details;
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

  async connect(previousDevice?: UsbDevice): Promise<{
    channels: number; swVersion: number; hwVersion: number; channelInfo: ChannelInfo;
  }> {
    const device = previousDevice ?? await this.usb.requestDevice({
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

  async startChannel(channel: number, bitrate: number, mode: string, termination: boolean, oneShot: boolean): Promise<{
    timing: BitTiming; features: number; terminationEnabled: boolean;
  }> {
    const info = await this.getChannelInfo(channel);
    const timing = calculateBitTiming(info.constants, bitrate);
    let flags = info.features & GS_CAN_FEATURE_BERR_REPORTING;
    if (oneShot) flags |= GS_CAN_FEATURE_ONE_SHOT;
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

  /** Read the optional gs_usb device state (state, RX error counter, TX error counter). */
  async getState(channel = this.channel): Promise<DeviceState> {
    if (!this.device?.opened) throw new Error('请先连接 USB 设备。');
    const value = await this.controlIn(GS_USB_BREQ_GET_STATE, channel, 0, 12);
    return {
      state: value.getUint32(0, true),
      rxerr: value.getUint32(4, true),
      txerr: value.getUint32(8, true),
    };
  }

  async send(id: number, extended: boolean, rtr: boolean, dlc: number, data: number[]): Promise<void> {
    if (!this.device?.opened || !this.channelRunning) throw new Error('请先启动 CAN 通道。');
    if (!Number.isInteger(dlc) || dlc < 0 || dlc > 8) throw new Error('经典 CAN 的 DLC 必须为 0–8。');
    const frame = new DataView(new ArrayBuffer(CLASSIC_FRAME_SIZE));
    writeU32(frame, 0, this.echoId++ % 10);
    let canId = id;
    if (extended) canId = (canId | CAN_EFF_FLAG) >>> 0;
    if (rtr) canId = (canId | CAN_RTR_FLAG) >>> 0;
    writeU32(frame, 4, canId);
    frame.setUint8(8, dlc);
    frame.setUint8(9, this.channel);
    if (!rtr) data.slice(0, dlc).forEach((byte, index) => frame.setUint8(12 + index, byte));
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
    const rtr = Boolean(rawId & CAN_RTR_FLAG);
    const data = rtr ? [] : Array.from({ length: dlc }, (_, index) => view.getUint8(offset + 12 + index));
    this.onFrame({
      timestamp: new Date(), direction: 'rx', id: rawId & 0x1fffffff,
      extended: Boolean(rawId & CAN_EFF_FLAG), rtr,
      error: Boolean(rawId & CAN_ERR_FLAG), dlc, data,
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
  const sendIdInput = byId<HTMLInputElement>('can-send-id');
  const sendDataInput = byId<HTMLInputElement>('can-send-data');
  const extendedCheckbox = byId<HTMLInputElement>('can-extended');
  const rtrCheckbox = byId<HTMLInputElement>('can-rtr');
  const dlcSelect = byId<HTMLInputElement>('can-dlc');
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
  const oneShot = byId<HTMLInputElement>('can-one-shot');
  const oneShotNote = byId<HTMLElement>('can-one-shot-note');
  const logElement = byId<HTMLElement>('can-log');
  const empty = byId<HTMLElement>('can-empty');
  const exportButton = byId<HTMLButtonElement>('can-export');
  const filterIdInput = byId<HTMLInputElement>('can-filter-id');
  const filterDataInput = byId<HTMLInputElement>('can-filter-data');
  const filterIdClear = byId<HTMLButtonElement>('can-filter-id-clear');
  const filterDataClear = byId<HTMLButtonElement>('can-filter-data-clear');
  const directionFilter = byId<HTMLInputElement>('can-direction-filter');
  const directionDropdown = byId<HTMLElement>('can-direction-dd');
  const frameTypeFilter = byId<HTMLInputElement>('can-frame-type-filter');
  const frameTypeDropdown = byId<HTMLElement>('can-frame-type-dd');
  const frameTypeTrigger = frameTypeDropdown.querySelector<HTMLButtonElement>('.serial-dd-trigger')!;
  const frameTypeMenu = byId<HTMLElement>('can-frame-type-menu');
  const frameTypeChecks = Array.from(frameTypeMenu.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  const errorDisplayToggle = byId<HTMLButtonElement>('can-error-display');
  const deviceErrorState = byId<HTMLElement>('can-device-error-state');
  const deviceTec = byId<HTMLElement>('can-device-tec');
  const deviceRec = byId<HTMLElement>('can-device-rec');
  const deviceErrorDetail = byId<HTMLElement>('can-device-error-detail');
  const deviceStateSource = byId<HTMLElement>('can-device-state-source');

  const sizeFilterDropdown = (root: HTMLElement, trigger: HTMLButtonElement, labels: string[]) => {
    const style = getComputedStyle(trigger);
    const probe = document.createElement('span');
    probe.style.cssText = [
      'position:absolute', 'visibility:hidden', 'white-space:nowrap', 'pointer-events:none',
      `font-family:${style.fontFamily}`, `font-size:${style.fontSize}`, `font-weight:${style.fontWeight}`,
      `letter-spacing:${style.letterSpacing}`,
    ].join(';');
    document.body.append(probe);
    const textWidth = Math.max(...labels.map((label) => {
      probe.textContent = label;
      return probe.getBoundingClientRect().width;
    }));
    probe.remove();
    const px = (value: string) => Number.parseFloat(value) || 0;
    const chevron = trigger.querySelector<HTMLElement>('.serial-dd-chevron');
    const width = Math.ceil(
      textWidth + px(style.paddingLeft) + px(style.paddingRight) + px(style.gap)
      + (chevron ? px(getComputedStyle(chevron).width) : 0)
      + px(style.borderLeftWidth) + px(style.borderRightWidth),
    );
    root.style.setProperty('--can-filter-width', `${width}px`);
  };

  sizeFilterDropdown(
    directionDropdown,
    directionDropdown.querySelector<HTMLButtonElement>('.serial-dd-trigger')!,
    Array.from(directionDropdown.querySelectorAll<HTMLElement>('[role="option"]')).map((option) => option.textContent?.trim() ?? ''),
  );
  sizeFilterDropdown(
    frameTypeDropdown,
    frameTypeTrigger,
    [frameTypeTrigger.querySelector<HTMLElement>('.serial-dd-trigger-label')?.textContent?.trim() ?? '', ...frameTypeChecks.map((input) => input.parentElement?.textContent?.trim() ?? '')],
  );
  const sendForm = byId<HTMLFormElement>('can-send-form');
  const cycleEnabled = byId<HTMLInputElement>('can-cycle-enabled');
  const intervalInput = byId<HTMLInputElement>('can-cycle-interval');
  const cycleCountInput = byId<HTMLInputElement>('can-cycle-count');
  const sendControl = byId<HTMLElement>('can-send-control');
  const sendToggle = byId<HTMLButtonElement>('can-send-toggle');
  const sendMenu = byId<HTMLElement>('can-send-menu');
  const sendMethod = byId<HTMLButtonElement>('can-send-method');
  const sendLabel = byId<HTMLElement>('can-send-label');
  const logs: CanFrame[] = [];
  let transport: GsUsbTransport | null = null;
  let lastDevice: UsbDevice | null = null;
  let usbConnected = false;
  let canRunning = false;
  let busy = false;
  let supportsTermination = false;
  let supportsOneShot = false;
  let appliedConfig: { channel: number; bitrate: string; mode: string; termination: boolean; oneShot: boolean } | null = null;
  let renderPending = false;
  let forceRender = true;
  let pendingFrames: CanFrame[] = [];
  let cycleRunning = false;
  let cycleTimer: number | null = null;
  let cycleRunId = 0;
  let cycleSent = 0;
  let cycleTotal = 0;
  let showParsedErrors = true;
  let statePollTimer: number | null = null;
  let statePollInFlight = false;
  let supportsGetState: boolean | null = null;
  const statePollInterval = 1000;
  let lastErrorFrameAt = 0;
  let lastStatePollAt = 0;
  let errorFrameVersion = 0;
  type DisplayDeviceState = 'unknown' | 'none' | 'active' | 'passive' | 'busoff';
  const deviceState = { state: 'unknown' as DisplayDeviceState, tec: null as number | null, rec: null as number | null };
  const stats = { rx: 0, tx: 0, errors: 0 };
  const syncLogActions = () => {
    exportButton.disabled = logs.length === 0;
  };
  syncLogActions();

  if (!usb) {
    noApi.hidden = false;
    connectButton.disabled = true;
    status.textContent = 'WebUSB 不可用。';
    return;
  }

  const wireTooltipTarget = wireAssistantTooltips(document.querySelector('.can-tool') ?? document);
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

  const sanitizeHexInput = (input: HTMLInputElement, maxLength: number) => {
    const original = input.value;
    const selection = input.selectionStart ?? original.length;
    const normalized = original.replace(/[^0-9a-f]/gi, '').toUpperCase().slice(0, maxLength);
    if (normalized === original) return;
    const nextSelection = Math.min(
      normalized.length,
      original.slice(0, selection).replace(/[^0-9a-f]/gi, '').length,
    );
    input.value = normalized;
    input.setSelectionRange(nextSelection, nextSelection);
  };

  const sanitizeHexDataElement = (input: HTMLInputElement) => {
    const original = input.value;
    const normalized = original.replace(/[^0-9a-f\s]/gi, '').replace(/\s/g, ' ').toUpperCase();
    if (normalized === original) return;
    const selection = input.selectionStart ?? original.length;
    const validBeforeSelection = original.slice(0, selection).replace(/[^0-9a-f\s]/gi, '').length;
    input.value = normalized;
    input.setSelectionRange(validBeforeSelection, validBeforeSelection);
  };

  const insertHexDataText = (value: string) => {
    const filtered = value.replace(/[^0-9a-f\s]/gi, '').replace(/\s/g, ' ').toUpperCase();
    if (!filtered) return;
    const start = sendDataInput.selectionStart ?? sendDataInput.value.length;
    const end = sendDataInput.selectionEnd ?? sendDataInput.value.length;
    sendDataInput.setRangeText(filtered, start, end, 'end');
    sendDataInput.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const sanitizeHexDataInput = () => {
    sanitizeHexDataElement(sendDataInput);
  };

  const formatHexDataInput = () => {
    sendDataInput.value = parseHexBytes(sendDataInput.value).map((byte) => hex(byte, 2)).join(' ');
    sendDataInput.setSelectionRange(sendDataInput.value.length, sendDataInput.value.length);
  };

  const syncIdPlaceholder = () => {
    sendIdInput.placeholder = extendedCheckbox.checked
      ? '00000000–1FFFFFFF'
      : '000–7FF';
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
    disconnectButton.textContent = usbConnected ? '断开' : lastDevice ? '重连' : '断开';
    disconnectButton.disabled = busy || (!usbConnected && !lastDevice);
    sendButton.disabled = busy || !canRunning;
    sendToggle.disabled = busy || !canRunning || cycleRunning;
    if (busy || !canRunning) setSendMenu(false);
    bitrateTrigger.disabled = busy;
    channelTrigger.disabled = busy || !usbConnected;
    modeTrigger.disabled = busy;
    termination.disabled = busy || !usbConnected || !supportsTermination;
    oneShot.disabled = busy || !usbConnected || !supportsOneShot;
  };

  const applyChannelInfo = (info: Pick<ChannelInfo, 'features' | 'terminationEnabled'>) => {
    supportsTermination = Boolean(info.features & GS_CAN_FEATURE_TERMINATION);
    supportsOneShot = Boolean(info.features & GS_CAN_FEATURE_ONE_SHOT);
    termination.checked = info.terminationEnabled;
    terminationNote.textContent = supportsTermination ? '设备支持软件切换' : '该通道不支持软件切换';
    oneShotNote.textContent = supportsOneShot ? '发送失败时不自动重发' : '该通道不支持此功能';
    if (!supportsOneShot) oneShot.checked = false;
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
    stopStatePolling();
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
        channel, Number(bitrateSelect.value), modeSelect.value, termination.checked, oneShot.checked,
      );
      canRunning = true;
      applyChannelInfo(result);
      appliedConfig = {
        channel,
        bitrate: bitrateSelect.value,
        mode: modeSelect.value,
        termination: termination.checked,
        oneShot: oneShot.checked,
      };
      status.textContent = `CAN ${channelSelect.value} · ${dropdownLabel(bitrateDropdown)} · ${dropdownLabel(modeDropdown)} 已自动应用。`;
      startStatePolling();
    } catch (error) {
      canRunning = transport.isRunning();
      let message = error instanceof Error ? error.message : 'CAN 配置应用失败。';
      if (canRunning && appliedConfig) {
        setDropdownValue(channelDropdown, channelSelect, String(appliedConfig.channel));
        setDropdownValue(bitrateDropdown, bitrateSelect, appliedConfig.bitrate);
        setDropdownValue(modeDropdown, modeSelect, appliedConfig.mode);
        try { applyChannelInfo(await transport.getChannelInfo(appliedConfig.channel)); } catch { /* Keep the last known capabilities. */ }
        termination.checked = appliedConfig.termination;
        oneShot.checked = appliedConfig.oneShot;
        message += '；界面已恢复到当前运行配置。';
        startStatePolling();
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
    byId('can-error-count').textContent = String(stats.errors);
  };

  const deviceStateLabel = (value: DisplayDeviceState): string => ({
    unknown: '未读取', none: '无错误', active: '主动错误', passive: '被动错误', busoff: 'Bus off',
  }[value]);

  const syncDeviceStateUi = () => {
    deviceErrorState.dataset.state = deviceState.state;
    deviceErrorState.textContent = deviceStateLabel(deviceState.state);
    deviceTec.textContent = deviceState.tec === null ? '—' : String(deviceState.tec);
    deviceRec.textContent = deviceState.rec === null ? '—' : String(deviceState.rec);
  };

  const setDeviceState = (stateValue: DisplayDeviceState, tec?: number | null, rec?: number | null) => {
    deviceState.state = stateValue;
    if (tec !== undefined) deviceState.tec = tec;
    if (rec !== undefined) deviceState.rec = rec;
    syncDeviceStateUi();
  };

  const setDeviceStateFromGetState = (value: DeviceState) => {
    const stateValue: DisplayDeviceState = value.state === 3
      ? 'busoff'
      : value.state === 2
        ? 'passive'
        : value.state === 1
          ? 'active'
          : value.state === 0
            ? (value.txerr === 0 && value.rxerr === 0 ? 'none' : 'active')
            : 'unknown';
    setDeviceState(stateValue, value.txerr, value.rxerr);
  };

  const updateDeviceStateFromErrorFrame = (frame: CanFrame) => {
    if (!frame.error) return;
    lastErrorFrameAt = performance.now();
    errorFrameVersion += 1;
    if (!statePollInFlight) scheduleStatePoll();
    const mask = frame.id & CAN_ERR_CLASS_MASK;
    const controller = frame.data[1] ?? 0;
    let stateValue: DisplayDeviceState = 'active';
    if (mask & CAN_ERR_BUSOFF) stateValue = 'busoff';
    else if (controller & (0x10 | 0x20)) stateValue = 'passive';
    else if (controller & 0x40) {
      const hasCounters = Boolean(mask & CAN_ERR_CNT);
      stateValue = hasCounters && frame.data[6] === 0 && frame.data[7] === 0 ? 'none' : 'active';
    }
    // Without GET_STATE, keep a severe state until the device explicitly reports recovery.
    if (stateValue === 'active' && (deviceState.state === 'busoff' || deviceState.state === 'passive')) {
      stateValue = deviceState.state;
    }
    const hasCounters = Boolean(mask & CAN_ERR_CNT);
    setDeviceState(
      stateValue,
      hasCounters && frame.data.length > 6 ? frame.data[6] : undefined,
      hasCounters && frame.data.length > 7 ? frame.data[7] : undefined,
    );
    const details = decodeCanError(frame.id, frame.data).filter((item) => !/^TEC: /.test(item));
    deviceErrorDetail.textContent = details.length ? details.join('；') : '收到错误反馈';
    deviceStateSource.textContent = supportsGetState === false ? '根据错误帧反馈更新' : '错误帧反馈 · GET_STATE';
  };

  const stopStatePolling = () => {
    if (statePollTimer !== null) window.clearTimeout(statePollTimer);
    statePollTimer = null;
  };

  const scheduleStatePoll = () => {
    stopStatePolling();
    if (!supportsGetState || !usbConnected || !canRunning || statePollInFlight) return;
    const lastStateActivityAt = Math.max(lastErrorFrameAt, lastStatePollAt);
    const delay = lastStateActivityAt > 0
      ? Math.max(0, statePollInterval - (performance.now() - lastStateActivityAt))
      : statePollInterval;
    statePollTimer = window.setTimeout(() => { void pollDeviceState(); }, delay);
  };

  const pollDeviceState = async () => {
    if (!transport || !usbConnected || !canRunning || statePollInFlight || supportsGetState === false) return;
    if (lastErrorFrameAt > 0 && performance.now() - lastErrorFrameAt < statePollInterval) {
      scheduleStatePoll();
      return;
    }
    statePollInFlight = true;
    const requestErrorFrameVersion = errorFrameVersion;
    try {
      const value = await transport.getState(Number(channelSelect.value));
      if (!usbConnected || !canRunning) return;
      supportsGetState = true;
      if (requestErrorFrameVersion === errorFrameVersion) {
        setDeviceStateFromGetState(value);
        deviceStateSource.textContent = '由 GET_STATE 定时读取 · 错误帧同步';
      }
    } catch {
      supportsGetState = false;
      deviceStateSource.textContent = '设备不支持 GET_STATE · 根据错误帧反馈更新';
    } finally {
      lastStatePollAt = performance.now();
      statePollInFlight = false;
      scheduleStatePoll();
    }
  };

  const startStatePolling = () => {
    stopStatePolling();
    supportsGetState = null;
    lastErrorFrameAt = 0;
    lastStatePollAt = 0;
    errorFrameVersion += 1;
    setDeviceState('unknown', null, null);
    deviceErrorDetail.textContent = '暂无错误反馈';
    deviceStateSource.textContent = '正在读取设备状态…';
    void pollDeviceState();
  };

  const matchesFilter = (frame: CanFrame): boolean => {
    const direction = directionFilter.value;
    if ((direction === 'rx' || direction === 'tx') && frame.direction !== direction) return false;
    const selectedTypes = new Set(frameTypeFilter.value.split(',').filter(Boolean));
    const frameType = frame.error ? 'error' : frame.rtr ? 'rtr' : frame.extended ? 'extended' : 'standard';
    if (!selectedTypes.has(frameType)) return false;
    const idQuery = filterIdInput.value.trim().toUpperCase().replace(/^0X/, '');
    const dataQuery = filterDataInput.value.replace(/\s/g, '').toUpperCase();
    const id = hex(frame.id, frame.extended ? 8 : 3);
    const data = frame.data.map((byte) => hex(byte, 2)).join('');
    return (!idQuery || id.includes(idQuery)) && (!dataQuery || data.includes(dataQuery));
  };

  const createRow = (frame: CanFrame): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'can-table can-row';
      row.dataset.direction = frame.direction;
      row.dataset.error = String(frame.error);
      const rawData = frame.rtr ? 'Remote request' : frame.data.map((byte) => hex(byte, 2)).join(' ') || '—';
      const parsedDetails = frame.error ? decodeCanError(frame.id, frame.data) : [];
      if (frame.error && showParsedErrors) {
        const time = document.createElement('time');
        time.textContent = formatTime(frame.timestamp);
        row.append(time);
        const direction = document.createElement('span');
        direction.className = 'can-direction';
        direction.textContent = 'ERR';
        row.append(direction);
        const detail = document.createElement('span');
        detail.className = 'can-error-parsed';
        detail.textContent = parsedDetails.join('；');
        detail.replaceChildren();
        const counterText = parsedDetails.find((text) => /^TEC: ([^ ]+) REC: (.+)$/.test(text));
        const regularDetails = parsedDetails.filter((text) => !/^TEC: ([^ ]+) REC: (.+)$/.test(text));
        const counter = counterText?.match(/^TEC: ([^ ]+) REC: (.+)$/);
        if (counter) {
          const counters = document.createElement('span');
          counters.className = 'can-error-counters';
          const tec = document.createElement('span');
          tec.className = 'can-error-counter';
          tec.textContent = `TEC: ${counter[1]}`;
          tec.dataset.tooltip = '发送错误计数';
          wireTooltipTarget(tec);
          const rec = document.createElement('span');
          rec.className = 'can-error-counter';
          rec.textContent = `REC: ${counter[2]}`;
          rec.dataset.tooltip = '接收错误计数';
          wireTooltipTarget(rec);
          counters.append(tec, rec);
          detail.append(counters);
        }
        regularDetails.forEach((text, index) => {
          if (index > 0) {
            const separator = document.createElement('span');
            separator.className = 'can-error-separator';
            separator.textContent = '|';
            detail.append(separator);
          }
          const splitAt = text.indexOf('：');
          const group = document.createElement('span');
          group.className = 'can-error-group';
          const category = document.createElement('span');
          category.className = 'can-error-category';
          category.textContent = splitAt > 0 ? text.slice(0, splitAt) : text;
          group.append(category);
          if (splitAt > 0 && text.slice(splitAt + 1)) {
            const hierarchy = document.createElement('span');
            hierarchy.className = 'can-error-hierarchy';
            hierarchy.textContent = '›';
            const subdetail = document.createElement('span');
            subdetail.className = 'can-error-subdetail';
            subdetail.textContent = text.slice(splitAt + 1).replace(/；/g, ' | ');
            group.append(hierarchy, subdetail);
          }
          detail.append(group);
        });
        row.append(detail);
        return row;
      }
      const values = [
        formatTime(frame.timestamp),
        frame.error ? 'ERR' : frame.direction.toUpperCase(),
        `0x${hex(frame.id, frame.error || frame.extended ? 8 : 3)}`,
        frame.error ? '错误帧' : `${frame.extended ? '扩展' : '标准'}${frame.rtr ? ' · RTR' : ''}`,
        String(frame.dlc),
        rawData,
      ];
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

  const isLogAtBottom = (): boolean =>
    logElement.scrollHeight - logElement.scrollTop - logElement.clientHeight <= 4;

  const scrollToBottom = (): void => {
    logElement.scrollTop = logElement.scrollHeight;
  };

  const render = () => {
    renderPending = false;
    const followOutput = isLogAtBottom();
    const previousScrollTop = logElement.scrollTop;
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
    if (followOutput) scrollToBottom();
    else logElement.scrollTop = previousScrollTop;
  };

  const scheduleRender = () => {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(render);
  };

  const syncErrorDisplayToggle = (rerender = false) => {
    errorDisplayToggle.textContent = showParsedErrors ? '解析' : '原始';
    errorDisplayToggle.setAttribute('aria-pressed', String(showParsedErrors));
    errorDisplayToggle.setAttribute('aria-label', `错误帧显示${showParsedErrors ? '解析信息' : '原始信息'}`);
    errorDisplayToggle.dataset.tooltip = `切换为${showParsedErrors ? '原始信息' : '解析信息'}`;
    if (rerender) {
      forceRender = true;
      scheduleRender();
    }
  };

  const addFrame = (frame: CanFrame) => {
    logs.push(frame);
    syncLogActions();
    pendingFrames.push(frame);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    updateDeviceStateFromErrorFrame(frame);
    if (frame.direction === 'rx') {
      stats.rx += 1;
      if (frame.error) stats.errors += 1;
    } else {
      stats.tx += 1;
    }
    updateStats();
    scheduleRender();
  };

  transport.onFrame = addFrame;
  transport.onDisconnect = (message) => {
    stopStatePolling();
    supportsGetState = null;
    lastErrorFrameAt = 0;
    lastStatePollAt = 0;
    errorFrameVersion += 1;
    setDeviceState('unknown', null, null);
    deviceErrorDetail.textContent = '暂无错误反馈';
    deviceStateSource.textContent = '连接后读取设备状态';
    usbConnected = false;
    canRunning = false;
    busy = false;
    supportsTermination = false;
    appliedConfig = null;
    if (message === 'USB 设备已拔出。') lastDevice = null;
    stopCycle();
    syncState();
    updateControls();
    status.textContent = message;
  };

  const connectDevice = async (previousDevice?: UsbDevice): Promise<void> => {
    if (!transport) return;
    const reconnecting = Boolean(previousDevice);
    busy = true;
    setState('connecting', '连接中');
    updateControls();
    status.textContent = reconnecting
      ? '正在重新连接上一次选择的 USB 设备…'
      : '请选择 USB 设备并等待 CAN 启动…';
    try {
      const result = await transport.connect(previousDevice);
      lastDevice = transport.device;
      populateChannelOptions(result.channels);
      applyChannelInfo(result.channelInfo);
      usbConnected = true;
      try {
        const started = await transport.startChannel(
          0, Number(bitrateSelect.value), modeSelect.value, termination.checked, oneShot.checked,
        );
        canRunning = true;
        applyChannelInfo(started);
        appliedConfig = {
          channel: 0,
          bitrate: bitrateSelect.value,
          mode: modeSelect.value,
          termination: termination.checked,
          oneShot: oneShot.checked,
        };
        status.textContent = `USB 已连接，CAN 0 · ${dropdownLabel(bitrateDropdown)} · ${dropdownLabel(modeDropdown)} 已启动。`;
        startStatePolling();
      } catch (error) {
        canRunning = transport.isRunning();
        status.textContent = error instanceof Error ? `USB 已连接，但 CAN 启动失败：${error.message}` : 'USB 已连接，但 CAN 启动失败。';
      }
    } catch (error) {
      usbConnected = false;
      canRunning = false;
      const message = error instanceof Error ? error.message : '连接失败。';
      status.textContent = reconnecting ? `重连失败：${message}` : message;
    } finally {
      busy = false;
      syncState();
      updateControls();
    }
  };

  connectButton.addEventListener('click', () => { void connectDevice(); });

  disconnectButton.addEventListener('click', async () => {
    if (!usbConnected) {
      if (lastDevice) void connectDevice(lastDevice);
      return;
    }
    busy = true;
    setState('connecting', '断开中');
    updateControls();
    status.textContent = '正在停止 CAN 并关闭 USB 设备…';
    stopCycle();
    try {
      await transport?.disconnect();
    } finally {
      stopStatePolling();
      supportsGetState = null;
      lastErrorFrameAt = 0;
      lastStatePollAt = 0;
      errorFrameVersion += 1;
      setDeviceState('unknown', null, null);
      deviceErrorDetail.textContent = '暂无错误反馈';
      deviceStateSource.textContent = '连接后读取设备状态';
      usbConnected = false;
      canRunning = false;
      supportsTermination = false;
      appliedConfig = null;
      busy = false;
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

  oneShot.addEventListener('change', () => {
    if (!usbConnected) return;
    void applyConfiguration();
  });

  const readSendFrame = () => {
    const extended = extendedCheckbox.checked;
    const rtr = rtrCheckbox.checked;
    const dlc = Number(dlcSelect.value);
    const id = parseCanId(sendIdInput.value, extended);
    if (!Number.isInteger(dlc) || dlc < 0 || dlc > 8) throw new Error('经典 CAN 的 DLC 必须为 0–8。');
    const enteredData = rtr || dlc === 0 ? [] : parseHexBytes(sendDataInput.value);
    const data = rtr ? [] : Array.from({ length: dlc }, (_, index) => enteredData[index] ?? 0);
    if (!rtr) sendDataInput.value = data.map((byte) => hex(byte, 2)).join(' ');
    return { extended, rtr, id, dlc, data };
  };

  const sendOnce = async (): Promise<boolean> => {
    if (!transport || !canRunning) {
      sendStatus.dataset.error = 'true';
      sendStatus.textContent = '请先连接并启动 CAN。';
      return false;
    }
    try {
      const frame = readSendFrame();
      await transport.send(frame.id, frame.extended, frame.rtr, frame.dlc, frame.data);
      addFrame({ timestamp: new Date(), direction: 'tx', error: false, ...frame });
      sendStatus.dataset.error = 'false';
      sendStatus.textContent = `已发送 0x${hex(frame.id, frame.extended ? 8 : 3)}，DLC ${frame.dlc}。`;
      return true;
    } catch (error) {
      sendStatus.dataset.error = 'true';
      sendStatus.textContent = error instanceof Error ? error.message : '发送失败。';
      return false;
    }
  };

  const cycleIntervalError = (): string => {
    const value = Number(intervalInput.value);
    return Number.isFinite(value) && value >= 10 && value <= 86400000
      ? ''
      : '循环间隔需为 10–86400000 ms。';
  };

  const cycleCountError = (): string => {
    const value = Number(cycleCountInput.value);
    return Number.isInteger(value) && (value === -1 || (value >= 1 && value <= 100000))
      ? ''
      : '发送次数需为 -1（无限）或 1–100000 次的整数。';
  };

  function setSendMenu(open: boolean): void {
    sendMenu.hidden = !open;
    sendToggle.setAttribute('aria-expanded', String(open));
  }

  function syncCycleUi(): void {
    sendMethod.setAttribute('aria-pressed', String(cycleEnabled.checked));
    if (!cycleRunning) sendLabel.textContent = cycleEnabled.checked ? '循环发送' : '发送帧';
  }

  function updateCycleProgress(): void {
    sendLabel.textContent = `停止循环 ${cycleSent}/${cycleTotal === -1 ? '∞' : cycleTotal}`;
  }

  function stopCycle(message?: string): void {
    if (cycleTimer !== null) window.clearTimeout(cycleTimer);
    cycleTimer = null;
    cycleRunId += 1;
    const wasRunning = cycleRunning;
    cycleRunning = false;
    cycleSent = 0;
    cycleTotal = 0;
    sendControl.dataset.running = 'false';
    intervalInput.disabled = false;
    cycleCountInput.disabled = false;
    sendToggle.disabled = busy || !canRunning;
    syncCycleUi();
    if (wasRunning && message) {
      sendStatus.dataset.error = String(message.includes('错误'));
      sendStatus.textContent = message;
    }
  }

  async function startCycle(): Promise<void> {
    if (!canRunning) return;
    const intervalError = cycleIntervalError();
    const countError = cycleCountError();
    if (intervalError || countError) {
      const input = intervalError ? intervalInput : cycleCountInput;
      sendStatus.dataset.error = 'true';
      sendStatus.textContent = intervalError || countError;
      setSendMenu(true);
      input.focus();
      return;
    }
    try {
      readSendFrame();
    } catch (error) {
      sendStatus.dataset.error = 'true';
      sendStatus.textContent = error instanceof Error ? error.message : 'CAN 帧参数无效。';
      return;
    }

    const interval = Number(intervalInput.value);
    cycleRunning = true;
    const runId = ++cycleRunId;
    cycleSent = 0;
    cycleTotal = Number(cycleCountInput.value);
    sendControl.dataset.running = 'true';
    intervalInput.disabled = true;
    cycleCountInput.disabled = true;
    sendToggle.disabled = true;
    setSendMenu(false);
    updateCycleProgress();

    let nextSendAt = performance.now();
    const sendNext = async () => {
      if (!cycleRunning || cycleRunId !== runId) return;
      const succeeded = await sendOnce();
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
      cycleTimer = window.setTimeout(() => { void sendNext(); }, Math.max(0, nextSendAt - performance.now()));
    };
    await sendNext();
  }

  sendForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (cycleRunning) {
      stopCycle('循环发送已停止。');
    } else if (cycleEnabled.checked) {
      void startCycle();
    } else {
      void sendOnce();
    }
  });

  sendMethod.addEventListener('click', () => {
    cycleEnabled.checked = !cycleEnabled.checked;
    syncCycleUi();
  });
  sendIdInput.addEventListener('input', () => { sanitizeHexInput(sendIdInput, 8); });
  extendedCheckbox.addEventListener('change', syncIdPlaceholder);
  syncIdPlaceholder();
  sendDataInput.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const commandKey = event.ctrlKey || event.metaKey;
    const formatShortcut = commandKey && (
      (key === 's' && !event.shiftKey && !event.altKey)
      || (key === 'f' && event.shiftKey && !event.altKey)
      || (key === 'l' && !event.shiftKey && event.altKey)
    );
    if (!formatShortcut) return;
    event.preventDefault();
    formatHexDataInput();
  });
  sendDataInput.addEventListener('beforeinput', (event) => {
    if (!event.inputType.startsWith('insert') || event.data === null) return;
    if (/^[0-9a-f ]*$/i.test(event.data)) return;
    event.preventDefault();
    insertHexDataText(event.data);
  });
  sendDataInput.addEventListener('paste', (event) => {
    event.preventDefault();
    insertHexDataText(event.clipboardData?.getData('text') ?? '');
  });
  sendDataInput.addEventListener('input', sanitizeHexDataInput);
  let lastValidDlc = /^[0-8]$/.test(dlcSelect.value) ? dlcSelect.value : '';
  dlcSelect.addEventListener('beforeinput', (event) => {
    if (!event.inputType.startsWith('insert') || event.data === null) return;
    if (dlcSelect.value === '' && /^[0-8]$/.test(event.data)) return;
    event.preventDefault();
  });
  dlcSelect.addEventListener('paste', (event) => {
    event.preventDefault();
    const value = event.clipboardData?.getData('text').trim() ?? '';
    if (dlcSelect.value !== '' || !/^[0-8]$/.test(value)) return;
    dlcSelect.value = value;
    dlcSelect.dispatchEvent(new Event('input', { bubbles: true }));
  });
  dlcSelect.addEventListener('input', () => {
    if (dlcSelect.value === '') {
      lastValidDlc = '';
      return;
    }
    if (/^[0-8]$/.test(dlcSelect.value)) {
      lastValidDlc = dlcSelect.value;
      return;
    }
    dlcSelect.value = lastValidDlc;
  });
  rtrCheckbox.addEventListener('change', () => {
    sendDataInput.disabled = rtrCheckbox.checked;
  });
  [intervalInput, cycleCountInput].forEach((input) => {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
    });
  });
  sendToggle.addEventListener('click', () => { setSendMenu(sendMenu.hidden); });
  document.addEventListener('pointerdown', (event) => {
    if (!sendMenu.hidden && !sendControl.contains(event.target as Node)) setSendMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sendToggle.getAttribute('aria-expanded') === 'true') {
      setSendMenu(false);
      sendToggle.focus();
    }
  });
  syncCycleUi();

  const refreshFilter = () => {
    forceRender = true;
    pendingFrames = [];
    scheduleRender();
  };
  const syncFilterClear = (input: HTMLInputElement, clearButton: HTMLButtonElement) => {
    clearButton.disabled = input.value.length === 0;
  };
  filterIdInput.addEventListener('input', () => {
    sanitizeHexInput(filterIdInput, 8);
    syncFilterClear(filterIdInput, filterIdClear);
    refreshFilter();
  });
  filterDataInput.addEventListener('input', () => {
    sanitizeHexDataElement(filterDataInput);
    syncFilterClear(filterDataInput, filterDataClear);
    refreshFilter();
  });
  filterIdClear.addEventListener('click', () => {
    filterIdInput.value = '';
    syncFilterClear(filterIdInput, filterIdClear);
    filterIdInput.focus();
    refreshFilter();
  });
  filterDataClear.addEventListener('click', () => {
    filterDataInput.value = '';
    syncFilterClear(filterDataInput, filterDataClear);
    filterDataInput.focus();
    refreshFilter();
  });
  syncFilterClear(filterIdInput, filterIdClear);
  syncFilterClear(filterDataInput, filterDataClear);

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
  const syncFrameTypeFilter = () => {
    const selected = frameTypeChecks.filter((input) => input.checked).map((input) => input.value);
    frameTypeFilter.value = selected.join(',');
    refreshFilter();
  };
  frameTypeTrigger.addEventListener('click', (event) => {
    event.stopPropagation();
    const opening = frameTypeMenu.hidden;
    if (opening) {
      document.querySelectorAll<HTMLElement>('.serial-dd-menu').forEach((menu) => {
        if (menu === frameTypeMenu) return;
        menu.hidden = true;
        menu.closest('.serial-dd')?.querySelector<HTMLButtonElement>('.serial-dd-trigger')?.setAttribute('aria-expanded', 'false');
      });
    }
    frameTypeMenu.hidden = !opening;
    frameTypeTrigger.setAttribute('aria-expanded', String(opening));
  });
  frameTypeChecks.forEach((input) => input.addEventListener('change', syncFrameTypeFilter));
  errorDisplayToggle.addEventListener('click', () => {
    showParsedErrors = !showParsedErrors;
    syncErrorDisplayToggle(true);
  });
  syncErrorDisplayToggle();
  registerSerialDropdownOutsideClose();

  byId('can-clear').addEventListener('click', () => {
    logs.length = 0;
    syncLogActions();
    pendingFrames = [];
    forceRender = true;
    stats.rx = 0; stats.tx = 0; stats.errors = 0;
    updateStats();
    render();
  });

  exportButton.addEventListener('click', () => {
    if (logs.length === 0) return;
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [['time', 'direction', 'can_id', 'frame_type', 'dlc', 'data_hex', 'error_detail'], ...logs.map((frame) => [
      frame.timestamp.toISOString(), frame.direction.toUpperCase(), `0x${hex(frame.id, frame.error || frame.extended ? 8 : 3)}`,
      frame.error ? 'error' : frame.extended ? (frame.rtr ? 'extended-rtr' : 'extended') : (frame.rtr ? 'standard-rtr' : 'standard'),
      String(frame.dlc), frame.data.map((byte) => hex(byte, 2)).join(' '), frame.error ? decodeCanError(frame.id, frame.data).join('；') : '',
    ])];
    const csv = `\uFEFF${rows.map((row) => row.map(escape).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `qdrive-can-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`; link.click();
    URL.revokeObjectURL(url);
  });

  window.addEventListener('pagehide', () => { void transport?.disconnect(); });
}
