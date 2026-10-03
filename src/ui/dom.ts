type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

/** Tiny hyperscript helper: h('div', { class: 'x', onclick: fn }, child, ...). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function button(label: string, onClick: () => void, opts: { cls?: string; disabled?: boolean } = {}): HTMLButtonElement {
  return h('button', {
    class: `mc-btn ${opts.cls ?? ''}`,
    text: label,
    disabled: opts.disabled ?? false,
    onclick: () => {
      if (!opts.disabled) onClick();
    },
  });
}

/** Minecraft-style option button that cycles through values. */
export function cycleButton<T extends string>(
  label: string, options: readonly T[], names: Record<T, string>, current: T, onChange: (v: T) => void,
): HTMLButtonElement {
  let value = current;
  const btn = h('button', { class: 'mc-btn' });
  const render = () => (btn.textContent = `${label}: ${names[value]}`);
  btn.addEventListener('click', () => {
    value = options[(options.indexOf(value) + 1) % options.length];
    render();
    onChange(value);
  });
  render();
  return btn;
}

/** Minecraft-style slider: the label lives inside the track. */
export function slider(
  min: number, max: number, step: number, value: number,
  label: (v: number) => string, onChange: (v: number) => void,
): HTMLElement {
  const text = h('span', { class: 'mc-slider-label' });
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  const update = () => {
    const v = Number(input.value);
    text.textContent = label(v);
    const pct = ((v - min) / (max - min)) * 100;
    input.style.setProperty('--pct', `${pct}%`);
  };
  input.addEventListener('input', () => {
    update();
    onChange(Number(input.value));
  });
  update();
  return h('label', { class: 'mc-slider' }, input, text);
}

export function screen(cls: string, ...children: Child[]): HTMLDivElement {
  return h('div', { class: `screen ${cls}` }, ...children);
}

/**
 * Standard Minecraft menu layout: 33 GUI px header with the title, a scrolling body
 * (optionally the dark "list" variant with separators) and a 33 GUI px footer.
 */
export function menuScreen(
  title: string, body: Child[], footer: Child[], opts: { list?: boolean; cls?: string; tallFooter?: boolean } = {},
): HTMLDivElement {
  return h('div', { class: `screen menu-bg ${opts.cls ?? ''}` },
    h('div', { class: 'screen-header' }, h('h2', { class: 'screen-title', text: title })),
    h('div', { class: `screen-body${opts.list ? ' list' : ''}` }, ...body),
    h('div', { class: `screen-footer${opts.tallFooter ? ' tall' : ''}` }, ...footer),
  );
}

/**
 * Minecraft's dirt menu background, generated (no Mojang assets): a 16×16 tile of brown noise, tiled and darkened.
 * Sets `--dirt` on the root once; screens use `background: var(--dirt)`.
 */
let dirtReady = false;
export function dirtBackground(): void {
  if (dirtReady) return;
  dirtReady = true;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = 38 + Math.floor(rnd() * 26);
      ctx.fillStyle = `rgb(${v + 8},${v - 2},${v - 14})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  document.documentElement.style.setProperty('--dirt', `url(${c.toDataURL()})`);
}
