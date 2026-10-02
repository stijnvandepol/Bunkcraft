import * as THREE from 'three';
import type { WorldUniforms } from './Materials';

const ORIGIN = new THREE.Vector3(0, 0, 0);
const Z_UP = new THREE.Vector3(0, 0, 1);

const BIAS = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
);

/**
 * Directional sun shadows with a single orthographic shadow map that follows the
 * player. The shadow camera is snapped to whole shadow-map texels in light space,
 * which stops shadow edges from "swimming" while walking.
 *
 * The world is static, so the map is cached: it is only re-rendered when the sun has
 * moved noticeably, the player moved a few blocks, or chunk geometry changed. On most
 * frames the shadow pass therefore costs nothing.
 */
export class ShadowRenderer {
  readonly camera = new THREE.OrthographicCamera();
  private target: THREE.WebGLRenderTarget | null = null;
  private size = 0;
  private extent = 80;
  private readonly lightRotation = new THREE.Matrix4();
  private readonly inverseRotation = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly lastCenter = new THREE.Vector3(Infinity, 0, 0);
  private readonly lastSun = new THREE.Vector3();
  private lastGeometry = -1;
  /** Number of shadow map renders (debug). */
  updates = 0;

  constructor(private readonly uniforms: WorldUniforms) {
    this.camera.near = 1;
    this.camera.far = 420;
  }

  /** @param maxSize the GPU's texture size limit: the map is clamped to it (weak and mobile GPUs). */
  configure(size: number, extent: number, maxSize = Infinity): void {
    size = Math.min(size, maxSize);
    if (size === this.size && this.target) return;
    this.target?.dispose();
    this.invalidate();
    this.size = size;
    this.extent = extent;
    const depth = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    this.target = new THREE.WebGLRenderTarget(size, size, { depthTexture: depth, depthBuffer: true });
    this.target.texture.generateMipmaps = false;
    this.uniforms.uShadowMap.value = depth;
    this.uniforms.uShadowTexel.value = 1 / size;
    const e = this.extent;
    this.camera.left = -e; this.camera.right = e; this.camera.top = e; this.camera.bottom = -e;
    this.camera.updateProjectionMatrix();
  }

  disable(): void {
    this.target?.dispose();
    this.target = null;
    this.size = 0;
    this.uniforms.uShadowMap.value = null;
  }

  invalidate(): void {
    this.lastGeometry = -1;
  }

  needsUpdate(center: THREE.Vector3, sunDir: THREE.Vector3, geometryVersion: number): boolean {
    return geometryVersion !== this.lastGeometry
      || center.distanceToSquared(this.lastCenter) > 16
      || sunDir.dot(this.lastSun) < 0.999995; // ≈ 0.18°
  }

  get enabled(): boolean {
    return this.target !== null;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, center: THREE.Vector3, sunDir: THREE.Vector3, geometryVersion: number): void {
    if (!this.target) return;
    this.lastCenter.copy(center);
    this.lastSun.copy(sunDir);
    this.lastGeometry = geometryVersion;
    this.updates++;
    // Light-space basis looking down the sun direction.
    this.lightRotation.lookAt(sunDir, ORIGIN, Math.abs(sunDir.y) > 0.99 ? Z_UP : this.up);
    this.inverseRotation.copy(this.lightRotation).invert();
    const texel = (this.extent * 2) / this.size;
    const p = this.tmp.copy(center).applyMatrix4(this.inverseRotation);
    p.x = Math.round(p.x / texel) * texel;
    p.y = Math.round(p.y / texel) * texel;
    p.applyMatrix4(this.lightRotation);

    this.camera.position.copy(p).addScaledVector(sunDir, 200);
    this.camera.quaternion.setFromRotationMatrix(this.lightRotation);
    this.camera.updateMatrixWorld(true);

    renderer.setRenderTarget(this.target);
    renderer.clear(false, true, false);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(null);

    this.uniforms.uShadowMatrix.value
      .copy(BIAS)
      .multiply(this.camera.projectionMatrix)
      .multiply(this.camera.matrixWorldInverse);
  }
}
