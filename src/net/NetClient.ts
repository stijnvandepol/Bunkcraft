import { BINARY_VERSION, decodeBinary } from './binary';
import { type ClientMessage, type ContainerClientMessage, PROTOCOL_VERSION, type ServerMessage } from './protocol';
import { forgetRoomPassword, identityKey, ownerToken, roomPassword } from './RoomApi';

export type WelcomeMessage = Extract<ServerMessage, { t: 'welcome' }>;

interface PendingEdit {
  x: number;
  y: number;
  z: number;
  prev: number;
  prevMeta: number;
}

/**
 * WebSocket client for the BunkCraft server. Block edits are applied locally right
 * away and remembered by sequence number; if the server rejects one, the previous
 * block is restored (Minecraft's "acknowledge block change" idea).
 */
export class NetClient {
  private ws: WebSocket | null = null;
  private seq = 1;
  private readonly pending = new Map<number, PendingEdit>();
  private sendTimer = 0;
  /** Seconds between position messages (20 Hz; arcade rooms send at their tick rate, up to 30 Hz). */
  posInterval = 0.05;
  private closedByUser = false;
  id = -1;
  /** All server messages after the welcome. */
  onMessage: ((msg: ServerMessage) => void) | null = null;
  /** Rollback of a rejected local edit. */
  onRevert: ((x: number, y: number, z: number, id: number, meta: number) => void) | null = null;
  /** The connection ended; `reconnectMs` is set when the server said it is restarting and will be back. */
  onClose: ((reason: string, reconnectMs?: number) => void) | null = null;

  /**
   * Accepts "host:port", a full ws(s):// URL, or empty for the page's own server.
   * With a game code the connection goes to that room (/ws/<CODE>) instead of the main world.
   */
  static urlFor(address: string, room?: string): string {
    const a = address.trim();
    const path = room ? `/ws/${room}` : '/ws';
    if (/^wss?:\/\//.test(a)) return a.replace(/\/ws(\/[A-Z0-9]+)?\/?$/, '') + path;
    const secure = location.protocol === 'https:';
    const host = a || location.host;
    return `${secure ? 'wss' : 'ws'}://${host}${path}`;
  }

  connect(address: string, name: string, room?: string): Promise<WelcomeMessage> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(NetClient.urlFor(address, room));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let welcomed = false;
      const timeout = window.setTimeout(() => {
        if (!welcomed) { ws.close(); reject(new Error('Connection timed out')); }
      }, 10_000);
      const host = address.trim() || location.host;
      ws.onopen = () => {
        const owner = room ? ownerToken(room) : undefined;
        const password = room ? roomPassword(room) : undefined;
        // `bin`: this client understands binary snap/ent frames, `binv` which formats (older servers ignore both).
        this.send({ t: 'hello', v: PROTOCOL_VERSION, name, key: identityKey(host, room), bin: true, binv: BINARY_VERSION, ...(owner ? { owner } : {}), ...(password ? { password } : {}) });
      };
      ws.onmessage = (e) => {
        let msg: ServerMessage;
        if (typeof e.data === 'string') {
          try {
            msg = JSON.parse(e.data) as ServerMessage;
          } catch {
            return;
          }
        } else {
          const decoded = decodeBinary(e.data as ArrayBuffer);
          if (!decoded) return;
          msg = decoded;
        }
        if (!welcomed) {
          if (msg.t === 'welcome') {
            welcomed = true;
            window.clearTimeout(timeout);
            this.id = msg.id;
            resolve(msg);
          } else if (msg.t === 'kick') {
            window.clearTimeout(timeout);
            // A refused password must not be sent again silently (the menu would never ask for it again).
            if (msg.code === 'password' && room) forgetRoomPassword(room);
            reject(new Error(msg.reason));
          }
          return;
        }
        if (msg.t === 'reject') {
          const p = this.pending.get(msg.seq);
          this.pending.delete(msg.seq);
          if (p) this.onRevert?.(p.x, p.y, p.z, p.prev, p.prevMeta);
          return;
        }
        if (msg.t === 'kick') {
          this.closedByUser = true;
          this.onClose?.(msg.reason, msg.reconnect);
          return;
        }
        this.onMessage?.(msg);
      };
      const notFound = room ? 'Game not found. It may have expired, check the code.' : 'Could not connect to the server';
      ws.onerror = () => {
        if (!welcomed) { window.clearTimeout(timeout); reject(new Error(notFound)); }
      };
      ws.onclose = () => {
        window.clearTimeout(timeout);
        if (welcomed && !this.closedByUser) this.onClose?.('Connection lost');
        if (!welcomed) reject(new Error(notFound));
      };
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendBlock(x: number, y: number, z: number, id: number, meta: number, prev: number, prevMeta: number): void {
    const seq = this.seq++;
    this.pending.set(seq, { x, y, z, prev, prevMeta });
    // Keep only recent edits around for rollback.
    if (this.pending.size > 256) this.pending.delete(this.pending.keys().next().value!);
    // `prev` lets the server spot a race with another player's edit of the same block (see protocol.ts).
    this.send(meta ? { t: 'block', seq, x, y, z, id, meta, prev } : { t: 'block', seq, x, y, z, id, prev });
  }

  /** Sends the player position at most 20 times per second. */
  /** `slide`: arcade, the physics step of the latest slide start (the server's slide budget), NaN = none yet. */
  update(dt: number, x: number, y: number, z: number, yaw: number, pitch: number, flags: number, held: number, step?: number, slide = NaN): void {
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer = this.posInterval;
    if (step === undefined) this.send({ t: 'pos', x, y, z, yaw, pitch, flags, held });
    else if (slide === slide) this.send({ t: 'pos', x, y, z, yaw, pitch, flags, held, step, sl: slide });
    else this.send({ t: 'pos', x, y, z, yaw, pitch, flags, held, step });
  }

  sendAttack(id: number, e?: number[]): void {
    this.send(e ? { t: 'attack', id, e } : { t: 'attack', id });
  }

  sendUseMob(id: number): void {
    this.send({ t: 'usemob', id });
  }

  sendShoot(x: number, y: number, z: number, dx: number, dy: number, dz: number, power: number, e?: number[]): void {
    this.send(e ? { t: 'shoot', x, y, z, dx, dy, dz, power, e } : { t: 'shoot', x, y, z, dx, dy, dz, power });
  }

  sendIgnite(x: number, y: number, z: number): void {
    this.send({ t: 'ignite', x, y, z });
  }

  /** Bone meal on a block (the server checks the held item and reach, then grows it). */
  sendBoneMeal(x: number, y: number, z: number): void {
    this.send({ t: 'bonemeal', x, y, z });
  }

  sendTake(id: number): void {
    this.send({ t: 'take', id });
  }

  sendDrop(id: number, count: number, damage: number | undefined, x: number, y: number, z: number, yaw: number | undefined, delay: number, data?: number[]): void {
    this.send({ t: 'drop', id, count, damage, data, x, y, z, yaw, delay });
  }

  sendChat(text: string): void {
    this.send({ t: 'chat', text });
  }

  /** Chest and furnace screens (see ContainerScreens). */
  sendContainer(msg: ContainerClientMessage): void {
    this.send(msg);
  }

  sendState(inventory: number[][], stats: number[], effects?: number[][]): void {
    this.send({ t: 'state', inventory, stats, ...(effects ? { effects } : {}) });
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }
}
