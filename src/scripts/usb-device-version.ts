type UsbDeviceVersion = {
  deviceVersionMajor?: number;
  deviceVersionMinor?: number;
  deviceVersionSubminor?: number;
};

export function formatUsbDeviceVersion(device: UsbDeviceVersion | null | undefined): string {
  if (!device) return '—';
  const parts = [device.deviceVersionMajor, device.deviceVersionMinor, device.deviceVersionSubminor];
  if (parts.some((value, index) => typeof value !== 'number' || !Number.isInteger(value)
    || value < 0 || value > (index === 0 ? 0xff : 0xf))) return '—';
  // WebUSB splits bcdDevice into a byte and two nibbles without decoding BCD digits.
  return parts.map((value) => value!.toString(16)).join('.');
}
