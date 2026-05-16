import {
  bootWebHostSerialShell,
  CTRL_MODE_SUBCMD,
  CTRL_MODE_UI,
  normalizeScientificNotation,
  type WebHostControlBinding,
} from './web-host-serial-shell.ts';

/** 电机：单控制量 `ctrl <mode> <value>` */
const motorControlBinding: WebHostControlBinding = {
  ctrlModeFallback: 'current',
  syncCtrlModeFormUi() {
    const ctrlModeHidden = document.getElementById('ctrl-mode') as HTMLInputElement | null;
    if (!ctrlModeHidden) return;
    const ui = CTRL_MODE_UI[ctrlModeHidden.value] ?? CTRL_MODE_UI.current;
    const singleInp = document.getElementById('gui-ctrl-value') as HTMLInputElement | null;
    const lab = document.getElementById('ctrl-value-label');
    if (!singleInp || !lab) return;
    lab.textContent = ui.label;
    singleInp.placeholder = ui.placeholder;
  },
  attachCtrlSend(ctx) {
    const ctrlModeHidden = ctx.ctrlModeHidden;
    const ctrlValueInput = document.getElementById('gui-ctrl-value') as HTMLInputElement | null;
    const ctrlSendBtn = document.getElementById('serial-ctrl-send') as HTMLButtonElement | null;

    function sendGuiCtrlValue(focusTerminalAfter = true): void {
      if (!ctx.isSerialConnected()) {
        ctx.setStatus('请先连接串口后再发送命令。');
        return;
      }
      if (!ctrlModeHidden) return;
      const sub = CTRL_MODE_SUBCMD[ctrlModeHidden.value];
      if (!sub) return;
      if (!ctrlValueInput) return;
      const v = normalizeScientificNotation(ctrlValueInput.value);
      if (!v) {
        ctx.setStatus('请填写控制量后再发送。');
        return;
      }
      void ctx.sendLine(`ctrl ${sub} ${v}`);
      ctx.focusTerminal(focusTerminalAfter);
    }

    ctrlSendBtn?.addEventListener('click', () => sendGuiCtrlValue(true));
    ctrlValueInput?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      sendGuiCtrlValue(false);
    });
  },
};

export function bootMotorSerialShell(): void {
  bootWebHostSerialShell({
    deviceInfoExtraDlId: 'device-info-motor',
    controls: motorControlBinding,
  });
}
