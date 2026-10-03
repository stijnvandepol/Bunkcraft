import type { ContainerClientMessage, ServerMessage } from '../src/net/protocol';
import { type ContainerKind, applyContainerClick } from '../src/items/ContainerOps';
import { type ItemStack, cloneStack, stackFromArray, stackToArray } from '../src/items/ItemRegistry';
import { type BlockEntity, type BlockEntityStore, FurnaceEntity } from '../src/world/BlockEntities';
import { type InventoryGuard, parseCursor, parseInventory } from './InventoryGuard';

/**
 * Server side of chests and furnaces: who has which container open, the click rules and the updates that go to
 * everybody who has one open. The entities themselves live in the world's `BlockEntityStore` (saved in world.json).
 *
 * Limits: a player has at most ONE container open (opening another closes the first), opens and clicks are rate
 * limited by the caller, the container must be within reach when opening and while open, and the number of entities
 * is capped by the store. Every click is applied to a COPY of the slots and only committed when the inventory guard
 * accepts the transfer, so a refused click changes nothing.
 */

/** Distance (blocks, from the eyes to the block centre) within which a container may be opened and used. */
export const CONTAINER_REACH = 8;
/** Props (furnace progress) are re-sent at most this often while only they change. */
const PROPS_INTERVAL_TICKS = 10;

/** What the service needs from a connected player. */
export interface ContainerSession {
  id: number;
  x: number; y: number; z: number;
  hasPos: boolean;
  guard: InventoryGuard;
  /** Rate limit for open/click messages. */
  containers: { take(): boolean };
}

export interface ContainerHost {
  /** The block entities of the world (null in arcade games: nothing to open). */
  store(): BlockEntityStore | null;
  send(sessionId: number, msg: ServerMessage): void;
  /** Survival games check inventories with the guard; creative and spectator trust the client. */
  guarded(): boolean;
  /** Log a refused transfer. */
  reject(name: string, reason: string): void;
  session(id: number): (ContainerSession & { name: string }) | undefined;
}

interface Open {
  /** Position of the entity (the low half of a double chest). */
  key: string;
  x: number; y: number; z: number;
  kind: ContainerKind;
}

const entityKey = (e: BlockEntity): string => `${e.x},${e.y},${e.z}`;
const rows = (slots: ItemStack[]): number[][] => slots.map((s) => (s.count > 0 ? stackToArray(s) : []));
const row = (s: ItemStack): number[] => (s.count > 0 ? stackToArray(s) : []);
const propsOf = (e: BlockEntity): number[] | undefined => (e instanceof FurnaceEntity ? [e.burnTime, e.burnTotal, e.cookTime, e.cookTotal] : undefined);

export class ContainerService {
  /** Session id → the container it has open. */
  private readonly opens = new Map<number, Open>();
  /** Entity key → sessions that have it open. */
  private readonly openers = new Map<string, Set<number>>();
  /** Entities whose contents changed since the last flush. */
  private readonly dirty = new Set<string>();
  /** What was last sent per open entity: slots signature and tick. */
  private readonly sent = new Map<string, { sig: string; tick: number }>();
  private tickCount = 0;
  private wired: BlockEntityStore | null = null;

  constructor(private readonly host: ContainerHost) {}

  get openCount(): number {
    return this.opens.size;
  }

  /** Hooks the store (once): changes of open containers are queued, removed ones close their screens. */
  private wire(store: BlockEntityStore): void {
    if (this.wired === store) return;
    this.wired = store;
    const prevChanged = store.onChanged, prevRemoved = store.onRemoved;
    store.onChanged = (e) => {
      prevChanged?.(e);
      const k = entityKey(e);
      if (this.openers.has(k)) this.dirty.add(k);
    };
    store.onRemoved = (e) => {
      prevRemoved?.(e);
      const k = entityKey(e);
      const ids = this.openers.get(k);
      if (!ids) return;
      for (const id of [...ids]) {
        this.host.send(id, { t: 'container', op: 'close', reason: 'The container is gone' });
        this.release(id);
      }
    };
  }

  handle(s: ContainerSession, msg: ContainerClientMessage): void {
    const store = this.host.store();
    if (!store) return;
    this.wire(store);
    if (msg.op === 'close') return this.release(s.id);
    if (!s.containers.take()) {
      if (msg.op === 'click') this.host.send(s.id, { t: 'container', op: 'result', seq: Number(msg.seq) | 0, ok: false, cursor: [] });
      return;
    }
    if (msg.op === 'open') return this.open(s, store, msg.x, msg.y, msg.z);
    if (msg.op === 'click') return this.click(s, store, msg);
  }

  /** The player left or died: forget what they had open. */
  onLeave(sessionId: number): void {
    this.release(sessionId);
  }

  private release(sessionId: number): void {
    const open = this.opens.get(sessionId);
    if (!open) return;
    this.opens.delete(sessionId);
    const set = this.openers.get(open.key);
    set?.delete(sessionId);
    if (set && set.size === 0) {
      this.openers.delete(open.key);
      this.sent.delete(open.key);
      this.dirty.delete(open.key);
    }
  }

  private reach(s: ContainerSession, x: number, y: number, z: number): boolean {
    return s.hasPos && Math.hypot(x + 0.5 - s.x, y + 0.5 - (s.y + 1.62), z + 0.5 - s.z) <= CONTAINER_REACH;
  }

  private open(s: ContainerSession, store: BlockEntityStore, x: number, y: number, z: number): void {
    const deny = (reason: string): void => this.host.send(s.id, { t: 'container', op: 'deny', x: Number(x) | 0, y: Number(y) | 0, z: Number(z) | 0, reason });
    if (![x, y, z].every(Number.isInteger)) return deny('bad position');
    if (y < 0 || y > 127 || !this.reach(s, x, y, z)) return deny('too far away');
    const ref = store.containerAt(x, y, z);
    if (!ref) return deny('not a container');
    // One container at a time: opening another closes the first.
    this.release(s.id);
    const key = entityKey(ref.entity);
    this.opens.set(s.id, { key, x: ref.x, y: ref.y, z: ref.z, kind: ref.kind });
    let set = this.openers.get(key);
    if (!set) this.openers.set(key, (set = new Set()));
    set.add(s.id);
    this.host.send(s.id, { t: 'container', op: 'open', x, y, z, kind: ref.kind, title: ref.title, slots: rows(ref.entity.slots), props: propsOf(ref.entity) });
  }

  private click(s: ContainerSession & { name?: string }, store: BlockEntityStore, msg: Extract<ContainerClientMessage, { op: 'click' }>): void {
    const seq = Number(msg.seq) | 0;
    const open = this.opens.get(s.id);
    const entity = open ? store.get(open.x, open.y, open.z) : undefined;
    const refuse = (reason: string, cursor: number[] = []): void => {
      this.host.send(s.id, { t: 'container', op: 'result', seq, ok: false, cursor });
      if (entity) this.host.send(s.id, { t: 'container', op: 'slots', slots: rows(entity.slots), props: propsOf(entity) });
      if (reason) this.host.reject(this.host.session(s.id)?.name ?? '?', reason);
    };
    if (!open || !entity) return refuse('');
    if (!this.reach(s, open.x, open.y, open.z)) {
      this.release(s.id);
      this.host.send(s.id, { t: 'container', op: 'close', reason: 'Too far away' });
      return;
    }
    const inv = parseInventory(msg.inv);
    const cur = parseCursor(msg.cursor);
    if (inv.error || cur.error) return refuse(`bad container click: ${inv.error ?? cur.error}`);
    if (!Number.isInteger(msg.slot) || (msg.button !== 0 && msg.button !== 1)) return refuse('bad container click');
    const guarded = this.host.guarded();
    if (guarded) {
      const check = s.guard.check(msg.inv, cur.stack);
      if (!check.ok) {
        this.host.send(s.id, { t: 'state', inventory: check.correction, reason: check.reason });
        return refuse(`inventory rejected at a container: ${check.reason}`);
      }
    }
    const cursor: ItemStack = cur.stack ? { id: cur.stack.id, count: cur.stack.count, damage: cur.stack.damage, data: undefined } : { id: 0, count: 0 };
    if (cur.stack?.extra) Object.assign(cursor, stackFromArray([cur.stack.id, cur.stack.count, cur.stack.damage ?? 0, ...cur.stack.extra]) ?? {});
    const invSlots: ItemStack[] = inv.slots.map((x) => (x.id > 0 ? (stackFromArray([x.id, x.count, x.damage ?? 0, ...(x.extra ?? [])]) ?? { id: 0, count: 0 }) : { id: 0, count: 0 }));
    // Apply to a copy; commit only when the guard accepts the transfer.
    const copy = entity.slots.map(cloneStack);
    const result = applyContainerClick(open.kind, copy, { slot: msg.slot, button: msg.button, shift: msg.shift === true, from: msg.from }, cursor, invSlots);
    if (!result.ok) return refuse('', row(cursor));
    if (guarded) {
      for (const sp of result.spent) {
        if (!s.guard.spendTransfer(sp.id, sp.count, sp.damage)) return refuse(`${sp.count} x ${sp.id} put into a container without owning it`);
      }
      for (const g of result.gained) s.guard.creditTransfer(g.id, g.count, g.damage);
    }
    entity.slots = copy;
    let xp = 0;
    if (result.tookOutput && entity instanceof FurnaceEntity) xp = entity.takeXp();
    entity.changed();
    this.host.send(s.id, {
      t: 'container', op: 'result', seq, ok: true, cursor: row(result.cursor),
      ...(result.toInv ? { toInv: stackToArray(result.toInv) } : {}),
      ...(result.fromInv ? { fromInv: result.fromInv } : {}),
      ...(xp > 0 ? { xp } : {}),
    });
  }

  /** Once per game tick: sends the new contents of changed containers to everybody who has them open. */
  tick(): void {
    this.tickCount++;
    const store = this.host.store();
    if (!store) return;
    // A player who walked away or whose block changed loses the screen.
    if (this.tickCount % 10 === 0) {
      for (const [id, open] of [...this.opens]) {
        const s = this.host.session(id);
        if (!s || !this.reach(s, open.x, open.y, open.z)) {
          this.release(id);
          if (s) this.host.send(id, { t: 'container', op: 'close', reason: 'Too far away' });
        }
      }
    }
    for (const key of this.dirty) {
      const set = this.openers.get(key);
      const first = set ? this.opens.get([...set][0]) : undefined;
      const entity = first ? store.get(first.x, first.y, first.z) : undefined;
      if (!set || !entity) { this.dirty.delete(key); continue; }
      const slots = rows(entity.slots);
      const sig = JSON.stringify(slots);
      const last = this.sent.get(key);
      const slotsChanged = !last || last.sig !== sig;
      if (!slotsChanged && this.tickCount - (last?.tick ?? 0) < PROPS_INTERVAL_TICKS) continue;
      this.dirty.delete(key);
      this.sent.set(key, { sig, tick: this.tickCount });
      const msg: ServerMessage = { t: 'container', op: 'slots', slots, props: propsOf(entity) };
      for (const id of set) this.host.send(id, msg);
      // Still burning: stay dirty so progress keeps flowing.
      if (entity.wantsTick()) this.dirty.add(key);
    }
  }
}
