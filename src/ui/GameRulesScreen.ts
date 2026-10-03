import { DIFFICULTY_NAMES, type Difficulty, nextDifficulty } from '../world/Difficulty';
import { type GameRules, RULE_DEFS, RULE_NAMES, type RuleName } from '../world/GameRules';
import { button, h, menuScreen } from './dom';
import './survivalRules.css';

/** Integer rules step through these values on click (Minecraft's screen has a text field; buttons fit the GUI here). */
const INT_STEPS: Partial<Record<RuleName, number[]>> = {
  randomTickSpeed: [0, 1, 3, 6, 12, 30, 100],
  playersSleepingPercentage: [0, 25, 50, 75, 100],
};

function label(rules: GameRules, name: RuleName): string {
  const v = rules.get(name);
  return `${RULE_DEFS[name].label}: ${typeof v === 'boolean' ? (v ? 'ON' : 'OFF') : v}`;
}

/** The "Game Rules" screen: one button per rule that toggles or steps its value. `onChange` runs after every change. */
export function gameRulesScreen(rules: GameRules, done: () => void, onChange?: () => void): HTMLDivElement {
  const hint = h('div', { class: 'rules-hint', text: 'Click a rule to change it' });
  const list = h('div', { class: 'rules-list' });
  for (const name of RULE_NAMES) {
    const def: { kind: string } = RULE_DEFS[name];
    const btn = button(label(rules, name), () => {
      const v = rules.get(name);
      if (def.kind === 'boolean') rules.set(name, !v);
      else {
        const steps = INT_STEPS[name] ?? [Number(v)];
        const i = steps.findIndex((s) => s > Number(v));
        rules.set(name, steps[i < 0 ? 0 : i]);
      }
      btn.textContent = label(rules, name);
      onChange?.();
    });
    btn.title = RULE_DEFS[name].hint;
    btn.addEventListener('mouseenter', () => { hint.textContent = RULE_DEFS[name].hint; });
    list.append(btn);
  }
  return menuScreen('Game Rules', [hint, list], [button('Done', done, { cls: 'w150' })]);
}

/** "Difficulty: Normal" cycle button; Hardcore locks it at Hard. */
export function difficultyButton(get: () => Difficulty, set: (d: Difficulty) => void, locked: () => boolean): HTMLButtonElement {
  const btn = button('', () => {
    if (locked()) return;
    set(nextDifficulty(get()));
    render();
  });
  const render = (): void => {
    btn.textContent = `Difficulty: ${DIFFICULTY_NAMES[locked() ? 'hard' : get()]}`;
    btn.disabled = locked();
  };
  render();
  (btn as HTMLButtonElement & { refresh?: () => void }).refresh = render;
  return btn;
}
