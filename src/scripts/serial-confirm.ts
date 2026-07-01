import { sleep } from './serial-transport.ts';

export type SerialConfirmKind = 'store_yn' | 'restore_yn' | 'calibrate_yn' | 'upgrade_yn';

export type SerialConfirmController = {
  open: (kind: SerialConfirmKind) => void;
  close: () => void;
  isOpen: () => boolean;
};

type SerialConfirmOptions = {
  inertRoot: HTMLElement;
  isConnected: () => boolean;
  sendLine: (line: string) => Promise<void>;
  focusTerminal: () => void;
  onRestoreConfirmed: () => Promise<void>;
};

function serialConfirmSendsNOnDismiss(kind: SerialConfirmKind | null): boolean {
  return (
    kind === 'store_yn' ||
    kind === 'restore_yn' ||
    kind === 'calibrate_yn' ||
    kind === 'upgrade_yn'
  );
}

function getFocusableElements(rootEl: HTMLElement): HTMLElement[] {
  const box = rootEl.querySelector('.serial-confirm-dialog__box');
  const root = box ?? rootEl;
  const sel =
    'button:not([disabled]), a[href]:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter((el) => el.getClientRects().length > 0);
}

export function createSerialConfirmController(options: SerialConfirmOptions): SerialConfirmController {
  const dialog = document.getElementById('serial-confirm-dialog');
  const title = document.getElementById('serial-confirm-title');
  const desc = document.getElementById('serial-confirm-desc');
  const ok = document.getElementById('serial-confirm-ok') as HTMLButtonElement | null;
  const cancel = document.getElementById('serial-confirm-cancel') as HTMLButtonElement | null;

  let pending: SerialConfirmKind | null = null;
  let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  const isOpen = () => Boolean(dialog?.classList.contains('open'));

  const close = () => {
    if (!dialog) return;
    options.inertRoot.removeAttribute('inert');
    dialog.classList.remove('open');
    dialog.setAttribute('aria-hidden', 'true');
    pending = null;
    if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler, true);
      keydownHandler = null;
    }
  };

  const dismissWithNo = () => {
    const was = pending;
    close();
    if (serialConfirmSendsNOnDismiss(was) && options.isConnected()) void options.sendLine('n');
    options.focusTerminal();
  };

  const open = (kind: SerialConfirmKind) => {
    if (!dialog || !title || !desc || !ok) return;
    pending = kind;
    if (kind === 'store_yn') {
      title.textContent = '写入到设备？';
      desc.textContent = '设备请求确认后再保存当前参数，请选择。';
    } else if (kind === 'restore_yn') {
      title.textContent = '恢复出厂默认？';
      desc.textContent = '设备请求确认后再恢复默认参数，请选择。';
    } else if (kind === 'upgrade_yn') {
      title.textContent = '升级固件？';
      desc.textContent = '设备请求确认后再进行固件升级，请选择。';
    } else {
      title.textContent = '是否继续？';
      desc.textContent = '设备请求确认后再继续当前步骤，请选择。';
    }
    dialog.classList.add('open');
    dialog.setAttribute('aria-hidden', 'false');
    options.inertRoot.setAttribute('inert', '');
    const ae = document.activeElement;
    if (ae instanceof HTMLElement && options.inertRoot.contains(ae)) {
      ae.blur();
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ok?.focus({ preventScroll: true });
      });
    });
    keydownHandler = (e: KeyboardEvent) => {
      if (!isOpen()) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        dismissWithNo();
        return;
      }

      if (e.key === 'Tab' && dialog) {
        e.preventDefault();
        const list = getFocusableElements(dialog);
        if (list.length === 0) return;
        const active = document.activeElement as HTMLElement | null;
        let i = active ? list.indexOf(active) : -1;
        if (i < 0) {
          list[e.shiftKey ? list.length - 1 : 0].focus();
          return;
        }
        if (e.shiftKey) {
          i = i <= 0 ? list.length - 1 : i - 1;
        } else {
          i = i >= list.length - 1 ? 0 : i + 1;
        }
        list[i].focus();
      }
    };
    document.addEventListener('keydown', keydownHandler, true);
  };

  dialog?.addEventListener('click', (e) => {
    if (e.target === dialog) dismissWithNo();
  });

  cancel?.addEventListener('click', dismissWithNo);

  ok?.addEventListener('click', () => {
    if (!options.isConnected() || !pending) return;
    const kind = pending;
    close();
    void (async () => {
      await options.sendLine('y');
      if (kind === 'restore_yn') {
        await sleep(1500);
        await options.onRestoreConfirmed();
      } else {
        options.focusTerminal();
      }
    })();
  });

  return { open, close, isOpen };
}
