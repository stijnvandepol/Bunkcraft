import type { ContainerClick } from '../items/ContainerOps';
import type { PlayerInventory } from '../items/Inventory';
import { type ItemStack, stackFromArray, stackToArray } from '../items/ItemRegistry';
import type { ContainerServerMessage, ContainerClientMessage } from '../net/protocol';
import type { ContainerView } from '../ui/SurvivalInventory';
import { FurnaceEntity } from '../world/BlockEntities';
import type { World } from '../world/World';

/** How long a container click may wait for the server before the screen accepts clicks again. */
const CLICK_TIMEOUT_MS = 2000;
/** How long an open request may go unanswered (an older server ignores it). */
const OPEN_TIMEOUT_MS = 3000;

export interface ContainerScreenDeps {
  world(): World | null;
  /** Multiplayer: the connection that carries container messages; null in singleplayer. */
  net(): { sendContainer(msg: ContainerClientMessage): void } | null;
  inventory: PlayerInventory;
  /** Shows the container screen (switches the game into the inventory state). */
  show(view: ContainerView): void;
  /** The screen currently open, its cursor and the way to change that cursor. */
  current(): ContainerView | null;
  cursor(): ItemStack;
  setCursor(stack: ItemStack): void;
  /** Redraw the open container (contents or furnace progress changed). */
  refresh(): void;
  /** Close the screen (the server closed the container). */
  close(): void;
  message(text: string): void;
  drop(stack: ItemStack): void;
  /** Furnace experience for the player (the XP system hooks in here). */
  awardXp(amount: number): void;
}

/**
 * Opens chests and furnaces. Singleplayer edits the world's block entities directly; in multiplayer the server owns
 * them and this class is the client end of the `container` protocol (see src/net/protocol.ts): the view's slots
 * mirror the server, clicks are sent with the inventory and cursor and their answer applies cursor and inventory.
 */
export class ContainerScreens {
  /** The server understands `container` messages (welcome.containers). */
  serverSupport = false;
  private remote: { view: ContainerView; slots: ItemStack[]; props: number[]; propsAt: number; seq: number; pending: number; pendingAt: number } | null = null;
  private openAt = 0;
  private openPos: [number, number, number] | null = null;

  constructor(private readonly d: ContainerScreenDeps) {}

  /** Right click on a container block. */
  open(x: number, y: number, z: number): void {
    const net = this.d.net();
    if (net) {
      if (!this.serverSupport) { this.d.message('This server does not store chests or furnaces.'); return; }
      if (this.openPos && performance.now() - this.openAt < OPEN_TIMEOUT_MS) return;
      this.openPos = [x, y, z];
      this.openAt = performance.now();
      net.sendContainer({ t: 'container', op: 'open', x, y, z });
      return;
    }
    const world = this.d.world();
    const ref = world?.blockEntities.containerAt(x, y, z);
    if (!ref) return;
    const e = ref.entity;
    const view: ContainerView = {
      title: ref.title,
      kind: ref.kind,
      get slots() { return e.slots; },
      onChange: () => e.changed(),
      furnace: e instanceof FurnaceEntity ? () => ({ progress: e.progress, flame: e.flame }) : undefined,
      onTakeOutput: e instanceof FurnaceEntity ? () => { e.takeXp(); } : undefined,
    };
    this.d.show(view);
  }

  /** 20 Hz: keeps a furnace screen moving. */
  tick(): void {
    const view = this.d.current();
    if (!view?.furnace) return;
    this.d.refresh();
  }

  /** Server messages of type `container`. */
  onMessage(msg: ContainerServerMessage): void {
    switch (msg.op) {
      case 'open': return this.onOpen(msg);
      case 'deny':
        this.openPos = null;
        this.d.message(`Can't open that: ${msg.reason}.`);
        return;
      case 'slots': {
        const r = this.remote;
        if (!r) return;
        r.slots.length = 0;
        for (const row of msg.slots) r.slots.push(parseRow(row));
        if (msg.props) { r.props = msg.props; r.propsAt = performance.now(); }
        this.d.refresh();
        return;
      }
      case 'result': return this.onResult(msg);
      case 'close':
        if (this.remote && this.d.current() === this.remote.view) {
          this.remote = null; // no close message back: the server already forgot it
          this.d.close();
        }
        return;
    }
  }

  private onOpen(msg: Extract<ContainerServerMessage, { op: 'open' }>): void {
    this.openPos = null;
    const slots = msg.slots.map(parseRow);
    const state = { view: null as unknown as ContainerView, slots, props: msg.props ?? [], propsAt: performance.now(), seq: 0, pending: -1, pendingAt: 0 };
    const net = this.d.net();
    if (!net) return;
    const send = (m: ContainerClientMessage): void => net.sendContainer(m);
    state.view = {
      title: msg.title,
      kind: msg.kind,
      get slots() { return state.slots; },
      furnace: msg.kind === 'furnace' ? () => furnaceBars(state.props, performance.now() - state.propsAt) : undefined,
      onClose: () => {
        if (this.remote === state) {
          this.remote = null;
          send({ t: 'container', op: 'close' });
        }
      },
      remote: {
        busy: () => state.pending >= 0 && performance.now() - state.pendingAt < CLICK_TIMEOUT_MS,
        click: (c: ContainerClick, cursor: ItemStack) => {
          state.pending = ++state.seq;
          state.pendingAt = performance.now();
          send({
            t: 'container', op: 'click', seq: state.seq, slot: c.slot, button: c.button, shift: c.shift || undefined, from: c.from,
            inv: this.d.inventory.serialize(), cursor: cursor.count > 0 ? stackToArray(cursor) : [],
          });
        },
      },
    };
    this.remote = state;
    this.d.show(state.view);
  }

  private onResult(msg: Extract<ContainerServerMessage, { op: 'result' }>): void {
    const r = this.remote;
    if (!r || msg.seq !== r.pending) return;
    r.pending = -1;
    this.d.setCursor(parseRow(msg.cursor));
    if (msg.ok && msg.toInv) {
      const s = parseRow(msg.toInv);
      const left = this.d.inventory.add(s);
      if (left > 0) this.d.drop({ ...s, count: left });
    }
    if (msg.ok && msg.fromInv) {
      const inv = this.d.inventory;
      const s = inv.get(msg.fromInv.slot);
      const n = Math.min(s.count, msg.fromInv.count);
      inv.set(msg.fromInv.slot, s.count - n > 0 ? { ...s, count: s.count - n } : { id: 0, count: 0 });
    }
    if (msg.xp) this.d.awardXp(msg.xp);
    this.d.refresh();
  }

  /** Left the server: forget everything. */
  reset(): void {
    this.remote = null;
    this.openPos = null;
    this.serverSupport = false;
  }
}

function parseRow(row: number[] | undefined): ItemStack {
  return stackFromArray(row) ?? { id: 0, count: 0 };
}

/** Furnace bars from the last server numbers, moved on by the time since (the server sends them twice a second). */
function furnaceBars(props: number[], ageMs: number): { progress: number; flame: number } {
  const [burn = 0, burnTotal = 0, cook = 0, cookTotal = 200] = props;
  const ticks = Math.min(10, Math.floor(ageMs / 50));
  const lit = burn > 0;
  const b = Math.max(0, burn - ticks);
  const c = lit && cook > 0 ? Math.min(cookTotal, cook + ticks) : cook;
  return { progress: cookTotal > 0 ? c / cookTotal : 0, flame: burnTotal > 0 ? b / burnTotal : 0 };
}
