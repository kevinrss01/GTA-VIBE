/**
 * Interiors for the buildings the player can walk into.
 *
 * A handful of parcels in the plan are marked `enterable`. The façade builder
 * leaves a real hole in the wall at `doorwayFor(parcel)`; this module builds
 * what is behind it: a lined room set just inside the footprint, with a floor
 * at the finished floor level, an opening that lines up with that hole exactly,
 * a ceiling with visible structure, and a fit-out appropriate to the kind of
 * place it is.
 *
 * The shell lives here. Everything inside it - counters, stalls, stairs,
 * lights - is in `interiorProps.ts`, which also owns the room-local coordinate
 * frame all of it is authored in.
 *
 * ## Meeting the shell
 *
 * The lining is held `WALL_INSET` (0.25 m) back from the parcel edge so the
 * exterior wall reads as having thickness. That leaves a cavity around the
 * room, which is closed at the only place it could be seen: the doorway, where
 * jambs, a soffit and a threshold line the reveal. No geometry ever leaves the
 * parcel footprint, so an interior cannot poke out through its own façade.
 *
 * ## Budget
 *
 * One merged geometry per material key per interior, under 4,000 triangles
 * each, two to five lights each. `tests/interiors.test.ts` holds those numbers.
 */

import { clamp } from '../../core/mathx';
import type { Parcel } from '../CityPlan';
import { doorApproach, doorLanding, doorOutsideY } from './doorway';
import {
  GeometryBatch,
  LINING,
  WALL_INSET,
  addBox,
  addCollider,
  addFittings,
  addFurnishingColliders,
  addQuad,
  addSolid,
  makeRoom,
  type Fitout,
  type LocalBox,
} from './interiorProps';
import type { GeometrySink } from './types';

/** Builds the interior of one enterable parcel. */
export function buildInterior(parcel: Parcel, sink: GeometrySink): void {
  const kind = parcel.interiorKind;
  if (kind === null) return;

  const room = makeRoom(parcel, kind);
  const ctx: Fitout = { room, batch: new GeometryBatch(), sink };

  addFloor(ctx);
  addWalls(ctx);
  addDoorReveal(ctx);
  addSkirting(ctx);
  addCeiling(ctx);
  addFrontDressing(ctx);
  addFittings(ctx);
  addRoomServices(ctx);
  // The generated furniture is placed at runtime by `src/shop/Furnishings`;
  // only its colliders belong to the world build.
  addFurnishingColliders(ctx);
  addExit(ctx);

  ctx.batch.flush(sink);
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function addFloor(ctx: Fitout): void {
  const { room } = ctx;
  const { width: W, depth: D, floorY: F } = room;

  addQuad(ctx, room.palette.floor, [0, W], [0, D], F, true);
  // The walkable surface covers the whole footprint, including the cavity
  // behind the lining, so the player cannot find a seam at the threshold. It
  // carries the palette's own floor material so the footstep mixer hears the
  // floor that is drawn rather than one generic indoor sound for every room.
  addCollider(
    ctx,
    {
      u: [-WALL_INSET, W + WALL_INSET],
      v: [-WALL_INSET, D + WALL_INSET],
      y: [F - 0.4, F],
    },
    false,
    true,
    room.palette.floor,
  );

  // A border band in a second stone reads as a laid floor rather than a decal.
  if (room.kind === 'lobby' || room.kind === 'marketHall' || room.kind === 'stairhall') {
    const band = room.kind === 'marketHall' ? 0.9 : 0.55;
    for (const strip of [
      { u: [0, W], v: [0, band] },
      { u: [0, W], v: [D - band, D] },
      { u: [0, band], v: [band, D - band] },
      { u: [W - band, W], v: [band, D - band] },
    ] as const) {
      addQuad(ctx, room.kind === 'lobby' ? 'stoneAshlar' : 'concrete', strip.u, strip.v, F + 0.008, true);
    }
  }
}

/**
 * The four lining walls. The front wall is built as two piers and a head so the
 * opening matches the façade's hole exactly - same centre, same width, same
 * height - and colliders are laid out to leave that opening clear.
 */
function addWalls(ctx: Fitout): void {
  const { room } = ctx;
  const { width: W, depth: D, floorY: F, ceilY: C, palette } = room;
  const half = room.doorWidth / 2;
  const head = F + room.doorHeight;

  const wall = (box: LocalBox, collider: LocalBox): void => {
    addBox(ctx, palette.wall, box);
    addCollider(ctx, collider, true, true);
  };

  // Front (street) wall, either side of the opening.
  if (room.doorU - half > 0.02) {
    wall(
      { u: [0, room.doorU - half], v: [0, LINING], y: [F, C] },
      { u: [-WALL_INSET, room.doorU - half], v: [-WALL_INSET, LINING], y: [F - 0.1, C] },
    );
  }
  if (W - (room.doorU + half) > 0.02) {
    wall(
      { u: [room.doorU + half, W], v: [0, LINING], y: [F, C] },
      { u: [room.doorU + half, W + WALL_INSET], v: [-WALL_INSET, LINING], y: [F - 0.1, C] },
    );
  }
  // Head over the opening. No collider: nothing walks at 2.5 m.
  addBox(ctx, palette.wall, {
    u: [room.doorU - half, room.doorU + half],
    v: [0, LINING],
    y: [head, C],
  });

  wall(
    { u: [0, W], v: [D - LINING, D], y: [F, C] },
    { u: [-WALL_INSET, W + WALL_INSET], v: [D - LINING, D + WALL_INSET], y: [F - 0.1, C] },
  );
  wall(
    { u: [0, LINING], v: [0, D], y: [F, C] },
    { u: [-WALL_INSET, LINING], v: [-WALL_INSET, D + WALL_INSET], y: [F - 0.1, C] },
  );
  wall(
    { u: [W - LINING, W], v: [0, D], y: [F, C] },
    { u: [W - LINING, W + WALL_INSET], v: [-WALL_INSET, D + WALL_INSET], y: [F - 0.1, C] },
  );
}

/**
 * Lines the reveal between the lining and the façade so the cavity is never
 * visible and no light escapes around the opening.
 */
function addDoorReveal(ctx: Fitout): void {
  const { room } = ctx;
  const { floorY: F, palette } = room;
  const half = room.doorWidth / 2;
  const head = F + room.doorHeight;
  const t = 0.06;

  // The reveal lines the cavity only, stopping a millimetre short of the
  // lining. Running it through the lining instead would put two coplanar faces
  // in the same place, which is what z-fighting looks like on a door frame.
  const inner = 0.001;
  for (const side of [-1, 1] as const) {
    const edge = room.doorU + side * half;
    addBox(ctx, palette.trim, {
      u: [Math.min(edge, edge + side * t), Math.max(edge, edge + side * t)],
      v: [-WALL_INSET, inner],
      y: [F, head + t],
    });
  }
  addBox(ctx, palette.trim, {
    u: [room.doorU - half - t, room.doorU + half + t],
    v: [-WALL_INSET, inner],
    y: [head, head + t],
  });
  // Threshold: a stone strip carried across the opening and a little way into
  // the room, standing proud of the floor the way a real one does.
  addBox(ctx, palette.threshold, {
    u: [room.doorU - half - t, room.doorU + half + t],
    v: [-WALL_INSET, 0.34],
    y: [F - 0.08, F + 0.012],
  });
}

function addSkirting(ctx: Fitout): void {
  const { room } = ctx;
  const { width: W, depth: D, floorY: F, palette } = room;
  const proud = 0.032;
  const height = room.kind === 'workshop' || room.kind === 'marketHall' ? 0.14 : 0.11;
  const y: readonly [number, number] = [F + 0.012, F + height];
  const half = room.doorWidth / 2;

  addBox(ctx, palette.trim, { u: [LINING, room.doorU - half], v: [LINING, LINING + proud], y });
  addBox(ctx, palette.trim, { u: [room.doorU + half, W - LINING], v: [LINING, LINING + proud], y });
  addBox(ctx, palette.trim, { u: [LINING, W - LINING], v: [D - LINING - proud, D - LINING], y });
  addBox(ctx, palette.trim, { u: [LINING, LINING + proud], v: [LINING, D - LINING], y });
  addBox(ctx, palette.trim, { u: [W - LINING - proud, W - LINING], v: [LINING, D - LINING], y });
}

/**
 * Ceiling plane plus its structure. Market halls, workshops and lobbies model
 * their own (trusses and coffers belong with the layout that spans them), so
 * only the joisted kinds are handled here.
 */
function addCeiling(ctx: Fitout): void {
  const { room } = ctx;
  const { width: W, depth: D, ceilY: C, palette } = room;
  addQuad(ctx, palette.ceiling, [0, W], [0, D], C, false);

  if (
    room.kind !== 'cafe' &&
    room.kind !== 'store' &&
    room.kind !== 'gunStore' &&
    room.kind !== 'stairhall'
  ) {
    return;
  }

  // Joists run across the shorter span, as they would be framed.
  const acrossU = W <= D;
  const span = acrossU ? W : D;
  const count = clamp(Math.round(span / 0.95), 3, 14);
  const depthOfJoist = room.kind === 'stairhall' ? 0.26 : 0.22;
  for (let i = 1; i < count; i += 1) {
    const at = (span * i) / count;
    const box: LocalBox = acrossU
      ? { u: [at - 0.045, at + 0.045], v: [LINING, D - LINING], y: [C - depthOfJoist, C] }
      : { u: [LINING, W - LINING], v: [at - 0.045, at + 0.045], y: [C - depthOfJoist, C] };
    addBox(ctx, palette.structure, box);
  }
  // A binder under the joists, which is what stops the ceiling reading as a lid.
  const binder: LocalBox = acrossU
    ? { u: [LINING, W - LINING], v: [D / 2 - 0.075, D / 2 + 0.075], y: [C - depthOfJoist - 0.12, C - depthOfJoist] }
    : { u: [W / 2 - 0.075, W / 2 + 0.075], v: [LINING, D - LINING], y: [C - depthOfJoist - 0.12, C - depthOfJoist] };
  addBox(ctx, palette.structure, binder);
}

/**
 * The inside of the shopfront: a stallriser, a display ledge with goods facing
 * the street, and a blind at the head. The exterior owns the glazing itself -
 * glazing it again from in here would double up the surface.
 */
function addFrontDressing(ctx: Fitout): void {
  const { room } = ctx;
  const { width: W, floorY: F, palette, rng } = room;
  const half = room.doorWidth / 2;

  const panels: readonly (readonly [number, number])[] = [
    [LINING, room.doorU - half],
    [room.doorU + half, W - LINING],
  ];

  for (const panel of panels) {
    const span = panel[1] - panel[0];
    if (span < 1.1) continue;

    if (room.kind === 'lobby') {
      // A lobby gets a stone plinth and a walk-off mat rather than a display.
      addBox(ctx, 'stoneAshlar', {
        u: panel,
        v: [LINING, LINING + 0.09],
        y: [F + 0.012, F + 0.42],
      });
      continue;
    }
    if (room.kind === 'workshop' || room.kind === 'stairhall') continue;

    addBox(ctx, palette.trim, { u: panel, v: [LINING, LINING + 0.05], y: [F + 0.012, F + 0.5] });
    addSolid(ctx, palette.surface, {
      u: [panel[0], panel[1]],
      v: [LINING, LINING + 0.44],
      y: [F + 0.5, F + 0.57],
    });
    // Goods faced up to the street.
    const items = clamp(Math.round(span / 0.75), 1, 6);
    for (let i = 0; i < items; i += 1) {
      const centre = panel[0] + 0.25 + ((span - 0.5) * (i + 0.5)) / items;
      const w = rng.range(0.16, 0.3);
      const h = rng.range(0.16, 0.4);
      addBox(ctx, i % 2 === 0 ? palette.joinery : 'canvasAwning', {
        u: [centre - w / 2, centre + w / 2],
        v: [LINING + 0.06, LINING + 0.38],
        y: [F + 0.57, F + 0.57 + h],
      });
    }
    // Transom rail and a blind rolled down a third of the way.
    const headY = Math.min(F + 2.32, room.ceilY - 0.3);
    addBox(ctx, palette.trim, { u: panel, v: [LINING, LINING + 0.07], y: [headY, headY + 0.09] });
    addBox(ctx, palette.fabric, {
      u: [panel[0] + 0.05, panel[1] - 0.05],
      v: [LINING + 0.02, LINING + 0.2],
      y: [headY - rng.range(0.3, 0.55), headY],
    });
  }
}

// ---------------------------------------------------------------------------
// Services and door furniture
// ---------------------------------------------------------------------------

/**
 * The layer every real room has and almost no modelled one does: the door
 * itself standing open, a mat inside it, a switch and a fire point beside it, a
 * rail around the walls, a vent, and a detector overhead.
 *
 * All of it is fixed to a wall or a ceiling, in the bands the per-kind layouts
 * leave clear, so it composes with every fit-out without a clash. None of it
 * takes a collider: everything here is shallower than the player's own body
 * radius, and a collider beside a doorway is how a player gets shut in.
 */
function addRoomServices(ctx: Fitout): void {
  const { room } = ctx;
  const half = room.doorWidth / 2;
  // Hinge against whichever pier is wider, so the leaf never crowds the narrow
  // one and the opening still reads from the street.
  const hingeLeft = room.doorU - half >= room.width - (room.doorU + half);

  addDoorLeaf(ctx, hingeLeft);
  addEntryMat(ctx);
  addDoorFurniture(ctx, hingeLeft);
  addWallRail(ctx);
  addWallVent(ctx);
  addDetector(ctx);
}

/** The door, standing open at right angles against its own jamb. */
function addDoorLeaf(ctx: Fitout, hingeLeft: boolean): void {
  const { room } = ctx;
  const { floorY: F, palette } = room;
  const half = room.doorWidth / 2;
  const jamb = hingeLeft ? room.doorU - half : room.doorU + half;
  const thickness = 0.055;
  // The leaf hangs *inside* the opening, so the clear width the façade cut is
  // reduced by the thickness of one leaf and nothing else.
  const u: readonly [number, number] = hingeLeft
    ? [jamb, jamb + thickness]
    : [jamb - thickness, jamb];
  const swing = Math.min(1.05, room.doorWidth * 0.44, room.depth - LINING - 0.6);
  if (swing < 0.5) return;

  const v0 = LINING + 0.02;
  const top = F + room.doorHeight - 0.05;
  addBox(ctx, palette.trim, { u, v: [v0, v0 + swing], y: [F + 0.02, top] });
  // A glazed upper panel, held in from the frame all round. A workshop gets a
  // boarded leaf instead: a joinery shop does not glaze its own back door.
  const face = hingeLeft ? u[1] : u[0];
  addBox(ctx, room.kind === 'workshop' ? palette.metal : 'glassShop', {
    u: [face - 0.008, face + 0.008],
    v: [v0 + 0.11, v0 + swing - 0.09],
    y: [F + 0.88, top - 0.13],
  });
  // Lever handle on the swinging edge, at the height a hand meets a door.
  addBox(ctx, palette.metal, {
    u: [face - 0.04, face + 0.04],
    v: [v0 + swing - 0.24, v0 + swing - 0.08],
    y: [F + 1.02, F + 1.08],
  });
}

/** A rubber walk-off mat on the traffic line, just past the stone threshold. */
function addEntryMat(ctx: Fitout): void {
  const { room } = ctx;
  const half = Math.min(room.doorWidth / 2 + 0.18, room.width / 2 - LINING);
  const back = Math.min(1.72, room.depth - LINING - 0.4);
  if (back <= 0.42 || half <= 0.2) return;
  addBox(ctx, 'roofTar', {
    u: [room.doorU - half, room.doorU + half],
    v: [0.4, back],
    y: [room.floorY + 0.013, room.floorY + 0.027],
  });
}

/**
 * Switch, socket and fire point on the pier opposite the door leaf. Everything
 * sits above 0.9 m so it clears the stallriser and display ledge on the kinds
 * that have a shopfront.
 */
function addDoorFurniture(ctx: Fitout, hingeLeft: boolean): void {
  const { room } = ctx;
  const { floorY: F, width: W, palette } = room;
  const half = room.doorWidth / 2;
  const pier = hingeLeft
    ? { from: room.doorU + half, to: W - LINING, sign: 1 }
    : { from: room.doorU - half, to: LINING, sign: -1 };
  if (Math.abs(pier.to - pier.from) < 1.5) return;

  const plateU = pier.from + pier.sign * 0.36;
  addBox(ctx, 'stuccoCream', {
    u: [plateU - 0.05, plateU + 0.05],
    v: [LINING, LINING + 0.018],
    y: [F + 1.24, F + 1.34],
  });
  addBox(ctx, 'stuccoCream', {
    u: [plateU - 0.07, plateU + 0.07],
    v: [LINING, LINING + 0.018],
    y: [F + 0.95, F + 1.03],
  });

  // Extinguisher on a bracket. Red is the one saturated colour a room like this
  // is allowed, and the eye goes straight to it.
  const canU = pier.from + pier.sign * 0.86;
  if (Math.abs(pier.to - canU) < 0.35) return;
  addBox(ctx, palette.metal, {
    u: [canU - 0.05, canU + 0.05],
    v: [LINING, LINING + 0.06],
    y: [F + 0.88, F + 1.26],
  });
  addBox(ctx, 'canvasAwning', {
    u: [canU - 0.085, canU + 0.085],
    v: [LINING + 0.04, LINING + 0.21],
    y: [F + 0.86, F + 1.3],
  });
  addBox(ctx, 'metalDark', {
    u: [canU - 0.03, canU + 0.03],
    v: [LINING + 0.09, LINING + 0.16],
    y: [F + 1.3, F + 1.4],
  });
}

/**
 * A rail run around both flank walls. One continuous horizontal line at eye
 * level does more to stop a wall reading as a flat plane than any amount of
 * texture, and it is two boxes.
 *
 * The industrial kinds are left alone: their flanks carry benches, stalls and
 * trusses, and a moulding would be wrong on them anyway.
 */
function addWallRail(ctx: Fitout): void {
  const { room } = ctx;
  if (room.kind === 'workshop' || room.kind === 'marketHall') return;

  const { floorY: F, width: W, depth: D, palette } = room;
  const y = F + Math.min(2.45, room.ceilY - F - 0.6);
  if (y - F < 1.6) return;
  const proud = 0.035;
  const v: readonly [number, number] = [LINING + 0.1, D - LINING - 0.1];
  addBox(ctx, palette.trim, { u: [LINING, LINING + proud], v, y: [y, y + 0.06] });
  addBox(ctx, palette.trim, { u: [W - LINING - proud, W - LINING], v, y: [y, y + 0.06] });
}

/** A louvred vent high on a flank wall, where every kind leaves the wall clear. */
function addWallVent(ctx: Fitout): void {
  const { room } = ctx;
  const { depth: D, ceilY: C, palette } = room;
  const v = clamp(D * 0.28, 0.9, D - 0.9);
  const top = C - 0.45;
  if (top - room.floorY < 2.2) return;
  addBox(ctx, palette.trim, {
    u: [LINING, LINING + 0.04],
    v: [v - 0.24, v + 0.24],
    y: [top - 0.3, top],
  });
  addBox(ctx, 'metalDark', {
    u: [LINING + 0.02, LINING + 0.05],
    v: [v - 0.2, v + 0.2],
    y: [top - 0.26, top - 0.04],
  });
}

/**
 * Smoke detector, hung under whatever the ceiling structure is rather than in
 * it: a disc buried in a joist is worse than no disc at all.
 */
function addDetector(ctx: Fitout): void {
  const { room } = ctx;
  const { ceilY: C, palette } = room;
  const drop =
    room.kind === 'cafe' || room.kind === 'store' || room.kind === 'gunStore' || room.kind === 'stairhall'
      ? 0.38
      : room.kind === 'lobby'
        ? 0.3
        : 0.05;
  const y = C - drop;
  const u = clamp(room.doorU + 1.5, 0.6, room.width - 0.6);
  const v = clamp(room.depth * 0.3, 1.2, room.depth - 1.2);
  addBox(ctx, 'stuccoCream', {
    u: [u - 0.09, u + 0.09],
    v: [v - 0.09, v + 0.09],
    y: [y - 0.035, y],
  });
  addBox(ctx, palette.glow, {
    u: [u - 0.016, u + 0.016],
    v: [v + 0.03, v + 0.06],
    y: [y - 0.045, y - 0.033],
  });
}

/**
 * The way out. The player lands just inside the door on entry, and this is the
 * prompt that takes them back to the pavement.
 *
 * The target height is the level *outside* the door, not the finished floor.
 * Handing back the floor level would drop the player the height of the
 * threshold every single time they left a building.
 */
function addExit(ctx: Fitout): void {
  const { room, sink } = ctx;
  const { door, parcel } = room;
  const landing = doorLanding(door);
  const approach = doorApproach(door);

  sink.interaction({
    id: `interior-exit-${parcel.id}`,
    x: landing.x,
    y: parcel.groundY + 1.2,
    z: landing.z,
    // Matches the front door's reach for the same reason: the landing is 1.8 m
    // inside, and a player walking at the door has to still be offered the way
    // out when they are standing on the threshold.
    radius: 2.8,
    prompt: 'Press E to leave',
    kind: 'door',
    parcelId: parcel.id,
    // Heading follows the camera convention in CityPlan: forward is
    // (-sin h, 0, -cos h), so this looks straight out of the building.
    target: {
      x: approach.x,
      y: doorOutsideY(parcel, door),
      z: approach.z,
      heading: Math.atan2(-door.normalX, -door.normalZ),
    },
  });
}
