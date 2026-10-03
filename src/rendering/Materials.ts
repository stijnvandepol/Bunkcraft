import * as THREE from 'three';

/**
 * Shared uniforms: one object referenced by every world material, so the day cycle,
 * fog and shadow state are updated once per frame instead of per material.
 */
export function createWorldUniforms(atlas: THREE.DataArrayTexture) {
  return {
    uAtlas: { value: atlas },
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.3, 1, 0.2).normalize() },
    uDaylight: { value: 1 },
    uSkyLightColor: { value: new THREE.Color(1, 1, 1) },
    uFogColor: { value: new THREE.Color(0.7, 0.8, 1) },
    uSunsetColor: { value: new THREE.Color(1, 0.6, 0.3) },
    uSunsetAmount: { value: 0 },
    uFogNear: { value: 60 },
    uFogFar: { value: 100 },
    uUnderwater: { value: 0 },
    uSway: { value: 1 },
    uShadowMap: { value: null as THREE.Texture | null },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uShadowStrength: { value: 0 },
    uShadowTexel: { value: 1 / 2048 },
    uWaterFancy: { value: 1 },
    /** 0 = Moody … 1 = Bright (Minecraft brightness slider). */
    uBrightness: { value: 0.5 },
  };
}

export type WorldUniforms = ReturnType<typeof createWorldUniforms>;

const COMMON_VERTEX = /* glsl */ `
  attribute vec4 packed;
  attribute vec4 data;
  uniform float uTime;
  uniform float uSway;

  const vec3 NORMALS[7] = vec3[7](
    vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0),
    vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0), vec3(0.0, 1.0, 0.0));

  vec2 chunkUv() {
    return vec2(mod(packed.w, 241.0), floor(packed.w / 241.0)) / 16.0;
  }

  vec4 worldPosition(out int normalIndex, out float ao, out float flags) {
    vec3 p = packed.xyz / 16.0;
    float b = data.y;
    normalIndex = int(mod(b, 8.0));
    ao = mod(floor(b / 8.0), 4.0);
    flags = floor(b / 32.0);
    vec4 world = modelMatrix * vec4(p, 1.0);
    if (uSway > 0.5 && mod(flags, 2.0) >= 1.0) {
      float ph = uTime * 1.7 + world.x * 0.6 + world.z * 0.45 + world.y * 0.3;
      world.x += sin(ph) * 0.045;
      world.z += cos(ph * 0.83) * 0.035;
    }
    return world;
  }
`;

/** Atlas sampler declaration (shaders with their own texture skip this one). */
export const ATLAS_GLSL = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray uAtlas;
`;

/** Light curve shared by every world-lit shader: chunks, water, entities, particles and the hand. */
export const LIGHT_GLSL = /* glsl */ `
  uniform float uDaylight;
  uniform vec3 uSkyLightColor;
  uniform float uBrightness;

  // Minecraft-like light curve: dim levels fall off quickly but never reach pitch black.
  float lightCurve(float l) {
    float c = l / (4.0 - 3.0 * l);
    return mix(c, l, 0.12 + 0.42 * uBrightness);
  }

  vec3 combineLight(float sky, float blk, float skyFactor) {
    vec3 skyCol = uSkyLightColor * lightCurve(sky) * uDaylight * skyFactor;
    vec3 blkCol = vec3(1.0, 0.86, 0.66) * lightCurve(blk) * 1.05;
    return max(max(skyCol, blkCol), vec3(0.02 + 0.045 * uBrightness));
  }
`;

/** Distance fog with sunset glow, and the denser blue fog under water. Needs `cameraPosition` (three.js builtin). */
export const FOG_GLSL = /* glsl */ `
  uniform vec3 uFogColor;
  uniform vec3 uSunsetColor;
  uniform float uSunsetAmount;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uUnderwater;
  uniform vec3 uSunDir;

  vec3 applyFog(vec3 color, vec3 worldPos) {
    vec3 toFrag = worldPos - cameraPosition;
    if (uUnderwater > 0.5) {
      float f = smoothstep(0.0, 26.0, length(toFrag));
      return mix(color, vec3(0.06, 0.2, 0.42) * max(uDaylight, 0.25), f);
    }
    float dist = length(toFrag.xz);
    float f = smoothstep(uFogNear, uFogFar, dist);
    vec3 dir = normalize(toFrag);
    vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + 1e-5);
    float glow = pow(max(dot(normalize(vec3(dir.x, 0.0, dir.z) + 1e-5), sunH), 0.0), 6.0) * uSunsetAmount;
    vec3 fogCol = mix(uFogColor, uSunsetColor, glow);
    return mix(color, fogCol, f);
  }
`;

/** Atlas + light + fog: the full set for block-textured shaders (chunks, water, block entities). */
export const COMMON_FRAGMENT = ATLAS_GLSL + LIGHT_GLSL + FOG_GLSL;

/** cutout = alpha-tested (leaves, glass, plants); solid blocks skip discard to keep early-Z. */
export function createChunkMaterial(u: WorldUniforms, cutout: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u,
    defines: cutout ? { CUTOUT: 1 } : {},
    vertexShader: /* glsl */ `
      ${COMMON_VERTEX}
      uniform mat4 uShadowMatrix;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      flat varying float vLayer;
      varying vec2 vLight;
      varying float vAO;
      varying float vShade;
      varying vec3 vWorldPos;
      varying vec3 vShadowCoord;
      varying float vNdotL;
      varying vec3 vTint;
      varying float vLava;
      attribute vec4 tint;

      // Minecraft face shading (E/W 0.6, N/S 0.8, top 1.0, bottom 0.5), slightly lifted
      // because the shadow map adds its own directional darkening.
      const float SHADE[7] = float[7](0.64, 0.64, 1.0, 0.52, 0.82, 0.82, 0.9);
      const float AO_CURVE[4] = float[4](0.42, 0.62, 0.81, 1.0);

      void main() {
        int ni; float ao; float flags;
        vec4 world = worldPosition(ni, ao, flags);
        vec3 n = NORMALS[ni];
        vNdotL = ni == 6 ? max(uSunDir.y, 0.0) : dot(n, uSunDir);
        // Normal offset in light space removes shadow acne on surfaces facing the sun.
        vShadowCoord = (uShadowMatrix * vec4(world.xyz + n * 0.08, 1.0)).xyz;
        vUv = chunkUv();
        vLayer = data.x;
        vLight = data.zw / 255.0;
        vAO = AO_CURVE[int(ao)];
        vShade = SHADE[ni];
        vWorldPos = world.xyz;
        vTint = tint.rgb;
        vLava = flags >= 4.0 ? 1.0 : 0.0;
        if (vLava > 0.5) vUv += vec2(uTime * 0.03, uTime * 0.05);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON_FRAGMENT}
      uniform sampler2D uShadowMap;
      varying vec3 vTint;
      varying float vLava;
      uniform float uShadowStrength;
      uniform float uShadowTexel;
      varying vec2 vUv;
      flat varying float vLayer;
      varying vec2 vLight;
      varying float vAO;
      varying float vShade;
      varying vec3 vWorldPos;
      varying vec3 vShadowCoord;
      varying float vNdotL;

      float sampleShadow() {
        vec3 c = vShadowCoord;
        if (c.x <= 0.0 || c.x >= 1.0 || c.y <= 0.0 || c.y >= 1.0 || c.z >= 1.0) return 1.0;
        float bias = 0.0007;
        float s = 0.0;
        // 4-tap PCF for soft-ish but still blocky shadow edges.
        s += step(c.z - bias, texture2D(uShadowMap, c.xy + vec2(-0.5, -0.5) * uShadowTexel).r);
        s += step(c.z - bias, texture2D(uShadowMap, c.xy + vec2(0.5, -0.5) * uShadowTexel).r);
        s += step(c.z - bias, texture2D(uShadowMap, c.xy + vec2(-0.5, 0.5) * uShadowTexel).r);
        s += step(c.z - bias, texture2D(uShadowMap, c.xy + vec2(0.5, 0.5) * uShadowTexel).r);
        return s * 0.25;
      }

      void main() {
        vec4 tex = texture(uAtlas, vec3(vUv, vLayer));
        #ifdef CUTOUT
        if (tex.a < 0.5) discard;
        tex.rgb *= vTint;
        #else
        // Opaque textures do not need alpha, so it marks the biome-tinted pixels
        // (alpha 0.5 = tinted, 1.0 = untinted, e.g. the dirt part of a grass block side).
        tex.rgb *= mix(vec3(1.0), vTint, clamp((1.0 - tex.a) * 2.0, 0.0, 1.0));
        #endif

        float skyFactor = vShade;
        if (uShadowStrength > 0.0) {
          float direct = vNdotL > 0.0 ? sampleShadow() * smoothstep(0.0, 0.35, vNdotL) : 0.0;
          skyFactor *= mix(1.0, 0.72 + 0.36 * direct, uShadowStrength);
        }
        vec3 light = combineLight(vLight.x, vLight.y, skyFactor);
        if (vLava > 0.5) light = vec3(1.0); // lava is self-lit
        vec3 color = tex.rgb * light * vAO;
        gl_FragColor = vec4(applyFog(color, vWorldPos), 1.0);
      }
    `,
  });
}

export function createWaterMaterial(u: WorldUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      ${COMMON_VERTEX}
      varying vec2 vUv;
      flat varying float vLayer;
      varying vec2 vLight;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vTop;
      varying vec3 vWaterTint;
      attribute vec4 tint;

      void main() {
        int ni; float ao; float flags;
        vec4 world = worldPosition(ni, ao, flags);
        vTop = mod(floor(flags / 2.0), 2.0);
        vWaterTint = tint.rgb;
        if (vTop > 0.5) {
          world.y += (sin(world.x * 0.9 + uTime * 1.6) * cos(world.z * 0.7 + uTime * 1.2)) * 0.035 - 0.02;
        }
        vUv = chunkUv();
        vLayer = data.x;
        vLight = data.zw / 255.0;
        vNormal = NORMALS[ni];
        vWorldPos = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON_FRAGMENT}
      uniform float uTime;
      uniform float uWaterFancy;
      varying vec2 vUv;
      flat varying float vLayer;
      varying vec2 vLight;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vTop;
      varying vec3 vWaterTint;

      void main() {
        vec2 uvA = (vTop > 0.5 ? vWorldPos.xz : vUv) + vec2(uTime * 0.045, uTime * 0.03);
        vec2 uvB = (vTop > 0.5 ? vWorldPos.zx * 0.83 : vUv * 0.9) - vec2(uTime * 0.03, uTime * 0.05);
        vec3 tex = mix(texture(uAtlas, vec3(uvA, vLayer)).rgb, texture(uAtlas, vec3(uvB, vLayer)).rgb, 0.5);

        // Biome water colour relative to the colour the texture is made for (#3F76E4): 1.0 in most biomes.
        tex = clamp(tex * vWaterTint / vec3(0.247, 0.463, 0.894), 0.0, 1.0);

        vec3 n = vNormal;
        if (vTop > 0.5) {
          // Analytic ripple normal (derivative of the vertex wave plus a finer detail wave).
          float t = uTime;
          float dx = cos(vWorldPos.x * 0.9 + t * 1.6) * 0.9 * cos(vWorldPos.z * 0.7 + t * 1.2) * 0.035
                   + cos(vWorldPos.x * 2.3 + vWorldPos.z * 1.1 + t * 2.4) * 0.03;
          float dz = -sin(vWorldPos.x * 0.9 + t * 1.6) * sin(vWorldPos.z * 0.7 + t * 1.2) * 0.7 * 0.035
                   + cos(vWorldPos.z * 2.1 - vWorldPos.x * 0.7 + t * 2.0) * 0.03;
          n = normalize(vec3(-dx * 4.0, 1.0, -dz * 4.0));
        }
        vec3 toCam = cameraPosition - vWorldPos;
        vec3 v = normalize(toCam);
        if (dot(v, n) < 0.0) n = -n;
        float fresnel = pow(1.0 - max(dot(n, v), 0.0), 3.0);

        vec3 light = combineLight(vLight.x, vLight.y, 1.0);
        vec3 color = tex * light;
        float alpha = 0.68;
        if (uWaterFancy > 0.5) {
          vec3 reflection = mix(uFogColor, uSkyLightColor * vec3(0.55, 0.7, 1.0), 0.4) * max(uDaylight, 0.15);
          color = mix(color, reflection, fresnel * 0.55 * vLight.x);
          vec3 h = normalize(uSunDir + v);
          float spec = pow(max(dot(n, h), 0.0), 90.0) * smoothstep(0.0, 0.2, uSunDir.y) * vLight.x;
          color += vec3(1.0, 0.94, 0.8) * spec * 0.9;
          alpha = mix(0.66, 0.93, fresnel) + spec * 0.3;
        }
        if (uUnderwater > 0.5) alpha = 0.55;
        gl_FragColor = vec4(applyFog(color, vWorldPos), clamp(alpha, 0.0, 1.0));
      }
    `,
  });
}

/** Depth-only material for the sun shadow pass; alpha-tests leaves/plants. */
export function createShadowDepthMaterial(u: WorldUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: /* glsl */ `
      ${COMMON_VERTEX}
      varying vec2 vUv;
      flat varying float vLayer;
      void main() {
        int ni; float ao; float flags;
        vec4 world = worldPosition(ni, ao, flags);
        vUv = chunkUv();
        vLayer = data.x;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp sampler2DArray;
      uniform sampler2DArray uAtlas;
      varying vec2 vUv;
      flat varying float vLayer;
      void main() {
        if (texture(uAtlas, vec3(vUv, vLayer)).a < 0.5) discard;
        gl_FragColor = vec4(1.0);
      }
    `,
  });
}
