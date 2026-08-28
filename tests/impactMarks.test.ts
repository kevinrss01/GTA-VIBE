/**
 * The mark a shot leaves, and where it leaves it.
 *
 * The defect these pin is the one a player reports as "shooting a wall does
 * nothing": every material in the city left the same soft round smudge out of
 * the same radial falloff texture the muzzle flash uses, so a bullet hole, a
 * chip in ashlar, a star in glazing and a blast scorch were one picture in
 * four colours - and a detonation's scorch was pinned 0.55 m BELOW the
 * detonation with a hard-coded upward normal, which for a rocket into a wall
 * is a horizontal disc hanging in the air in front of it.
 *
 * Everything here reads the instance buffers the marks mesh actually writes.
 * A counter going up proves a pool was spent; only the matrix proves a decal
 * is on the surface, in its plane, facing out of it and clear of it.
 *
 * No renderer: `CombatFx` builds its meshes and textures on the CPU and
 * `update` writes the buffers, so the geometry of a decal is assertable
 * without a GL context. What is NOT assertable here is that the injected GLSL
 * compiles - see the shader test, which checks the surgery landed on the real
 * chunk names rather than that the driver accepted the result.
 */

import { InstancedMesh, ShaderLib, type DataTexture, type MeshBasicMaterial, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import {
  CombatFx,
  decalFor,
  FX_CAPACITY,
  impactSound,
  markLift,
  markSizeFor,
  surfaceImpact,
  type DecalKind,
  type ImpactKind,
} from '../src/combat/CombatFx';
import { ALL_MATERIAL_KEYS } from '../src/render/materials';

const CAMERA: readonly [number, number, number] = [0, 1.6, -8];

function meshNamed(fx: CombatFx, name: string): InstancedMesh {
  let found: InstancedMesh | null = null;
  fx.group.traverse((child: Object3D) => {
    if (child instanceof InstancedMesh && child.name === name) found = child;
  });
  if (!found) throw new Error(`no instanced mesh named ${name}`);
  return found;
}

const marksOf = (fx: CombatFx): InstancedMesh => meshNamed(fx, 'combat-marks');
const smokeOf = (fx: CombatFx): InstancedMesh => meshNamed(fx, 'combat-smoke');

/** The columns and translation of one instance, as plain vectors. */
interface Frame {
  ax: readonly [number, number, number];
  ay: readonly [number, number, number];
  az: readonly [number, number, number];
  at: readonly [number, number, number];
}

function frameAt(mesh: InstancedMesh, index: number): Frame {
  const m = mesh.instanceMatrix.array as ArrayLike<number>;
  const o = index * 16;
  const read = (k: number): readonly [number, number, number] => [
    m[o + k] ?? 0,
    m[o + k + 1] ?? 0,
    m[o + k + 2] ?? 0,
  ];
  return { ax: read(0), ay: read(4), az: read(8), at: read(12) };
}

const dot = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: readonly [number, number, number]): number => Math.sqrt(dot(a, a));

/** A `rand` that always answers the same thing, so a decal is reproducible. */
const fixed = (value: number) => (): number => value;

function run(fx: CombatFx, seconds: number, step = 1 / 60): void {
  const frames = Math.max(1, Math.round(seconds / step));
  for (let i = 0; i < frames; i += 1) fx.update(step, CAMERA[0], CAMERA[1], CAMERA[2]);
}

describe('a material chooses its own mark', () => {
  it('classifies every material in the render library, with no gaps', () => {
    const tiles = new Set<DecalKind>();
    for (const key of ALL_MATERIAL_KEYS) {
      const impact = surfaceImpact(key);
      const tile = decalFor(impact);
      expect(tile, `${key} produced no decal`).toBeDefined();
      expect(['hole', 'chip', 'star', 'scorch']).toContain(tile);
      // Every visual impact must also have a recorded sound, or a material
      // makes a mark nobody hears.
      expect(impactSound(impact)).toBeDefined();
      expect(markSizeFor(impact)).toBeGreaterThan(0);
      tiles.add(tile);
    }
    // The library is varied enough that a single tile for everything would be
    // the bug this replaces.
    expect(tiles.size).toBeGreaterThanOrEqual(3);
  });

  it('gives glass and steel a star, masonry a chip, and timber a hole', () => {
    expect(decalFor(surfaceImpact('glassShop'))).toBe('star');
    expect(decalFor(surfaceImpact('lampGlass'))).toBe('star');
    expect(decalFor(surfaceImpact('corrugated'))).toBe('star');
    expect(decalFor(surfaceImpact('metalDark'))).toBe('star');
    expect(decalFor(surfaceImpact('stoneAshlar'))).toBe('chip');
    expect(decalFor(surfaceImpact('concrete'))).toBe('chip');
    expect(decalFor(surfaceImpact('brickRed'))).toBe('chip');
    expect(decalFor(surfaceImpact('timber'))).toBe('hole');
    expect(decalFor(surfaceImpact('doorPainted'))).toBe('hole');
    // A round through a canopy is the smallest mark in the table.
    expect(markSizeFor(surfaceImpact('foliage'))).toBeLessThan(
      markSizeFor(surfaceImpact('concrete')),
    );
    // A body marks the floor, not the person, and does it with a soft blot.
    expect(decalFor('body')).toBe('scorch');
  });

  it('never claims a material has no impact at all', () => {
    const kinds: ImpactKind[] = [
      'world', 'stone', 'concrete', 'metal', 'glass', 'timber', 'foliage', 'body',
    ];
    for (const kind of kinds) {
      expect(decalFor(kind)).toBeDefined();
      expect(markSizeFor(kind)).toBeGreaterThan(0);
    }
  });
});

describe('a mark on a surface', () => {
  it('lies in the plane of the surface and faces out of it', () => {
    const fx = new CombatFx();
    // A wall running north-south at x = 4, struck from the west: the outward
    // normal is -X and the decal has to stand up in the y-z plane.
    fx.impact(4, 2.1, -3, -1, 0, 0, 'concrete', fixed(0));
    run(fx, 1 / 60);

    const mesh = marksOf(fx);
    expect(mesh.count).toBe(1);
    const frame = frameAt(mesh, 0);

    // Third column is the surface normal, exactly and unscaled.
    expect(frame.az[0]).toBeCloseTo(-1, 6);
    expect(frame.az[1]).toBeCloseTo(0, 6);
    expect(frame.az[2]).toBeCloseTo(0, 6);
    expect(length(frame.az)).toBeCloseTo(1, 6);

    // The other two span the wall, are perpendicular to it and to each other,
    // and are the same length - a decal must not be sheared or stretched.
    const size = markSizeFor('concrete');
    expect(length(frame.ax)).toBeCloseTo(size * 2, 6);
    expect(length(frame.ay)).toBeCloseTo(size * 2, 6);
    expect(dot(frame.ax, frame.az)).toBeCloseTo(0, 6);
    expect(dot(frame.ay, frame.az)).toBeCloseTo(0, 6);
    expect(dot(frame.ax, frame.ay)).toBeCloseTo(0, 6);
  });

  it('sits over the contact point, proud of the surface and never behind it', () => {
    const fx = new CombatFx();
    const hit: readonly [number, number, number] = [4, 2.1, -3];
    const normal: readonly [number, number, number] = [-1, 0, 0];
    fx.impact(hit[0], hit[1], hit[2], normal[0], normal[1], normal[2], 'stone', fixed(0));
    run(fx, 1 / 60);

    const frame = frameAt(marksOf(fx), 0);
    const offset: readonly [number, number, number] = [
      frame.at[0] - hit[0],
      frame.at[1] - hit[1],
      frame.at[2] - hit[2],
    ];
    const lift = markLift(markSizeFor('stone'));

    // Along the normal by exactly the lift...
    expect(dot(offset, normal)).toBeCloseTo(lift, 6);
    // ...and by nothing at all across it, so the mark is over the hole rather
    // than beside it.
    expect(length(offset)).toBeCloseTo(lift, 6);
    // In FRONT of the plane. A negative offset is a decal inside the wall,
    // which is invisible, and zero is a decal that z-fights with it.
    expect(dot(offset, normal)).toBeGreaterThan(0);
  });

  it('lifts every size it can be asked for, and never lifts absurdly', () => {
    for (const size of [0, 0.01, 0.05, 0.1, 0.5, 1, 5.9, 20]) {
      const lift = markLift(size);
      expect(lift).toBeGreaterThan(0);
      expect(lift).toBeLessThanOrEqual(0.05);
      expect(Number.isFinite(lift)).toBe(true);
    }
    // A blast scorch the size of a car clears more than a bullet hole does.
    expect(markLift(5.9)).toBeGreaterThan(markLift(0.07));
  });

  it('is biased in depth as well as in space, for the grazing case', () => {
    const fx = new CombatFx();
    const material = marksOf(fx).material as MeshBasicMaterial;
    // A lift along the normal projects to almost nothing when the surface is
    // seen edge-on, which is exactly where a decal z-fights. The depth bias is
    // what covers that case, and it must pull TOWARD the camera.
    expect(material.polygonOffset).toBe(true);
    expect(material.polygonOffsetFactor).toBeLessThan(0);
    expect(material.polygonOffsetUnits).toBeLessThan(0);
    // Decals must not write depth, or the one in front hides the one behind.
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
    fx.dispose();
  });

  it('lies flat on the floor for a body, at the victim’s feet', () => {
    const fx = new CombatFx();
    // A head shot 1.7 m up somebody standing on a floor at y = 0.4.
    fx.impact(2, 2.1, 5, 0, 0, -1, 'body', fixed(0.5), 0.4);
    run(fx, 1 / 60);
    const frame = frameAt(marksOf(fx), 0);
    // Up, whatever the shot's own normal was.
    expect(frame.az[1]).toBeCloseTo(1, 6);
    // On the floor, not below the wound: the guess this replaces would have
    // put it at 1.2 m, most of a metre in the air.
    const size = markSizeFor('body') + 0.5 * 0.05;
    expect(frame.at[1]).toBeCloseTo(0.4 + markLift(size), 6);
  });

  it('turns each mark differently, so a wall of holes is not wallpaper', () => {
    const fx = new CombatFx();
    fx.impact(4, 2, 0, -1, 0, 0, 'concrete', fixed(0));
    fx.impact(4, 2, 1, -1, 0, 0, 'concrete', fixed(0.4));
    run(fx, 1 / 60);
    const mesh = marksOf(fx);
    expect(mesh.count).toBe(2);
    const a = frameAt(mesh, 0);
    const b = frameAt(mesh, 1);
    // Same plane...
    expect(dot(a.az, b.az)).toBeCloseTo(1, 6);
    // ...different roll within it.
    const cosine = dot(a.ax, b.ax) / (length(a.ax) * length(b.ax));
    expect(Math.abs(cosine)).toBeLessThan(0.99);
  });
});

describe('the decal pool', () => {
  it('stops at its capacity however many rounds are fired', () => {
    const fx = new CombatFx();
    for (let i = 0; i < 600; i += 1) {
      fx.impact(i * 0.1, 2, 0, -1, 0, 0, 'concrete', fixed(0.3));
      if (i % 40 === 0) run(fx, 1 / 60);
    }
    run(fx, 1 / 60);
    expect(marksOf(fx).count).toBe(FX_CAPACITY.marks);
    expect(marksOf(fx).count).toBeLessThanOrEqual(FX_CAPACITY.marks);
    expect(fx.stats.glows).toBeLessThanOrEqual(FX_CAPACITY.glows);
    expect(fx.markReport()).toHaveLength(FX_CAPACITY.marks);
    fx.dispose();
  });

  it('gives a mark back once it has aged out, and hides the mesh', () => {
    const fx = new CombatFx();
    fx.impact(4, 2, 0, -1, 0, 0, 'metal', fixed(0.2));
    run(fx, 1);
    expect(fx.stats.marks).toBe(1);
    expect(marksOf(fx).visible).toBe(true);

    // Past any bullet mark's life. Blood and blast scorches last longer and
    // are covered below; this is the one a rifle leaves.
    run(fx, 30);
    expect(fx.stats.marks).toBe(0);
    expect(marksOf(fx).visible).toBe(false);
    expect(fx.markReport()).toHaveLength(0);
    fx.dispose();
  });

  it('keeps blood and blast scorches longer than bullet marks', () => {
    const fx = new CombatFx();
    fx.impact(0, 1, 0, 0, 1, 0, 'concrete', fixed(0.2));
    fx.impact(3, 1, 0, 0, 1, 0, 'body', fixed(0.2), 0);
    fx.explosion(9, 1, 0, 9.5, fixed(0.2));
    run(fx, 1 / 60);
    expect(fx.stats.marks).toBe(3);

    // Twenty-two seconds: the bullet mark is gone, the other two are not.
    run(fx, 22);
    expect(fx.stats.marks).toBe(2);
    // Thirty: the blood has gone too and only the scorch is left.
    run(fx, 8);
    expect(fx.stats.marks).toBe(1);
    run(fx, 20);
    expect(fx.stats.marks).toBe(0);
    fx.dispose();
  });

  it('clears everything on demand without tearing the pools down', () => {
    const fx = new CombatFx();
    fx.explosion(0, 1, 0, 9.5, fixed(0.4));
    run(fx, 1 / 60);
    expect(fx.stats.marks).toBeGreaterThan(0);
    expect(fx.stats.smoke).toBeGreaterThan(0);

    fx.clear();
    expect(fx.stats.marks).toBe(0);
    expect(fx.stats.glows).toBe(0);
    expect(fx.stats.smoke).toBe(0);
    expect(marksOf(fx).visible).toBe(false);
    expect(smokeOf(fx).visible).toBe(false);

    // Still usable afterwards - `clear` is a respawn, not a teardown.
    fx.impact(1, 1, 1, 0, 1, 0, 'stone', fixed(0.1));
    run(fx, 1 / 60);
    expect(fx.stats.marks).toBe(1);
    fx.dispose();
  });
});

describe('disposal', () => {
  it('releases every geometry, material and texture it built', () => {
    const fx = new CombatFx();
    const meshes = ['combat-glow', 'combat-marks', 'combat-smoke'].map((name) =>
      meshNamed(fx, name),
    );
    const released: string[] = [];
    const watch = (label: string, target: { addEventListener: (t: 'dispose', fn: () => void) => void }): void => {
      target.addEventListener('dispose', () => released.push(label));
    };
    for (const mesh of meshes) {
      watch(`${mesh.name}-geometry`, mesh.geometry);
      const material = mesh.material as MeshBasicMaterial;
      watch(`${mesh.name}-material`, material);
      const map = material.map as DataTexture | null;
      if (map) watch(`${mesh.name}-map`, map);
    }

    fx.dispose();

    for (const mesh of meshes) {
      expect(released, `${mesh.name} kept its geometry`).toContain(`${mesh.name}-geometry`);
      expect(released, `${mesh.name} kept its material`).toContain(`${mesh.name}-material`);
      expect(released, `${mesh.name} kept its texture`).toContain(`${mesh.name}-map`);
    }
    // Idempotent: a second dispose must not double-release anything.
    const count = released.length;
    fx.dispose();
    expect(released).toHaveLength(count);
  });
});

describe('the decal atlas', () => {
  it('is four distinguishable pictures with no bleed between them', () => {
    const fx = new CombatFx();
    const atlas = (marksOf(fx).material as MeshBasicMaterial).map as DataTexture;
    const image = atlas.image as { data: Uint8Array; width: number; height: number };
    expect(image.width).toBe(128);
    expect(image.height).toBe(128);
    // Mipmaps would average one tile into the next at distance, which is the
    // artefact the transparent margin exists to prevent.
    expect(atlas.generateMipmaps).toBe(false);

    const tilePx = 64;
    const alphaSums: number[] = [];
    for (let ty = 0; ty < 2; ty += 1) {
      for (let tx = 0; tx < 2; tx += 1) {
        let sum = 0;
        for (let y = 0; y < tilePx; y += 1) {
          for (let x = 0; x < tilePx; x += 1) {
            const px = tx * tilePx + x;
            const py = ty * tilePx + y;
            const alpha = image.data[(py * image.width + px) * 4 + 3] ?? 0;
            sum += alpha;
            const edge = Math.min(x, y, tilePx - 1 - x, tilePx - 1 - y);
            if (edge < 2) {
              expect(alpha, `tile ${tx},${ty} bleeds at its ${edge}px border`).toBe(0);
            }
          }
        }
        // Every tile has to actually draw something.
        expect(sum).toBeGreaterThan(0);
        alphaSums.push(sum);
      }
    }
    // Four different marks, not one mark four times.
    expect(new Set(alphaSums).size).toBe(4);
    fx.dispose();
  });

  it('is byte-identical between two constructions', () => {
    const a = new CombatFx();
    const b = new CombatFx();
    const dataA = ((marksOf(a).material as MeshBasicMaterial).map as DataTexture)
      .image as { data: Uint8Array };
    const dataB = ((marksOf(b).material as MeshBasicMaterial).map as DataTexture)
      .image as { data: Uint8Array };
    expect(Array.from(dataA.data)).toEqual(Array.from(dataB.data));
    a.dispose();
    b.dispose();
  });
});

/**
 * The shader surgery.
 *
 * This does NOT prove the result compiles - that needs a driver, and the
 * verification pass in a real browser is what covers it. What it does prove is
 * that the injection landed: every chunk name it replaces still exists in the
 * three.js version this repository builds against, the attribute and varying
 * are declared exactly once each, and nothing that was replaced was deleted.
 * A silent miss - three renaming a chunk - would otherwise leave the marks
 * mesh rendering the whole atlas at full opacity on every instance.
 */
describe('the per-instance decal injection', () => {
  interface FakeShader {
    vertexShader: string;
    fragmentShader: string;
  }

  function inject(material: MeshBasicMaterial): FakeShader {
    const shader: FakeShader = {
      vertexShader: ShaderLib.basic.vertexShader,
      fragmentShader: ShaderLib.basic.fragmentShader,
    };
    const compile = material.onBeforeCompile as unknown as (s: FakeShader) => void;
    compile(shader);
    return shader;
  }

  it('declares its attribute and slides the UV into the instance’s tile', () => {
    const fx = new CombatFx();
    const shader = inject(marksOf(fx).material as MeshBasicMaterial);

    expect(shader.vertexShader).toContain('attribute vec3 iDecal;');
    expect(shader.vertexShader).toContain('varying vec3 vDecal;');
    // The slide must come AFTER the chunk that writes `vMapUv`, or it is
    // overwritten by it.
    const uvAt = shader.vertexShader.indexOf('#include <uv_vertex>');
    const slideAt = shader.vertexShader.indexOf('vMapUv = vMapUv * 0.500000 + iDecal.xy;');
    expect(uvAt).toBeGreaterThanOrEqual(0);
    expect(slideAt).toBeGreaterThan(uvAt);

    expect(shader.fragmentShader).toContain('varying vec3 vDecal;');
    expect(shader.fragmentShader).toContain('diffuseColor.a *= vDecal.z;');
    // Replaced, not removed: the map still has to be sampled.
    expect(shader.fragmentShader).toContain('#include <map_fragment>');
    fx.dispose();
  });

  it('leaves the smoke sheet whole, because it has only one tile', () => {
    const fx = new CombatFx();
    const shader = inject(smokeOf(fx).material as MeshBasicMaterial);
    expect(shader.vertexShader).toContain('vMapUv = vMapUv * 1.000000 + iDecal.xy;');
    expect(shader.fragmentShader).toContain('diffuseColor.a *= vDecal.z;');
    fx.dispose();
  });

  it('gives the two materials different program cache keys', () => {
    const fx = new CombatFx();
    const marks = marksOf(fx).material as MeshBasicMaterial;
    const smoke = smokeOf(fx).material as MeshBasicMaterial;
    const markKey = marks.customProgramCacheKey?.();
    const smokeKey = smoke.customProgramCacheKey?.();
    expect(markKey).toBeTruthy();
    expect(smokeKey).toBeTruthy();
    // Sharing a key would hand the smoke the marks' compiled program, and the
    // atlas slide with it.
    expect(markKey).not.toBe(smokeKey);
    fx.dispose();
  });

  it('carries a tile and an alpha for every live instance', () => {
    const fx = new CombatFx();
    fx.impact(4, 2, 0, -1, 0, 0, 'glass', fixed(0));
    fx.impact(4, 2, 1, -1, 0, 0, 'concrete', fixed(0));
    run(fx, 1 / 60);

    const mesh = marksOf(fx);
    const attribute = mesh.geometry.getAttribute('iDecal');
    expect(attribute).toBeDefined();
    expect(attribute.itemSize).toBe(3);
    const data = attribute.array as Float32Array;
    // Glass takes a star and concrete a chip: different tiles, so different
    // atlas offsets, out of one draw call.
    const glassTile = [data[0], data[1]];
    const concreteTile = [data[3], data[4]];
    expect(glassTile).not.toEqual(concreteTile);
    // Full alpha while young; a mark fades in the alpha rather than shrinking.
    expect(data[2] ?? 0).toBeGreaterThan(0.5);
    expect(data[5] ?? 0).toBeGreaterThan(0.5);

    // ...and the alpha really does fall while the size does not.
    const before = frameAt(mesh, 0);
    run(fx, 17);
    const after = frameAt(mesh, 0);
    const faded = (mesh.geometry.getAttribute('iDecal').array as Float32Array)[2] ?? 1;
    expect(faded).toBeLessThan(0.5);
    expect(length(after.ax)).toBeCloseTo(length(before.ax), 6);
    fx.dispose();
  });
});
