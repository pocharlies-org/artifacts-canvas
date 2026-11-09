type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

/** Tiny DOM builder. Strings become text nodes (never HTML). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Close open popovers when clicking elsewhere. */
export function installPopoverDismiss() {
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as HTMLElement;
    for (const p of document.querySelectorAll<HTMLElement>('.popover.open')) {
      const owner = p.dataset.owner ? document.getElementById(p.dataset.owner) : null;
      if (!p.contains(target) && !(owner && owner.contains(target))) p.classList.remove('open');
    }
  });
}
