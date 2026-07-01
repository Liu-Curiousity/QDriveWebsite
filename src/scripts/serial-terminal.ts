import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export type SerialTerminalHandle = {
  term: Terminal;
  fitAddon: FitAddon;
  terminalWrapEl: HTMLElement | null;
  serialShellInertRoot: HTMLElement;
};

function termTheme(dark: boolean) {
  return dark
    ? {
        background: '#111111',
        foreground: '#f9fafb',
        cursor: '#f9fafb',
        selectionBackground: 'rgba(249, 250, 251, 0.25)',
      }
    : {
        background: '#ffffff',
        foreground: '#111827',
        cursor: '#111827',
        selectionBackground: 'rgba(17, 24, 39, 0.12)',
      };
}

function syncXtermChrome(term: Terminal, wrapEl: HTMLElement | null): void {
  const th = term.options.theme;
  const bg =
    th &&
    typeof th === 'object' &&
    'background' in th &&
    typeof (th as { background?: unknown }).background === 'string'
      ? (th as { background: string }).background
      : '#ffffff';
  const viewport = term.element?.querySelector<HTMLElement>('.xterm-viewport');
  viewport?.style.setProperty('background-color', bg, 'important');
  if (wrapEl) wrapEl.style.backgroundColor = bg;
}

export function createSerialTerminal(terminalEl: HTMLElement): SerialTerminalHandle {
  const fitAddon = new FitAddon();
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.1,
    scrollback: 2000,
    theme: termTheme(window.matchMedia('(prefers-color-scheme: dark)').matches),
  });

  term.loadAddon(fitAddon);
  term.open(terminalEl);

  const terminalWrapEl = terminalEl.closest('.serial-terminal-wrap') as HTMLElement | null;
  const serialShellInertRoot: HTMLElement = terminalWrapEl ?? terminalEl;

  fitAddon.fit();
  syncXtermChrome(term, terminalWrapEl);

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => {
    term.options.theme = termTheme(mq.matches);
    syncXtermChrome(term, terminalWrapEl);
  };
  mq.addEventListener('change', onScheme);

  const ro = new ResizeObserver(() => {
    try {
      fitAddon.fit();
      syncXtermChrome(term, terminalWrapEl);
    } catch {
      /* ignore */
    }
  });
  ro.observe(terminalEl.parentElement ?? terminalEl);

  return {
    term,
    fitAddon,
    terminalWrapEl,
    serialShellInertRoot,
  };
}

export type { Terminal };
