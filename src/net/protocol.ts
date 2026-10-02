import type { GameMode } from '../player/GameMode';

/**
 * Multiplayer protocol (JSON over one WebSocket at /ws). Shared by the browser client
 * and the Node server so both sides agree on every message shape.
 *
 * Terrain is generated from the seed on every client, so only player edits travel over
 * the network. Movement is client-predicted and sanity-checked by the server; block
 * edits are applied optimistically and confirmed or rolled back by the server.
 */
export const PROTOCOL_VERSION = 1;

/** Saved per player on the server (by name). */
export interface PlayerRecord {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  inventory?: number[][];
  stats?: number[];
}

export interface RemotePlayerInfo {
  id: number;
  name: string;
}

/** Snapshot entry: [id, x, y, z, yaw, pitch, flags, heldItem]. flags: 1 sprinting, 2 flying, 4 on ground. */
export type SnapshotEntry = [number, number, number, number, number, number, number, number];

// ---------------------------------------------------------------- client → server

export type ClientMessage =
  | { t: 'hello'; v: number; name: string }
  | { t: 'pos'; x: number; y: number; z: number; yaw: number; pitch: number; flags: number; held: number }
  | { t: 'block'; seq: number; x: number; y: number; z: number; id: number }
  | { t: 'chat'; text: string }
  | { t: 'state'; inventory: number[][]; stats: number[] };

// ---------------------------------------------------------------- server → client

export type ServerMessage =
  | {
    t: 'welcome'; id: number; worldName: string; seed: number; gameMode: GameMode; time: number;
    spawn: { x: number; y: number; z: number };
    /** Flat list of edits: x, y, z, id, x, y, z, id, … */
    edits: number[];
    player: PlayerRecord | null;
    players: RemotePlayerInfo[];
    motd: string;
  }
  | { t: 'join'; id: number; name: string }
  | { t: 'leave'; id: number; name: string }
  | { t: 'snap'; players: SnapshotEntry[] }
  | { t: 'block'; x: number; y: number; z: number; id: number }
  | { t: 'reject'; seq: number; x: number; y: number; z: number; id: number }
  | { t: 'chat'; from: string; text: string; system?: boolean }
  | { t: 'time'; time: number }
  | { t: 'teleport'; x: number; y: number; z: number }
  | { t: 'kick'; reason: string };

export const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

export function sanitizeChat(text: string): string {
  // Strip control characters and cap the length; rendering always uses textContent.
  return text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
}
