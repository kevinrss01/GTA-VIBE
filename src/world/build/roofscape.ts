/**
 * Roof treatments and the silhouette above them.
 *
 * The top of a building is what a skyline is made of, so nothing here is
 * implied: a parapet is a real ring with an inside face and a coping, a pitched
 * roof has fascias and a ridge cap, a sawtooth has glazing you can see into.
 * The art brief's verification checklist asks for at least four different roof
 * heights in any street view, and that only works if the tops are modelled.
 *
 * Everything is emitted in world space through the shared `MeshWriter`. Roof
 * clutter is placed as instances, so it costs a matrix rather than geometry.
 */

import { Matrix4 } from 'three';

import type { Rect } from '../../core/mathx';
import type { Rng } from '../../core/rng';
import type { MaterialKey } from '../../render/materials';
import { FACE, type MeshWriter } from './facade';
import type { GeometrySink, PropKey } from './types';

/** A flat deck, drawn just inside whatever ring stands on the perimeter. */
export function flatDeck(writer: MeshWriter, rect: Rect, y: number, key: MaterialKey, inset = 0.02): void {
  writer.box(
    key,
    rect.minX + inset,
    y - 0.08,
    rect.minZ + inset,
    rect.maxX - inset,
    y,
    rect.maxZ - inset,
    FACE.PY,
  );
}

/**
 * A parapet ring with a coping on top.
 *
 * Built as four boxes rather than one big box minus a small one, because the
 * inner face is visible from every window and balcony above it and from the
 * street opposite once the building is more than a few storeys tall.
 */
export function parapetRing(
  writer: MeshWriter,
  rect: Rect,
  y: number,
  height: number,
  thickness: number,
  wall: MaterialKey,
  coping: MaterialKey,
  proud = 0.05,
): void {
  const t = Math.max(0.16, Math.min(thickness, Math.min(rect.maxX - rect.minX, rect.maxZ - rect.minZ) * 0.3));
  const top = y + height;
  const faces = FACE.NO_BOTTOM;

  writer.box(wall, rect.minX - proud, y, rect.minZ - proud, rect.maxX + proud, top, rect.minZ + t, faces);
  writer.box(wall, rect.minX - proud, y, rect.maxZ - t, rect.maxX + proud, top, rect.maxZ + proud, faces);
  writer.box(wall, rect.minX - proud, y, rect.minZ + t, rect.minX + t, top, rect.maxZ - t, faces);
  writer.box(wall, rect.maxX - t, y, rect.minZ + t, rect.maxX + proud, top, rect.maxZ - t, faces);

  const lip = proud + 0.06;
  const capTop = top + 0.09;
  writer.box(coping, rect.minX - lip, top, rect.minZ - lip, rect.maxX + lip, capTop, rect.minZ + t + 0.04, faces);
  writer.box(coping, rect.minX - lip, top, rect.maxZ - t - 0.04, rect.maxX + lip, capTop, rect.maxZ + lip, faces);
  writer.box(coping, rect.minX - lip, top, rect.minZ + t + 0.04, rect.minX + t + 0.04, capTop, rect.maxZ - t - 0.04, faces);
  writer.box(coping, rect.maxX - t - 0.04, top, rect.minZ + t + 0.04, rect.maxX + lip, capTop, rect.maxZ - t - 0.04, faces);
}

export interface CorniceBand {
  readonly height: number;
  readonly proud: number;
  readonly key: MaterialKey;
}

/**
 * A stack of projecting bands: a string course, a cornice, a moulded eave.
 * Each band is a single box ring, so a heavy three-part cornice costs 34
 * triangles and does more for the silhouette than anything else on the wall.
 */
export function corniceStack(
  writer: MeshWriter,
  rect: Rect,
  y: number,
  bands: readonly CorniceBand[],
): number {
  let cursor = y;
  bands.forEach((band, index) => {
    writer.box(
      band.key,
      rect.minX - band.proud,
      cursor,
      rect.minZ - band.proud,
      rect.maxX + band.proud,
      cursor + band.height,
      rect.maxZ + band.proud,
      index === 0 ? FACE.ALL : FACE.NO_BOTTOM,
    );
    cursor += band.height;
  });
  return cursor;
}

/** A single projecting band, used for floor lines and eyebrow slabs. */
export function stringCourse(
  writer: MeshWriter,
  rect: Rect,
  y: number,
  height: number,
  proud: number,
  key: MaterialKey,
): void {
  writer.box(key, rect.minX - proud, y, rect.minZ - proud, rect.maxX + proud, y + height, rect.maxZ + proud, FACE.ALL);
}

/**
 * A gabled roof with eaves, fascias and a ridge cap. The gable ends are drawn
 * in the wall material because that is what they are - the wall carrying on up.
 */
export function gableRoof(
  writer: MeshWriter,
  rect: Rect,
  eaveY: number,
  height: number,
  ridgeAxis: 'x' | 'z',
  tile: MaterialKey,
  trim: MaterialKey,
  gableWall: MaterialKey,
  overhang = 0.34,
): void {
  const x0 = rect.minX - overhang;
  const x1 = rect.maxX + overhang;
  const z0 = rect.minZ - overhang;
  const z1 = rect.maxZ + overhang;
  const ridgeY = eaveY + height;

  if (ridgeAxis === 'x') {
    const cz = (rect.minZ + rect.maxZ) * 0.5;
    writer.quadFacing(tile, [x0, eaveY, z0], [x1, eaveY, z0], [x1, ridgeY, cz], [x0, ridgeY, cz], [0, 1, -1]);
    writer.quadFacing(tile, [x0, eaveY, z1], [x1, eaveY, z1], [x1, ridgeY, cz], [x0, ridgeY, cz], [0, 1, 1]);
    writer.triFacing(
      gableWall,
      [rect.minX, eaveY, rect.minZ],
      [rect.minX, eaveY, rect.maxZ],
      [rect.minX, ridgeY, cz],
      [-1, 0, 0],
    );
    writer.triFacing(
      gableWall,
      [rect.maxX, eaveY, rect.minZ],
      [rect.maxX, eaveY, rect.maxZ],
      [rect.maxX, ridgeY, cz],
      [1, 0, 0],
    );
    writer.box(trim, x0, eaveY - 0.19, z0, x1, eaveY, z0 + 0.1, FACE.ALL);
    writer.box(trim, x0, eaveY - 0.19, z1 - 0.1, x1, eaveY, z1, FACE.ALL);
    writer.box(trim, x0, ridgeY - 0.07, cz - 0.11, x1, ridgeY + 0.07, cz + 0.11, FACE.ALL);
  } else {
    const cx = (rect.minX + rect.maxX) * 0.5;
    writer.quadFacing(tile, [x0, eaveY, z0], [x0, eaveY, z1], [cx, ridgeY, z1], [cx, ridgeY, z0], [-1, 1, 0]);
    writer.quadFacing(tile, [x1, eaveY, z0], [x1, eaveY, z1], [cx, ridgeY, z1], [cx, ridgeY, z0], [1, 1, 0]);
    writer.triFacing(
      gableWall,
      [rect.minX, eaveY, rect.minZ],
      [rect.maxX, eaveY, rect.minZ],
      [cx, ridgeY, rect.minZ],
      [0, 0, -1],
    );
    writer.triFacing(
      gableWall,
      [rect.minX, eaveY, rect.maxZ],
      [rect.maxX, eaveY, rect.maxZ],
      [cx, ridgeY, rect.maxZ],
      [0, 0, 1],
    );
    writer.box(trim, x0, eaveY - 0.19, z0, x0 + 0.1, eaveY, z1, FACE.ALL);
    writer.box(trim, x1 - 0.1, eaveY - 0.19, z0, x1, eaveY, z1, FACE.ALL);
    writer.box(trim, cx - 0.11, ridgeY - 0.07, z0, cx + 0.11, ridgeY + 0.07, z1, FACE.ALL);
  }
}

/** How many sawtooth bays a shed of a given depth wants. */
export function sawtoothTeeth(depth: number): number {
  return Math.max(2, Math.min(6, Math.round(depth / 7)));
}

/**
 * A north-light sawtooth: each tooth is a sloping deck and a glazed riser.
 * Six triangles per tooth, and it turns a shed into a working building.
 */
export function sawtoothRoof(
  writer: MeshWriter,
  rect: Rect,
  eaveY: number,
  teeth: number,
  height: number,
  deck: MaterialKey,
  glazing: MaterialKey,
): void {
  const count = Math.max(2, Math.min(teeth, 7));
  const depth = (rect.maxZ - rect.minZ) / count;
  for (let i = 0; i < count; i += 1) {
    const z0 = rect.minZ + depth * i;
    const z1 = z0 + depth;
    const high = eaveY + height;
    writer.quadFacing(
      deck,
      [rect.minX, eaveY, z0],
      [rect.maxX, eaveY, z0],
      [rect.maxX, high, z1],
      [rect.minX, high, z1],
      [0, 1, -1],
    );
    writer.quadFacing(
      glazing,
      [rect.minX, eaveY, z1],
      [rect.maxX, eaveY, z1],
      [rect.maxX, high, z1],
      [rect.minX, high, z1],
      [0, 0, 1],
    );
    writer.triFacing(deck, [rect.minX, eaveY, z0], [rect.minX, eaveY, z1], [rect.minX, high, z1], [-1, 0, 0]);
    writer.triFacing(deck, [rect.maxX, eaveY, z0], [rect.maxX, eaveY, z1], [rect.maxX, high, z1], [1, 0, 0]);
  }
}

/** A glazed lantern down the ridge of a market hall. */
export function roofLantern(
  writer: MeshWriter,
  rect: Rect,
  y: number,
  width: number,
  height: number,
  glazing: MaterialKey,
  frame: MaterialKey,
): void {
  const cx = (rect.minX + rect.maxX) * 0.5;
  const x0 = cx - width * 0.5;
  const x1 = cx + width * 0.5;
  const z0 = rect.minZ + 1.6;
  const z1 = rect.maxZ - 1.6;
  if (z1 - z0 < 2 || width < 1) return;
  writer.box(glazing, x0, y, z0, x1, y + height, z1, FACE.SIDES);
  writer.box(frame, x0 - 0.12, y + height, z0 - 0.12, x1 + 0.12, y + height + 0.16, z1 + 0.12, FACE.NO_BOTTOM);
  writer.box(frame, x0 - 0.05, y - 0.05, z0 - 0.05, x1 + 0.05, y + 0.14, z1 + 0.05, FACE.NO_BOTTOM);
}

/** A louvred plant enclosure, the thing that gives an office block its cap. */
export function plantEnclosure(
  writer: MeshWriter,
  rect: Rect,
  y: number,
  height: number,
  inset: number,
  wall: MaterialKey,
  trim: MaterialKey,
): void {
  const x0 = rect.minX + inset;
  const x1 = rect.maxX - inset;
  const z0 = rect.minZ + inset;
  const z1 = rect.maxZ - inset;
  if (x1 - x0 < 2.5 || z1 - z0 < 2.5) return;
  writer.box(wall, x0, y, z0, x1, y + height, z1, FACE.NO_BOTTOM);
  writer.box(trim, x0 - 0.09, y + height, z0 - 0.09, x1 + 0.09, y + height + 0.12, z1 + 0.09, FACE.NO_BOTTOM);
  // Two louvre bands read as plant intake from the street below.
  for (const t of [0.34, 0.62]) {
    const band = y + height * t;
    writer.box(trim, x0 - 0.04, band, z0 - 0.04, x1 + 0.04, band + 0.14, z1 + 0.04, FACE.SIDES);
  }
}

const CLUTTER: readonly PropKey[] = ['acUnit', 'roofVent', 'acUnit', 'satelliteDish', 'waterTank', 'roofVent'];

/**
 * Scatters plant across a roof.
 *
 * Kept well inside the parapet: clutter perched on the coping is one of the
 * clearest "placed by a script" tells when the player looks down from a tower.
 */
export function roofClutter(
  sink: GeometrySink,
  rng: Rng,
  rect: Rect,
  y: number,
  count: number,
  margin = 1.4,
): void {
  const x0 = rect.minX + margin;
  const x1 = rect.maxX - margin;
  const z0 = rect.minZ + margin;
  const z1 = rect.maxZ - margin;
  if (x1 - x0 < 0.8 || z1 - z0 < 0.8) return;

  const matrix = new Matrix4();
  for (let i = 0; i < count; i += 1) {
    const prop = rng.pick(CLUTTER);
    // Water tanks are heavy: keep them near the middle where a real one sits
    // over the structural core.
    const pull = prop === 'waterTank' ? 0.35 : 1;
    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    const x = cx + (rng.range(x0, x1) - cx) * pull;
    const z = cz + (rng.range(z0, z1) - cz) * pull;
    matrix.makeRotationY(rng.range(0, Math.PI * 2));
    matrix.setPosition(x, y, z);
    sink.instance(prop, matrix);
  }
}
