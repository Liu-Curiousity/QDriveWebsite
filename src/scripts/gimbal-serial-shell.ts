import {
  bootWebHostSerialShell,
  CTRL_MODE_SUBCMD,
  CTRL_MODE_UI,
  normalizeScientificNotation,
  stripAnsi,
  type DriveStateBinding,
  type WebHostControlBinding,
  type WebHostSerialReadyContext,
} from './web-host-serial-shell.ts';

type Tri = 'on' | 'off' | 'unknown';

export type GimbalStatusFlags = {
  enabled: Tri;
  stability: Tri;
  laser: Tri;
};

function parseGimbalYesNoToken(v: string): boolean | null {
  const t = v.trim().toLowerCase();
  if (t === 'yes' || t === 'true' || t === '1' || t === 'on') return true;
  if (t === 'no' || t === 'false' || t === '0' || t === 'off') return false;
  return null;
}

/** 解析云台固件 `status` 中的 Enabled / Stability Enabled / Laser Enabled（Yes/No） */
export function parseGimbalStatusFlags(raw: string): GimbalStatusFlags | null {
  const plain = stripAnsi(raw).replace(/\0/g, '').replace(/\u00a0/g, ' ');
  let enabled: boolean | null = null;
  let stability: boolean | null = null;
  let laser: boolean | null = null;

  for (const line of plain.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;

    let m = t.match(/^Stability\s+Enabled\s*[:：]\s*(.+)$/i);
    if (m) {
      stability = parseGimbalYesNoToken(m[1]);
      continue;
    }
    m = t.match(/^Laser\s+Enabled\s*[:：]\s*(.+)$/i);
    if (m) {
      laser = parseGimbalYesNoToken(m[1]);
      continue;
    }
    m = t.match(/^Enabled\s*[:：]\s*(.+)$/i);
    if (m) {
      enabled = parseGimbalYesNoToken(m[1]);
      continue;
    }
  }

  if (enabled === null && stability === null && laser === null) return null;

  const toTri = (v: boolean | null): Tri => (v === null ? 'unknown' : v ? 'on' : 'off');

  return {
    enabled: toTri(enabled),
    stability: toTri(stability),
    laser: toTri(laser),
  };
}

type RowUi = 'disconnected' | 'unknown' | 'on' | 'off';

type GimbalStatusRowKind = 'enable' | 'stability' | 'laser';

function gimbalStatusLabel(row: GimbalStatusRowKind, s: RowUi): string {
  if (s === 'disconnected' || s === 'unknown') return s === 'disconnected' ? '未连接' : '状态未知';
  if (row === 'enable') return s === 'on' ? '已使能' : '已失能';
  if (row === 'stability') return s === 'on' ? '自稳打开' : '自稳关闭';
  return s === 'on' ? '激光打开' : '激光关闭';
}

function gimbalStatusAria(row: GimbalStatusRowKind, s: RowUi): string {
  const prefix: Record<GimbalStatusRowKind, string> = {
    enable: '使能',
    stability: '自稳',
    laser: '激光',
  };
  return `${prefix[row]}：${gimbalStatusLabel(row, s)}`;
}

/** 自稳 / 激光开关命令后的固件回显（不发 status） */
function applyGimbalStabilityLaserEcho(cmd: string, raw: string): void {
  const elSt = document.getElementById('serial-drive-state-stability');
  const elLz = document.getElementById('serial-drive-state-laser');
  const plain = stripAnsi(raw).replace(/\0/g, '');

  if (cmd === 'enable_stability') {
    if (/stability\s+enabled/i.test(plain)) setGimbalStatusRow(elSt, 'stability', 'on');
    return;
  }
  if (cmd === 'disable_stability') {
    if (/stability\s+control\s+disabled/i.test(plain)) setGimbalStatusRow(elSt, 'stability', 'off');
    return;
  }
  if (cmd === 'enable_laser') {
    if (/laser\s+enabled/i.test(plain)) setGimbalStatusRow(elLz, 'laser', 'on');
    return;
  }
  if (cmd === 'disable_laser') {
    if (/laser\s+disabled/i.test(plain)) setGimbalStatusRow(elLz, 'laser', 'off');
  }
}

function setGimbalStatusRow(el: HTMLElement | null, row: GimbalStatusRowKind, s: RowUi): void {
  if (!el) return;
  el.dataset.state = s;
  const textEl = el.querySelector<HTMLElement>('.serial-drive-state-text');
  const text = gimbalStatusLabel(row, s);
  if (textEl) textEl.textContent = text;
  el.setAttribute('aria-label', gimbalStatusAria(row, s));
}

function createGimbalDriveBinding(): DriveStateBinding {
  const elEn = document.getElementById('serial-drive-state-enable');
  const elSt = document.getElementById('serial-drive-state-stability');
  const elLz = document.getElementById('serial-drive-state-laser');

  return {
    onDisconnected() {
      setGimbalStatusRow(elEn, 'enable', 'disconnected');
      setGimbalStatusRow(elSt, 'stability', 'disconnected');
      setGimbalStatusRow(elLz, 'laser', 'disconnected');
    },
    onConnectedUnknown() {
      setGimbalStatusRow(elEn, 'enable', 'unknown');
      setGimbalStatusRow(elSt, 'stability', 'unknown');
      setGimbalStatusRow(elLz, 'laser', 'unknown');
    },
    onStatusRaw(raw: string) {
      const p = parseGimbalStatusFlags(raw);
      if (!p) {
        setGimbalStatusRow(elEn, 'enable', 'unknown');
        setGimbalStatusRow(elSt, 'stability', 'unknown');
        setGimbalStatusRow(elLz, 'laser', 'unknown');
        return;
      }
      const map: Record<Tri, RowUi> = {
        on: 'on',
        off: 'off',
        unknown: 'unknown',
      };
      setGimbalStatusRow(elEn, 'enable', map[p.enabled]);
      setGimbalStatusRow(elSt, 'stability', map[p.stability]);
      setGimbalStatusRow(elLz, 'laser', map[p.laser]);
    },
    onMainEnableCapture(plain: string) {
      if (/failed/i.test(plain)) return;
      setGimbalStatusRow(elEn, 'enable', 'on');
    },
    onMainDisable() {
      setGimbalStatusRow(elEn, 'enable', 'off');
    },
  };
}

/** 云台：Yaw / Pitch 双控制量 `ctrl <mode> <yaw> <pitch>` */
const gimbalControlBinding: WebHostControlBinding = {
  ctrlModeFallback: 'speed',
  syncCtrlModeFormUi() {
    const ctrlModeHidden = document.getElementById('ctrl-mode') as HTMLInputElement | null;
    if (!ctrlModeHidden) return;
    const ui = CTRL_MODE_UI[ctrlModeHidden.value] ?? CTRL_MODE_UI.current;
    const lab = document.getElementById('ctrl-value-label');
    const yawInp = document.getElementById('gui-ctrl-value-yaw') as HTMLInputElement | null;
    const pitchInp = document.getElementById('gui-ctrl-value-pitch') as HTMLInputElement | null;
    if (lab) lab.textContent = ui.label;
    if (yawInp) yawInp.placeholder = 'Yaw轴';
    if (pitchInp) pitchInp.placeholder = 'Pitch轴';
  },
  attachCtrlSend(ctx) {
    const ctrlModeHidden = ctx.ctrlModeHidden;
    const ctrlYawInput = document.getElementById('gui-ctrl-value-yaw') as HTMLInputElement | null;
    const ctrlPitchInput = document.getElementById('gui-ctrl-value-pitch') as HTMLInputElement | null;
    const ctrlSendBtn = document.getElementById('serial-ctrl-send') as HTMLButtonElement | null;

    function sendGuiCtrlValue(focusTerminalAfter = true): void {
      if (!ctx.isSerialConnected()) {
        ctx.setStatus('请先连接串口后再发送命令。');
        return;
      }
      if (!ctrlModeHidden) return;
      const sub = CTRL_MODE_SUBCMD[ctrlModeHidden.value];
      if (!sub) return;
      if (!ctrlYawInput || !ctrlPitchInput) return;
      const vy = normalizeScientificNotation(ctrlYawInput.value);
      const vp = normalizeScientificNotation(ctrlPitchInput.value);
      if (!vy || !vp) {
        ctx.setStatus('请填写 Yaw 轴与 Pitch 轴控制量后再发送。');
        return;
      }
      void ctx.sendLine(`ctrl ${sub} ${vy} ${vp}`);
      ctx.focusTerminal(focusTerminalAfter);
    }

    ctrlSendBtn?.addEventListener('click', () => sendGuiCtrlValue(true));
    [ctrlYawInput, ctrlPitchInput].forEach((el) => {
      el?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        sendGuiCtrlValue(false);
      });
    });
  },
};

function attachGimbalExtraCommands(ctx: WebHostSerialReadyContext): void {
  const pairs: [string, string][] = [
    ['serial-cmd-enable-stability', 'enable_stability'],
    ['serial-cmd-disable-stability', 'disable_stability'],
    ['serial-cmd-enable-laser', 'enable_laser'],
    ['serial-cmd-disable-laser', 'disable_laser'],
  ];

  for (const [id, line] of pairs) {
    document.getElementById(id)?.addEventListener('click', () => {
      if (!ctx.isSerialConnected()) {
        ctx.setStatusLine('请先连接串口后再发送命令。');
        return;
      }
      void (async () => {
        try {
          const raw = await ctx.captureUntilIdle(() => ctx.sendLine(line));
          applyGimbalStabilityLaserEcho(line, raw);
        } catch {
          /* 回显仍由 readLoop 写入终端 */
        }
        ctx.focusTerminal();
      })();
    });
  }
}

/** 参数区 Yaw / Pitch 全宽分段切换 */
function attachGimbalConfigAxisSwitch(): void {
  const root = document.querySelector('.gimbal-axis-switch');
  const yawPanel = document.getElementById('gimbal-config-yaw');
  const pitchPanel = document.getElementById('gimbal-config-pitch');
  if (!root || !yawPanel || !pitchPanel) return;

  const yawEl: HTMLElement = yawPanel;
  const pitchEl: HTMLElement = pitchPanel;

  const btns = root.querySelectorAll<HTMLButtonElement>('[data-axis]');
  if (btns.length === 0) return;

  function showAxis(axis: 'yaw' | 'pitch'): void {
    for (const btn of btns) {
      const a = btn.dataset.axis;
      const active = a === axis;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    yawEl.hidden = axis !== 'yaw';
    pitchEl.hidden = axis !== 'pitch';
  }

  for (const btn of btns) {
    btn.addEventListener('click', () => {
      const a = btn.dataset.axis;
      if (a === 'yaw' || a === 'pitch') showAxis(a);
    });
  }
}

/** Yaw / Pitch 面板各有一份 uart.baud_rate，编辑时保持同步 */
function attachGimbalSharedConfigFieldSync(): void {
  const uartInputs = document.querySelectorAll<HTMLInputElement>('[data-config-key="uart.baud_rate"]');
  if (uartInputs.length < 2) return;

  uartInputs.forEach((input) => {
    input.addEventListener('input', () => {
      for (const other of uartInputs) {
        if (other !== input) other.value = input.value;
      }
    });
  });
}

export function bootGimbalSerialShell(): void {
  const gimbalDrive = createGimbalDriveBinding();
  bootWebHostSerialShell({
    deviceInfoExtraDlId: 'device-info-gimbal',
    controls: gimbalControlBinding,
    driveState: gimbalDrive,
    afterSerialReady: (ctx) => {
      attachGimbalExtraCommands(ctx);
      attachGimbalConfigAxisSwitch();
      attachGimbalSharedConfigFieldSync();
    },
  });
}
