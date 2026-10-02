import { type ClientMessage, PROTOCOL_VERSION, type ServerMessage } from './protocol';

export type WelcomeMessage = Extract<ServerMessage, { t: 'welcome' }>;

interface PendingEdit {
  x: number;
  y: number;
  z: number;
  prev: number;
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
  private closedByUser = false;
  id = -1;
  /** All server messages after the welcome. */
  onMessage: ((msg: ServerMessage) => void) | null = null;
  /** Rollback of a rejected local edit. */
  onRevert: ((x: number, y: number, z: number, id: number) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;

  /** Accepts "host:port", a full ws(s):// URL, or empty for the page's own server. */
  static urlFor(address: string): string {
    const a = address.trim();
    if (/^wss?:\/\//.test(a)) return a;
    const secure = location.protocol === 'https:';
    const host = a || location.host;
    return `${secure ? 'wss' : 'ws'}://${host}/ws`;
  }

  connect(address: string, name: string): Promise<WelcomeMessage> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(NetClient.urlFor(address));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws = ws;
      let welcomed = false;
      const timeout = window.setTimeout(() => {
        if (!welcomed) { ws.close(); reject(new Error('Connection timed out')); }
      }, 10_000);
      ws.onopen = () => this.send({ t: 'hello', v: PROTOCOL_VERSION, name });
      ws.onmessage = (e) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(e.data)) as ServerMessage;
        } catch {
          return;
        }
        if (!welcomed) {
          if (msg.t === 'welcome') {
            welcomed = true;
            window.clearTimeout(timeout);
            this.id = msg.id;
            resolve(msg);
          } else if (msg.t === 'kick') {
            window.clearTimeout(timeout);
            reject(new Error(msg.reason));
          }
          return;
        }
        if (msg.t === 'reject') {
          const p = this.pending.get(msg.seq);
          this.pending.delete(msg.seq);
          if (p) this.onRevert?.(p.x, p.y, p.z, p.prev);
          return;
        }
        if (msg.t === 'kick') {
          this.closedByUser = true;
          this.onClose?.(msg.reason);
          return;
        }
        this.onMessage?.(msg);
      };
      ws.onerror = () => {
        if (!welcomed) { window.clearTimeout(timeout); reject(new Error('Could not connect to the server')); }
      };
      ws.onclose = () => {
        window.clearTimeout(timeout);
        if (welcomed && !this.closedByUser) this.onClose?.('Connection lost');
        if (!welcomed) reject(new Error('Could not connect to the server'));
      };
    });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendBlock(x: number, y: number, z: number, id: number, prev: number): void {
    const seq = this.seq++;
    this.pending.set(seq, { x, y, z, prev });
    // Keep only recent edits around for rollback.
    if (this.pending.size > 256) this.pending.delete(this.pending.keys().next().value!);
    this.send({ t: 'block', seq, x, y, z, id });
  }

  /** Sends the player position at most 20 times per second. */
  update(dt: number, x: number, y: number, z: number, yaw: number, pitch: number, flags: number, held: number): void {
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer = 0.05;
    this.send({ t: 'pos', x, y, z, yaw, pitch, flags, held });
  }

  sendChat(text: string): void {
    this.send({ t: 'chat', text });
  }

  sendState(inventory: number[][], stats: number[]): void {
    this.send({ t: 'state', inventory, stats });
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }
}
