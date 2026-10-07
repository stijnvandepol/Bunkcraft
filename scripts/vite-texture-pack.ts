import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Built-in texture packs as one file. The default pack is ~56 small PNGs (~50 KB together) that the title screen
 * waits for: 56 requests (10+ round trips over HTTP/1.1, seconds on a slow mobile link; the service worker then
 * re-fetches all of them in the background on every visit). The build writes `texturepacks/<id>.bcpk` with every
 * PNG of the folder inside; the client fetches that once (src/rendering/TexturePacks.ts `bundledResolver`) and falls
 * back to the single files when it is missing.
 *
 * Format (read by `parsePackBundle`): "BCPK", u32 LE header length, UTF-8 JSON header
 * `{ "files": { "<name without .png>": [offset, length] } }`, then the PNG bytes (offsets from the end of the header).
 */
export function encodePackBundle(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const index: Record<string, [number, number]> = {};
  let offset = 0;
  const names = [...files.keys()].sort();
  for (const name of names) {
    const len = files.get(name)!.length;
    index[name] = [offset, len];
    offset += len;
  }
  const header = new TextEncoder().encode(JSON.stringify({ files: index }));
  const out = new Uint8Array(8 + header.length + offset);
  out.set([0x42, 0x43, 0x50, 0x4b]); // "BCPK"
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  let o = 8 + header.length;
  for (const name of names) {
    out.set(files.get(name)!, o);
    o += files.get(name)!.length;
  }
  return out;
}

/** The PNGs of one pack folder, by name without extension. */
export function readPackFolder(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith('.png')) files.set(f.slice(0, -4), readFileSync(join(dir, f)));
  }
  return files;
}

/** Built-in pack folders under public/texturepacks (each becomes texturepacks/<folder>.bcpk). */
function packFolders(publicDir: string): string[] {
  const root = join(publicDir, 'texturepacks');
  try {
    return readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
  } catch {
    return [];
  }
}

export function texturePackBundles(): Plugin {
  let publicDir = 'public';
  return {
    name: 'bunkcraft-texture-pack-bundles',
    configResolved(config) { publicDir = config.publicDir || 'public'; },
    // Dev server: built on request, so edits to the PNGs show up without a restart.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/texturepacks\/([a-z0-9-]+)\.bcpk$/.exec((req.url ?? '').split('?')[0]);
        if (!m || !packFolders(publicDir).includes(m[1])) return next();
        const body = encodePackBundle(readPackFolder(join(publicDir, 'texturepacks', m[1])));
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('cache-control', 'no-cache');
        res.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
      });
    },
    generateBundle() {
      for (const id of packFolders(publicDir)) {
        this.emitFile({ type: 'asset', fileName: `texturepacks/${id}.bcpk`, source: encodePackBundle(readPackFolder(join(publicDir, 'texturepacks', id))) });
      }
    },
  };
}
