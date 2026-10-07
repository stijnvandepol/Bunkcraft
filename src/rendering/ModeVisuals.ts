import * as THREE from 'three';
import { TEAM_COLORS, type Team } from '../modes/GameTypes';
import { zoneColor } from '../modes/ModeView';
import type { ModeState } from '../net/protocol';

const MAX_ZONES = 6;
/** Kill confirmed: the server keeps at most 40 tags on the ground (server/modes/confirm.ts MAX_TAGS). */
const MAX_TAGS = 40;
const SITE_COLOR = 0xffaa00;

/** Search and destroy: the planted bomb, a dark crate with a red light on top. */
function bombModel(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 0.45), new THREE.MeshBasicMaterial({ color: 0x2a2a2a }));
  body.position.y = 0.18;
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.25), new THREE.MeshBasicMaterial({ color: 0x4f6a3a }));
  panel.position.y = 0.37;
  const light = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
  light.position.set(0.22, 0.42, 0);
  light.name = 'light';
  g.add(body, panel, light);
  return g;
}

/** A team flag as a box model: base plate, pole, a banner with a white stripe and a small finial. */
function flagModel(team: Team): THREE.Group {
  const g = new THREE.Group();
  const cloth = new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAM_COLORS[team]) });
  const dark = new THREE.MeshBasicMaterial({ color: 0x3a2a1a });
  const stone = new THREE.MeshBasicMaterial({ color: 0x8a8a8a });
  const white = new THREE.MeshBasicMaterial({ color: 0xf0f0f0 });
  const box = (w: number, hgt: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), m);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };
  box(0.9, 0.12, 0.9, stone, 0, 0.06, 0);
  box(0.1, 2.6, 0.1, dark, 0, 1.3, 0);
  box(0.18, 0.18, 0.18, white, 0, 2.66, 0);
  // The banner hangs from the pole on its own pivot so it can wave.
  const banner = new THREE.Group();
  banner.position.set(0.05, 2.2, 0);
  const cl = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.75, 0.05), cloth);
  cl.position.set(0.55, -0.35, 0);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 0.06), white);
  stripe.position.set(0.55, -0.35, 0);
  banner.add(cl, stripe);
  banner.name = 'banner';
  g.add(banner);
  return g;
}

/**
 * World objects of the objective modes: the two flags (capture the flag), a glowing ring on the
 * ground per capture zone (coloured by its owner) or bomb site, the planted bomb and the dog tags of kill confirmed. Positions come from the server's mode state;
 * a carried flag rides on its carrier's back between updates. One group, added to the scene by the game.
 */
export class ModeVisuals {
  readonly group = new THREE.Group();
  private readonly flags = new Map<Team, THREE.Group>();
  private readonly rings: THREE.Mesh[] = [];
  private state: ModeState | null = null;
  private readonly tmp = new THREE.Vector3();
  /** Kill confirmed tags: one instanced plate each, spinning above the floor. */
  private readonly tags: THREE.InstancedMesh;
  private readonly tagObj = new THREE.Object3D();
  private readonly tagColor = new THREE.Color();
  private readonly bomb = bombModel();
  private readonly bombLight = this.bomb.getObjectByName('light')!;
  private selfId = 0;

  constructor() {
    for (const team of ['red', 'blue'] as const) {
      const f = flagModel(team);
      f.visible = false;
      this.flags.set(team, f);
      this.group.add(f);
    }
    const geo = new THREE.RingGeometry(0.92, 1, 48);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX_ZONES; i++) {
      const ring = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }));
      ring.visible = false;
      ring.renderOrder = 2;
      this.rings.push(ring);
      this.group.add(ring);
    }
    this.tags = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 0.65, 0.06), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_TAGS);
    this.tags.count = 0;
    this.tags.frustumCulled = false;
    this.group.add(this.tags);
    this.bomb.visible = false;
    this.group.add(this.bomb);
  }

  setState(state: ModeState | null, selfId = this.selfId): void {
    this.state = state;
    this.selfId = selfId;
    for (const r of this.rings) r.visible = false;
    for (const f of this.flags.values()) f.visible = false;
    this.tags.count = 0;
    this.bomb.visible = false;
    if (!state) return;
    if (state.kind === 'tags') {
      const n = Math.min(MAX_TAGS, state.tags.length);
      for (let i = 0; i < n; i++) this.tags.setColorAt(i, this.tagColor.set(TEAM_COLORS[state.tags[i].team]));
      if (this.tags.instanceColor) this.tags.instanceColor.needsUpdate = true;
      this.tags.count = n;
    } else if (state.kind === 'bomb') {
      const planted = state.sites.find((x) => x.planted);
      state.sites.forEach((x, i) => {
        const ring = this.rings[i];
        if (!ring || (planted && !x.planted)) return;
        ring.visible = true;
        ring.position.set(x.x, x.y + 0.04, x.z);
        ring.scale.setScalar(x.r);
        (ring.material as THREE.MeshBasicMaterial).color.set(x.planted ? TEAM_COLORS.red : SITE_COLOR);
      });
      if (planted) {
        this.bomb.visible = true;
        this.bomb.position.set(planted.x, planted.y, planted.z);
      }
    } else if (state.kind === 'zones') {
      state.zones.forEach((z, i) => {
        const ring = this.rings[i];
        if (!ring) return;
        const show = state.variant === 'domination' || z.active;
        ring.visible = show;
        ring.position.set(z.x, z.y + 0.04, z.z);
        ring.scale.setScalar(z.r);
        (ring.material as THREE.MeshBasicMaterial).color.set(zoneColor(z, selfId));
      });
    } else if (state.kind === 'ctf') {
      for (const f of state.flags) {
        const g = this.flags.get(f.team)!;
        g.visible = true;
        g.position.set(f.x, f.y, f.z);
        g.scale.setScalar(f.status === 'carried' ? 0.6 : 1);
        g.rotation.z = f.status === 'dropped' ? 0.5 : 0;
      }
    }
  }

  /** Per frame: carried flags follow their carriers, banners wave. Allocation-free. */
  update(now: number, carrierPos: (id: number, out: THREE.Vector3) => boolean): void {
    const st = this.state;
    if (st?.kind === 'tags') {
      // Tags hover and turn so they catch the eye from any side.
      const o = this.tagObj;
      for (let i = 0; i < this.tags.count; i++) {
        const tag = st.tags[i];
        o.position.set(tag.x, tag.y + 0.8 + Math.sin(now * 3 + i) * 0.1, tag.z);
        o.rotation.set(0, now * 2.4 + i, 0);
        o.updateMatrix();
        this.tags.setMatrixAt(i, o.matrix);
      }
      this.tags.instanceMatrix.needsUpdate = true;
      return;
    }
    if (st?.kind === 'bomb') {
      // The bomb's light blinks faster as the fuse runs down.
      if (this.bomb.visible) {
        const rate = st.fuseIn > 10 ? 1 : st.fuseIn > 5 ? 2 : 4;
        this.bombLight.visible = Math.floor(now * rate * 2) % 2 === 0;
      }
      return;
    }
    if (!st || st.kind !== 'ctf') return;
    for (const f of st.flags) {
      const g = this.flags.get(f.team)!;
      if (f.status === 'carried' && carrierPos(f.carrier, this.tmp)) g.position.set(this.tmp.x - 0.25, this.tmp.y + 0.9, this.tmp.z);
      const banner = g.children[g.children.length - 1];
      banner.rotation.y = Math.sin(now * 2.3 + (f.team === 'red' ? 0 : 1.7)) * 0.35;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
