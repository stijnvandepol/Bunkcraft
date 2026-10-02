import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../../src/net/protocol';
import type { GameServer } from '../../server/GameServer';

/** Just enough of a `ws` socket for GameServer.accept(): records what the server sends. */
export class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: ServerMessage[] = [];
  closeCode: number | null = null;
  send(data: string): void { this.sent.push(JSON.parse(data) as ServerMessage); }
  close(code?: number): void { this.readyState = 3; this.closeCode = code ?? 1000; }
  terminate(): void { this.readyState = 3; }
  ping(): void { this.emit('pong'); }
  say(msg: ClientMessage | Record<string, unknown>): void { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
  raw(data: Buffer | string, binary = false): void { this.emit('message', typeof data === 'string' ? Buffer.from(data) : data, binary); }
  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
}

export function connect(server: GameServer, name: string, version = PROTOCOL_VERSION): FakeSocket {
  const ws = new FakeSocket();
  server.accept(ws as unknown as WebSocket);
  ws.say({ t: 'hello', v: version, name });
  return ws;
}
