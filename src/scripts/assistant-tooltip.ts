/**
 * Shared tooltip behavior for web-host upper-computer pages.
 *
 * The visual rules live in serial-assistant.css so Serial, CAN and future
 * assistants can use one consistent tooltip without copying page logic.
 */
export function wireAssistantTooltips(root: ParentNode = document): (target: HTMLElement) => void {
  const tooltip = document.createElement('div');
  tooltip.className = 'serial-assistant-tooltip';
  tooltip.id = `assistant-tooltip-${Math.random().toString(36).slice(2)}`;
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.append(tooltip);

  let activeTarget: HTMLElement | null = null;
  let showTimer: number | null = null;

  const tooltipText = (target: HTMLElement) => target.dataset.tooltip
    ?? target.getAttribute('aria-label')
    ?? '';

  const positionTooltip = (target: HTMLElement) => {
    const targetRect = target.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const viewportPadding = 10;
    const gap = 9;
    const fitsAbove = targetRect.top >= tooltipHeight + gap + viewportPadding;
    const top = fitsAbove
      ? targetRect.top - tooltipHeight - gap
      : targetRect.bottom + gap;
    const centeredLeft = targetRect.left + targetRect.width / 2 - tooltipWidth / 2;
    const left = Math.min(
      window.innerWidth - tooltipWidth - viewportPadding,
      Math.max(viewportPadding, centeredLeft),
    );
    tooltip.dataset.placement = fitsAbove ? 'top' : 'bottom';
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.setProperty('--tooltip-anchor-x', `${targetRect.left + targetRect.width / 2 - left}px`);
  };

  const showTooltip = (target: HTMLElement, immediate = false) => {
    const text = tooltipText(target);
    if (!text) return;
    if (showTimer !== null) window.clearTimeout(showTimer);
    const reveal = () => {
      activeTarget = target;
      tooltip.textContent = text;
      tooltip.hidden = false;
      positionTooltip(target);
      requestAnimationFrame(() => tooltip.classList.add('is-visible'));
    };
    if (immediate) {
      showTimer = null;
      reveal();
    } else {
      showTimer = window.setTimeout(reveal, 280);
    }
  };

  const hideTooltip = (target?: HTMLElement) => {
    if (target && activeTarget && target !== activeTarget) return;
    if (showTimer !== null) window.clearTimeout(showTimer);
    showTimer = null;
    activeTarget = null;
    tooltip.classList.remove('is-visible');
    window.setTimeout(() => {
      if (!tooltip.classList.contains('is-visible')) tooltip.hidden = true;
    }, 120);
  };

  const wireTarget = (target: HTMLElement) => {
    if (target.dataset.tooltipWired === 'true') return;
    target.dataset.tooltipWired = 'true';
    target.removeAttribute('title');
    target.setAttribute('aria-describedby', tooltip.id);
    target.addEventListener('pointerenter', () => showTooltip(target));
    target.addEventListener('pointerleave', () => hideTooltip(target));
    target.addEventListener('focus', () => showTooltip(target));
    target.addEventListener('blur', () => hideTooltip(target));
    target.addEventListener('serial-assistant-show-tooltip', () => showTooltip(target, true));
    target.addEventListener('serial-assistant-hide-tooltip', () => hideTooltip(target));
  };

  root.querySelectorAll<HTMLElement>('[data-tooltip], button[aria-label]:not([data-tooltip-disabled])').forEach(wireTarget);
  window.addEventListener('scroll', () => hideTooltip(), true);
  window.addEventListener('resize', () => hideTooltip());
  return wireTarget;
}
