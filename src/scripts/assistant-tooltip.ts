import '../styles/assistant-tooltip.css';

let sharedWireTarget: ((target: HTMLElement) => void) | undefined;

/** Site-wide tooltip. Explicit data-tooltip hints and native validation share
 * the existing web-host appearance; page callers may also opt in icon buttons. */
export function wireAssistantTooltips(root: ParentNode = document): (target: HTMLElement) => void {
  if (!sharedWireTarget) sharedWireTarget = createTooltips();
  root.querySelectorAll<HTMLElement>('[data-tooltip], button[aria-label]:not([data-tooltip-disabled])').forEach(sharedWireTarget);
  return sharedWireTarget;
}

export function initializeSiteTooltips(): void {
  if (!sharedWireTarget) sharedWireTarget = createTooltips();
}

function createTooltips(): (target: HTMLElement) => void {
  const tooltip = document.createElement('div');
  tooltip.className = 'serial-assistant-tooltip';
  tooltip.id = 'site-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.setAttribute('popover', 'manual');
  tooltip.hidden = true;
  document.body.append(tooltip);
  let activeTarget: HTMLElement | null = null;
  let timer: number | undefined;
  const managedForms = new WeakSet<HTMLFormElement>();
  const selector = '[data-tooltip], [title]:not(iframe), [data-tooltip-wired], input, textarea, select';
  const isField = (target: HTMLElement): target is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  const textFor = (target: HTMLElement) => {
    if (isField(target) && target.willValidate && !target.validity.valid) return target.validationMessage;
    return target.dataset.tooltip ?? (target.dataset.tooltipWired ? target.getAttribute('aria-label') : '') ?? '';
  };
  const position = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const above = rect.top >= height + 19;
    const left = Math.max(10, Math.min(window.innerWidth - width - 10, rect.left + rect.width / 2 - width / 2));
    tooltip.dataset.placement = above ? 'top' : 'bottom';
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(10, Math.min(window.innerHeight - height - 10, above ? rect.top - height - 9 : rect.bottom + 9))}px`;
    tooltip.style.setProperty('--tooltip-anchor-x', `${rect.left + rect.width / 2 - left}px`);
  };
  const hide = () => {
    window.clearTimeout(timer);
    timer = undefined;
    if (activeTarget) {
      const ids = (activeTarget.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== tooltip.id);
      if (ids.length) activeTarget.setAttribute('aria-describedby', ids.join(' '));
      else activeTarget.removeAttribute('aria-describedby');
    }
    activeTarget = null;
    tooltip.classList.remove('is-visible');
    if (tooltip.matches(':popover-open')) tooltip.hidePopover();
    tooltip.hidden = true;
  };
  const show = (target: HTMLElement, immediate = false) => {
    hide();
    activeTarget = target;
    const reveal = () => {
      if (!target.isConnected || !target.getClientRects().length) return;
      const text = textFor(target);
      if (!text) return;
      // A tooltip belonging to a modal must remain in that modal's accessible
      // subtree. The popover top layer prevents clipping and z-index conflicts.
      const host = target.closest('dialog[open]') ?? document.body;
      if (tooltip.parentElement !== host) host.append(tooltip);
      activeTarget = target;
      tooltip.textContent = text;
      tooltip.hidden = false;
      tooltip.showPopover();
      position(target);
      const ids = new Set((target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
      ids.add(tooltip.id);
      target.setAttribute('aria-describedby', [...ids].join(' '));
      tooltip.classList.add('is-visible');
    };
    if (immediate) reveal();
    else timer = window.setTimeout(reveal, 280);
  };
  const migrateTitle = (target: HTMLElement) => {
    if (!target.hasAttribute('title') || target instanceof HTMLIFrameElement) return;
    target.dataset.tooltip = target.getAttribute('title') ?? '';
    target.removeAttribute('title');
  };
  const wireTarget = (target: HTMLElement) => {
    migrateTitle(target);
    if (target.dataset.tooltipWired === 'true') return;
    target.dataset.tooltipWired = 'true';
    // Existing Serial validation events are deliberately non-bubbling.
    target.addEventListener('serial-assistant-show-tooltip', () => show(target, true));
    target.addEventListener('serial-assistant-hide-tooltip', () => { if (activeTarget === target) hide(); });
  };
  const prepare = (root: ParentNode) => {
    const nodes = [...root.querySelectorAll<HTMLElement>('[title]:not(iframe), form')];
    if (root instanceof HTMLElement && root.matches('[title]:not(iframe), form')) nodes.unshift(root);
    for (const node of nodes) {
      migrateTitle(node);
      if (node instanceof HTMLFormElement && !node.noValidate) {
        managedForms.add(node);
        node.noValidate = true;
      }
    }
  };
  prepare(document);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLElement) migrateTitle(record.target);
      for (const node of record.addedNodes) if (node instanceof HTMLElement) prepare(node);
    }
    if (activeTarget && (!activeTarget.isConnected || !activeTarget.getClientRects().length)) hide();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'open', 'hidden'] });
  const targetFor = (event: Event) => event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
  document.addEventListener('pointerover', event => {
    const target = targetFor(event);
    if (target && !target.contains(event.relatedTarget as Node | null)) { migrateTitle(target); show(target); }
  });
  document.addEventListener('pointerout', event => {
    const target = targetFor(event);
    if (target === activeTarget && target && !target.contains(event.relatedTarget as Node | null)) hide();
  });
  document.addEventListener('focusin', event => { const target = targetFor(event); if (target) show(target); });
  document.addEventListener('focusout', event => { if (event.target === activeTarget) hide(); });
  document.addEventListener('input', event => { if (event.target === activeTarget) hide(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  document.addEventListener('close', hide, true);
  window.addEventListener('scroll', () => { if (!tooltip.hidden) hide(); }, true);
  window.addEventListener('resize', hide);
  let reportingInvalid = false;
  document.addEventListener('invalid', event => {
    event.preventDefault();
    if (!(event.target instanceof HTMLElement) || reportingInvalid) return;
    reportingInvalid = true;
    const target = event.target;
    target.focus();
    show(target, true);
    queueMicrotask(() => { reportingInvalid = false; });
  }, true);
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !managedForms.has(form)) return;
    if (event.submitter instanceof HTMLButtonElement || event.submitter instanceof HTMLInputElement) {
      if (event.submitter.formNoValidate) return;
    }
    if (!form.checkValidity()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  return wireTarget;
}
