import * as THREE from 'three';
import { FACE_LAYER, getBlockDef } from '../world/BlockRegistry';
import type { BlockIcons } from '../ui/BlockIcons';
import { LIGHT_GLSL, type WorldUniforms } from './Materials';

const SWING_TIME = 0.3; // 6 ticks

/**
 * First-person hand: the arm, a held block (real mini cube using the block texture
 * array) or a held item (flat sprite). Drawn in its own pass after the world with the
 * depth buffer cleared, so it never clips into walls. Animations follow Minecraft:
 * swing (6 ticks), equip (drop and rise when switching), walk bob and eating.
 */
export class HandRenderer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, 0.01, 10);

  /** Compiles the hand and held-item shaders ahead of the first in-game frame. */
  precompile(three: THREE.WebGLRenderer): Promise<unknown> {
    return three.compileAsync(this.scene, this.camera);
  }
  private readonly root = new THREE.Group();
  private readonly arm: THREE.Mesh;
  private readonly block: THREE.Mesh;
  private readonly sprite: THREE.Mesh;
  private readonly spriteTexture: THREE.CanvasTexture;
  private readonly spriteCanvas = document.createElement('canvas');
  private readonly layers: THREE.BufferAttribute;
  private readonly light = { value: new THREE.Vector2(1, 0) };
  /** Enchantment glint on the held item: x = on (0/1), y = time in seconds. */
  private readonly glint = { value: new THREE.Vector2(0, 0) };
  private heldId = -1;
  private iconVersion = -1;
  private swing = 1;
  private equip = 1;
  private eating = 0;
  visible = true;

  constructor(uniforms: WorldUniforms, private readonly icons: BlockIcons) {
    this.scene.add(this.root);
    const shared = { uDaylight: uniforms.uDaylight, uSkyLightColor: uniforms.uSkyLightColor, uBrightness: uniforms.uBrightness, uLight: this.light };
    const lightGlsl = /* glsl */ `
      ${LIGHT_GLSL}
      uniform vec2 uLight;
      vec3 handLight() {
        return max(combineLight(uLight.x, uLight.y, 1.0), vec3(0.06));
      }
    `;

    // Arm: 4×12×4 px box, skin coloured, shaded per face.
    const armGeo = new THREE.BoxGeometry(4 / 16, 12 / 16, 4 / 16);
    armGeo.translate(0, -6 / 16, 0);
    this.arm = new THREE.Mesh(armGeo, new THREE.ShaderMaterial({
      uniforms: shared,
      vertexShader: 'varying vec3 vN; void main() { vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `${lightGlsl}
        varying vec3 vN;
        void main() {
          float shade = vN.y > 0.5 ? 1.0 : vN.y < -0.5 ? 0.5 : abs(vN.x) > 0.5 ? 0.7 : 0.85;
          gl_FragColor = vec4(vec3(0.83, 0.62, 0.47) * shade * handLight(), 1.0);
        }`,
    }));

    // Held block: unit cube whose faces sample the block texture array.
    const cube = new THREE.BoxGeometry(1, 1, 1);
    this.layers = new THREE.BufferAttribute(new Float32Array(24), 1);
    cube.setAttribute('layer', this.layers);
    this.block = new THREE.Mesh(cube, new THREE.ShaderMaterial({
      uniforms: { ...shared, uAtlas: uniforms.uAtlas },
      vertexShader: `
        attribute float layer;
        varying vec2 vUv; varying float vLayer; varying vec3 vN;
        void main() { vUv = uv; vLayer = layer; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `${lightGlsl}
        precision highp sampler2DArray;
        uniform sampler2DArray uAtlas;
        varying vec2 vUv; varying float vLayer; varying vec3 vN;
        void main() {
          vec4 t = texture(uAtlas, vec3(vUv, vLayer));
          if (t.a < 0.3) discard;
          float shade = vN.y > 0.5 ? 1.0 : vN.y < -0.5 ? 0.5 : abs(vN.x) > 0.5 ? 0.7 : 0.85;
          // Tinted greyscale pixels (alpha 0.5) get the default plains grass colour.
          t.rgb *= mix(vec3(1.0), vec3(0.57, 0.74, 0.35), step(t.a, 0.75));
          gl_FragColor = vec4(t.rgb * shade * handLight(), 1.0);
        }`,
    }));

    // Held item: flat sprite.
    this.spriteCanvas.width = this.spriteCanvas.height = 64;
    this.spriteTexture = new THREE.CanvasTexture(this.spriteCanvas);
    this.spriteTexture.magFilter = THREE.NearestFilter;
    this.spriteTexture.minFilter = THREE.NearestFilter;
    this.spriteTexture.colorSpace = THREE.NoColorSpace;
    this.sprite = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      uniforms: { ...shared, uMap: { value: this.spriteTexture }, uGlint: this.glint },
      side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `${lightGlsl}
        uniform sampler2D uMap;
        uniform vec2 uGlint;
        varying vec2 vUv;
        void main() {
          vec4 t = texture2D(uMap, vUv);
          if (t.a < 0.5) discard;
          vec3 c = t.rgb * handLight();
          if (uGlint.x > 0.5) {
            // Enchantment glint: two purple bands sliding diagonally over the item (cheap, no extra pass).
            float a = fract((vUv.x + vUv.y * 0.6) * 1.2 - uGlint.y * 0.45);
            float b = fract((vUv.x * 0.7 - vUv.y) * 0.9 + uGlint.y * 0.3);
            float band = smoothstep(0.0, 0.18, a) * (1.0 - smoothstep(0.18, 0.36, a)) + 0.6 * smoothstep(0.0, 0.12, b) * (1.0 - smoothstep(0.12, 0.24, b));
            c += vec3(0.5, 0.25, 0.95) * (0.18 + band * 0.55);
          }
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
    this.root.add(this.arm, this.block, this.sprite);
  }

  /** Start a swing (click, break tick, place). */
  swingHand(): void {
    if (this.swing >= 0.5) this.swing = 0;
  }

  setEating(eating: boolean): void {
    this.eating = eating ? this.eating : 0;
  }

  private setHeld(id: number): void {
    if (id === this.heldId && this.icons.version === this.iconVersion) return;
    if (id !== this.heldId) this.equip = 0;
    this.heldId = id;
    this.iconVersion = this.icons.version;
    const def = id > 0 && id < 256 ? getBlockDef(id) : undefined;
    // Dyed blocks (and variants) are drawn as their tinted icon: the hand cube has no per-block tint.
    const cube = def && def.shape === 'cube' && !def.dye;
    this.arm.visible = id === 0;
    this.block.visible = !!cube;
    this.sprite.visible = id > 0 && !cube;
    if (cube) {
      // BoxGeometry face order: +X, −X, +Y, −Y, +Z, −Z — same as the registry.
      for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) this.layers.setX(f * 4 + v, FACE_LAYER[id * 6 + f]);
      this.layers.needsUpdate = true;
    } else if (id > 0) {
      const ctx = this.spriteCanvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, 64, 64);
      ctx.drawImage(this.icons.canvas(id), 0, 0, 64, 64);
      this.spriteTexture.needsUpdate = true;
    }
  }

  /**
   * @param held      item id in the selected slot (0 = empty hand)
   * @param bobPhase  walk phase from the camera (radians), bobAmount 0..1.3
   * @param light     packed light at the player (sky << 4 | block)
   */
  update(dt: number, held: number, bobPhase: number, bobAmount: number, light: number, eating: boolean, aspect: number, glint = false, time = 0): void {
    this.setHeld(held);
    this.glint.value.set(glint ? 1 : 0, time);
    this.swing = Math.min(1, this.swing + dt / SWING_TIME);
    this.equip = Math.min(1, this.equip + dt * 5);
    this.eating = eating ? this.eating + dt : 0;
    this.light.value.set((light >> 4) / 15, (light & 15) / 15);
    if (Math.abs(this.camera.aspect - aspect) > 1e-3) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }

    const p = this.swing;
    const sp = Math.sin(Math.sqrt(p) * Math.PI);
    const bx = Math.cos(bobPhase) * 0.025 * bobAmount;
    const by = -Math.abs(Math.sin(bobPhase)) * 0.035 * bobAmount;
    const equipDrop = (1 - this.equip) * -0.6;
    const eat = this.eating > 0 ? Math.abs(Math.sin(this.eating * 18)) * 0.06 : 0;

    const r = this.root;
    r.position.set(0.56 + bx - 0.35 * sp, -0.52 + by + equipDrop + 0.2 * Math.sin(Math.sqrt(p) * Math.PI * 2) + eat, -0.72 - 0.2 * Math.sin(p * Math.PI));
    if (this.eating > 0) r.position.x -= 0.25;
    r.rotation.set(-sp * 0.6, sp * 0.4, Math.sin(p * p * Math.PI) * -0.35, 'YXZ');

    // Per-object resting poses.
    this.arm.position.set(0.12, 0.1, 0.05);
    this.arm.rotation.set(Math.PI * 0.42, -0.12, 0.35);
    this.block.position.set(0, 0, 0);
    this.block.scale.setScalar(0.4);
    this.block.rotation.set(0, Math.PI / 4, 0);
    this.sprite.position.set(0, 0.06, 0);
    this.sprite.scale.setScalar(0.62);
    this.sprite.rotation.set(0, -Math.PI / 4.5, 0.18);
  }

  render(renderer: THREE.WebGLRenderer): void {
    if (!this.visible) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }
}
