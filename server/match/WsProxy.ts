import { WebSocket, type RawData } from 'ws';

/**
 * Bridges a player's WebSocket (accepted by the control plane) to the match runner that hosts their lobby.
 *
 * - The upstream connection opens on the player's first message (the `hello`): the control plane needs it to tell
 *   the runner who the player is (profile, rank, skin; see Ident). Later messages wait in a small buffer meanwhile.
 * - Frames pass through untouched, text stays text and binary stays binary.
 * - Backpressure: when one side's send buffer passes HIGH_WATER the other side stops reading until it drains.
 * - Pings of the runner go through to the player and the matching pongs come back, so the runner's ping (lag
 *   compensation!) measures the player and not the internal hop. The control plane's own keep-alive pings carry no
 *   payload and are never forwarded.
 * - A close on either side closes the other with the same code where the protocol allows it.
 */

const HIGH_WATER = 1 << 20;
const MAX_EARLY_MESSAGES = 64;
const MAX_EARLY_BYTES = 256 * 1024;
const PING_TAG = 'bcp';
/** 'bcp' + four base-36 digits. */
const TAG_LENGTH = 7;

export interface BridgeOptions {
  /**
   * Opens the upstream socket for this first message, or rejects (the player gets a kick and a close). `first` in
   * the answer replaces the message (the control plane may rewrite the hello, see ControlPlane).
   */
  connect(first: string): Promise<{ upstream: WebSocket; first?: string }>;
  /** Called once when both sides are closed. */
  onClose?(): void;
  /** A client that sends no hello within this time is closed (default 10 s, as GameServer.accept does in-process). */
  helloTimeoutMs?: number;
}

/** Close codes a peer may send (1005, 1006 and 1015 are reserved for local use). */
function sendableCode(code: number): number {
  return code === 1000 || (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999) ? code : 1011;
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(sendableCode(code), reason.slice(0, 120));
  } catch {
    ws.terminate();
  }
}

/** Sends with backpressure: pauses `from` while `to` has too much queued and resumes once it drained. */
function relay(to: WebSocket, from: WebSocket, data: RawData, isBinary: boolean): void {
  if (to.readyState !== WebSocket.OPEN) return;
  to.send(data as Buffer, { binary: isBinary });
  if (to.bufferedAmount > HIGH_WATER && !from.isPaused) {
    from.pause();
    const wait = setInterval(() => {
      if (to.readyState !== WebSocket.OPEN || from.readyState !== WebSocket.OPEN) { clearInterval(wait); return; }
      if (to.bufferedAmount < HIGH_WATER / 4) { clearInterval(wait); from.resume(); }
    }, 10);
    wait.unref();
  }
}

export function bridge(client: WebSocket, opts: BridgeOptions): void {
  let upstream: WebSocket | null = null;
  let early: { data: RawData; binary: boolean }[] = [];
  let earlyBytes = 0;
  let started = false;
  let done = false;
  let pingSeq = 0;
  const pending = new Set<string>();
  // Without it a silent connection held a slot (connection caps) for as long as it answered the keep-alive pings.
  const helloTimer = setTimeout(() => { if (!started) closeQuietly(client, 1008, 'No hello'); }, opts.helloTimeoutMs ?? 10_000);
  helloTimer.unref();

  const finish = () => {
    if (done) return;
    done = true;
    opts.onClose?.();
  };

  const wire = (up: WebSocket) => {
    upstream = up;
    up.on('message', (data, isBinary) => relay(client, up, data, isBinary));
    up.on('ping', (data) => {
      if (client.readyState !== WebSocket.OPEN) return;
      // Tag the forwarded ping so its pong can be told from a pong to the control plane's own keep-alive.
      const tag = `${PING_TAG}${(pingSeq++ % 1679616).toString(36).padStart(4, '0')}`;
      pending.add(tag);
      if (pending.size > 8) pending.delete(pending.values().next().value!);
      client.ping(Buffer.concat([Buffer.from(tag), data as Buffer]));
    });
    up.on('close', (code, reason) => { closeQuietly(client, code, reason.toString()); finish(); });
    up.on('error', () => { up.terminate(); closeQuietly(client, 1011, 'Match server unavailable'); });
    for (const m of early) up.send(m.data as Buffer, { binary: m.binary });
    early = [];
  };

  client.on('pong', (data: Buffer) => {
    if (!upstream || data.length < TAG_LENGTH) return;
    const tag = data.subarray(0, TAG_LENGTH).toString('latin1');
    if (!pending.delete(tag)) return;
    if (upstream.readyState === WebSocket.OPEN) upstream.pong(data.subarray(TAG_LENGTH));
  });

  client.on('message', (data, isBinary) => {
    if (upstream) { relay(upstream, client, data, isBinary); return; }
    if (!started) {
      started = true;
      clearTimeout(helloTimer);
      if (isBinary) { closeQuietly(client, 1008, 'No hello'); return; }
      const first = (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)).toString('utf8');
      early.push({ data, binary: false });
      earlyBytes += first.length;
      opts.connect(first).then(({ upstream: up, first: rewritten }) => {
        if (client.readyState !== WebSocket.OPEN) { up.close(1001, 'Gone'); return; }
        if (rewritten !== undefined) early[0] = { data: Buffer.from(rewritten), binary: false };
        wire(up);
      }, (err: unknown) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ t: 'kick', reason: 'The match server is not reachable. Try again in a moment.', reconnect: 3000 }));
        }
        closeQuietly(client, 1013, err instanceof Error ? err.message : 'Try again later');
        finish();
      });
      return;
    }
    const size = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : (data as Buffer).byteLength;
    earlyBytes += size;
    if (early.length >= MAX_EARLY_MESSAGES || earlyBytes > MAX_EARLY_BYTES) { closeQuietly(client, 1008, 'Too much too early'); return; }
    early.push({ data, binary: isBinary });
  });
  client.on('close', (code, reason) => {
    clearTimeout(helloTimer);
    if (upstream) closeQuietly(upstream, code, reason.toString());
    finish();
  });
  client.on('error', () => client.terminate());
}
