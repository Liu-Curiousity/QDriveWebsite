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
const RX_ECHO_ID = 0xffffffff;
const CLASSIC_FRAME_SIZE = 20;
const MAX_PENDING_WRITES = 64;
const FRAME_BATCH_INTERVAL_MS = 50;
const MAX_FRAME_BATCH = 64;
const CYCLE_PROGRESS_INTERVAL_MS = 50;

type UsbDevice = any;
type UsbManager = {
  getDevices(): Promise<UsbDevice[]>;
  addEventListener(type: 'disconnect', listener: (event: any) => void): void;
};

type UsbDeviceSelector = {
  vendorId: number;
  productId: number;
  serialNumber: string | null;
  productName: string | null;
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

type WorkerFrame = {
  timestamp: number;
  direction: 'rx' | 'tx';
  id: number;
  extended: boolean;
  rtr: boolean;
  error: boolean;
  dlc: number;
  data: number[];
};

type SendFrame = Omit<WorkerFrame, 'timestamp' | 'direction' | 'error'>;

type WorkerCommand = {
  id: number;
  command: 'probe' | 'connect' | 'disconnect' | 'getChannelInfo' | 'startChannel' | 'setTermination'
    | 'getState' | 'send' | 'startCycle' | 'stopCycle';
  payload?: any;
};

const workerScope = globalThis as typeof globalThis & {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<WorkerCommand>) => void) | null;
};

const writeU32 = (view: DataView, offset: number, value: number) => view.setUint32(offset, value >>> 0, true);

function calculateBitTiming(constants: BitTimingConstants, bitrate: number): BitTiming {
  const targetSamplePoint = bitrate > 800000 ? 0.75 : bitrate > 500000 ? 0.8 : 0.875;
  let best: (BitTiming & { bitrateError: number; sampleError: number }) | null = null;

  for (let brp = constants.brpMin; brp <= constants.brpMax; brp += Math.max(1, constants.brpInc)) {
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

class GsUsbWorkerTransport {
  private usb: UsbManager;
  private device: UsbDevice | null = null;
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
  private writeChain: Promise<void> = Promise.resolve();
  private pendingWriteCount = 0;
  private writeCapacityWaiters: Array<() => void> = [];
  private frameBatch: WorkerFrame[] = [];
  private frameBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  private cycleGeneration = 0;

  constructor(usb: UsbManager) {
    this.usb = usb;
    usb.addEventListener('disconnect', (event) => {
      if (event.device !== this.device) return;
      this.stopCycle();
      this.readActive = false;
      this.channelRunning = false;
      this.generation += 1;
      this.device = null;
      this.flushFrames();
      workerScope.postMessage({ type: 'disconnect', message: 'USB 设备已拔出。' });
    });
  }

  async connect(selector: UsbDeviceSelector): Promise<{ channelInfo: ChannelInfo }> {
    const devices = await this.usb.getDevices();
    const exactSerialMatch = selector.serialNumber
      ? devices.find((candidate) => candidate.vendorId === selector.vendorId
        && candidate.productId === selector.productId
        && candidate.serialNumber === selector.serialNumber)
      : null;
    const device = selector.serialNumber
      ? exactSerialMatch
      : devices.find((candidate) => candidate.vendorId === selector.vendorId
        && candidate.productId === selector.productId
        && (!selector.productName || candidate.productName === selector.productName));
    if (!device) throw new Error('Worker 无法取得已授权的 USB 设备，请重新选择设备。');
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
      await this.controlIn(GS_USB_BREQ_DEVICE_CONFIG, 1, this.interfaceNumber, 12);
      this.featuresByChannel.clear();
      this.channelRunning = false;
      const channelInfo = await this.getChannelInfo(0);
      this.readActive = true;
      const generation = ++this.generation;
      void this.readLoop(generation);
      return { channelInfo };
    } catch (error) {
      await this.closeDevice();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.stopCycle();
    try { await this.stopChannel(); } catch { /* Device may already be gone. */ }
    this.readActive = false;
    this.channelRunning = false;
    this.generation += 1;
    this.flushFrames();
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
    this.stopCycle();
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
    this.stopCycle();
    if (!this.channelRunning) return;
    try {
      await this.writeChain.catch(() => undefined);
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

  async getState(channel = this.channel): Promise<DeviceState> {
    if (!this.device?.opened) throw new Error('请先连接 USB 设备。');
    const value = await this.controlIn(GS_USB_BREQ_GET_STATE, channel, 0, 12);
    return {
      state: value.getUint32(0, true),
      rxerr: value.getUint32(4, true),
      txerr: value.getUint32(8, true),
    };
  }

  async send(frameData: SendFrame): Promise<void> {
    await this.waitForWriteCapacity();
    try {
      if (!this.device?.opened || !this.channelRunning) throw new Error('请先启动 CAN 通道。');
      if (!Number.isInteger(frameData.dlc) || frameData.dlc < 0 || frameData.dlc > 8) {
        throw new Error('经典 CAN 的 DLC 必须为 0–8。');
      }
      const activeDevice = this.device;
      const activeGeneration = this.generation;
      const endpointOut = this.endpointOut;
      const frame = new DataView(new ArrayBuffer(CLASSIC_FRAME_SIZE));
      writeU32(frame, 0, this.echoId++ % 10);
      let canId = frameData.id;
      if (frameData.extended) canId = (canId | CAN_EFF_FLAG) >>> 0;
      if (frameData.rtr) canId = (canId | CAN_RTR_FLAG) >>> 0;
      writeU32(frame, 4, canId);
      frame.setUint8(8, frameData.dlc);
      frame.setUint8(9, this.channel);
      if (!frameData.rtr) frameData.data.slice(0, frameData.dlc)
        .forEach((byte, index) => frame.setUint8(12 + index, byte));

      this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
        if (this.device !== activeDevice || this.generation !== activeGeneration
          || !activeDevice.opened || !this.channelRunning) {
          throw new Error('CAN 连接已断开。');
        }
        const result = await activeDevice.transferOut(endpointOut, frame.buffer);
        if (result.status !== 'ok') throw new Error(`USB 写入失败：${result.status}`);
      });
      await this.writeChain;
    } finally {
      this.releaseWriteCapacity();
    }
  }

  async sendAndCapture(frame: SendFrame): Promise<void> {
    await this.send(frame);
    this.queueFrame({ timestamp: Date.now(), direction: 'tx', error: false, ...frame });
  }

  startCycle(frame: SendFrame, interval: number, total: number): void {
    this.stopCycle();
    if (!this.device?.opened || !this.channelRunning) throw new Error('请先启动 CAN 通道。');
    const generation = ++this.cycleGeneration;
    let sent = 0;
    let nextSendAt = performance.now();
    let lastProgressAt = -Infinity;

    const sendNext = async () => {
      if (generation !== this.cycleGeneration) return;
      try {
        await this.send(frame);
      } catch (error) {
        if (generation !== this.cycleGeneration) return;
        this.stopCycle();
        workerScope.postMessage({
          type: 'cycleError',
          message: error instanceof Error ? error.message : '循环发送失败。',
        });
        return;
      }
      if (generation !== this.cycleGeneration) return;
      sent += 1;
      this.queueFrame({ timestamp: Date.now(), direction: 'tx', error: false, ...frame });
      if (total !== -1 && sent >= total) {
        this.stopCycle();
        workerScope.postMessage({ type: 'cycleComplete', sent });
        return;
      }

      const progressAt = performance.now();
      if (progressAt - lastProgressAt >= CYCLE_PROGRESS_INTERVAL_MS) {
        lastProgressAt = progressAt;
        workerScope.postMessage({ type: 'cycleProgress', sent, total });
      }

      // Preserve the original absolute-time schedule. If one send finishes late,
      // the next timeout becomes zero until the original timeline is caught up.
      nextSendAt += interval;
      this.cycleTimer = setTimeout(() => { void sendNext(); }, Math.max(0, nextSendAt - performance.now()));
    };

    void sendNext();
  }

  stopCycle(): void {
    if (this.cycleTimer !== null) clearTimeout(this.cycleTimer);
    this.cycleTimer = null;
    this.cycleGeneration += 1;
  }

  private async waitForWriteCapacity(): Promise<void> {
    if (this.pendingWriteCount < MAX_PENDING_WRITES) {
      this.pendingWriteCount += 1;
      return;
    }
    await new Promise<void>((resolve) => this.writeCapacityWaiters.push(resolve));
  }

  private releaseWriteCapacity(): void {
    const next = this.writeCapacityWaiters.shift();
    if (next) next();
    else this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1);
  }

  private queueFrame(frame: WorkerFrame): void {
    this.frameBatch.push(frame);
    if (this.frameBatch.length >= MAX_FRAME_BATCH) {
      this.flushFrames();
      return;
    }
    if (this.frameBatchTimer === null) {
      this.frameBatchTimer = setTimeout(() => this.flushFrames(), FRAME_BATCH_INTERVAL_MS);
    }
  }

  private flushFrames(): void {
    if (this.frameBatchTimer !== null) clearTimeout(this.frameBatchTimer);
    this.frameBatchTimer = null;
    if (this.frameBatch.length === 0) return;
    const frames = this.frameBatch;
    this.frameBatch = [];
    workerScope.postMessage({ type: 'frames', frames });
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
    const result = await this.device.controlTransferOut(
      { requestType: 'vendor', recipient: 'interface', request, value, index },
      data.buffer,
    );
    if (result.status !== 'ok') throw new Error(`gs_usb 控制请求 ${request} 失败：${result.status}`);
  }

  private async controlIn(request: number, value: number, index: number, length: number): Promise<DataView> {
    const result = await this.device.controlTransferIn(
      { requestType: 'vendor', recipient: 'interface', request, value, index },
      length,
    );
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
          this.stopCycle();
          this.readActive = false;
          void this.closeDevice();
          workerScope.postMessage({ type: 'disconnect', message: 'USB 读取中断，请检查设备连接或驱动占用。' });
        }
        return;
      }
    }
  }

  private parseFrame(view: DataView, offset: number): void {
    const echoId = view.getUint32(offset, true);
    if (echoId !== RX_ECHO_ID || view.getUint8(offset + 9) !== this.channel) return;
    const rawId = view.getUint32(offset + 4, true);
    const dlc = Math.min(8, view.getUint8(offset + 8));
    const rtr = Boolean(rawId & CAN_RTR_FLAG);
    const data = rtr ? [] : Array.from({ length: dlc }, (_, index) => view.getUint8(offset + 12 + index));
    this.queueFrame({
      timestamp: Date.now(), direction: 'rx', id: rawId & 0x1fffffff,
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

const usb = (navigator as Navigator & { usb?: UsbManager }).usb;
const transport = usb ? new GsUsbWorkerTransport(usb) : null;

workerScope.onmessage = (event) => {
  const { id, command, payload } = event.data;
  void (async () => {
    if (!transport) throw new Error('当前浏览器不支持在 Dedicated Worker 中使用 WebUSB。');
    switch (command) {
      case 'probe': return true;
      case 'connect': return transport.connect(payload.selector);
      case 'disconnect': return transport.disconnect();
      case 'getChannelInfo': return transport.getChannelInfo(payload.channel);
      case 'startChannel': return transport.startChannel(
        payload.channel, payload.bitrate, payload.mode, payload.termination, payload.oneShot,
      );
      case 'setTermination': return transport.setTermination(payload.enabled, payload.channel);
      case 'getState': return transport.getState(payload.channel);
      case 'send': return transport.sendAndCapture(payload.frame);
      case 'startCycle': return transport.startCycle(payload.frame, payload.interval, payload.total);
      case 'stopCycle': return transport.stopCycle();
      default: throw new Error(`未知的 CAN Worker 命令：${String(command)}`);
    }
  })().then(
    (value) => workerScope.postMessage({ type: 'response', id, ok: true, value, running: transport?.isRunning() ?? false }),
    (error) => workerScope.postMessage({
      type: 'response', id, ok: false,
      error: error instanceof Error ? error.message : 'CAN Worker 操作失败。',
      running: transport?.isRunning() ?? false,
    }),
  );
};
