const encoder = new TextEncoder();

export const POST_CONNECT_KEY_SEQ = ' \x7f';
export const POST_CONNECT_KEY_DELAY_MS = 10;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function serialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function stripAnsi(input: string): string {
  return input.replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[-/]*[@-~])/gm, '');
}

export type SerialTransportEvents = {
  onChunk: (chunk: string) => void;
  onBeforeStop?: () => void;
  onUnexpectedDisconnect?: () => void;
  onReadError?: () => void;
};

export type SerialCaptureOptions = {
  /** Do not forward captured chunks to the terminal. */
  silent?: boolean;
  /** End a capture as soon as its complete response has been received. */
  isComplete?: (buffer: string) => boolean;
};

export class SerialTransport {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private rxDecoder = new TextDecoder();
  private readLoopActive = false;
  private serialRxCapture: { receive: (chunk: string) => void; silent: boolean } | null = null;
  private captureChain: Promise<void> = Promise.resolve();
  private captureActive = false;

  constructor(private readonly events: SerialTransportEvents) {}

  isConnected(): boolean {
    return this.writer !== null;
  }

  async connect(baudRate: number): Promise<void> {
    await this.stop();

    const selected = await navigator.serial.requestPort();
    await selected.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 65536,
    });

    this.port = selected;
    if (!this.port.readable || !this.port.writable) {
      await this.stop();
      throw new Error('串口流不可用，请重试或重新插拔设备。');
    }

    this.rxDecoder = new TextDecoder();
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.readLoopActive = true;
    void this.readLoop();
  }

  async stop(): Promise<void> {
    this.events.onBeforeStop?.();
    this.readLoopActive = false;

    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* ignore */
    }
    this.reader = null;

    try {
      await this.writer?.close();
    } catch {
      /* ignore */
    }
    this.writer = null;

    try {
      if (this.port) await this.port.close();
    } catch {
      /* ignore */
    }
    this.port = null;
  }

  async sendRaw(data: string): Promise<void> {
    if (!this.writer) return;
    await this.writer.write(encoder.encode(data));
  }

  async sendLine(line: string): Promise<void> {
    await this.sendRaw(`${line}\n`);
  }

  isCaptureActive(): boolean {
    return this.captureActive;
  }

  async waitForCapture(): Promise<void> {
    await this.captureChain;
  }

  async captureUntilIdle(
    runSend: () => Promise<void>,
    idleMs = 70,
    maxMs = 2000,
    options: SerialCaptureOptions = {},
  ): Promise<string> {
    const previous = this.captureChain;
    let release: () => void = () => {};
    this.captureChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    this.captureActive = true;
    try {
      return await this.captureUntilIdleNow(runSend, idleMs, maxMs, options);
    } finally {
      this.captureActive = false;
      release();
    }
  }

  private async captureUntilIdleNow(
    runSend: () => Promise<void>,
    idleMs: number,
    maxMs: number,
    options: SerialCaptureOptions,
  ): Promise<string> {
    let buf = '';
    let resolveComplete: (() => void) | null = null;
    let complete = false;
    const completion = options.isComplete
      ? new Promise<void>((resolve) => {
          resolveComplete = resolve;
        })
      : null;
    this.serialRxCapture = {
      receive(chunk) {
        buf += chunk;
        if (!complete && options.isComplete?.(buf)) {
          complete = true;
          resolveComplete?.();
        }
      },
      silent: options.silent === true,
    };

    try {
      await runSend();
      if (completion) {
        await Promise.race([completion, sleep(maxMs)]);
        return buf;
      }
      const start = Date.now();
      let lastLen = 0;
      let stableAt = Date.now();
      while (Date.now() - start < maxMs) {
        await sleep(Math.min(45, Math.max(12, Math.floor(idleMs / 2))));
        if (buf.length !== lastLen) {
          lastLen = buf.length;
          stableAt = Date.now();
        } else if (buf.length > 0 && Date.now() - stableAt >= idleMs) {
          break;
        }
      }
      return buf;
    } finally {
      this.serialRxCapture = null;
    }
  }

  private async readLoop(): Promise<void> {
    if (!this.reader) return;

    let unexpectedDisconnect = false;
    let readErrored = false;

    try {
      while (this.readLoopActive && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) {
          const tail = this.rxDecoder.decode();
          if (tail) this.emitChunk(tail);
          if (this.readLoopActive) unexpectedDisconnect = true;
          break;
        }
        if (value && value.byteLength > 0) {
          const chunk = this.rxDecoder.decode(value, { stream: true });
          if (chunk) this.emitChunk(chunk);
        }
      }
    } catch {
      if (this.readLoopActive) {
        unexpectedDisconnect = true;
        readErrored = true;
      }
    } finally {
      if (unexpectedDisconnect) {
        if (readErrored) this.events.onReadError?.();
        else this.events.onUnexpectedDisconnect?.();
        await this.stop();
      }
    }
  }

  private emitChunk(chunk: string): void {
    const capture = this.serialRxCapture;
    capture?.receive(chunk);
    if (!capture?.silent) this.events.onChunk(chunk);
  }
}
