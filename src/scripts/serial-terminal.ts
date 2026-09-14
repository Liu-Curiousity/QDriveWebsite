import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export type SerialTerminalHandle = {
  term: Terminal;
  fitAddon: FitAddon;
  terminalWrapEl: HTMLElement | null;
  serialShellInertRoot: HTMLElement;
};

function termTheme(terminalEl: HTMLElement) {
  const card = terminalEl.closest('.serial-terminal-card') ?? terminalEl;
  const styles = getComputedStyle(card);
  return {
    background: styles.backgroundColor,
    foreground: styles.color,
    cursor: styles.color,
    selectionBackground: window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'rgba(249, 250, 251, 0.25)'
      : 'rgba(17, 24, 39, 0.12)',
  };
}

export function createSerialTerminal(terminalEl: HTMLElement): SerialTerminalHandle {
  const fitAddon = new FitAddon();
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.1,
    scrollback: 2000,
    theme: termTheme(terminalEl),
  });

  term.loadAddon(fitAddon);
  term.open(terminalEl);

  const terminalWrapEl = terminalEl.closest('.serial-terminal-wrap') as HTMLElement | null;
  const serialShellInertRoot: HTMLElement = terminalWrapEl ?? terminalEl;

  fitAddon.fit();

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => {
    const theme = termTheme(terminalEl);
    term.options.theme = theme;
    const viewport = term.element?.querySelector<HTMLElement>('.xterm-viewport');
    if (viewport) viewport.style.backgroundColor = theme.background;
  };
  onScheme();
  mq.addEventListener('change', onScheme);

  const ro = new ResizeObserver(() => {
    try {
      fitAddon.fit();
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
