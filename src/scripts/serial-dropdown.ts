export function wireSerialDropdown(
  root: HTMLElement,
  onPick: (value: string, labelText: string) => void,
): void {
  const trigger = root.querySelector<HTMLButtonElement>('.serial-dd-trigger');
  const menu = root.querySelector<HTMLElement>('.serial-dd-menu');
  const labelEl = root.querySelector<HTMLElement>('.serial-dd-trigger-label');
  if (!trigger || !menu || !labelEl) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.hidden;
    if (opening) {
      document.querySelectorAll<HTMLElement>('.serial-dd-menu').forEach((m) => {
        if (m === menu) return;
        if (!m.hidden) {
          m.hidden = true;
          m.closest('.serial-dd')
            ?.querySelector<HTMLButtonElement>('.serial-dd-trigger')
            ?.setAttribute('aria-expanded', 'false');
        }
      });
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    } else {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  });

  // 事件委托让使用同一组件的动态选项（例如 USB 设备返回的 CAN 通道）也能直接复用交互。
  menu.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const item = target?.closest<HTMLButtonElement>('[role="option"]');
    if (!item || !menu.contains(item) || item.disabled) return;
    e.stopPropagation();
    const value = item.dataset.value ?? '';
    const labelText = item.textContent?.trim() ?? '';
    onPick(value, labelText);
    labelEl.textContent = labelText;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  });
}

let outsideCloseRegistered = false;

export function registerSerialDropdownOutsideClose(): void {
  if (outsideCloseRegistered) return;
  outsideCloseRegistered = true;

  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    document.querySelectorAll<HTMLElement>('.serial-dd').forEach((root) => {
      if (root.contains(t)) return;
      const menu = root.querySelector<HTMLElement>('.serial-dd-menu');
      const tr = root.querySelector<HTMLButtonElement>('.serial-dd-trigger');
      if (menu && !menu.hidden) {
        menu.hidden = true;
        tr?.setAttribute('aria-expanded', 'false');
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll<HTMLElement>('.serial-dd-menu').forEach((menu) => {
      if (menu.hidden) return;
      menu.hidden = true;
      menu
        .closest('.serial-dd')
        ?.querySelector<HTMLButtonElement>('.serial-dd-trigger')
        ?.setAttribute('aria-expanded', 'false');
    });
  });
}
