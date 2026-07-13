const DFU = {
  DNLOAD: 0x01,
  GETSTATUS: 0x03,
  CLRSTATUS: 0x04,
  GETSTATE: 0x05,
  ABORT: 0x06,
  STATUS_OK: 0,
  IDLE: 2,
  DNLOAD_BUSY: 4,
  DNLOAD_IDLE: 5,
  MANIFEST: 7,
  MANIFEST_WAIT_RESET: 8,
  ERROR: 10,
} as const;

const DFUSE = { SET_ADDRESS: 0x21, ERASE_SECTOR: 0x41 } as const;

type UsbAlternate = {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  interfaceName?: string;
};

type UsbInterface = { interfaceNumber: number; claimed?: boolean; alternates: UsbAlternate[] };
type UsbConfiguration = { configurationValue: number; interfaces: UsbInterface[] };
type UsbTransfer = { status: string; data?: DataView; bytesWritten?: number };
type UsbDevice = {
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  opened: boolean;
  configuration: UsbConfiguration | null;
  configurations: UsbConfiguration[];
  open: () => Promise<void>;
  close: () => Promise<void>;
  reset: () => Promise<void>;
  selectConfiguration: (configurationValue: number) => Promise<void>;
  claimInterface: (interfaceNumber: number) => Promise<void>;
  selectAlternateInterface: (interfaceNumber: number, alternateSetting: number) => Promise<void>;
  controlTransferIn: (setup: Record<string, number | string>, length: number) => Promise<UsbTransfer>;
  controlTransferOut: (setup: Record<string, number | string>, data?: BufferSource) => Promise<UsbTransfer>;
};
type UsbManager = { requestDevice: (options: { filters: Record<string, number>[] }) => Promise<UsbDevice> };
type DfuSetting = {
  configurationValue: number;
  interfaceNumber: number;
  alternateSetting: number;
  protocol: number;
  name: string;
  transferSize: number;
  dfuVersion: number;
  manifestationTolerant: boolean;
};
type DfuDescriptor = {
  name: string;
  transferSize: number;
  dfuVersion: number;
  manifestationTolerant: boolean;
};
type FlashSegment = { start: number; end: number; sectorSize: number; erasable: boolean; writable: boolean };
type FirmwareImage = { altSetting: number; address: number; data: ArrayBuffer };
type FirmwareIdentity = { vendorId: number; productId: number };

function getWebUsb(): UsbManager | undefined {
  return (navigator as Navigator & { usb?: UsbManager }).usb;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function settingKey(configurationValue: number, interfaceNumber: number, alternateSetting: number): string {
  return `${configurationValue}:${interfaceNumber}:${alternateSetting}`;
}

function findDfuSettings(device: UsbDevice, descriptorInfo = new Map<string, DfuDescriptor>()): DfuSetting[] {
  const settings: DfuSetting[] = [];
  for (const configuration of device.configurations) {
    for (const intf of configuration.interfaces) {
      for (const alternate of intf.alternates) {
        if (
          alternate.interfaceClass === 0xfe &&
          alternate.interfaceSubclass === 0x01 &&
          (alternate.interfaceProtocol === 0x01 || alternate.interfaceProtocol === 0x02)
        ) {
          const descriptor = descriptorInfo.get(
            settingKey(configuration.configurationValue, intf.interfaceNumber, alternate.alternateSetting),
          );
          settings.push({
            configurationValue: configuration.configurationValue,
            interfaceNumber: intf.interfaceNumber,
            alternateSetting: alternate.alternateSetting,
            protocol: alternate.interfaceProtocol,
            name: descriptor?.name || alternate.interfaceName || '',
            transferSize: descriptor?.transferSize || 1024,
            dfuVersion: descriptor?.dfuVersion || 0,
            manifestationTolerant: descriptor?.manifestationTolerant ?? false,
          });
        }
      }
    }
  }
  return settings;
}

/** Read the iInterface strings that Chromium does not always expose on USBAlternateInterface. */
async function readDfuInterfaceDescriptors(device: UsbDevice): Promise<Map<string, DfuDescriptor>> {
  const GET_DESCRIPTOR = 0x06;
  const CONFIGURATION_DESCRIPTOR = 0x02;
  const STRING_DESCRIPTOR = 0x03;
  const openedHere = !device.opened;
  const stringIndexes = new Map<string, number>();
  const descriptors = new Map<string, DfuDescriptor>();

  async function readDescriptor(value: number, index: number, length: number): Promise<DataView> {
    const result = await device.controlTransferIn(
      { requestType: 'standard', recipient: 'device', request: GET_DESCRIPTOR, value, index },
      length,
    );
    if (result.status !== 'ok' || !result.data) throw new Error(`USB 描述符读取失败：${result.status}`);
    return result.data;
  }

  try {
    if (openedHere) await device.open();
    for (let index = 0; index < device.configurations.length; index += 1) {
      const header = await readDescriptor((CONFIGURATION_DESCRIPTOR << 8) | index, 0, 4);
      const totalLength = header.getUint16(2, true);
      const descriptor = await readDescriptor((CONFIGURATION_DESCRIPTOR << 8) | index, 0, totalLength);
      const configurationValue = descriptor.getUint8(5);
      let currentDfuKey: string | null = null;
      for (let offset = descriptor.getUint8(0); offset + 2 <= descriptor.byteLength; ) {
        const length = descriptor.getUint8(offset);
        if (length < 2 || offset + length > descriptor.byteLength) break;
        if (descriptor.getUint8(offset + 1) === 0x04 && length >= 9) {
          const interfaceClass = descriptor.getUint8(offset + 5);
          const interfaceSubclass = descriptor.getUint8(offset + 6);
          if (interfaceClass === 0xfe && interfaceSubclass === 0x01) {
            const key = settingKey(configurationValue, descriptor.getUint8(offset + 2), descriptor.getUint8(offset + 3));
            const stringIndex = descriptor.getUint8(offset + 8);
            if (stringIndex) stringIndexes.set(key, stringIndex);
            descriptors.set(key, { name: '', transferSize: 1024, dfuVersion: 0, manifestationTolerant: false });
            currentDfuKey = key;
          } else {
            currentDfuKey = null;
          }
        } else if (descriptor.getUint8(offset + 1) === 0x21 && currentDfuKey && length >= 9) {
          const current = descriptors.get(currentDfuKey);
          if (current) {
            current.transferSize = descriptor.getUint16(offset + 5, true) || 1024;
            current.dfuVersion = descriptor.getUint16(offset + 7, true);
            current.manifestationTolerant = (descriptor.getUint8(offset + 2) & 0x04) !== 0;
          }
        }
        offset += length;
      }
    }
    for (const [key, stringIndex] of stringIndexes) {
      const header = await readDescriptor((STRING_DESCRIPTOR << 8) | stringIndex, 0x0409, 2);
      const length = header.getUint8(0);
      if (length < 2) continue;
      const descriptor = await readDescriptor((STRING_DESCRIPTOR << 8) | stringIndex, 0x0409, length);
      const words: number[] = [];
      for (let offset = 2; offset + 1 < descriptor.byteLength; offset += 2) {
        words.push(descriptor.getUint16(offset, true));
      }
      const current = descriptors.get(key);
      if (current) current.name = String.fromCharCode(...words);
    }
  } catch {
    // The regular WebUSB interfaceName remains available on devices that reject descriptor reads.
  } finally {
    if (openedHere && device.opened) await device.close();
  }
  return descriptors;
}

function parseMemoryDescriptor(name: string): FlashSegment[] {
  if (!name.startsWith('@')) return [];
  const segments: FlashSegment[] = [];
  const groups = /\/\s*(0x[0-9a-fA-F]{1,8})\s*\/((?:\s*\d+\s*\*\s*\d+\s?[ BKM]\s*[a-g]\s*,?\s*)+)/g;
  const units: Record<string, number> = { ' ': 1, B: 1, K: 1024, M: 1024 * 1024 };
  let group: RegExpExecArray | null;
  while ((group = groups.exec(name)) !== null) {
    let address = Number.parseInt(group[1], 16);
    const sectors = /(\d+)\s*\*\s*(\d+)\s?([ BKM])\s*([a-g])/g;
    let sector: RegExpExecArray | null;
    while ((sector = sectors.exec(group[2])) !== null) {
      const count = Number.parseInt(sector[1], 10);
      const sectorSize = Number.parseInt(sector[2], 10) * units[sector[3]];
      const permissions = sector[4].charCodeAt(0) - 'a'.charCodeAt(0) + 1;
      segments.push({
        start: address,
        end: address + count * sectorSize,
        sectorSize,
        erasable: (permissions & 0x02) !== 0,
        writable: (permissions & 0x04) !== 0,
      });
      address += count * sectorSize;
    }
  }
  return segments;
}

function parseFirmware(data: ArrayBuffer): FirmwareImage[] {
  const bytes = new Uint8Array(data);
  const text = new TextDecoder().decode(bytes.subarray(0, 5));
  if (text !== 'DfuSe') return [{ altSetting: 0, address: Number.NaN, data }];

  const view = new DataView(data);
  if (bytes.byteLength < 11 || view.getUint8(5) !== 1) throw new Error('DFU 文件头无效。');
  const imageSize = view.getUint32(6, true);
  const targetCount = view.getUint8(10);
  if (imageSize > bytes.byteLength || targetCount === 0) throw new Error('DFU 文件内容不完整。');

  let offset = 11;
  const images: FirmwareImage[] = [];
  for (let target = 0; target < targetCount; target += 1) {
    if (offset + 274 > bytes.byteLength || new TextDecoder().decode(bytes.subarray(offset, offset + 6)) !== 'Target') {
      throw new Error('DFU 文件中的 Target 区块无效。');
    }
    const altSetting = view.getUint8(offset + 6);
    const targetSize = view.getUint32(offset + 266, true);
    const elementCount = view.getUint32(offset + 270, true);
    offset += 274;
    const targetEnd = offset + targetSize;
    if (targetEnd > bytes.byteLength) throw new Error('DFU 文件中的 Target 数据不完整。');
    for (let element = 0; element < elementCount; element += 1) {
      if (offset + 8 > targetEnd) throw new Error('DFU 文件中的固件元素无效。');
      const address = view.getUint32(offset, true);
      const length = view.getUint32(offset + 4, true);
      offset += 8;
      if (offset + length > targetEnd) throw new Error('DFU 文件中的固件元素长度无效。');
      images.push({ altSetting, address, data: data.slice(offset, offset + length) });
      offset += length;
    }
    if (offset !== targetEnd) throw new Error('DFU 文件中的 Target 长度不匹配。');
  }
  return images;
}

function parseFirmwareIdentity(data: ArrayBuffer): FirmwareIdentity {
  if (data.byteLength < 16) throw new Error('DFU 文件缺少 DFU Suffix。');
  const view = new DataView(data);
  const suffixOffset = data.byteLength - 16;
  const signature = String.fromCharCode(
    view.getUint8(suffixOffset + 8),
    view.getUint8(suffixOffset + 9),
    view.getUint8(suffixOffset + 10),
  );
  if (signature !== 'UFD' || view.getUint8(suffixOffset + 11) !== 16) {
    throw new Error('DFU 文件不包含有效的 Vendor ID / Product ID。');
  }
  return {
    productId: view.getUint16(suffixOffset + 2, true),
    vendorId: view.getUint16(suffixOffset + 4, true),
  };
}

function hexId(value: number): string {
  return `0x${value.toString(16).padStart(4, '0').toUpperCase()}`;
}

function isDfuFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.dfu');
}

function supportsDfuSe(setting: DfuSetting): boolean {
  return setting.protocol === 0x02 && setting.dfuVersion === 0x011a;
}

class DfuConnection {
  private active: DfuSetting | null = null;
  private claimed = new Set<number>();
  private erasedSectors = new Set<string>();

  constructor(private readonly device: UsbDevice) {}

  async open(setting: DfuSetting): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (this.device.configuration?.configurationValue !== setting.configurationValue) {
      await this.device.selectConfiguration(setting.configurationValue);
    }
    if (!this.claimed.has(setting.interfaceNumber)) {
      await this.device.claimInterface(setting.interfaceNumber);
      this.claimed.add(setting.interfaceNumber);
    }
    if (
      !this.active ||
      this.active.interfaceNumber !== setting.interfaceNumber ||
      this.active.alternateSetting !== setting.alternateSetting
    ) {
      await this.device.selectAlternateInterface(setting.interfaceNumber, setting.alternateSetting);
    }
    this.active = setting;
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async reset(): Promise<void> {
    await this.device.reset();
  }

  private get interfaceNumber(): number {
    if (!this.active) throw new Error('尚未选择 DFU 接口。');
    return this.active.interfaceNumber;
  }

  private async out(request: number, value = 0, data?: BufferSource): Promise<number> {
    const requestName: Record<number, string> = {
      [DFU.DNLOAD]: 'DFU_DNLOAD',
      [DFU.CLRSTATUS]: 'DFU_CLRSTATUS',
      [DFU.ABORT]: 'DFU_ABORT',
    };
    let result: UsbTransfer;
    try {
      result = await this.device.controlTransferOut(
        { requestType: 'class', recipient: 'interface', request, value, index: this.interfaceNumber },
        data,
      );
    } catch (error) {
      throw new Error(`${requestName[request] ?? `DFU 请求 ${request}`}（块 ${value}）USB 传输失败：${asErrorMessage(error)}`);
    }
    if (result.status !== 'ok') throw new Error(`DFU 控制传输失败：${result.status}`);
    return result.bytesWritten ?? 0;
  }

  private async status(): Promise<{ status: number; timeout: number; state: number }> {
    const result = await this.device.controlTransferIn(
      { requestType: 'class', recipient: 'interface', request: DFU.GETSTATUS, value: 0, index: this.interfaceNumber },
      6,
    );
    if (result.status !== 'ok' || !result.data) throw new Error(`DFU 状态读取失败：${result.status}`);
    return {
      status: result.data.getUint8(0),
      timeout: result.data.getUint32(1, true) & 0x00ffffff,
      state: result.data.getUint8(4),
    };
  }

  private async pollUntil(predicate: (state: number) => boolean): Promise<{ status: number; timeout: number; state: number }> {
    let current = await this.status();
    while (!predicate(current.state) && current.state !== DFU.ERROR) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(1, current.timeout)));
      current = await this.status();
    }
    return current;
  }

  async prepare(): Promise<void> {
    let state: number;
    try {
      state = (await this.device.controlTransferIn(
        { requestType: 'class', recipient: 'interface', request: DFU.GETSTATE, value: 0, index: this.interfaceNumber },
        1,
      )).data?.getUint8(0) ?? DFU.IDLE;
    } catch {
      state = DFU.IDLE;
    }
    if (state === DFU.ERROR) {
      await this.out(DFU.CLRSTATUS);
      state = (await this.status()).state;
    }
    if (state === DFU.MANIFEST_WAIT_RESET) {
      throw new Error('DFU 设备正等待复位。请拔插设备或重新进入 DFU 模式后再试。');
    }
    if (state !== DFU.IDLE) {
      await this.out(DFU.ABORT);
      const status = await this.pollUntil((next) => next === DFU.IDLE);
      if (status.state !== DFU.IDLE) throw new Error('无法将 DFU 设备切换为空闲状态。');
    }
  }

  private async command(command: number, address: number): Promise<void> {
    const payload = new Uint8Array(5);
    payload[0] = command;
    new DataView(payload.buffer).setUint32(1, address, true);
    await this.out(DFU.DNLOAD, 0, payload);
    const status = await this.pollUntil((state) => state !== DFU.DNLOAD_BUSY);
    if (status.status !== DFU.STATUS_OK || status.state !== DFU.DNLOAD_IDLE) {
      throw new Error(`DFU 命令执行失败（状态 ${status.status}）。`);
    }
  }

  private segmentFor(segments: FlashSegment[], address: number): FlashSegment | undefined {
    return segments.find((segment) => segment.start <= address && address < segment.end);
  }

  private async erase(segments: FlashSegment[], start: number, length: number, report: (done: number, total: number, text: string) => void): Promise<void> {
    const end = start + length;
    let address = start;
    let done = 0;
    while (address < end) {
      const segment = this.segmentFor(segments, address);
      if (!segment || !segment.erasable) throw new Error(`地址 0x${address.toString(16)} 不支持擦除。`);
      const sectorAddress = segment.start + Math.floor((address - segment.start) / segment.sectorSize) * segment.sectorSize;
      const sectorKey = `${this.interfaceNumber}:${this.active?.alternateSetting ?? 0}:${sectorAddress}`;
      if (!this.erasedSectors.has(sectorKey)) {
        await this.command(DFUSE.ERASE_SECTOR, sectorAddress);
        this.erasedSectors.add(sectorKey);
      }
      address = sectorAddress + segment.sectorSize;
      done = Math.min(length, Math.max(done, address - start));
      report(done, length, '正在擦除 Flash…');
    }
  }

  async writeDfuse(
    image: FirmwareImage,
    setting: DfuSetting,
    report: (done: number, total: number, text: string) => void,
  ): Promise<void> {
    const segments = parseMemoryDescriptor(setting.name);
    if (segments.length === 0) throw new Error('未读取到设备公布的 DfuSe Flash 内存映射，已阻止写入以避免错误擦除。');
    const start = Number.isNaN(image.address) ? segments[0].start : image.address;
    if (!this.segmentFor(segments, start)) throw new Error(`固件起始地址 0x${start.toString(16)} 不在设备 Flash 范围内。`);
    await this.erase(segments, start, image.data.byteLength, report);

    const bytes = new Uint8Array(image.data);
    let offset = 0;
    const transferSize = Math.max(1, setting.transferSize);
    while (offset < bytes.byteLength) {
      const address = start + offset;
      const segment = this.segmentFor(segments, address);
      if (!segment || !segment.writable) throw new Error(`地址 0x${address.toString(16)} 不支持写入。`);
      const length = Math.min(transferSize, bytes.byteLength - offset, segment.end - address);
      await this.command(DFUSE.SET_ADDRESS, address);
      await this.out(DFU.DNLOAD, 2, bytes.slice(offset, offset + length));
      const status = await this.pollUntil((state) => state === DFU.DNLOAD_IDLE);
      if (status.status !== DFU.STATUS_OK) throw new Error(`DFU 写入失败（状态 ${status.status}）。`);
      offset += length;
      report(offset, bytes.byteLength, '正在写入固件…');
    }
    await this.command(DFUSE.SET_ADDRESS, start);
  }

  async writeStandard(
    data: ArrayBuffer,
    transferSize: number,
    report: (done: number, total: number, text: string) => void,
  ): Promise<number> {
    const bytes = new Uint8Array(data);
    const chunkSize = Math.max(1, transferSize);
    let offset = 0;
    let transaction = 0;
    while (offset < bytes.byteLength) {
      const length = Math.min(chunkSize, bytes.byteLength - offset);
      await this.out(DFU.DNLOAD, transaction, bytes.slice(offset, offset + length));
      const status = await this.pollUntil((state) => state === DFU.DNLOAD_IDLE);
      if (status.status !== DFU.STATUS_OK) throw new Error(`标准 DFU 写入失败（状态 ${status.status}）。`);
      transaction += 1;
      offset += length;
      report(offset, bytes.byteLength, '设备正在擦除并写入固件…');
    }
    return transaction;
  }

  async manifest(transaction = 0): Promise<void> {
    await this.out(DFU.DNLOAD, transaction, new ArrayBuffer(0));
    try {
      const status = await this.pollUntil((state) => state === DFU.MANIFEST || state === DFU.MANIFEST_WAIT_RESET || state === DFU.IDLE);
      if (status.status !== DFU.STATUS_OK) throw new Error(`固件生效失败（状态 ${status.status}）。`);
    } catch (error) {
      const message = asErrorMessage(error);
      if (!/disconnect|unavailable|notfound/i.test(message)) throw error;
    }
  }
}

export type DfuUpdateController = { available: boolean; open: () => void };

export function createDfuUpdateController(): DfuUpdateController {
  const dialog = document.getElementById('dfu-update-dialog');
  const fileInput = document.getElementById('dfu-file-input') as HTMLInputElement | null;
  const chooseFile = document.getElementById('dfu-file-select') as HTMLButtonElement | null;
  const chooseDevice = document.getElementById('dfu-device-select') as HTMLButtonElement | null;
  const startButton = document.getElementById('dfu-start') as HTMLButtonElement | null;
  const cancelButton = document.getElementById('dfu-cancel') as HTMLButtonElement | null;
  const closeButton = document.getElementById('dfu-close') as HTMLButtonElement | null;
  const fileName = document.getElementById('dfu-file-name');
  const deviceInfo = document.getElementById('dfu-device-name');
  const status = document.getElementById('dfu-status');
  const progress = document.getElementById('dfu-progress') as HTMLProgressElement | null;
  const progressText = document.getElementById('dfu-progress-text');
  let device: UsbDevice | null = null;
  let settings: DfuSetting[] = [];
  let firmwareIdentity: FirmwareIdentity | null = null;
  let busy = false;

  const setStatus = (text: string) => {
    if (status) status.textContent = text;
  };
  const updateStartState = () => {
    const deviceMatchesFirmware =
      device !== null &&
      firmwareIdentity !== null &&
      device.vendorId === firmwareIdentity.vendorId &&
      device.productId === firmwareIdentity.productId;
    if (startButton) startButton.disabled = busy || !deviceMatchesFirmware || !(fileInput?.files?.length);
  };
  const report = (done: number, total: number, text: string) => {
    if (progress) {
      progress.max = Math.max(1, total);
      progress.value = done;
    }
    if (progressText) progressText.textContent = `${Math.round((done / Math.max(1, total)) * 100)}%`;
    setStatus(`${text} ${Math.round((done / Math.max(1, total)) * 100)}%`);
  };
  const close = () => {
    if (busy) return;
    dialog?.classList.remove('open');
    dialog?.setAttribute('aria-hidden', 'true');
  };

  chooseFile?.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    firmwareIdentity = null;
    updateStartState();
    if (!file) {
      if (fileName) fileName.textContent = '尚未选择 .dfu 文件';
      setStatus('请选择 DFU 固件文件。');
      return;
    }
    if (!isDfuFile(file)) {
      fileInput.value = '';
      if (fileName) fileName.textContent = '请选择 .dfu 后缀的固件文件';
      setStatus('仅支持后缀为 .dfu 的固件文件。');
      return;
    }
    try {
      firmwareIdentity = parseFirmwareIdentity(await file.arrayBuffer());
      if (fileName) fileName.textContent = `${file.name}（${Math.ceil(file.size / 1024)} KB）`;
      const identityText = `VID ${hexId(firmwareIdentity.vendorId)} / PID ${hexId(firmwareIdentity.productId)}`;
      if (device && (device.vendorId !== firmwareIdentity.vendorId || device.productId !== firmwareIdentity.productId)) {
        setStatus(`固件要求 ${identityText}，与所选设备不匹配，无法升级。`);
      } else {
        setStatus(`已选择：${file.name}（${Math.ceil(file.size / 1024)} KB，${identityText}）`);
      }
    } catch (error) {
      setStatus(`固件文件无效：${asErrorMessage(error)}`);
    }
    updateStartState();
  });
  cancelButton?.addEventListener('click', close);
  closeButton?.addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dialog?.classList.contains('open')) close();
  });

  chooseDevice?.addEventListener('click', async () => {
    const usb = getWebUsb();
    if (!usb) {
      setStatus('当前浏览器不支持 WebUSB，请使用最新版 Chrome 或 Edge。');
      return;
    }
    try {
      setStatus('请在浏览器弹窗中选择已进入 DFU 模式的设备。');
      // DFU is commonly exposed as an interface of a composite USB device, so
      // filter only by vendor ID instead of the device class.
      const selected = await usb.requestDevice({ filters: [{ vendorId: 0x0483 }] });
      const descriptorInfo = await readDfuInterfaceDescriptors(selected);
      const dfuSettings = findDfuSettings(selected, descriptorInfo).filter((setting) => setting.protocol === 0x02);
      if (dfuSettings.length === 0) {
        throw new Error('所选设备未处于 DFU 模式，请确认设备已进入升级模式。');
      }
      device = selected;
      settings = dfuSettings;
      if (deviceInfo) {
        deviceInfo.textContent = `${selected.productName || 'QDrive DFU'}（VID ${hexId(selected.vendorId)} / PID ${hexId(selected.productId)}）`;
      }
      if (firmwareIdentity && (selected.vendorId !== firmwareIdentity.vendorId || selected.productId !== firmwareIdentity.productId)) {
        setStatus(`固件要求 VID ${hexId(firmwareIdentity.vendorId)} / PID ${hexId(firmwareIdentity.productId)}，与所选设备不匹配，无法升级。`);
      } else {
        setStatus('设备已选择。请确认固件文件后开始升级。');
      }
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFoundError') setStatus('未选择 DFU 设备。');
      else setStatus(`选择设备失败：${asErrorMessage(error)}`);
    }
    updateStartState();
  });

  startButton?.addEventListener('click', async () => {
    const file = fileInput?.files?.[0];
    if (!file || !device) return;
    if (!isDfuFile(file)) {
      setStatus('仅支持选择 .dfu 固件文件。');
      return;
    }
    busy = true;
    updateStartState();
    if (chooseFile) chooseFile.disabled = true;
    if (chooseDevice) chooseDevice.disabled = true;
    if (fileInput) fileInput.disabled = true;
    if (cancelButton) cancelButton.disabled = true;
    try {
      const firmware = await file.arrayBuffer();
      const identity = parseFirmwareIdentity(firmware);
      if (device.vendorId !== identity.vendorId || device.productId !== identity.productId) {
        throw new Error(`固件要求 VID ${hexId(identity.vendorId)} / PID ${hexId(identity.productId)}，与所选设备不匹配。`);
      }
      const connection = new DfuConnection(device);
      try {
        const setting = settings[0];
        await connection.open(setting);
        await connection.prepare();
        let standardTransaction: number | null = null;
        if (supportsDfuSe(setting)) {
          const images = parseFirmware(firmware);
          const selectedSettings = new Map(settings.map((item) => [item.alternateSetting, item]));
          for (const image of images) {
            if (!selectedSettings.has(image.altSetting) && !Number.isNaN(image.address)) {
              throw new Error(`设备没有 DFU 文件所需的备用设置 ${image.altSetting}。`);
            }
          }
          let written = 0;
          const total = images.reduce((sum, image) => sum + image.data.byteLength, 0);
          for (const image of images) {
            const imageSetting = selectedSettings.get(image.altSetting) ?? setting;
            await connection.open(imageSetting);
            await connection.writeDfuse(image, imageSetting, (done, _imageTotal, text) => report(written + done, total, text));
            written += image.data.byteLength;
          }
        } else {
          standardTransaction = await connection.writeStandard(firmware, setting.transferSize, report);
        }
        setStatus('正在使新固件生效…');
        await connection.manifest(standardTransaction ?? 0);
        const total = standardTransaction === null ? parseFirmware(firmware).reduce((sum, image) => sum + image.data.byteLength, 0) : firmware.byteLength;
        report(total, total, '升级完成，设备正在重启。');
        try {
          await connection.reset();
        } catch {
          // Most DFU bootloaders reset themselves after manifestation.
        }
      } finally {
        await connection.close();
      }
    } catch {
      setStatus('升级失败，请重新选择 DFU 设备。');
      // 失败后设备可能仍停在 busy/error 状态或已重新枚举，禁止复用旧句柄。
      device = null;
      settings = [];
      if (deviceInfo) deviceInfo.textContent = '尚未选择 DFU 设备。请重新选择设备后再试。';
    } finally {
      busy = false;
      if (chooseFile) chooseFile.disabled = false;
      if (chooseDevice) chooseDevice.disabled = false;
      if (fileInput) fileInput.disabled = false;
      if (cancelButton) cancelButton.disabled = false;
      updateStartState();
    }
  });

  return {
    available: Boolean(dialog && fileInput && chooseDevice && startButton && cancelButton),
    open() {
      if (!dialog) return;
      device = null;
      settings = [];
      firmwareIdentity = null;
      if (fileInput) fileInput.value = '';
      if (fileName) fileName.textContent = '尚未选择 .dfu 文件';
      if (progressText) progressText.textContent = '0%';
      if (deviceInfo) deviceInfo.textContent = '尚未选择 DFU 设备。';
      if (progress) {
        progress.max = 1;
        progress.value = 0;
      }
      setStatus(getWebUsb() ? '请选择 DFU 固件文件和设备。' : '当前浏览器不支持 WebUSB，请使用最新版 Chrome 或 Edge。');
      dialog.classList.add('open');
      dialog.setAttribute('aria-hidden', 'false');
      updateStartState();
      window.setTimeout(() => fileInput?.focus(), 0);
    },
  };
}
