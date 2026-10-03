import { customName, enchantLines, hasEnchants } from '../items/EnchantRules';
import { ITEM, type ItemStack, getItemDef, maxDurability } from '../items/ItemRegistry';
import { h } from './dom';

/**
 * Item tooltips and the enchantment glint, shared by the inventory screens and the hotbar. Like Minecraft: an enchanted
 * item's name is aqua, a custom name is italic, the enchantments follow in grey with roman numerals.
 */

/** Does this stack show the purple glint? Enchanted items and enchanted books. */
export function hasGlint(stack: ItemStack): boolean {
  return stack.id > 0 && (hasEnchants(stack.data) || stack.id === ITEM.ENCHANTED_BOOK);
}

/** Tooltip lines of a stack as DOM nodes (empty for an empty slot). */
export function tooltipNodes(stack: ItemStack, extra: string[] = []): HTMLElement[] {
  if (!stack.id) return [];
  const def = getItemDef(stack.id);
  const custom = customName(stack.data);
  const glint = hasGlint(stack);
  const name = h('div', { class: `tt-name${glint ? ' tt-enchanted' : ''}${custom ? ' tt-custom' : ''}`, text: custom || def?.displayName || '' });
  const lines = enchantLines(stack.data).map((t) => h('div', { class: 'tt-line', text: t }));
  const max = maxDurability(stack.id);
  if (max && stack.damage) lines.push(h('div', { class: 'tt-line', text: `Durability: ${max - stack.damage} / ${max}` }));
  for (const t of extra) lines.push(h('div', { class: 'tt-line', text: t }));
  return [name, ...lines];
}

/** The plain-text name of a stack (custom name first). */
export function stackTitle(stack: ItemStack): string {
  return customName(stack.data) || getItemDef(stack.id)?.displayName || '';
}

/** An animated purple sheen clipped to the icon's shape (CSS mask), laid over a 16x16 slot icon. */
export function glintOverlay(iconUrl: string): HTMLDivElement {
  const el = h('div', { class: 'glint' });
  el.style.setProperty('-webkit-mask-image', `url("${iconUrl}")`);
  el.style.setProperty('mask-image', `url("${iconUrl}")`);
  return el;
}
