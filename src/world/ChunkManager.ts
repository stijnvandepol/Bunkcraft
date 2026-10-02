import * as THREE from 'three';
import type { GeometryData, MeshResult } from '../rendering/ChunkMesher';
import type { WorkerPool } from '../workers/WorkerPool';
import type { GenerateResponse, MeshResponse } from '../workers/protocol';
import { CHUNK_EMPTY, CHUNK_GENERATING, CHUNK_READY, Chunk } from './Chunk';
import { CHUNK_HEIGHT, CHUNK_SIZE, chunkKey } from './constants';
import type { WorldType } from './WorldGenerator';

export interface ChunkMaterials {
  opaque: THREE.Material;
  cutout: THREE.Material;
  water: THREE.Material;
}

function geometryBytes(g: GeometryData | null): number {
  return g ? g.packed.byteLength + g.data.byteLength + g.tint.byteLength + g.index.byteLength : 0;
}

function resultBytes(r: MeshResult): number {
  return geometryBytes(r.opaque) + geometryBytes(r.cutout) + geometryBytes(r.water);
}

interface PendingMesh {
  chunk: Chunk;
  version: number;
  result: MeshResult;
}

/**
 * Streams chunks around the player:
 *  - generation and meshing run in the worker pool, nearest chunks first
 *  - a chunk is meshed only once its 8 neighbours exist (seamless AO/light)
 *  - finished meshes are uploaded under a per-frame byte budget, and drawn once right
 *    away so the GPU upload happens now instead of when the chunk first enters view
 *  - chunks outside the render distance are unloaded and their GPU buffers freed
 */
export class ChunkManager {
  readonly chunks = new Map<number, Chunk>();
  readonly opaqueGroup = new THREE.Group();
  readonly waterGroup = new THREE.Group();
  renderDistance = 8;
  fancyLeaves = true;

  private offsets: Int16Array = new Int16Array(0);
  private offsetsFor = -1;
  private centerX = Infinity;
  private centerZ = Infinity;
  private genInFlight = 0;
  private meshInFlight = 0;
  private readonly results: PendingMesh[] = [];
  private readonly meshPool: THREE.Mesh[] = [];
  /** Meshes uploaded this frame; frustum culling is skipped once to force the GPU upload. */
  private readonly fresh: THREE.Mesh[] = [];
  /** Chunks that own at least one mesh (flat array: no iterator garbage in the per-frame cull). */
  private readonly drawList: Chunk[] = [];
  private readonly planes = new Float64Array(24);
  private readonly cullKey = new Float64Array(20).fill(NaN);
  private readonly projView = new THREE.Matrix4();
  private readonly cullFrustum = new THREE.Frustum();
  private cullDirty = true;
  /** Meshes hidden from the main camera by the CPU cull (drawn only in the shadow pass). */
  culledChunks = 0;
  private disposed = false;
  private scanNeeded = true;
  /** Incremented whenever chunk geometry changes (used to invalidate the cached shadow map). */
  geometryVersion = 0;
  /** Incremented whenever a chunk is added to or removed from the map (invalidates World's lookup cache). */
  epoch = 0;
  /** Applied editing diffs, called after generation (saved player edits). */
  onGenerated: ((chunk: Chunk) => void) | null = null;
  /** Called when a chunk is unloaded (entities tied to it are removed). */
  onUnloaded: ((key: number) => void) | null = null;

  constructor(
    private readonly seed: number,
    private readonly pool: WorkerPool,
    private readonly materials: ChunkMaterials,
    private readonly worldType: WorldType = 'terrain',
  ) {
    // The groups never move and chunk meshes have their matrixWorld set once: keep the per-frame
    // updateMatrixWorld traversal out of ~1000 children.
    this.opaqueGroup.matrixAutoUpdate = false;
    this.waterGroup.matrixAutoUpdate = false;
    this.opaqueGroup.matrixWorldAutoUpdate = false;
    this.waterGroup.matrixWorldAutoUpdate = false;
  }

  get(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  /** Square spiral offsets sorted by distance, filtered to a circle. */
  private buildOffsets(radius: number): void {
    const list: [number, number, number][] = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d = dx * dx + dz * dz;
        if (d <= (radius + 0.5) * (radius + 0.5)) list.push([dx, dz, d]);
      }
    }
    list.sort((a, b) => a[2] - b[2]);
    this.offsets = new Int16Array(list.length * 2);
    list.forEach(([dx, dz], i) => { this.offsets[i * 2] = dx; this.offsets[i * 2 + 1] = dz; });
    this.offsetsFor = radius;
  }

  markDirty(): void {
    this.scanNeeded = true;
  }

  update(px: number, pz: number, uploadBudgetBytes = 1.5 * 1024 * 1024): void {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);
    const genRadius = this.renderDistance + 1;
    if (this.offsetsFor !== genRadius) {
      this.buildOffsets(genRadius);
      this.centerX = Infinity;
    }
    if (pcx !== this.centerX || pcz !== this.centerZ) {
      this.centerX = pcx;
      this.centerZ = pcz;
      this.unloadFar(pcx, pcz);
      this.scanNeeded = true;
    }
    this.applyResults(uploadBudgetBytes);
    if (this.scanNeeded) this.schedule(pcx, pcz);
  }

  private schedule(pcx: number, pcz: number): void {
    const maxInFlight = this.pool.size * 2;
    const off = this.offsets;
    const meshR2 = (this.renderDistance + 0.5) ** 2;
    let blocked = false;
    for (let i = 0; i < off.length; i += 2) {
      const dx = off[i], dz = off[i + 1];
      const cx = pcx + dx, cz = pcz + dz;
      const key = chunkKey(cx, cz);
      let chunk = this.chunks.get(key);
      if (!chunk) {
        chunk = new Chunk(cx, cz, key);
        this.chunks.set(key, chunk);
        this.epoch++;
      }
      if (chunk.state === CHUNK_EMPTY) {
        if (this.genInFlight < maxInFlight) this.requestGenerate(chunk);
        else blocked = true;
      } else if (chunk.needsMesh && !chunk.meshing && dx * dx + dz * dz <= meshR2) {
        if (!this.neighboursReady(chunk)) continue;
        if (this.meshInFlight < maxInFlight || chunk.urgent) this.requestMesh(chunk);
        else blocked = true;
      }
      if (blocked && this.genInFlight >= maxInFlight && this.meshInFlight >= maxInFlight) return;
    }
    // Everything inside the radius is generated and meshed: idle until something changes.
    if (!blocked && this.genInFlight === 0 && this.meshInFlight === 0) this.scanNeeded = false;
  }

  private neighboursReady(c: Chunk): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.chunks.get(chunkKey(c.cx + dx, c.cz + dz));
        if (!n || n.state !== CHUNK_READY) return false;
      }
    }
    return true;
  }

  private requestGenerate(chunk: Chunk): void {
    chunk.state = CHUNK_GENERATING;
    this.genInFlight++;
    this.pool.submit({ type: 'generate', id: 0, seed: this.seed, worldType: this.worldType, cx: chunk.cx, cz: chunk.cz }, (res) => {
      this.genInFlight--;
      if (this.disposed || this.chunks.get(chunk.key) !== chunk) return;
      chunk.blocks = (res as GenerateResponse).blocks;
      chunk.biomes = (res as GenerateResponse).biomes;
      chunk.state = CHUNK_READY;
      chunk.version++;
      this.onGenerated?.(chunk);
      this.scanNeeded = true;
    }, [], false, () => {
      // The worker crashed repeatedly on this job: let the next scan try again.
      this.genInFlight--;
      chunk.state = CHUNK_EMPTY;
      this.scanNeeded = true;
    });
  }

  /** Immediately (re)mesh a chunk with high priority, if possible. */
  requestMeshUrgent(chunk: Chunk): void {
    chunk.urgent = true;
    this.scanNeeded = true;
    if (!chunk.meshing && chunk.needsMesh && this.neighboursReady(chunk)) this.requestMesh(chunk);
  }

  private requestMesh(chunk: Chunk): void {
    const neighbours: Uint8Array[] = [];
    const biomes: Uint8Array[] = [];
    const metas: (Uint8Array | null)[] = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.chunks.get(chunkKey(chunk.cx + dx, chunk.cz + dz))!;
        neighbours.push(n.blocks!);
        biomes.push(n.biomes!);
        metas.push(n.meta);
      }
    }
    const version = chunk.version;
    const urgent = chunk.urgent;
    chunk.urgent = false;
    chunk.meshing = true;
    this.meshInFlight++;
    // Typed arrays are structured-cloned (copied): the main thread keeps ownership.
    this.pool.submit({ type: 'mesh', id: 0, neighbours, metas, biomes, fancyLeaves: this.fancyLeaves }, (res) => {
      this.meshInFlight--;
      chunk.meshing = false;
      if (this.disposed || this.chunks.get(chunk.key) !== chunk) return;
      const result = (res as MeshResponse).result;
      if (urgent) this.uploadMesh(chunk, version, result); // edits skip the upload queue
      else this.results.push({ chunk, version, result });
      this.scanNeeded = true;
    }, [], urgent, () => {
      this.meshInFlight--;
      chunk.meshing = false;
      this.scanNeeded = true;
    });
  }

  private applyResults(budgetBytes: number): void {
    let bytes = 0;
    while (this.results.length > 0 && bytes < budgetBytes) {
      const r = this.results.shift()!;
      if (this.chunks.get(r.chunk.key) !== r.chunk) continue;
      this.uploadMesh(r.chunk, r.version, r.result);
      bytes += resultBytes(r.result);
    }
  }

  /** Call after rendering: re-enable frustum culling for meshes force-drawn this frame. */
  afterRender(): void {
    if (this.fresh.length === 0) return;
    for (const m of this.fresh) m.frustumCulled = true;
    this.fresh.length = 0;
    this.cullDirty = true; // their layer mask was forced visible: re-evaluate next frame
  }

  private uploadMesh(chunk: Chunk, version: number, result: MeshResult): void {
    // An urgent (edit) remesh may already have uploaded a newer version.
    if (chunk.meshedVersion >= version) return;
    chunk.meshedVersion = version;
    const prevLight = chunk.light;
    chunk.light = result.light;
    if (prevLight) this.propagateLight(chunk, prevLight, result.light);
    chunk.opaque = this.setGeometry(chunk, chunk.opaque, result.opaque, this.materials.opaque, this.opaqueGroup);
    chunk.cutout = this.setGeometry(chunk, chunk.cutout, result.cutout, this.materials.cutout, this.opaqueGroup);
    // Only chunks inside the shadow map's reach (≤ 128 blocks) invalidate the cached shadows.
    if (Math.abs(chunk.cx - this.centerX) <= 9 && Math.abs(chunk.cz - this.centerZ) <= 9) this.geometryVersion++;
    chunk.water = this.setGeometry(chunk, chunk.water, result.water, this.materials.water, this.waterGroup);
    this.updateExtent(chunk);
    if (chunk.version !== version) this.scanNeeded = true;
  }

  /**
   * Light only reaches a neighbour through the border cells of this chunk: when none of them changed
   * between two mesh passes, the neighbour's light is unchanged too and it needs no remesh.
   */
  private propagateLight(chunk: Chunk, prev: Uint8Array, next: Uint8Array): void {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const n = this.get(chunk.cx + dx, chunk.cz + dz);
        if (!n || n.state !== CHUNK_READY || !n.light) continue;
        // Border strip facing the neighbour: a full column (diagonal), a row or a column of cells.
        const x0 = dx < 0 ? 0 : dx > 0 ? 15 : 0, x1 = dx === 0 ? 15 : x0;
        const z0 = dz < 0 ? 0 : dz > 0 ? 15 : 0, z1 = dz === 0 ? 15 : z0;
        if (!borderChanged(prev, next, x0, x1, z0, z1)) continue;
        n.version++;
        this.scanNeeded = true;
      }
    }
  }

  private setGeometry(
    chunk: Chunk, mesh: THREE.Mesh | null, data: GeometryData | null,
    material: THREE.Material, group: THREE.Group,
  ): THREE.Mesh | null {
    if (mesh) mesh.geometry.dispose();
    if (!data) {
      if (mesh) this.releaseMesh(mesh);
      return null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('packed', new THREE.BufferAttribute(data.packed, 4));
    geo.setAttribute('data', new THREE.BufferAttribute(data.data, 4));
    geo.setAttribute('tint', new THREE.BufferAttribute(data.tint, 4, true));
    geo.setIndex(new THREE.BufferAttribute(data.index, 1));
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, data.minY - 0.5, 0), new THREE.Vector3(16, data.maxY + 0.5, 16));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    if (!mesh) {
      mesh = this.meshPool.pop() ?? new THREE.Mesh();
      mesh.matrixAutoUpdate = false;
      mesh.position.set(chunk.cx * CHUNK_SIZE, 0, chunk.cz * CHUNK_SIZE);
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
      mesh.material = material;
      group.add(mesh);
    }
    mesh.geometry = geo;
    mesh.layers.mask = 3;
    mesh.frustumCulled = false;
    this.fresh.push(mesh);
    return mesh;
  }

  private updateExtent(c: Chunk): void {
    let lo = Infinity, hi = -Infinity;
    for (const m of [c.opaque, c.cutout, c.water]) {
      if (!m) continue;
      const b = m.geometry.boundingBox!;
      if (b.min.y < lo) lo = b.min.y;
      if (b.max.y > hi) hi = b.max.y;
    }
    if (hi < lo) {
      this.removeFromDrawList(c);
    } else {
      c.minY = lo;
      c.maxY = hi;
      if (c.drawSlot < 0) {
        c.drawSlot = this.drawList.length;
        this.drawList.push(c);
      }
    }
    this.cullDirty = true;
  }

  private removeFromDrawList(c: Chunk): void {
    const i = c.drawSlot;
    if (i < 0) return;
    const last = this.drawList.pop()!;
    if (last !== c) {
      this.drawList[i] = last;
      last.drawSlot = i;
    }
    c.drawSlot = -1;
    this.cullDirty = true;
  }

  /**
   * CPU visibility pass before the main render: one box test per chunk column instead of one
   * bounding-sphere test per mesh inside three.js' scene traversal (opaque, cutout and water are up
   * to three objects per chunk). Hidden meshes only lose layer 0, so the shadow camera (all
   * layers) still draws shadow casters behind the player. Columns beyond `farDist` are fully
   * fogged and skipped as well. Skipped entirely while the camera and the chunk set are unchanged.
   */
  cull(camera: THREE.PerspectiveCamera, farDist: number): void {
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = this.projView.elements, key = this.cullKey;
    let same = !this.cullDirty && key[16] === farDist;
    for (let i = 0; same && i < 16; i++) if (key[i] !== e[i]) same = false;
    if (same) return;
    for (let i = 0; i < 16; i++) key[i] = e[i];
    key[16] = farDist;
    this.cullDirty = false;

    const fr = this.cullFrustum.setFromProjectionMatrix(this.projView);
    const pl = this.planes;
    for (let i = 0; i < 6; i++) {
      const p = fr.planes[i];
      pl[i * 4] = p.normal.x; pl[i * 4 + 1] = p.normal.y; pl[i * 4 + 2] = p.normal.z; pl[i * 4 + 3] = p.constant;
    }
    const cx = camera.position.x, cz = camera.position.z;
    const far2 = farDist * farDist;
    const list = this.drawList;
    let culled = 0;
    for (let n = 0; n < list.length; n++) {
      const c = list[n];
      const x0 = c.cx * CHUNK_SIZE, z0 = c.cz * CHUNK_SIZE, x1 = x0 + CHUNK_SIZE, z1 = z0 + CHUNK_SIZE;
      const dx = Math.max(x0 - cx, 0, cx - x1), dz = Math.max(z0 - cz, 0, cz - z1);
      let visible = dx * dx + dz * dz < far2;
      for (let i = 0; visible && i < 6; i++) {
        const nx = pl[i * 4], ny = pl[i * 4 + 1], nz = pl[i * 4 + 2];
        // Corner of the box furthest along the plane normal: if even that is behind, the box is out.
        if (nx * (nx > 0 ? x1 : x0) + ny * (ny > 0 ? c.maxY : c.minY) + nz * (nz > 0 ? z1 : z0) + pl[i * 4 + 3] < 0) visible = false;
      }
      if (!visible) culled++;
      const mask = visible ? 3 : 2;
      if (c.opaque) c.opaque.layers.mask = mask;
      if (c.cutout) c.cutout.layers.mask = mask;
      if (c.water) c.water.layers.mask = mask;
    }
    this.culledChunks = culled;
    // Fresh meshes are force-drawn once so the GPU upload happens now.
    for (let i = 0; i < this.fresh.length; i++) this.fresh[i].layers.mask = 3;
  }

  private releaseMesh(mesh: THREE.Mesh): void {
    mesh.removeFromParent();
    this.meshPool.push(mesh);
  }

  private unloadFar(pcx: number, pcz: number): void {
    const limit = (this.renderDistance + 2.5) ** 2;
    for (const [key, c] of this.chunks) {
      const dx = c.cx - pcx, dz = c.cz - pcz;
      if (dx * dx + dz * dz > limit) {
        this.disposeChunk(c);
        this.chunks.delete(key);
        this.epoch++;
        this.onUnloaded?.(key);
      }
    }
  }

  private disposeChunk(c: Chunk): void {
    for (const m of [c.opaque, c.cutout, c.water]) {
      if (m) {
        m.geometry.dispose();
        this.releaseMesh(m);
      }
    }
    c.opaque = c.cutout = c.water = null;
    this.removeFromDrawList(c);
    c.blocks = null;
    c.meta = null;
    c.biomes = null;
    c.light = null;
  }

  /** Force every chunk to be remeshed (e.g. leaves quality changed). */
  remeshAll(): void {
    for (const c of this.chunks.values()) if (c.state === CHUNK_READY) c.version++;
    this.scanNeeded = true;
  }

  /** Number of loaded chunks whose mesh is inside the camera frustum. */
  countVisible(frustum: THREE.Frustum): number {
    let n = 0;
    const s = new THREE.Sphere();
    for (const c of this.chunks.values()) {
      const m = c.opaque ?? c.cutout;
      if (!m) continue;
      s.copy(m.geometry.boundingSphere!).applyMatrix4(m.matrixWorld);
      if (frustum.intersectsSphere(s)) n++;
    }
    return n;
  }

  stats() {
    let ready = 0, meshed = 0, triangles = 0;
    for (const c of this.chunks.values()) {
      if (c.state === CHUNK_READY) ready++;
      if (c.opaque || c.cutout || c.water) meshed++;
      if (c.opaque) triangles += (c.opaque.geometry.index!.count / 3);
      if (c.cutout) triangles += (c.cutout.geometry.index!.count / 3);
      if (c.water) triangles += (c.water.geometry.index!.count / 3);
    }
    return { loaded: ready, meshed, triangles, genInFlight: this.genInFlight, meshInFlight: this.meshInFlight, uploadQueue: this.results.length };
  }

  isAreaReady(px: number, pz: number, radius: number): boolean {
    const pcx = Math.floor(px / CHUNK_SIZE), pcz = Math.floor(pz / CHUNK_SIZE);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const c = this.chunks.get(chunkKey(pcx + dx, pcz + dz));
        if (!c || c.meshedVersion < 0) return false;
      }
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.chunks.values()) this.disposeChunk(c);
    this.chunks.clear();
    this.drawList.length = 0;
    this.epoch++;
    this.results.length = 0;
    this.opaqueGroup.removeFromParent();
    this.waterGroup.removeFromParent();
  }
}

function borderChanged(a: Uint8Array, b: Uint8Array, x0: number, x1: number, z0: number, z1: number): boolean {
  for (let y = 0; y < CHUNK_HEIGHT; y++) {
    for (let z = z0; z <= z1; z++) {
      const row = (y << 8) | (z << 4);
      for (let x = x0; x <= x1; x++) if (a[row | x] !== b[row | x]) return true;
    }
  }
  return false;
}
