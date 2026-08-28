/**
 * The generated props travellers carry, and the ones sitting in the lounge.
 *
 * Free of Three.js so the placement arithmetic - which is where an attachment
 * actually goes wrong - can be asserted without a renderer.
 *
 * ## When luggage is held in a hand, and when it is not
 *
 * `PedestrianVat` ships a per-frame HAND TRACK where the bake recorded one, and
 * `OfficerRig` uses it to put a pistol in an officer's grip. The four original
 * civilian bakes have `hand: null` - measured, see
 * `tools/bake-pedestrian-vat.mjs` - and the traveller bakes have it, so
 * `placeLuggage` takes an optional hand and uses it when there is one.
 *
 * It uses it only for a `hang` piece, which is the only kind actually held. A
 * rolling case does not need a wrist: it trails on the floor behind the person
 * at a fixed offset, and a rucksack is strapped to a back. Putting either at
 * the measured hand would have it bobbing a hand's width every stride, which
 * is worse than the fixed offset, not better.
 *
 * Either way the offset goes through the body's own transform, so a wider
 * traveller's case swings wider and a taller one's bag hangs higher. Skip that
 * step and the case drifts off a tall traveller: the offset is in the
 * CHARACTER's frame, not the world's.
 *
 * ## Units
 *
 * Offsets are in RIG units, the units the bake is authored in: one unit of
 * height is one body height, and one unit across is one unit of the instance
 * matrix's `girth` - which the crowd runs at about 1.0, so across the ground a
 * rig unit is about a metre. That asymmetry is the crowd's, not this module's;
 * see the note on `PedestrianSystem.walked`.
 *
 * ## Why seated people are props and not characters
 *
 * A VAT character has two clips, walk and idle, and both are standing. Forcing
 * one into a chair means scaling and shearing a standing pose until its shins
 * happen to end near the floor, which reads as a mannequin dropped onto a
 * bench. A model posed sitting reads as a person sitting, costs one instanced
 * draw call for the whole lounge, and costs nothing per frame because it never
 * moves. What it gives up is that nobody ever stands up: that is a visible
 * limitation and a deliberate one, because the alternative - a standing
 * character popping into a seated prop - is a worse thing to see than a
 * lounge that stays seated.
 */

/** Every model's own forward axis, in the sense `Furnishings` uses. */
export type FrontAxis = 'x' | '-x' | 'z' | '-z';

/**
 * Rotation that turns a model's own forward axis onto a heading.
 *
 * Solving `rotationY(heading + turn) * front == (-sin heading, 0, -cos heading)`
 * has exactly these four answers. Written out rather than derived because
 * getting one wrong points every suitcase sideways, which is not obvious from
 * a plan view and extremely obvious from the concourse.
 */
export const FRONT_TURNS: Readonly<Record<FrontAxis, number>> = {
  z: Math.PI,
  '-z': 0,
  x: Math.PI / 2,
  '-x': -Math.PI / 2,
};

export type LuggageKind = 'suitcase' | 'duffel' | 'trolley' | 'backpack' | 'garment-bag';

export const LUGGAGE_KINDS: readonly LuggageKind[] = [
  'suitcase',
  'duffel',
  'trolley',
  'backpack',
  'garment-bag',
];

/** Where a piece rides relative to its owner, in rig units. */
export interface CarryOffset {
  /** Positive is the traveller's right. */
  readonly right: number;
  /** Positive is BEHIND them: the rig's forward is -Z. */
  readonly back: number;
  /** Grip height as a fraction of the traveller's height. */
  readonly grip: number;
}

export interface LuggageSpec {
  /** Runtime GLB, relative to the site root. */
  readonly url: string;
  /**
   * Which axis of the normalised model the `metres` figure measures.
   *
   * Every generated model arrives normalised into a unit box with a CENTRE
   * pivot, so exactly one dimension is 0.998 and WHICH one differs per model.
   * Fitting the duffel - whose long axis is Z - by its height would produce a
   * holdall the size of a car.
   */
  readonly fit: 'x' | 'y' | 'z';
  readonly metres: number;
  readonly front: FrontAxis;
  readonly offset: CarryOffset;
  /**
   * How the piece sits relative to its grip height.
   *
   *   `floor`  stands it on the ground under the grip - a rolling case.
   *   `hang`   suspends it from the grip by its own top, AND follows the
   *            measured hand when the character has one - a holdall.
   *   `shoulder` hangs from the grip like `hang` but never follows the hand,
   *            because it is over a shoulder rather than in a fist.
   *   `worn`   centres it on the grip - a backpack, which is neither carried
   *            nor rolled but strapped to a back, so the thing the offset
   *            describes is the middle of it rather than its top or its base.
   */
  readonly rest: 'floor' | 'hang' | 'shoulder' | 'worn';
  /** Share of luggage-carrying travellers who take this. Normalised at use. */
  readonly share: number;
}

/**
 * Measured from the staged models, not guessed.
 *
 *   suitcase 0.283 x 0.998 x 0.533, four wheels one at each corner, telescopic
 *            handle at local -X. It is a SPINNER, so it rolls upright: tilting
 *            it back onto two wheels would lift the other two off the floor,
 *            and there is no hand to pin the raised end to.
 *   duffel   0.596 x 0.604 x 0.998, long axis Z, carry handles on top.
 *   trolley  0.525 x 0.998 x 0.533, push bar across the top at local -Z, so
 *            the pusher stands at -Z and the trolley runs ahead at +Z.
 *
 * Real sizes: a large checked case is 0.50 x 0.30 x 0.75 m and 1.02 m with the
 * handle up, which is what the model's proportions already are to within a
 * centimetre; a holdall is 0.62 m long; an airport trolley's bar is at 1.0 m.
 */
export const LUGGAGE_SPECS: Readonly<Record<LuggageKind, LuggageSpec>> = {
  suitcase: {
    url: 'models/airport/suitcase.glb',
    fit: 'y',
    metres: 1.02,
    // The handle end must face the person towing it, and the handle is at -X.
    front: '-x',
    offset: { right: 0.24, back: 0.54, grip: 0.47 },
    rest: 'floor',
    share: 0.34,
  },
  duffel: {
    url: 'models/airport/duffel.glb',
    fit: 'z',
    metres: 0.62,
    front: '-z',
    offset: { right: 0.29, back: 0.05, grip: 0.46 },
    rest: 'hang',
    share: 0.2,
  },
  trolley: {
    url: 'models/airport/trolley.glb',
    fit: 'y',
    metres: 1,
    front: 'z',
    // Ahead of the traveller, so `back` is negative. Far enough out that the
    // push bar clears the arm swing rather than passing through it.
    offset: { right: 0, back: -0.72, grip: 0.55 },
    rest: 'floor',
    share: 0.08,
  },
  /*
   * 0.875 x 0.998 x 0.703 normalised, standing on +Y with a centre pivot and
   * facing -Z, the same convention as the three above and as the workstream
   * that staged it reported. Real day packs are 0.45 to 0.55 m tall.
   *
   * `worn` rather than `hang`: a rucksack is strapped to a back, so what the
   * offset describes is the middle of it, and it must NOT follow the measured
   * hand - a pack that bobs a hand's width every stride is worse than one at a
   * fixed offset.
   */
  backpack: {
    url: 'models/airport/backpack.glb',
    fit: 'y',
    metres: 0.5,
    front: '-z',
    // Against the back, centred on the shoulder blades: 0.68 of a 1.73 m
    // person is 1.18 m, so the pack spans roughly 0.93 to 1.43 m.
    offset: { right: 0, back: 0.2, grip: 0.68 },
    rest: 'worn',
    share: 0.26,
  },
  /*
   * 0.382 x 0.998 x 0.425 normalised, with 983 of its 1441 vertices in the top
   * half: the bulk is the shoulder end, which is what a garment bag looks
   * like. Carried over a shoulder rather than swinging from a hand, because a
   * 0.9 m bag hanging from a hand at hip height reaches through the floor -
   * which is why its `grip` is a shoulder height and not a wrist one.
   */
  'garment-bag': {
    url: 'models/airport/garment-bag.glb',
    fit: 'y',
    metres: 0.9,
    front: '-z',
    // Over the shoulder: 0.80 of height is 1.38 m on a 1.73 m person, so the
    // bag hangs from there down to about knee height.
    offset: { right: 0.22, back: 0.1, grip: 0.8 },
    rest: 'shoulder',
    share: 0.12,
  },
};

/** How far below the grip a hanging bag's top sits, in metres: a fist. */
const HANG_GAP = 0.05;

export interface Carrier {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  /** Vertical scale of the instance matrix, in metres. */
  readonly height: number;
  /** Horizontal scale of the instance matrix. */
  readonly girth: number;
}

export interface PropPlacement {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * A hand, in the rig's own frame: `x` right, `y` up as a fraction of body
 * height, `z` back. Exactly what `VatClip.handAt` writes.
 */
export interface HandPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Where one piece of luggage goes this frame.
 *
 * The offset is carried through the SAME transform the instance matrix applies
 * to the body - `Ry(heading) * scale(girth, height, girth)` - so a wide
 * traveller's case swings wider and a tall one's bag hangs higher, with no
 * second set of constants to keep in step.
 *
 * @param modelHeight the fitted model's real height in metres; only `hang`
 *                    needs it, to suspend the bag by its own top.
 */
export function placeLuggage(
  spec: LuggageSpec,
  carrier: Carrier,
  floorY: number,
  modelHeight: number,
  out: PropPlacement,
  hand?: HandPoint | null,
): void {
  const c = Math.cos(carrier.heading);
  const s = Math.sin(carrier.heading);
  /*
   * A HELD bag follows the hand that is holding it, when the bake measured one.
   *
   * `VatClip.handAt` reports the right hand per frame in the same rig frame
   * these offsets are written in, so it drops straight in: x is right, z is
   * back, y is the fraction of the body's height. `ped-e` is the first
   * traveller baked with the track, and it is the difference between a holdall
   * that swings with the arm and one welded to a hip.
   *
   * Only `hang` pieces use it. A towed spinner's position is decided by the
   * floor and by staying out from under the walker's heels, and a rucksack's
   * by the back it is strapped to; putting either at the wrist would have them
   * bobbing a hand's width every stride.
   */
  const held = hand != null && spec.rest === 'hang';
  const right = held ? (hand as HandPoint).x : spec.offset.right;
  const back = held ? (hand as HandPoint).z : spec.offset.back;
  // Columns 0 and 2 of the body's instance matrix, applied to (right, _, back).
  out.x = carrier.x + carrier.girth * (c * right + s * back);
  out.z = carrier.z + carrier.girth * (-s * right + c * back);
  const grip =
    floorY + carrier.height * (held ? (hand as HandPoint).y : spec.offset.grip);
  if (spec.rest === 'floor') {
    out.y = floorY;
  } else if (spec.rest === 'worn') {
    // Centred on the grip: the model's pivot is at its base, so half its own
    // height comes off. Never below the floor, whatever height it is given.
    out.y = Math.max(floorY, grip - modelHeight * 0.5);
  } else {
    // Never below the floor, whatever height the caller hands us.
    out.y = Math.max(floorY, grip - HANG_GAP - modelHeight);
  }
  out.yaw = carrier.heading + FRONT_TURNS[spec.front];
}

export type SeatedModel = 'seated-a' | 'seated-b';

export const SEATED_MODELS: readonly SeatedModel[] = ['seated-a', 'seated-b'];

export interface SeatedSpec {
  readonly url: string;
  readonly front: FrontAxis;
  /**
   * Seated stature in metres: floor to the top of the head. 1.24 to 1.34 m
   * covers the adult range on a normal bench, and is what the per-person
   * variation is drawn from.
   */
  readonly stature: number;
  /**
   * Height of the pose's own seat pad as a fraction of its stature, measured
   * off the staged model: the lowest point of the band between 10 and 42 per
   * cent of the way back from the toes, which is the underside of the thigh.
   *
   * Only used when a caller supplies a seat's real pad height; without one the
   * figure stands its own feet on the floor, which is never wrong.
   */
  readonly padFraction: number;
  /** Widest across the shoulders and knees, as a fraction of stature. */
  readonly widthFraction: number;
  /** Toes to back, as a fraction of stature. Both measured off the model. */
  readonly depthFraction: number;
}

export const SEATED_SPECS: Readonly<Record<SeatedModel, SeatedSpec>> = {
  // Feet at +X, head at -X: the figure faces +X. Measured from the staged
  // model by comparing the centroid of the lowest and highest slabs.
  'seated-a': {
    url: 'models/airport/seated-a.glb',
    front: 'x',
    stature: 1.29,
    padFraction: 0.282,
    widthFraction: 0.409,
    depthFraction: 0.616,
  },
  'seated-b': {
    url: 'models/airport/seated-b.glb',
    front: 'x',
    stature: 1.31,
    padFraction: 0.341,
    // Leaning forward at a phone with the knees apart: a quarter of a metre
    // wider across than `seated-a`, which is why a narrow bench gets the
    // other one.
    widthFraction: 0.605,
    depthFraction: 0.757,
  },
};

/**
 * How far a seated figure's feet may be lifted off the floor to meet a pad.
 *
 * Two centimetres. Past that the figure reads as hovering, and sitting it
 * slightly low on the bench is the better of two wrong answers.
 */
export const SEAT_LIFT_LIMIT = 0.02;

/**
 * Puts one seated figure on one seat.
 *
 * `padY` is the world height of the bench's seat surface when the caller knows
 * it. Without it the figure's feet go on the floor and its hips land wherever
 * the pose puts them - `padFraction * stature` above the floor, which is what
 * `stats.impliedSeatPadY` reports so the bench can be built to match.
 */
export function placeSeated(
  spec: SeatedSpec,
  anchor: { readonly x: number; readonly z: number; readonly heading: number },
  floorY: number,
  stature: number,
  padY: number | undefined,
  out: PropPlacement,
): void {
  out.x = anchor.x;
  out.z = anchor.z;
  out.yaw = anchor.heading + FRONT_TURNS[spec.front];
  if (padY === undefined) {
    out.y = floorY;
    return;
  }
  const lift = padY - (floorY + spec.padFraction * stature);
  out.y = floorY + Math.min(Math.max(lift, -Infinity), SEAT_LIFT_LIMIT);
}
