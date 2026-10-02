import * as THREE from 'three';
import { DESTROY_STAGES, textureLayer } from '../world/BlockRegistry';
import type { WorldUniforms } from './Materials';

/** Thin black selection outline plus the crack overlay while mining. */
export class BlockHighlight {
  readonly group = new THREE.Group();
  private readonly outline: THREE.LineSegments;
  private readonly crack: THREE.Mesh;
  private readonly crackMaterial: THREE.ShaderMaterial;
  private readonly firstStage = textureLayer('destroy_0');

  constructor(uniforms: WorldUniforms) {
    const box = new THREE.BoxGeometry(1.004, 1.004, 1.004);
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.crackMaterial = new THREE.ShaderMaterial({
      uniforms: { uAtlas: uniforms.uAtlas, uLayer: { value: this.firstStage } },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      // Multiplicative blend (dst * src * 2): grey 0.5 = unchanged, darker = crack.
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.SrcColorFactor,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp sampler2DArray;
        uniform sampler2DArray uAtlas;
        uniform float uLayer;
        varying vec2 vUv;
        void main() {
          vec4 t = textureLod(uAtlas, vec3(vUv, uLayer), 0.0);
          if (t.a < 0.5) discard;
          gl_FragColor = vec4(t.rgb, 1.0);
        }
      `,
    });
    this.crack = new THREE.Mesh(new THREE.BoxGeometry(1.003, 1.003, 1.003), this.crackMaterial);
    this.crack.visible = false;
    this.group.add(this.outline, this.crack);
    this.group.visible = false;
  }

  /** Outlines the block, or just the box (0..1 inside the block) a slab, stair or door fills. */
  show(x: number, y: number, z: number, x0 = 0, y0 = 0, z0 = 0, x1 = 1, y1 = 1, z1 = 1): void {
    this.group.visible = true;
    this.group.position.set(x + (x0 + x1) / 2, y + (y0 + y1) / 2, z + (z0 + z1) / 2);
    this.group.scale.set(x1 - x0, y1 - y0, z1 - z0);
  }

  hide(): void {
    this.group.visible = false;
  }

  /** progress in [0,1); <0 hides the crack overlay. */
  setProgress(progress: number): void {
    if (progress <= 0) {
      this.crack.visible = false;
      return;
    }
    this.crack.visible = true;
    const stage = Math.min(DESTROY_STAGES - 1, Math.floor(progress * DESTROY_STAGES));
    this.crackMaterial.uniforms.uLayer.value = this.firstStage + stage;
  }
}
