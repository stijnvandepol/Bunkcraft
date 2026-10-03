import * as THREE from 'three';
import { BlockHighlight } from '../rendering/BlockHighlight';
import { Clouds } from '../rendering/Clouds';
import type { DayCycle } from '../rendering/DayCycle';
import {
  createChunkMaterial, createShadowDepthMaterial, createWaterMaterial, createWorldUniforms, type WorldUniforms,
} from '../rendering/Materials';
import { Particles } from '../rendering/Particles';
import { ShadowRenderer } from '../rendering/Shadows';
import { Sky } from '../rendering/Sky';
import { type TextureSet, buildTextures } from '../rendering/TextureAtlas';
import type { World } from '../world/World';
import type { Settings } from './Settings';

/** Sort items of three.js' render list (the fields we compare). */
interface RenderItem { id: number; groupOrder: number; renderOrder: number; z: number; material: { id: number } | null }

/** Same order as three.js' painterSortStable, but returning small integers. */
function sortFrontToBack(a: RenderItem, b: RenderItem): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder < b.groupOrder ? -1 : 1;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder < b.renderOrder ? -1 : 1;
  if (a.material!.id !== b.material!.id) return a.material!.id < b.material!.id ? -1 : 1;
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/** Same order as three.js' reversePainterSortStable (transparent objects: far to near). */
function sortBackToFront(a: RenderItem, b: RenderItem): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder < b.groupOrder ? -1 : 1;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder < b.renderOrder ? -1 : 1;
  if (a.z !== b.z) return a.z > b.z ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

export interface FrameStats {
  drawCalls: number;
  triangles: number;
  shadowCalls: number;
}

/**
 * Owns the WebGL renderer, the scene graph and the per-frame render passes:
 *   1. sun shadow map (depth-only, opaque chunks)
 *   2. main pass: sky → opaque chunks → clouds/particles → water (sorted, blended)
 */
export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly uniforms: WorldUniforms;
  readonly textures: TextureSet;
  readonly chunkMaterial: THREE.ShaderMaterial;
  readonly cutoutMaterial: THREE.ShaderMaterial;
  readonly waterMaterial: THREE.ShaderMaterial;
  readonly sky = new Sky();
  readonly clouds = new Clouds();
  readonly particles: Particles;
  readonly highlight: BlockHighlight;
  readonly stats: FrameStats = { drawCalls: 0, triangles: 0, shadowCalls: 0 };
  readonly shadows: ShadowRenderer;
  private readonly depthMaterial: THREE.ShaderMaterial;
  private world: World | null = null;
  /** Objects hidden during the shadow pass besides the built-ins (entities). */
  readonly shadowExcluded: THREE.Object3D[] = [];
  /** Extra pass after the main render (first-person hand). */
  afterMain: ((renderer: THREE.WebGLRenderer) => void) | null = null;
  private readonly shadowHidden: THREE.Object3D[] = [];
  private readonly shadowVisible: boolean[] = [];
  private renderScale = 1;
  /** Multiplier from dynamic resolution (1 = the user's render scale). */
  private dynamicScale = 1;
  private readonly maxAnisotropy: number;
  private renderDistance = 8;
  private cloudsEnabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.three = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.three.info.autoReset = false;
    // three.js' own comparators return doubles, which V8 boxes into heap numbers on every compare.
    this.three.setOpaqueSort(sortFrontToBack);
    this.three.setTransparentSort(sortBackToFront);
    this.three.outputColorSpace = THREE.LinearSRGBColorSpace; // shaders output display-ready colours
    this.three.setClearColor(0x000000, 1);

    this.maxAnisotropy = this.three.capabilities.getMaxAnisotropy();
    this.textures = buildTextures(this.maxAnisotropy);
    this.uniforms = createWorldUniforms(this.textures.texture);
    this.chunkMaterial = createChunkMaterial(this.uniforms, false);
    this.cutoutMaterial = createChunkMaterial(this.uniforms, true);
    this.waterMaterial = createWaterMaterial(this.uniforms);
    this.depthMaterial = createShadowDepthMaterial(this.uniforms);
    this.shadows = new ShadowRenderer(this.uniforms);
    this.particles = new Particles(this.uniforms);
    this.highlight = new BlockHighlight(this.uniforms);

    this.scene.add(this.sky.mesh, this.clouds.mesh, this.particles.mesh, this.highlight.group);
    this.scene.matrixWorldAutoUpdate = true;
    this.resize();
  }

  attachWorld(world: World | null): void {
    if (this.world) {
      this.world.chunks.opaqueGroup.removeFromParent();
      this.world.chunks.waterGroup.removeFromParent();
    }
    this.world = world;
    if (world) this.scene.add(world.chunks.opaqueGroup, world.chunks.waterGroup);
    this.particles.clear();
    this.highlight.hide();
  }

  applySettings(s: Settings): void {
    const fancy = s.graphics === 'fancy';
    this.renderScale = s.renderScale / 100;
    this.uniforms.uSway.value = fancy ? 1 : 0;
    this.uniforms.uWaterFancy.value = fancy ? 1 : 0;
    // Anisotropic filtering costs texture bandwidth that weak GPUs lack; Fast turns it off.
    const anisotropy = fancy ? Math.min(4, this.maxAnisotropy) : 1;
    if (this.textures.texture.anisotropy !== anisotropy) {
      this.textures.texture.anisotropy = anisotropy;
      this.textures.texture.needsUpdate = true;
    }
    this.cloudsEnabled = s.clouds !== 'off';
    this.uniforms.uBrightness.value = s.brightness / 100;
    this.renderDistance = s.renderDistance;
    const maxShadow = this.three.capabilities.maxTextureSize;
    if (s.shadows === 'off') this.shadows.disable();
    else if (s.shadows === 'low') this.shadows.configure(1024, 56, maxShadow);
    else if (s.shadows === 'high') this.shadows.configure(2048, 88, maxShadow);
    else this.shadows.configure(4096, 128, maxShadow);
    this.particles.density = s.particles === 'all' ? 1 : s.particles === 'decreased' ? 0.5 : 0.25;
    this.resize();
  }

  /** The distance the adaptive governor currently allows (fog follows it). */
  setRenderDistance(chunks: number): void {
    this.renderDistance = chunks;
  }

  /** Device pixel ratio (capped at 2) times the user render scale, before dynamic resolution. */
  get basePixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, 2) * this.renderScale;
  }

  setDynamicScale(scale: number): void {
    if (scale === this.dynamicScale) return;
    this.dynamicScale = scale;
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    // Below 100% renders fewer pixels on weak GPUs, above 100% supersamples for smooth edges.
    const ratio = this.basePixelRatio * this.dynamicScale;
    this.three.setPixelRatio(Math.max(0.25, Math.min(4, ratio)));
    // Supersampled frames must be filtered when scaled down; upscaled ones stay pixel-crisp.
    this.three.domElement.style.imageRendering = this.renderScale * this.dynamicScale > 1 ? 'auto' : 'pixelated';
    this.three.setSize(w, h, false);
  }

  render(camera: THREE.PerspectiveCamera, cycle: DayCycle, time: number, underwater: boolean): void {
    const u = this.uniforms;
    u.uTime.value = time;
    u.uSunDir.value.copy(cycle.sunDir);
    u.uDaylight.value = cycle.daylight;
    u.uSkyLightColor.value.copy(cycle.skyLight);
    u.uFogColor.value.copy(cycle.horizon);
    u.uSunsetColor.value.copy(cycle.sunset);
    u.uSunsetAmount.value = cycle.sunsetAmount;
    u.uUnderwater.value = underwater ? 1 : 0;
    const fogFar = Math.max(24, (this.renderDistance - 0.6) * 16);
    u.uFogFar.value = fogFar;
    u.uFogNear.value = fogFar * 0.6;

    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    if (Math.abs(camera.aspect - aspect) > 1e-4) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
    this.sky.update(cycle, underwater);
    this.clouds.mesh.visible = this.cloudsEnabled && !underwater;
    this.three.setClearColor(cycle.horizon, 1);

    this.three.info.reset();
    // 1. Shadow pass, faded out when the sun is low (no shadows at night).
    const sunUp = cycle.sunDir.y;
    const strength = this.shadows.enabled ? Math.min(1, Math.max(0, (sunUp - 0.04) / 0.12)) : 0;
    u.uShadowStrength.value = strength;
    if (strength > 0 && this.world && this.shadows.needsUpdate(camera.position, cycle.sunDir, this.world.chunks.geometryVersion)) {
      this.renderShadows(camera.position, cycle.sunDir);
    }
    this.stats.shadowCalls = this.three.info.render.calls;

    // 2. Main pass.
    this.world?.chunks.cull(camera, underwater ? Infinity : fogFar);
    this.three.render(this.scene, camera);
    this.afterMain?.(this.three);
    this.stats.drawCalls = this.three.info.render.calls - this.stats.shadowCalls;
    this.stats.triangles = this.three.info.render.triangles;
  }

  private renderShadows(center: THREE.Vector3, sunDir: THREE.Vector3): void {
    const world = this.world!;
    const hidden = this.shadowHidden;
    hidden.length = 0;
    hidden.push(this.sky.mesh, this.clouds.mesh, this.particles.mesh, this.highlight.group, world.chunks.waterGroup, ...this.shadowExcluded);
    for (let i = 0; i < hidden.length; i++) {
      this.shadowVisible[i] = hidden[i].visible;
      hidden[i].visible = false;
    }
    this.scene.overrideMaterial = this.depthMaterial;
    this.shadows.render(this.three, this.scene, center, sunDir, world.chunks.geometryVersion);
    this.scene.overrideMaterial = null;
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = this.shadowVisible[i];
  }
}
