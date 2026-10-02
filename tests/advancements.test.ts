import { describe, expect, it } from 'vitest';
import { ADVANCEMENTS, AdvancementTracker, getAdvancement } from '../src/player/Advancements';
import { ITEM } from '../src/items/ItemRegistry';
import { BLOCK } from '../src/world/BlockRegistry';

describe('advancement data', () => {
  it('has unique ids and valid parents in the same tab', () => {
    const ids = new Set(ADVANCEMENTS.map((a) => a.id));
    expect(ids.size).toBe(ADVANCEMENTS.length);
    for (const a of ADVANCEMENTS) {
      if (a.parent) expect(getAdvancement(a.parent)?.tab).toBe(a.tab);
      else expect(a.trigger.type).toBe('enter');
    }
  });
});

describe('AdvancementTracker', () => {
  it('awards on matching events once and fires callbacks', () => {
    const t = new AdvancementTracker();
    const got: string[] = [];
    t.onAward = (d) => got.push(d.id);
    t.onItemGained(BLOCK.COBBLESTONE);
    t.onItemGained(BLOCK.COBBLESTONE);
    t.onItemGained(ITEM.DIAMOND);
    expect(got).toEqual(['story/mine_stone', 'story/mine_diamond']);
  });

  it('awards roots on enter, hostile kills and arrow hits', () => {
    const t = new AdvancementTracker();
    t.onEnterWorld();
    t.onMobKilled(false);
    expect(t.has('adventure/kill_a_mob')).toBe(false);
    t.onMobKilled(true);
    t.onArrowHitMob();
    expect(t.has('story/root') && t.has('adventure/root')).toBe(true);
    expect(t.has('adventure/kill_a_mob') && t.has('adventure/shoot_arrow')).toBe(true);
  });

  it('unlocks children when the parent is earned', () => {
    const t = new AdvancementTracker();
    expect(t.isUnlocked('story/root')).toBe(true);
    expect(t.isUnlocked('story/mine_stone')).toBe(false);
    t.onEnterWorld();
    expect(t.isUnlocked('story/mine_stone')).toBe(true);
  });

  it('awards nothing when disabled', () => {
    const t = new AdvancementTracker();
    t.enabled = false;
    t.onEnterWorld();
    t.onItemGained(ITEM.DIAMOND);
    expect(t.progress().done).toBe(0);
  });

  it('round-trips through serialize/load without toasts and drops unknown ids', () => {
    const t = new AdvancementTracker();
    t.onEnterWorld();
    t.onItemGained(BLOCK.COBBLESTONE);
    const save = JSON.parse(JSON.stringify(t.serialize()));
    save['removed/old'] = 1;
    const u = new AdvancementTracker();
    let toasts = 0;
    u.onAward = () => toasts++;
    u.load(save);
    expect(toasts).toBe(0);
    expect(u.has('story/mine_stone')).toBe(true);
    expect(u.has('removed/old')).toBe(false);
    expect(u.progress()).toEqual({ done: 3, total: ADVANCEMENTS.length });
    u.onItemGained(BLOCK.COBBLESTONE);
    expect(toasts).toBe(0);
  });
});
