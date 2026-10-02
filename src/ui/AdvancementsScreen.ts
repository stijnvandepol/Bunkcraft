import { ADVANCEMENTS, type AdvancementDef, type AdvancementTab, type AdvancementTracker, TAB_NAMES } from '../player/Advancements';
import type { BlockIcons } from './BlockIcons';
import { button, h } from './dom';

const CELL = 34; // GUI px between node centres
const NODE = 26;

/** Depth-first layout: x = depth, y = leaf row, parents centred on their children. */
function layout(tab: AdvancementTab): Map<string, { x: number; y: number }> {
  const defs = ADVANCEMENTS.filter((a) => a.tab === tab);
  const pos = new Map<string, { x: number; y: number }>();
  let row = 0;
  const place = (id: string, depth: number): number => {
    const kids = defs.filter((d) => d.parent === id);
    const ys = kids.map((k) => place(k.id, depth + 1));
    const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : row++;
    pos.set(id, { x: depth, y });
    return y;
  };
  for (const root of defs.filter((d) => !d.parent)) place(root.id, 0);
  return pos;
}

/** Minecraft's Advancements screen: one tab per root, a tree of icons, hover tooltips. */
export function advancementsScreen(tracker: AdvancementTracker, icons: BlockIcons, close: () => void): HTMLDivElement {
  const tabs: AdvancementTab[] = ['story', 'adventure'];
  let current: AdvancementTab = 'story';

  const title = h('h2', { class: 'screen-title' });
  const tabBar = h('div', { class: 'adv-tabs' });
  const area = h('div', { class: 'adv-area' });
  const tip = h('div', { class: 'mc-tooltip adv-tip hidden' });

  const showTip = (def: AdvancementDef, e: MouseEvent) => {
    const earned = tracker.has(def.id);
    tip.replaceChildren(
      h('div', { class: earned ? 'adv-tip-title done' : 'adv-tip-title', text: def.title }),
      h('div', { class: 'adv-tip-desc', text: def.description }),
    );
    tip.classList.remove('hidden');
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX + 12, innerWidth - r.width - 4)}px`;
    tip.style.top = `${Math.min(e.clientY + 12, innerHeight - r.height - 4)}px`;
  };

  const render = () => {
    const p = tracker.progress();
    title.textContent = `Advancements — ${p.done}/${p.total}`;
    tabBar.replaceChildren(...tabs.map((t) => {
      const root = ADVANCEMENTS.find((a) => a.tab === t && !a.parent)!;
      const tp = tracker.progress(t);
      return h('div', {
        class: `adv-tab${t === current ? ' active' : ''}`,
        title: `${TAB_NAMES[t]} ${tp.done}/${tp.total}`,
        onclick: () => { current = t; render(); },
      }, h('img', { src: icons.get(root.icon), alt: '', draggable: false }), h('span', { text: TAB_NAMES[t] }));
    }));

    const pos = layout(current);
    const defs = ADVANCEMENTS.filter((a) => a.tab === current);
    const nodes: HTMLElement[] = [];
    let maxX = 0, maxY = 0;
    for (const d of defs) {
      const q = pos.get(d.id)!;
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
      if (d.parent) {
        const a = pos.get(d.parent)!;
        const done = tracker.has(d.id);
        // Elbow connector: horizontal from the parent, vertical, horizontal into the child.
        const line = (cls: string, x: number, y: number, w: number, hgt: number) =>
          h('div', { class: `adv-line ${cls}${done ? ' done' : ''}`, style: `left:calc(var(--s)*${x});top:calc(var(--s)*${y});width:calc(var(--s)*${w});height:calc(var(--s)*${hgt})` });
        const ax = a.x * CELL + NODE / 2, ay = a.y * CELL + NODE / 2, qx = q.x * CELL + NODE / 2, qy = q.y * CELL + NODE / 2;
        const mx = (ax + qx) / 2;
        nodes.push(line('h', ax, ay - 1, mx - ax + 1, 2));
        nodes.push(line('v', mx - 1, Math.min(ay, qy) - 1, 2, Math.abs(qy - ay) + 2));
        nodes.push(line('h', mx, qy - 1, qx - mx, 2));
      }
    }
    for (const d of defs) {
      const q = pos.get(d.id)!;
      const earned = tracker.has(d.id);
      const unlocked = tracker.isUnlocked(d.id);
      const node = h('div', {
        class: `adv-node ${d.frame}${earned ? ' done' : ''}${unlocked ? '' : ' locked'}`,
        style: `left:calc(var(--s)*${q.x * CELL});top:calc(var(--s)*${q.y * CELL})`,
        onmousemove: (e: MouseEvent) => showTip(d, e),
        onmouseleave: () => tip.classList.add('hidden'),
      }, h('img', { src: icons.get(d.icon), alt: '', draggable: false }));
      nodes.push(node);
    }
    const tree = h('div', { class: 'adv-tree', style: `width:calc(var(--s)*${(maxX + 1) * CELL});height:calc(var(--s)*${(maxY + 1) * CELL})` }, ...nodes);
    area.replaceChildren(tree);
  };
  render();

  return h('div', { class: 'screen menu-bg advancements' },
    h('div', { class: 'screen-header' }, title),
    tabBar,
    area,
    h('div', { class: 'screen-footer' }, button('Done', close, { cls: 'w150' })),
    tip,
  );
}
