// AssemblyScript noise kernels for the BunkCraft WASM experiment (throw-away; not part of the game build).
// Improved-Perlin-style 3D gradient noise with a stateless integer hash (no table gathers), scalar and SIMD (4 x-lanes).

@inline function fade(t: f32): f32 { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
@inline function lerpf(a: f32, b: f32, t: f32): f32 { return a + t * (b - a); }

@inline function hashi(x: i32, y: i32, z: i32): i32 {
  let h: i32 = x * 374761393 ^ y * 1103515245 ^ z * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) & 15;
}

@inline function grad(h: i32, x: f32, y: f32, z: f32): f32 {
  const u: f32 = h < 8 ? x : y;
  const v: f32 = h < 4 ? y : (h == 12 || h == 14 ? x : z);
  return ((h & 1) == 0 ? u : -u) + ((h & 2) == 0 ? v : -v);
}

export function perlin(x: f32, y: f32, z: f32): f32 {
  const xf = Mathf.floor(x), yf = Mathf.floor(y), zf = Mathf.floor(z);
  const xi = <i32>xf, yi = <i32>yf, zi = <i32>zf;
  const fx = x - xf, fy = y - yf, fz = z - zf;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const a = lerpf(
    lerpf(grad(hashi(xi, yi, zi), fx, fy, fz), grad(hashi(xi + 1, yi, zi), fx - 1, fy, fz), u),
    lerpf(grad(hashi(xi, yi + 1, zi), fx, fy - 1, fz), grad(hashi(xi + 1, yi + 1, zi), fx - 1, fy - 1, fz), u), v);
  const b = lerpf(
    lerpf(grad(hashi(xi, yi, zi + 1), fx, fy, fz - 1), grad(hashi(xi + 1, yi, zi + 1), fx - 1, fy, fz - 1), u),
    lerpf(grad(hashi(xi, yi + 1, zi + 1), fx, fy - 1, fz - 1), grad(hashi(xi + 1, yi + 1, zi + 1), fx - 1, fy - 1, fz - 1), u), v);
  return lerpf(a, b, w);
}

/** Fills out[x + z*16 + y*256] (BunkCraft chunk layout, 16x128x16) with noise at (ox+x)*s, y*s, (oz+z)*s. */
export function fillScalar(out: usize, ox: f32, oz: f32, s: f32): void {
  let p = out;
  for (let y = 0; y < 128; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    store<f32>(p, perlin((ox + <f32>x) * s, <f32>y * s, (oz + <f32>z) * s));
    p += 4;
  }
}

// ---- SIMD: 4 x-lanes at once ----
@inline function vfade(t: v128): v128 {
  const t6 = f32x4.sub(f32x4.mul(t, f32x4.splat(6.0)), f32x4.splat(15.0));
  const t10 = f32x4.add(f32x4.mul(t, t6), f32x4.splat(10.0));
  return f32x4.mul(f32x4.mul(f32x4.mul(t, t), t), t10);
}
@inline function vlerp(a: v128, b: v128, t: v128): v128 { return f32x4.add(a, f32x4.mul(t, f32x4.sub(b, a))); }
@inline function vhash(x: v128, y: v128, z: v128): v128 {
  let h = v128.xor(v128.xor(i32x4.mul(x, i32x4.splat(374761393)), i32x4.mul(y, i32x4.splat(1103515245))), i32x4.mul(z, i32x4.splat(668265263)));
  h = i32x4.mul(v128.xor(h, i32x4.shr_u(h, 13)), i32x4.splat(1274126177));
  return v128.and(v128.xor(h, i32x4.shr_u(h, 16)), i32x4.splat(15));
}
@inline function vgrad(h: v128, x: v128, y: v128, z: v128): v128 {
  const m8 = i32x4.lt_s(h, i32x4.splat(8));
  const m4 = i32x4.lt_s(h, i32x4.splat(4));
  const m1214 = v128.or(i32x4.eq(h, i32x4.splat(12)), i32x4.eq(h, i32x4.splat(14)));
  const u = v128.bitselect(x, y, m8);
  const v = v128.bitselect(y, v128.bitselect(x, z, m1214), m4);
  const sgn = i32x4.splat(<i32>0x80000000);
  const su = v128.and(i32x4.shl(h, 31), sgn);
  const sv = v128.and(i32x4.shl(h, 30), sgn);
  return f32x4.add(v128.xor(u, su), v128.xor(v, sv));
}

export function fillSimd(out: usize, ox: f32, oz: f32, s: f32): void {
  const one = i32x4.splat(1);
  const fone = f32x4.splat(1.0);
  const lane = f32x4(0, 1, 2, 3);
  let p = out;
  const vs = f32x4.splat(s);
  for (let y = 0; y < 128; y++) {
    const yv = f32x4.splat(<f32>y * s);
    const yf = f32x4.floor(yv);
    const yi = i32x4.trunc_sat_f32x4_s(yf);
    const fy = f32x4.sub(yv, yf);
    const v = vfade(fy);
    const yi1 = i32x4.add(yi, one);
    const fy1 = f32x4.sub(fy, fone);
    for (let z = 0; z < 16; z++) {
      const zv = f32x4.splat((oz + <f32>z) * s);
      const zf = f32x4.floor(zv);
      const zi = i32x4.trunc_sat_f32x4_s(zf);
      const fz = f32x4.sub(zv, zf);
      const w = vfade(fz);
      const zi1 = i32x4.add(zi, one);
      const fz1 = f32x4.sub(fz, fone);
      for (let x = 0; x < 16; x += 4) {
        const xv = f32x4.mul(f32x4.add(f32x4.splat(ox + <f32>x), lane), vs);
        const xf = f32x4.floor(xv);
        const xi = i32x4.trunc_sat_f32x4_s(xf);
        const fx = f32x4.sub(xv, xf);
        const u = vfade(fx);
        const xi1 = i32x4.add(xi, one);
        const fx1 = f32x4.sub(fx, fone);
        const a = vlerp(
          vlerp(vgrad(vhash(xi, yi, zi), fx, fy, fz), vgrad(vhash(xi1, yi, zi), fx1, fy, fz), u),
          vlerp(vgrad(vhash(xi, yi1, zi), fx, fy1, fz), vgrad(vhash(xi1, yi1, zi), fx1, fy1, fz), u), v);
        const b = vlerp(
          vlerp(vgrad(vhash(xi, yi, zi1), fx, fy, fz1), vgrad(vhash(xi1, yi, zi1), fx1, fy, fz1), u),
          vlerp(vgrad(vhash(xi, yi1, zi1), fx, fy1, fz1), vgrad(vhash(xi1, yi1, zi1), fx1, fy1, fz1), u), v);
        v128.store(p, vlerp(a, b, w));
        p += 16;
      }
    }
  }
}
