# BunkCraft: notes for Claude Code

BunkCraft is a Minecraft-inspired voxel game for the browser: TypeScript, Three.js r186 (WebGL2) and Vite.
A Node server (`server/`) serves the built game and the multiplayer WebSocket on one port.
The user is Stijn and writes in **Dutch**, so reply in Dutch. Code, comments and commit messages are in English.

## Commands

```bash
npm install            # node_modules is not committed
npm run dev            # Vite on :5173 (proxies /ws → :3000)
npm run server         # multiplayer server on :3000 (tsx watch)
npm run build          # tsc --noEmit + vite build → dist/
npm start              # production: serves dist/ + WebSocket on :3000 (run build first)
npm run typecheck
```

Docker: `docker build -t bunkcraft . && docker run -p 3000:3000 -v bunkcraft-data:/app/data bunkcraft`.
Server configuration uses environment variables (`PORT`, `DATA_DIR`, `SEED`, `GAMEMODE`, `WORLD_NAME`, `MOTD`, `MAX_PLAYERS`); see `docs/SERVER.md`.

## Architecture (where things live)

- `src/core/`: `Game.ts` (state machine: menu/loading/playing/paused/inventory/dead/chat; fixed 60 Hz physics, 20 Hz game tick), `Renderer.ts` (shadow pass → main pass → hand pass), `Interaction.ts` (break/place/attack/eat), `Input`, `Camera`, `Audio` (all procedural), `Settings` (quality presets).
- `src/world/`:
  - `BlockRegistry.ts` is data-driven: ids < 256, face order +X −X +Y −Y +Z −Z, flat lookup tables.
  - `TerrainGenerator.ts` is deterministic from the seed and runs in workers *and* on the server.
  - `ChunkManager.ts` handles streaming, priority meshing and upload budgets.
  - `World.ts` covers get/setBlock, sparse edits, explosions and `onEdit` for network sync.
  - Chunks are 16×16×128 `Uint8Array`, index `x | z<<4 | y<<8`.
- `src/rendering/`:
  - `ChunkMesher.ts` (worker) does greedy meshing with per-vertex AO and smooth light. The vertex format is `Uint16×4` (pos×16 + uv) + `Uint8×4` data + `Uint8×4` tint, so all attributes are 4-component (ANGLE-friendly). The UV is packed `u16 + v16*241`, which caps merges at 15 blocks.
  - `Lighting.ts` does a BFS over a 48×48×130 region.
  - `TextureAtlas.ts` builds the texture array (procedural textures and packs).
  - `TexturePacks.ts` covers Pixel Perfection plus local import of the user's own Minecraft jar/zip.
  - Also here: `Materials.ts` (shaders), `HandRenderer.ts`, sky, clouds, particles and shadows (cached).
- `src/entities/`:
  - Mobs are box models, one `InstancedMesh` per body part.
  - AI follows Minecraft goals.
  - `EntityManager` handles spawning and despawning.
  - Item drops render as billboards.
- `src/items/`: items and tools (ids ≥ 256), `Inventory` (36 slots), `Recipes` (recipe-book crafting, stations within 4 blocks).
- `src/player/`: `Player` (AABB physics), `PlayerStats` (health, hunger, air, Minecraft numbers at 20 ticks/s), `GameMode`.
- `src/net/` + `server/`: JSON protocol (`src/net/protocol.ts`, shared). The server owns the edits, time and player records (`data/world.json`) and validates reach, ids, rates and speed. Clients apply edits optimistically and roll back on reject. Multiplayer v1 is peaceful (no server-side mobs yet).
- `src/ui/`: Minecraft 1.21-style menus, integer GUI scale (`--s`), OFL pixel font (`public/fonts`), HUD, inventories, chat and the F3 overlay.

Docs:
- `docs/RESEARCH.md`: visuals, performance, technology choice.
- `docs/GAMEPLAY.md`
- `docs/MULTIPLAYER.md`
- `docs/SERVER.md`
- `docs/ROADMAP.md`: prioritized next steps; keep it updated.
- `docs/HANDOFF.md`: the latest session handoff.

## Rules and decisions

- **No Mojang assets in the repo.**
  - Default textures: Pixel Perfection (CC BY-SA 4.0, credited).
  - Font: Minecraft-Font (OFL).
  - Original Minecraft textures may only be loaded by the player from their own files, and are stored in their browser only.
- **Stay on Three.js WebGL2.** WebGPU only when multi-draw-indirect is standard and it beats WebGL on our benchmark.
- **Performance target:** smooth 60+ FPS on an integrated GPU without lowering graphics. No allocations in per-frame code paths.
- **Git:**
  - Work on branch `feature/bunkcraft-engine`.
  - Commit with clear messages ending with the Co-Authored-By line.
  - **Only push when Stijn asks.**
- **Run `npx tsc --noEmit` and `npm run build` after changes.**
- **Research first** when Stijn asks for something big; he likes reports, then implementation.

## Gotchas when testing

- **Throttled browser windows.** A Playwright window behind other windows runs at 1–10 FPS. Call `page.bringToFront()` repeatedly while waiting, or measurements and timing look broken.
- **Pointer lock fails in automated browsers.** Tests set `game.input.locked = true; game.state = 'playing'` and dispatch mouse events on `#game`.
- **`window.game` is a debug hook in dev builds only (`npm run dev`).** In production `window.game` is the `<canvas id="game">` element (named access). Test multiplayer through the Vite dev server (:5173), which proxies `/ws` to :3000.
- **World generation is asynchronous.** Wait until `game.state !== 'loading'` before manipulating the world.
- **Worlds persist in the browser.** Singleplayer worlds live in IndexedDB `bunkcraft`. Settings live in localStorage `bunkcraft.settings`.
