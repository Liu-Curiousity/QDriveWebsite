const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const RESOURCE_DIALOGS_BOOTED_ATTRIBUTE = 'data-resource-dialogs-booted';
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
  if (document.documentElement.hasAttribute(RESOURCE_DIALOGS_BOOTED_ATTRIBUTE)) return;

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
  document.documentElement.setAttribute(RESOURCE_DIALOGS_BOOTED_ATTRIBUTE, 'true');

  const entriesByTrigger = new Map(entries.map((entry) => [entry.triggerId, entry]));
  let activeEntry: ResourceDialogEntry | null = null;
  let lastFocused: HTMLElement | null = null;
  let previousBodyOverflow = '';
  let focusFrame: number | null = null;

  const close = (restoreFocus = true): void => {
    if (!activeEntry) return;
    if (focusFrame !== null) {
      window.cancelAnimationFrame(focusFrame);
      focusFrame = null;
    }
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
    entry.dialog.scrollTop = 0;
    entry.dialog
      .querySelectorAll<HTMLElement>('.download-resource-dialog__list')
      .forEach((list) => { list.scrollTop = 0; });
    entry.dialog.classList.add('open');
    entry.dialog.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    focusFrame = window.requestAnimationFrame(() => {
      focusFrame = null;
      if (activeEntry !== entry || entry.dialog.getAttribute('aria-hidden') !== 'false') return;
      getFocusableElements(entry.dialog)[0]?.focus({ preventScroll: true });
    });
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
