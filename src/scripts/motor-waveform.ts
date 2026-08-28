import { stripAnsi } from './serial-transport.ts';
import { wireSerialDropdown } from './serial-dropdown.ts';
import type { WebHostSerialReadyContext } from './web-host-serial-shell.ts';

type MotorSample = {
  time: number;
  current: number;
  speed: number;
  angle: number;
};

type SeriesKey = 'current' | 'speed' | 'angle';

type Chart = {
  key: SeriesKey;
  canvas: HTMLCanvasElement;
  valueEl: HTMLElement | null;
  yZoom: number;
};

const SERIES: Record<SeriesKey, { label: string; unit: string; color: string; flatRange: number }> = {
  current: { label: '电流', unit: 'A', color: '#2563eb', flatRange: 0.1 },
  speed: { label: '速度', unit: 'rpm', color: '#059669', flatRange: 10 },
  angle: { label: '角度', unit: 'rad', color: '#d97706', flatRange: 0.1 },
};

const STATUS_NUMBER = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[-+]?\\d+)?';
const MANUAL_COMMAND_PAUSE_CYCLES = 3;
const MAX_VISIBLE_SECONDS = 10;
const PLOT_LEFT = 40;
const PLOT_RIGHT = 6;

function hasCompleteStatus(raw: string): boolean {
  const plain = stripAnsi(raw).replace(/\\0/g, '');
  const statusPatterns = [
    new RegExp(`Current\\s*:\\s*${STATUS_NUMBER}\\s+A\\b`, 'i'),
    new RegExp(`Speed\\s*:\\s*${STATUS_NUMBER}\\s+rpm\\b`, 'i'),
    new RegExp(`Angle\\s*:\\s*${STATUS_NUMBER}\\s+rad\\b`, 'i'),
  ];
  const voltagePattern = new RegExp(`Voltage\\s*:\\s*${STATUS_NUMBER}\\s+V\\b`, 'i');
  const voltageMatch = voltagePattern.exec(plain);
  if (!voltageMatch || !statusPatterns.every((pattern) => pattern.test(plain))) return false;

  // The shell prompt follows the Voltage line; capture it too so it stays out of Xterm.
  return plain.slice((voltageMatch.index ?? 0) + voltageMatch[0].length).includes('QDrive:/$ ');
}

function parseStatus(raw: string): Omit<MotorSample, 'time'> | null {
  const values: Partial<Record<SeriesKey, number>> = {};
  const labels: Record<string, SeriesKey> = { current: 'current', speed: 'speed', angle: 'angle' };
  const number = `(${STATUS_NUMBER})`;
  const fieldPattern = new RegExp(`(Current|Speed|Angle)\\s*:\\s*${number}`, 'gi');
  const plain = stripAnsi(raw).replace(/\\0/g, '');

  for (const match of plain.matchAll(fieldPattern)) {
    const key = labels[match[1].toLowerCase()];
    const value = Number(match[2]);
    if (Number.isFinite(value)) values[key] = value;
  }

  return values.current === undefined || values.speed === undefined || values.angle === undefined ? null : {
    current: values.current,
    speed: values.speed,
    angle: values.angle,
  };
}

function formatValue(value: number, unit: string): string {
  const digits = Math.abs(value) >= 100 ? 1 : Math.abs(value) >= 10 ? 2 : 3;
  return `${value.toFixed(digits)} ${unit}`;
}

function niceRange(values: number[], flatRange: number): [number, number] {
  if (values.length === 0) return [-1, 1];
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const padding = Math.max(Math.abs(min) * 0.12, flatRange);
    return [min - padding, max + padding];
  }
  const paddedMin = min - (max - min) * 0.12;
  const paddedMax = max + (max - min) * 0.12;
  const rawStep = (paddedMax - paddedMin) / 4;
  const power = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / power;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = factor * power;
  min = Math.floor(paddedMin / step) * step;
  max = Math.ceil(paddedMax / step) * step;
  return [min, max];
}

function formatAxisValue(value: number, step: number): string {
  const absStep = Math.abs(step);
  if (absStep >= 1000 || (absStep > 0 && absStep < 0.001)) return value.toExponential(2);
  const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(Math.max(absStep, Number.EPSILON)))));
  return value.toFixed(decimals);
}

function visibleSamples(samples: MotorSample[], xVisibleSeconds: number, xEndOffsetSeconds: number): MotorSample[] {
  const xEnd = samples[samples.length - 1].time - xEndOffsetSeconds;
  const xStart = xEnd - xVisibleSeconds;
  return samples.filter((sample) => sample.time >= xStart && sample.time <= xEnd);
}

function closestSample(samples: MotorSample[], time: number): MotorSample {
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].time < time) low = mid + 1;
    else high = mid;
  }
  const current = samples[low];
  const previous = samples[Math.max(0, low - 1)];
  return Math.abs(current.time - time) < Math.abs(previous.time - time) ? current : previous;
}

function drawRoundedLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  stroke: string,
): void {
  const radius = Math.min(4, height / 2, width / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function drawChart(
  chart: Chart,
  samples: MotorSample[],
  xVisibleSeconds: number,
  xEndOffsetSeconds: number,
  hoverClientX: number | null,
  timeOrigin: number,
): void {
  const ctx = chart.canvas.getContext('2d');
  if (!ctx) return;
  const rect = chart.canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (chart.canvas.width !== width || chart.canvas.height !== height) {
    chart.canvas.width = width;
    chart.canvas.height = height;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;
  const left = PLOT_LEFT;
  const right = PLOT_RIGHT;
  const top = 12;
  const bottom = 25;
  const plotW = Math.max(1, w - left - right);
  const plotH = Math.max(1, h - top - bottom);
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const grid = dark ? '#303037' : '#e5e7eb';
  const text = dark ? '#a1a1aa' : '#6b7280';
  const plot = dark ? '#111111' : '#ffffff';
  ctx.fillStyle = plot;
  ctx.fillRect(0, 0, w, h);

  const visible = samples.length > 0 ? visibleSamples(samples, xVisibleSeconds, xEndOffsetSeconds) : [];
  const xStart = visible[0]?.time ?? timeOrigin;
  const xEnd = visible[visible.length - 1]?.time ?? timeOrigin + MAX_VISIBLE_SECONDS;
  const [autoMin, autoMax] = visible.length > 0
    ? niceRange(visible.map((sample) => sample[chart.key]), SERIES[chart.key].flatRange)
    : [-1, 1];
  const center = (autoMin + autoMax) / 2;
  const half = ((autoMax - autoMin) / 2) * chart.yZoom;
  const yMin = center - half;
  const yMax = center + half;
  const xSpan = Math.max(xEnd - xStart, 0.001);
  const ySpan = Math.max(yMax - yMin, Number.EPSILON);
  const x = (time: number) => left + ((time - xStart) / xSpan) * plotW;
  const y = (value: number) => top + (1 - (value - yMin) / ySpan) * plotH;

  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillStyle = text;
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i += 1) {
    const yy = top + (plotH * i) / 4;
    const value = yMax - (ySpan * i) / 4;
    ctx.beginPath();
    ctx.moveTo(left, yy + 0.5);
    ctx.lineTo(w - right, yy + 0.5);
    ctx.stroke();
    ctx.fillText(formatAxisValue(value, ySpan / 4), left - 7, yy + 4);
  }
  if (yMin <= 0 && yMax >= 0) {
    const zeroY = y(0);
    ctx.strokeStyle = dark ? '#a1a1aa' : '#4b5563';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, zeroY + 0.5);
    ctx.lineTo(w - right, zeroY + 0.5);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i += 1) {
    const xx = left + (plotW * i) / 4;
    const value = xStart + (xSpan * i) / 4;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xx + 0.5, top);
    ctx.lineTo(xx + 0.5, h - bottom);
    ctx.stroke();
    ctx.fillText(`${(value - timeOrigin).toFixed(Math.abs(value - timeOrigin) < 10 ? 3 : 2)}s`, xx, h - 7);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, plotW, plotH);
  ctx.clip();
  if (samples.length > 0 && timeOrigin >= xStart && timeOrigin <= xEnd) {
    const zeroX = x(timeOrigin);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = dark ? '#fbbf24' : '#b45309';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(zeroX, top);
    ctx.lineTo(zeroX, h - bottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = SERIES[chart.key].color;
  ctx.lineWidth = 1.7;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (visible.length > 0) {
    const pointStep = Math.max(1, Math.ceil(visible.length / Math.max(1, Math.floor(plotW * 4))));
    ctx.beginPath();
    for (let index = 0; index < visible.length; index += pointStep) {
      const sample = visible[index];
      if (index === 0) ctx.moveTo(x(sample.time), y(sample[chart.key]));
      else ctx.lineTo(x(sample.time), y(sample[chart.key]));
    }
    const lastSample = visible[visible.length - 1];
    if (lastSample && (visible.length - 1) % pointStep !== 0) {
      ctx.lineTo(x(lastSample.time), y(lastSample[chart.key]));
    }
    ctx.stroke();
  }

  const hoverX = hoverClientX === null
    ? null
    : Math.min(Math.max(left, hoverClientX - rect.left), w - right);
  const hoverTime = hoverX === null
    ? null
    : xStart + ((hoverX - left) / plotW) * xSpan;
  const hoverSample = hoverTime !== null && visible.length > 0
    ? closestSample(visible, hoverTime)
    : null;
  if (hoverSample) {
    const sample = hoverSample;
    const hoverY = y(sample[chart.key]);
    const label = formatValue(sample[chart.key], SERIES[chart.key].unit);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = dark ? '#e4e4e7' : '#27272a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hoverX!, top);
    ctx.lineTo(hoverX!, h - bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = dark ? '#ffffff' : '#111827';
    ctx.beginPath();
    ctx.arc(hoverX!, hoverY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = dark ? '#111111' : '#ffffff';
    ctx.stroke();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const labelWidth = ctx.measureText(label).width + 10;
    const labelX = Math.min(Math.max(left, hoverX! + 7), w - right - labelWidth);
    const labelY = Math.min(Math.max(top + 2, hoverY - 21), h - bottom - 18);
    drawRoundedLabel(ctx, labelX, labelY, labelWidth, 17, dark ? '#27272a' : '#ffffff', dark ? '#52525b' : '#d4d4d8');
    ctx.fillStyle = dark ? '#f4f4f5' : '#27272a';
    ctx.textAlign = 'left';
    ctx.fillText(label, labelX + 5, labelY + 12);
  }
  ctx.restore();

  if (hoverSample) {
    const timeLabel = `${(hoverSample.time - timeOrigin).toFixed(3)}s`;
    const timeX = hoverX!;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const labelWidth = ctx.measureText(timeLabel).width + 10;
    const labelX = Math.min(Math.max(left, timeX - labelWidth / 2), w - right - labelWidth);
    const labelY = h - bottom + 3;
    drawRoundedLabel(ctx, labelX, labelY, labelWidth, 17, dark ? '#27272a' : '#ffffff', dark ? '#52525b' : '#d4d4d8');
    ctx.fillStyle = dark ? '#f4f4f5' : '#27272a';
    ctx.textAlign = 'center';
    ctx.fillText(timeLabel, labelX + labelWidth / 2, labelY + 12);
  }
}

export function bootMotorWaveform(ctx: WebHostSerialReadyContext): void {
  const panel = document.getElementById('motor-waveform-panel');
  const toggle = document.getElementById('motor-waveform-toggle') as HTMLButtonElement | null;
  const exportButton = document.getElementById('motor-waveform-export') as HTMLButtonElement | null;
  const frequencyInput = document.getElementById('motor-waveform-frequency') as HTMLInputElement | null;
  const stateEl = document.getElementById('motor-waveform-state');
  if (!panel || !toggle || !frequencyInput || !stateEl) return;
  const waveformToggle = toggle;
  const waveformFrequencyInput = frequencyInput;
  const waveformStateEl = stateEl;
  const waveformStateTextEl = stateEl.querySelector<HTMLElement>('.serial-drive-state-text');
  const frequencyDropdown = document.getElementById('motor-waveform-frequency-dd');
  if (frequencyDropdown) {
    wireSerialDropdown(frequencyDropdown, (value) => {
      waveformFrequencyInput.value = value || '30';
    });
  }

  const charts = (Object.keys(SERIES) as SeriesKey[]).map((key) => ({
    key,
    canvas: panel.querySelector<HTMLCanvasElement>(`[data-motor-waveform="${key}"]`) as HTMLCanvasElement,
    valueEl: panel.querySelector<HTMLElement>(`[data-motor-value="${key}"]`),
    yZoom: 1,
  })).filter((chart): chart is Chart => chart.canvas !== null);
  const samples: MotorSample[] = [];
  const maxSamples = 6000;
  let running = false;
  let timer: number | null = null;
  let startedAt = 0;
  let xVisibleSeconds = MAX_VISIBLE_SECONDS;
  let xEndOffsetSeconds = 0;
  let timeOrigin = 0;
  let pauseUntil = 0;
  let nextPollAt = 0;
  let sessionId = 0;
  let drawQueued = false;
  let hoverClientX: number | null = null;
  let drag: { pointerId: number; startX: number; startOffset: number; moved: boolean } | null = null;
  let pendingTimeOrigin: number | null = null;
  let timeOriginClickTimer: number | null = null;

  ctx.subscribeToUserCommands(() => {
    pauseUntil = performance.now() + MANUAL_COMMAND_PAUSE_CYCLES * (1000 / getFrequency());
  });

  function draw(): void {
    charts.forEach((chart) => drawChart(chart, samples, xVisibleSeconds, xEndOffsetSeconds, hoverClientX, timeOrigin));
  }

  function clampXEndOffset(): void {
    if (samples.length < 2) {
      xEndOffsetSeconds = 0;
      return;
    }
    const availableSeconds = samples[samples.length - 1].time - samples[0].time;
    const maxOffset = Math.max(0, availableSeconds - Math.min(availableSeconds, xVisibleSeconds));
    xEndOffsetSeconds = Math.min(Math.max(0, xEndOffsetSeconds), maxOffset);
  }

  function updateHoverPosition(clientX: number): void {
    hoverClientX = clientX;
  }

  function plotXRatio(canvas: HTMLCanvasElement, clientX: number): number {
    const rect = canvas.getBoundingClientRect();
    const plotW = Math.max(1, rect.width - PLOT_LEFT - PLOT_RIGHT);
    return Math.min(1, Math.max(0, (clientX - rect.left - PLOT_LEFT) / plotW));
  }

  function hoverTimeAt(canvas: HTMLCanvasElement, clientX: number): number | null {
    if (samples.length === 0) return null;
    const visible = visibleSamples(samples, xVisibleSeconds, xEndOffsetSeconds);
    if (visible.length === 0) return null;
    const ratio = plotXRatio(canvas, clientX);
    return visible[0].time + (visible[visible.length - 1].time - visible[0].time) * ratio;
  }

  function requestDraw(): void {
    if (drawQueued) return;
    drawQueued = true;
    window.requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  function setWaveformState(text: string, state: 'on' | 'off' | 'unknown' = 'off'): void {
    waveformStateEl.dataset.state = state;
    waveformStateEl.title = '';
    if (waveformStateTextEl) waveformStateTextEl.textContent = text;
  }

  function exportSamples(): void {
    if (samples.length === 0) return;
    const rows = [
      'time_s,current_A,speed_rpm,angle_rad',
      ...samples.map((sample) => [
        sample.time.toFixed(6),
        String(sample.current),
        String(sample.speed),
        String(sample.angle),
      ].join(',')),
    ];
    const blob = new Blob([`\ufeff${rows.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `qdrive-motor-waveform-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function stop(message = '已停止'): void {
    sessionId += 1;
    running = false;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    ctx.setTerminalInputEnabled(true);
    waveformToggle.textContent = '开始绘制';
    waveformToggle.setAttribute('aria-pressed', 'false');
    setWaveformState(message, 'off');
  }

  function getFrequency(): number {
    const parsed = Number(waveformFrequencyInput.value);
    const frequency = Number.isFinite(parsed) ? Math.min(120, Math.max(30, parsed)) : 30;
    waveformFrequencyInput.value = String(frequency);
    return frequency;
  }

  async function poll(activeSessionId: number): Promise<void> {
    if (!running || activeSessionId !== sessionId) return;
    const remainingPause = pauseUntil - performance.now();
    if (remainingPause > 0) {
      nextPollAt = performance.now() + remainingPause;
      timer = window.setTimeout(() => void poll(activeSessionId), remainingPause);
      return;
    }
    if (!ctx.isSerialConnected()) {
      stop('串口已断开');
      return;
    }
    const frequency = getFrequency();
    try {
      const raw = await ctx.captureUntilIdle(() => ctx.sendPollingLine('status'), 22.5, 500, {
        silent: true,
        isComplete: hasCompleteStatus,
      });
      if (!running || activeSessionId !== sessionId) return;
      const parsed = parseStatus(raw);
      if (parsed) {
        const time = (performance.now() - startedAt) / 1000;
        samples.push({ time, ...parsed });
        if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
        if (exportButton) exportButton.disabled = false;
        const previousTime = samples.length > 1 ? samples[samples.length - 2].time : time;
        if (xEndOffsetSeconds > 0) xEndOffsetSeconds += time - previousTime;
        clampXEndOffset();
        charts.forEach((chart) => {
          chart.valueEl && (chart.valueEl.textContent = formatValue(parsed[chart.key], SERIES[chart.key].unit));
        });
        setWaveformState('采集中', 'on');
        requestDraw();
      } else {
        const preview = stripAnsi(raw)
          .replace(/\\0/g, '')
          .replace(/\\s+/g, ' ')
          .trim()
          .slice(0, 110);
        setWaveformState(raw ? `解析失败：${preview}` : '未收到状态回包', 'unknown');
        waveformStateEl.title = raw ? stripAnsi(raw).trim() : '';
      }
    } catch {
      setWaveformState('采样通信失败', 'unknown');
    }
    if (running && activeSessionId === sessionId) {
      const manualCommandDelay = Math.max(0, pauseUntil - performance.now());
      if (manualCommandDelay > 0) {
        nextPollAt = performance.now() + manualCommandDelay;
        timer = window.setTimeout(() => void poll(activeSessionId), manualCommandDelay);
        return;
      }

      nextPollAt += 1000 / frequency;
      const delay = nextPollAt - performance.now();
      if (delay <= 0) {
        // Browser timers wake late at short intervals. Start immediately when a deadline
        // has already passed so the error does not accumulate from cycle to cycle.
        void poll(activeSessionId);
      } else {
        timer = window.setTimeout(() => void poll(activeSessionId), delay);
      }
    }
  }

  waveformToggle.addEventListener('click', () => {
    if (running) {
      stop();
      return;
    }
    if (!ctx.isSerialConnected()) {
      ctx.setStatusLine('请先连接串口后再开始绘制。');
      return;
    }
    running = true;
    sessionId += 1;
    const activeSessionId = sessionId;
    const lastSampleTime = samples[samples.length - 1]?.time ?? 0;
    startedAt = performance.now() - lastSampleTime * 1000;
    nextPollAt = performance.now();
    pauseUntil = 0;
    ctx.setTerminalInputEnabled(false);
    waveformToggle.textContent = '停止绘制';
    waveformToggle.setAttribute('aria-pressed', 'true');
    setWaveformState('采集中', 'on');
    void poll(activeSessionId);
  });

  exportButton?.addEventListener('click', exportSamples);

  charts.forEach((chart) => {
    chart.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (event.shiftKey) chart.yZoom = Math.min(100, Math.max(0.02, chart.yZoom * (event.deltaY < 0 ? 0.8 : 1.25)));
      if (event.ctrlKey) {
        const anchorTime = hoverTimeAt(chart.canvas, event.clientX);
        const anchorRatio = plotXRatio(chart.canvas, event.clientX);
        xVisibleSeconds = Math.min(
          MAX_VISIBLE_SECONDS,
          Math.max(0.01, xVisibleSeconds * (event.deltaY < 0 ? 0.8 : 1.25)),
        );
        // Keep the time under the cursor fixed while changing the horizontal scale.
        if (anchorTime !== null) {
          xEndOffsetSeconds = samples[samples.length - 1].time
            - (anchorTime + (1 - anchorRatio) * xVisibleSeconds);
        }
      } else if (!event.shiftKey && samples.length > 1) {
        const previousOffset = xEndOffsetSeconds;
        xEndOffsetSeconds += event.deltaY > 0 ? -xVisibleSeconds * 0.1 : xVisibleSeconds * 0.1;
        clampXEndOffset();
        if (xEndOffsetSeconds === previousOffset) return;
      }
      clampXEndOffset();
      requestDraw();
    }, { passive: false });
    chart.canvas.addEventListener('pointerdown', (event) => {
      updateHoverPosition(event.clientX);
      drag = { pointerId: event.pointerId, startX: event.clientX, startOffset: xEndOffsetSeconds, moved: false };
      chart.canvas.setPointerCapture(event.pointerId);
      chart.canvas.style.cursor = 'grabbing';
      requestDraw();
    });
    chart.canvas.addEventListener('pointermove', (event) => {
      updateHoverPosition(event.clientX);
      if (drag?.pointerId === event.pointerId) {
        const plotW = Math.max(1, chart.canvas.getBoundingClientRect().width - PLOT_LEFT - PLOT_RIGHT);
        const offsetDelta = ((event.clientX - drag.startX) / plotW) * xVisibleSeconds;
        drag.moved ||= Math.abs(event.clientX - drag.startX) > 3;
        xEndOffsetSeconds = Math.max(0, drag.startOffset + offsetDelta);
        clampXEndOffset();
      }
      requestDraw();
    });
    chart.canvas.addEventListener('pointerup', (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      const hoverTime = hoverTimeAt(chart.canvas, event.clientX);
      if (!drag.moved && hoverTime !== null) {
        pendingTimeOrigin = closestSample(samples, hoverTime).time;
        if (timeOriginClickTimer !== null) window.clearTimeout(timeOriginClickTimer);
        timeOriginClickTimer = window.setTimeout(() => {
          if (pendingTimeOrigin !== null) timeOrigin = pendingTimeOrigin;
          pendingTimeOrigin = null;
          timeOriginClickTimer = null;
          requestDraw();
        }, 200);
      }
      drag = null;
      chart.canvas.releasePointerCapture(event.pointerId);
      chart.canvas.style.cursor = 'crosshair';
    });
    chart.canvas.addEventListener('pointercancel', () => {
      drag = null;
      chart.canvas.style.cursor = 'crosshair';
    });
    chart.canvas.addEventListener('pointerleave', () => {
      if (drag) return;
      hoverClientX = null;
      requestDraw();
    });
    chart.canvas.addEventListener('dblclick', () => {
      if (timeOriginClickTimer !== null) window.clearTimeout(timeOriginClickTimer);
      timeOriginClickTimer = null;
      pendingTimeOrigin = null;
      charts.forEach((item) => { item.yZoom = 1; });
      xVisibleSeconds = MAX_VISIBLE_SECONDS;
      xEndOffsetSeconds = 0;
      requestDraw();
    });
  });

  new ResizeObserver(requestDraw).observe(panel);
  requestDraw();
}
