const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const FOCUS_AFTER_REVEAL_MS = 300;

type ResourceDialogEntry = {
  dialog: HTMLElement;
  triggerId: string;
};

function getFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

export function bootResourceDialogs(): void {
  const entries = Array.from(
    document.querySelectorAll<HTMLElement>('[data-resource-dialog][data-open-trigger-id]'),
  )
    .map((dialog): ResourceDialogEntry | null => {
      const triggerId = dialog.dataset.openTriggerId;
      if (!triggerId) return null;
      dialog.setAttribute('aria-hidden', 'true');
      return { dialog, triggerId };
    })
    .filter((entry): entry is ResourceDialogEntry => entry !== null);

  if (entries.length === 0) return;

  const entriesByTrigger = new Map(entries.map((entry) => [entry.triggerId, entry]));
  let activeEntry: ResourceDialogEntry | null = null;
  let lastFocused: HTMLElement | null = null;
  let previousBodyOverflow = '';

  const close = (restoreFocus = true): void => {
    if (!activeEntry) return;
    activeEntry.dialog.classList.remove('open');
    activeEntry.dialog.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = previousBodyOverflow;
    activeEntry = null;
    if (restoreFocus) lastFocused?.focus();
    lastFocused = null;
  };

  const open = (entry: ResourceDialogEntry): void => {
    if (activeEntry === entry) return;
    if (activeEntry) close(false);
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousBodyOverflow = document.body.style.overflow;
    activeEntry = entry;
    entry.dialog.classList.add('open');
    entry.dialog.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    window.setTimeout(
      () => getFocusableElements(entry.dialog)[0]?.focus(),
      FOCUS_AFTER_REVEAL_MS,
    );
  };

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const trigger = target.closest<HTMLElement>('[id]');
    const entry = trigger ? entriesByTrigger.get(trigger.id) : undefined;
    if (entry) {
      open(entry);
      return;
    }

    if (!activeEntry) return;
    if (target === activeEntry.dialog || target.closest('.resource-dialog-close')) close();
  });

  document.addEventListener('keydown', (event) => {
    if (!activeEntry) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = getFocusableElements(activeEntry.dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || !activeEntry.dialog.contains(current))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (current === last || !activeEntry.dialog.contains(current))) {
      event.preventDefault();
      first.focus();
    }
  });
}
