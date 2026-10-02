import * as THREE from 'three';
import type { GeometryData, MeshResult } from '../rendering/ChunkMesher';
import type { WorkerPool } from '../workers/WorkerPool';
import type { GenerateResponse, MeshResponse } from '../workers/protocol';
import { CHUNK_EMPTY, CHUNK_GENERATING, CHUNK_READY, Chunk } from './Chunk';
import { CHUNK_SIZE, chunkKey } from './constants';

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
  private disposed = false;
  private scanNeeded = true;
  /** Incremented whenever chunk geometry changes (used to invalidate the cached shadow map). */
  geometryVersion = 0;
  /** Applied editing diffs, called after generation (saved player edits). */
  onGenerated: ((chunk: Chunk) => void) | null = null;
  /** Called when a chunk is unloaded (entities tied to it are removed). */
  onUnloaded: ((key: number) => void) | null = null;

  constructor(
    private readonly seed: number,
    private readonly pool: WorkerPool,
    private readonly materials: ChunkMaterials,
  ) {
    this.opaqueGroup.matrixAutoUpdate = false;
    this.waterGroup.matrixAutoUpdate = false;
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
    this.pool.submit({ type: 'generate', id: 0, seed: this.seed, cx: chunk.cx, cz: chunk.cz }, (res) => {
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
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.chunks.get(chunkKey(chunk.cx + dx, chunk.cz + dz))!;
        neighbours.push(n.blocks!);
        biomes.push(n.biomes!);
      }
    }
    const version = chunk.version;
    const urgent = chunk.urgent;
    chunk.urgent = false;
    chunk.meshing = true;
    this.meshInFlight++;
    // Typed arrays are structured-cloned (copied): the main thread keeps ownership.
    this.pool.submit({ type: 'mesh', id: 0, neighbours, biomes, fancyLeaves: this.fancyLeaves }, (res) => {
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
    for (const m of this.fresh) m.frustumCulled = true;
    this.fresh.length = 0;
  }

  private uploadMesh(chunk: Chunk, version: number, result: MeshResult): void {
    // An urgent (edit) remesh may already have uploaded a newer version.
    if (chunk.meshedVersion >= version) return;
    chunk.meshedVersion = version;
    chunk.light = result.light;
    chunk.opaque = this.setGeometry(chunk, chunk.opaque, result.opaque, this.materials.opaque, this.opaqueGroup);
    chunk.cutout = this.setGeometry(chunk, chunk.cutout, result.cutout, this.materials.cutout, this.opaqueGroup);
    // Only chunks inside the shadow map's reach (≤ 128 blocks) invalidate the cached shadows.
    if (Math.abs(chunk.cx - this.centerX) <= 9 && Math.abs(chunk.cz - this.centerZ) <= 9) this.geometryVersion++;
    chunk.water = this.setGeometry(chunk, chunk.water, result.water, this.materials.water, this.waterGroup);
    if (chunk.version !== version) this.scanNeeded = true;
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
    mesh.frustumCulled = false;
    this.fresh.push(mesh);
    return mesh;
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
    c.blocks = null;
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
    this.results.length = 0;
    this.opaqueGroup.removeFromParent();
    this.waterGroup.removeFromParent();
  }
}
