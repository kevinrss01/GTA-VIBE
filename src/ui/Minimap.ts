/**
 * Meridian Bay minimap.
 *
 * COORDINATES. One world unit is one metre, +X is east and +Z is south. The map
 * is north-up, so world +X runs right across the map and world +Z runs *down*
 * it. That single fact is what `worldToMap` encodes, and everything else here
 * (the crop, the player arrow, the field-of-view wedge, the labels) is derived
 * from it rather than re-deriving a sign convention of its own.
 *
 * HEADING. The camera yaw convention is forward = `(-sin yaw, 0, -cos yaw)`, so
 * yaw 0 faces north (-Z). In map space that is `(-sin yaw, -cos yaw)` with y
 * pointing down, which is exactly `headingVector`. Yaw 0 therefore points up
 * the map, as it must.
 *
 * COST. The static map - water, roads, pavements, blocks, buildings, landmarks -
 * is rasterised once into an offscreen canvas at a fixed metres-to-pixels scale
 * and never redrawn. A frame costs one `drawImage` of a translated crop plus a
 * handful of path operations for the player marker; the expanded map is the
 * same, against a second cache that also carries its labels and is only rebuilt
 * when the viewport changes. Redrawing the city per frame would cost more than
 * the 3D scene it sits on top of, which is why it is not done.
 *
 * The geometry is kept as pure exported functions so it can be tested without a
 * canvas; the class below is the only part that touches the DOM.
 */

import './ui.css';

import { TAU, type Rect } from '../core/mathx';
import {
  corridorHalfWidth,
  type CityBlock,
  type CityPlan,
  type DistrictId,
  type Parcel,
  type Street,
} from '../world/CityPlan';
import { shorelineX } from '../world/elevation';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * Every colour the map uses, in one place so the whole thing can be retuned
 * without hunting through draw calls. Deliberately desaturated: the only warm
 * note is the accent on the buildings the player can actually walk into.
 *
 * The values are a deliberate lightness ramp, because the street corridors
 * cover roughly 45 per cent of the plan area. Left any lighter they turn the
 * whole city into one bright slab with the buildings reading as holes in it, so
 * the ramp is ground < buildings < carriageway < pavement, with only a few
 * steps of separation between each.
 */
export const MINIMAP_PALETTE = {
  /** Outside the mapped area. */
  beyond: '#090c0f',
  land: '#12171b',
  water: '#0d1720',
  shore: '#2c4653',
  /** Courtyards and service ground inside a block. */
  block: '#171d22',
  park: '#1e2a23',
  plaza: '#2d353b',
  /** Carriageway. Darker than the pavement it sits inside. */
  road: '#333c44',
  /** Wider carriageways read a shade brighter so the arterials stand out. */
  arterial: '#3c454e',
  /** Corridor: the pavement either side of the carriageway. */
  pavement: '#444d55',
  building: '#262e35',
  buildingEdge: '#12171b',
  /** Buildings the player can enter. The one warm colour on the map. */
  enterable: '#c8a06a',
  /**
   * The gun store. It gets its own colour and its own shape because the
   * player has to be able to FIND it, and a ring identical to six other rings
   * is not findable - it is only findable once you already know which one.
   */
  gunStore: '#d4574b',
  /** The Vibe's magenta, so a mission marker is never a shop marker. */
  waypoint: '#e24a78',
  landmark: '#93aab8',
  player: '#eef2f4',
  playerEdge: '#0b0f12',
  fov: 'rgba(238, 242, 244, 0.20)',
  label: '#b3bfc7',
  labelDim: '#7d8a93',
  /** Drawn behind label text so it survives crossing a pale road. */
  labelHalo: 'rgba(9, 12, 15, 0.85)',
} as const;

export type MinimapPalette = typeof MINIMAP_PALETTE;

/**
 * Display names for the plan's district ids, used on the expanded map and
 * available to the HUD readout so the two can never disagree about a place.
 */
export const DISTRICT_LABELS: Readonly<Record<DistrictId, string>> = {
  harbourside: 'Harbourside',
  cannery: 'The Cannery',
  oldQuarter: 'Old Quarter',
  core: 'Meridian Core',
  civic: 'Lantern Park',
  ridge: 'Ridge Terraces',
};

// ---------------------------------------------------------------------------
// Geometry - pure, canvas-free, unit-testable
// ---------------------------------------------------------------------------

/** A point in map pixels: +x right, +y down. */
export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

/** The world rectangle the static map covers. */
export interface MapBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly width: number;
  readonly depth: number;
}

/** Metres of empty ground kept around the built city. */
export const MAP_MARGIN = 28;

/**
 * Pixels per metre in the offscreen static layer. Chosen so the layer is sharp
 * when downsampled into the ~190 px dial and still acceptable when scaled up to
 * the expanded map, without the memory cost of a 4 px/m raster.
 */
export const STATIC_SCALE = 3.2;

/** Field of view of the wedge drawn from the player marker. */
export const FOV_DEGREES = 70;

/** World-space extent of a street corridor, pavements included. */
export function streetExtent(street: Street): Rect {
  const half = corridorHalfWidth(street);
  return street.axis === 'x'
    ? {
        minX: street.position - half,
        maxX: street.position + half,
        minZ: street.from,
        maxZ: street.to,
      }
    : {
        minX: street.from,
        maxX: street.to,
        minZ: street.position - half,
        maxZ: street.position + half,
      };
}

/**
 * The world rectangle the map covers: everything in the plan plus a margin.
 * Not squared off - the dial crops a square out of it and the expanded map
 * keeps the aspect, so forcing a square here would only waste texture memory.
 */
export function mapBoundsFor(plan: CityPlan, margin: number = MAP_MARGIN): MapBounds {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;

  const include = (rect: Rect): void => {
    if (rect.minX < minX) minX = rect.minX;
    if (rect.minZ < minZ) minZ = rect.minZ;
    if (rect.maxX > maxX) maxX = rect.maxX;
    if (rect.maxZ > maxZ) maxZ = rect.maxZ;
  };

  for (const street of plan.streets) include(streetExtent(street));
  for (const block of plan.blocks) include(block.rect);
  for (const parcel of plan.parcels) include(parcel.rect);
  for (const landmark of plan.landmarks) {
    include({ minX: landmark.x, maxX: landmark.x, minZ: landmark.z, maxZ: landmark.z });
  }

  const padded = {
    minX: minX - margin,
    minZ: minZ - margin,
    maxX: maxX + margin,
    maxZ: maxZ + margin,
  };
  return {
    ...padded,
    width: padded.maxX - padded.minX,
    depth: padded.maxZ - padded.minZ,
  };
}

/**
 * Projects a world point onto the map. `scale` is pixels per metre.
 * +X (east) goes right, +Z (south) goes down: a north-up map.
 */
export function worldToMap(
  x: number,
  z: number,
  bounds: MapBounds,
  scale: number = STATIC_SCALE,
): MapPoint {
  return { x: (x - bounds.minX) * scale, y: (z - bounds.minZ) * scale };
}

/** Unit heading in map space for a camera yaw. Yaw 0 faces north, i.e. up. */
export function headingVector(yaw: number): MapPoint {
  return { x: -Math.sin(yaw), y: -Math.cos(yaw) };
}

/**
 * The field-of-view wedge, in map pixels relative to the player.
 *
 * Element 0 is the apex at the player; the rest is the arc, swept symmetrically
 * about `headingVector(yaw)`. This is the clearest reading of which way the
 * player is looking, which is why it is drawn rather than the arrow alone.
 */
export function fovWedgePoints(
  yaw: number,
  radius: number,
  fovDegrees: number = FOV_DEGREES,
  segments = 12,
): MapPoint[] {
  const heading = headingVector(yaw);
  const centre = Math.atan2(heading.y, heading.x);
  const half = ((fovDegrees * Math.PI) / 180) * 0.5;
  const steps = Math.max(2, Math.floor(segments));
  const points: MapPoint[] = [{ x: 0, y: 0 }];
  for (let i = 0; i <= steps; i += 1) {
    const angle = centre - half + (2 * half * i) / steps;
    points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return points;
}

/** The buildings the player can walk into. */
export function enterableParcels(plan: CityPlan): readonly Parcel[] {
  return plan.parcels.filter((parcel) => parcel.enterable);
}

/** Streets worth naming on the expanded map. */
export function labelledStreets(plan: CityPlan): readonly Street[] {
  return plan.streets.filter(
    (street) => street.kind === 'arterial' || street.kind === 'promenade',
  );
}

/** Label anchor for each district: the centre of the ground it covers. */
export function districtAnchors(plan: CityPlan): { district: DistrictId; x: number; z: number }[] {
  const sums = new Map<DistrictId, { x: number; z: number; weight: number }>();
  for (const block of plan.blocks) {
    const entry = sums.get(block.district) ?? { x: 0, z: 0, weight: 0 };
    const area = (block.rect.maxX - block.rect.minX) * (block.rect.maxZ - block.rect.minZ);
    entry.x += ((block.rect.minX + block.rect.maxX) * 0.5) * area;
    entry.z += ((block.rect.minZ + block.rect.maxZ) * 0.5) * area;
    entry.weight += area;
    sums.set(block.district, entry);
  }
  const out: { district: DistrictId; x: number; z: number }[] = [];
  for (const [district, entry] of sums) {
    if (entry.weight <= 0) continue;
    out.push({ district, x: entry.x / entry.weight, z: entry.z / entry.weight });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

export interface MinimapOptions {
  /** Diameter of the corner dial in CSS pixels. */
  size?: number;
  /** Metres of world per CSS pixel in the dial. Smaller means closer in. */
  metresPerPixel?: number;
}

const DEFAULT_SIZE = 190;
const DEFAULT_METRES_PER_PIXEL = 1.3;
/** Fraction of the smaller viewport axis the expanded map takes up. */
const EXPANDED_FRACTION = 0.62;
const EXPANDED_MAX = 780;
const MAX_DPR = 2;
/** Published on <body> while the map is open so other layers can stand back. */
const BODY_MAP_OPEN = 'mb-map-open';

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Minimap requires a 2D canvas context');
  return ctx;
}

export class Minimap {
  /** The element to append to the DOM. A full-screen, click-through layer. */
  readonly element: HTMLElement;

  private readonly plan: CityPlan;
  /**
   * Where the mission is pointing, in world metres, or null.
   *
   * Held here rather than passed into `update` because it changes about four
   * times in a session and the frame loop should not be carrying it.
   */
  private waypoint: { readonly x: number; readonly z: number } | null = null;
  private readonly bounds: MapBounds;
  private readonly size: number;
  private readonly metresPerPixel: number;

  private readonly staticLayer: HTMLCanvasElement;
  private readonly dial: HTMLCanvasElement;
  private readonly dialCtx: CanvasRenderingContext2D;
  private readonly overlay: HTMLElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D;
  /** Static map plus labels, rasterised at the expanded map's display size. */
  private readonly expandedCache: HTMLCanvasElement;

  private dpr = 1;
  private expandedWidth = 0;
  private expandedHeight = 0;
  private isExpanded = false;
  private disposed = false;

  private playerX = 0;
  private playerZ = 0;
  private playerYaw = 0;
  private dirty = true;

  private readonly onResize = (): void => {
    this.layout();
    this.dirty = true;
    this.render();
  };

  constructor(plan: CityPlan, options?: MinimapOptions) {
    this.plan = plan;
    this.bounds = mapBoundsFor(plan);
    this.size = Math.max(120, Math.round(options?.size ?? DEFAULT_SIZE));
    this.metresPerPixel = Math.max(0.4, options?.metresPerPixel ?? DEFAULT_METRES_PER_PIXEL);

    this.staticLayer = document.createElement('canvas');
    this.staticLayer.width = Math.ceil(this.bounds.width * STATIC_SCALE);
    this.staticLayer.height = Math.ceil(this.bounds.depth * STATIC_SCALE);
    this.buildStaticLayer(context2d(this.staticLayer));

    this.element = document.createElement('div');
    this.element.className = 'mb-minimap-layer';

    const dialBox = document.createElement('div');
    dialBox.className = 'mb-minimap';
    dialBox.style.setProperty('--mb-minimap-size', `${this.size}px`);

    this.dial = document.createElement('canvas');
    this.dial.className = 'mb-minimap__canvas';
    this.dialCtx = context2d(this.dial);

    // Bezel and the north tick. Both are chrome only: the map is north-up, so
    // the tick never moves and neither needs to be touched again.
    const frame = document.createElement('div');
    frame.className = 'mb-minimap__frame';
    const north = document.createElement('span');
    north.className = 'mb-minimap__north';
    north.textContent = 'N';

    dialBox.append(this.dial, frame, north);

    this.overlay = document.createElement('div');
    this.overlay.className = 'mb-map';
    this.overlay.setAttribute('aria-hidden', 'true');
    const sheet = document.createElement('div');
    sheet.className = 'mb-map__sheet';
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'mb-map__canvas';
    this.overlayCtx = context2d(this.overlayCanvas);
    const caption = document.createElement('p');
    caption.className = 'mb-map__caption';
    caption.textContent = 'Meridian Bay — press M to close';
    sheet.append(this.overlayCanvas, caption);
    this.overlay.append(sheet);

    this.expandedCache = document.createElement('canvas');

    this.element.append(dialBox, this.overlay);

    this.layout();
    window.addEventListener('resize', this.onResize, { passive: true });
    this.render();
  }

  get expanded(): boolean {
    return this.isExpanded;
  }

  setExpanded(expanded: boolean): void {
    if (this.isExpanded === expanded || this.disposed) return;
    this.isExpanded = expanded;
    this.element.classList.toggle('is-expanded', expanded);
    this.overlay.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    // The HUD is a separate layer with no reference to this one, so the state
    // is published on <body> and ui.css quietens the chrome that would
    // otherwise sit on top of the open map.
    document.body.classList.toggle(BODY_MAP_OPEN, expanded);
    if (expanded) this.layoutExpanded();
    this.dirty = true;
    this.render();
  }

  /** Called every frame. Cheap: one blit plus the marker. */
  update(x: number, z: number, yaw: number): void {
    if (this.disposed) return;
    if (x === this.playerX && z === this.playerZ && yaw === this.playerYaw && !this.dirty) return;
    this.playerX = x;
    this.playerZ = z;
    this.playerYaw = yaw;
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    document.body.classList.remove(BODY_MAP_OPEN);
    // Release the raster memory; a detached canvas of 0x0 frees its backing store.
    this.staticLayer.width = 0;
    this.staticLayer.height = 0;
    this.expandedCache.width = 0;
    this.expandedCache.height = 0;
    this.element.remove();
  }

  // -- layout ---------------------------------------------------------------

  private layout(): void {
    this.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const device = Math.round(this.size * this.dpr);
    if (this.dial.width !== device || this.dial.height !== device) {
      this.dial.width = device;
      this.dial.height = device;
    }
    this.dial.style.width = `${this.size}px`;
    this.dial.style.height = `${this.size}px`;
    this.layoutExpanded();
  }

  private layoutExpanded(): void {
    const aspect = this.bounds.width / this.bounds.depth;
    // A viewport can read as zero while the page is still coming up or while
    // the tab is hidden; falling back keeps the map from baking a 1x1 canvas
    // it would then have to be told to rebuild.
    const viewWidth = Math.max(320, window.innerWidth || 0);
    const viewHeight = Math.max(240, window.innerHeight || 0);
    const limit = Math.min(viewWidth, viewHeight) * EXPANDED_FRACTION;
    let cssHeight = Math.min(limit, EXPANDED_MAX);
    let cssWidth = cssHeight * aspect;
    const maxWidth = Math.min(viewWidth * 0.9, EXPANDED_MAX);
    if (cssWidth > maxWidth) {
      cssWidth = maxWidth;
      cssHeight = cssWidth / aspect;
    }
    const width = Math.max(1, Math.round(cssWidth * this.dpr));
    const height = Math.max(1, Math.round(cssHeight * this.dpr));
    this.overlayCanvas.style.width = `${Math.round(cssWidth)}px`;
    this.overlayCanvas.style.height = `${Math.round(cssHeight)}px`;
    if (this.overlayCanvas.width !== width || this.overlayCanvas.height !== height) {
      this.overlayCanvas.width = width;
      this.overlayCanvas.height = height;
    }
    if (this.expandedWidth !== width || this.expandedHeight !== height) {
      this.expandedWidth = width;
      this.expandedHeight = height;
      if (this.isExpanded) this.buildExpandedCache();
    }
  }

  // -- per-frame ------------------------------------------------------------

  private render(): void {
    this.dirty = false;
    if (this.isExpanded) this.renderExpanded();
    else this.renderDial();
  }

  private renderDial(): void {
    const ctx = this.dialCtx;
    const side = this.dial.width;
    if (side === 0) return;
    const radius = side * 0.5;
    const span = this.size * this.metresPerPixel * STATIC_SCALE * this.dpr;
    // Source crop in static-layer pixels, centred on the player.
    const centre = worldToMap(this.playerX, this.playerZ, this.bounds);
    const sourceSpan = span / this.dpr;

    ctx.save();
    ctx.clearRect(0, 0, side, side);
    ctx.beginPath();
    ctx.arc(radius, radius, radius, 0, TAU);
    ctx.clip();
    ctx.fillStyle = MINIMAP_PALETTE.beyond;
    ctx.fillRect(0, 0, side, side);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      this.staticLayer,
      centre.x - sourceSpan * 0.5,
      centre.y - sourceSpan * 0.5,
      sourceSpan,
      sourceSpan,
      0,
      0,
      side,
      side,
    );
    // Markers ride on top at a fixed screen size, and anything outside the
    // crop is pinned to the rim so it still points the way.
    const originX = centre.x - sourceSpan * 0.5;
    const originY = centre.y - sourceSpan * 0.5;
    const k = side / sourceSpan;
    const project = (wx: number, wz: number): MapPoint => {
      const m = worldToMap(wx, wz, this.bounds);
      return { x: (m.x - originX) * k, y: (m.y - originY) * k };
    };
    this.drawMarkers(ctx, project, this.dpr, {
      cx: radius,
      cy: radius,
      radius: radius - 9 * this.dpr,
    });
    this.drawPlayer(ctx, radius, radius, this.dpr, 30);
    ctx.restore();
  }

  private renderExpanded(): void {
    const ctx = this.overlayCtx;
    const { width, height } = this.overlayCanvas;
    if (width === 0 || height === 0) return;
    if (this.expandedCache.width !== width || this.expandedCache.height !== height) {
      this.buildExpandedCache();
    }
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.expandedCache, 0, 0);
    const scale = width / this.bounds.width;
    const point = worldToMap(this.playerX, this.playerZ, this.bounds, scale);
    // A shade larger than on the dial: the marker has a whole city around it
    // here and would otherwise be lost among the streets.
    this.drawPlayer(ctx, point.x, point.y, this.dpr * 1.35, 30);
  }

  /** The player arrow and its field-of-view wedge, drawn at (cx, cy). */
  private drawPlayer(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    scale: number,
    reach: number,
  ): void {
    const radius = reach * scale;
    const wedge = fovWedgePoints(this.playerYaw, radius);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let i = 1; i < wedge.length; i += 1) {
      const point = wedge[i];
      if (!point) continue;
      ctx.lineTo(cx + point.x, cy + point.y);
    }
    ctx.closePath();
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, MINIMAP_PALETTE.fov);
    gradient.addColorStop(1, 'rgba(238, 242, 244, 0)');
    ctx.fillStyle = gradient;
    ctx.fill();

    const heading = headingVector(this.playerYaw);
    const px = -heading.y;
    const py = heading.x;
    const nose = 8.2 * scale;
    const tail = 5.4 * scale;
    const wing = 5.0 * scale;
    ctx.beginPath();
    ctx.moveTo(cx + heading.x * nose, cy + heading.y * nose);
    ctx.lineTo(cx - heading.x * tail + px * wing, cy - heading.y * tail + py * wing);
    ctx.lineTo(cx - heading.x * tail * 0.42, cy - heading.y * tail * 0.42);
    ctx.lineTo(cx - heading.x * tail - px * wing, cy - heading.y * tail - py * wing);
    ctx.closePath();
    ctx.fillStyle = MINIMAP_PALETTE.player;
    ctx.fill();
    ctx.lineWidth = 1.1 * scale;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = MINIMAP_PALETTE.playerEdge;
    ctx.stroke();
    ctx.restore();
  }

  // -- static raster --------------------------------------------------------

  private toStatic(x: number, z: number): MapPoint {
    return worldToMap(x, z, this.bounds);
  }

  private fillRect(ctx: CanvasRenderingContext2D, rect: Rect, colour: string): void {
    const a = this.toStatic(rect.minX, rect.minZ);
    const b = this.toStatic(rect.maxX, rect.maxZ);
    ctx.fillStyle = colour;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }

  /**
   * Rasterises the whole city once. Order is water, corridors, carriageways,
   * block interiors, buildings, then markers - each layer only ever sits inside
   * the gap the previous one left, so nothing is overpainted by accident.
   */
  private buildStaticLayer(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.staticLayer;
    ctx.fillStyle = MINIMAP_PALETTE.land;
    ctx.fillRect(0, 0, width, height);

    this.drawBay(ctx, height);

    for (const street of this.plan.streets) {
      this.fillRect(ctx, streetExtent(street), MINIMAP_PALETTE.pavement);
    }
    for (const street of this.plan.streets) {
      const half = street.roadHalf;
      const rect: Rect =
        street.axis === 'x'
          ? {
              minX: street.position - half,
              maxX: street.position + half,
              minZ: street.from,
              maxZ: street.to,
            }
          : {
              minX: street.from,
              maxX: street.to,
              minZ: street.position - half,
              maxZ: street.position + half,
            };
      this.fillRect(
        ctx,
        rect,
        street.kind === 'arterial' ? MINIMAP_PALETTE.arterial : MINIMAP_PALETTE.road,
      );
    }

    for (const block of this.plan.blocks) this.drawBlock(ctx, block);
    for (const parcel of this.plan.parcels) this.drawParcel(ctx, parcel);
    // NOTE: markers are deliberately NOT baked here. The static layer is
    // 3.2 px per metre and is then scaled to whichever view is drawing it, so
    // a marker baked at world scale shrank with the zoom: the gun-store pin
    // measured THREE pixels on the expanded map, with its own crosshair
    // overdrawing what was left of the fill. They are drawn per-view instead,
    // at a fixed size in screen pixels - see `drawMarkers`.
  }

  /** The bay: everything west of the shoreline curve. */
  private drawBay(ctx: CanvasRenderingContext2D, height: number): void {
    const step = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (let z = this.bounds.minZ; z <= this.bounds.maxZ + step; z += step) {
      const clamped = Math.min(z, this.bounds.maxZ);
      const point = this.toStatic(shorelineX(clamped), clamped);
      ctx.lineTo(point.x, point.y);
    }
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = MINIMAP_PALETTE.water;
    ctx.fill();
    ctx.strokeStyle = MINIMAP_PALETTE.shore;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  private drawBlock(ctx: CanvasRenderingContext2D, block: CityBlock): void {
    const colour =
      block.kind === 'park'
        ? MINIMAP_PALETTE.park
        : block.kind === 'plaza'
          ? MINIMAP_PALETTE.plaza
          : MINIMAP_PALETTE.block;
    this.fillRect(ctx, block.rect, colour);
  }

  private drawParcel(ctx: CanvasRenderingContext2D, parcel: Parcel): void {
    const a = this.toStatic(parcel.rect.minX, parcel.rect.minZ);
    const b = this.toStatic(parcel.rect.maxX, parcel.rect.maxZ);
    const w = b.x - a.x;
    const h = b.y - a.y;
    ctx.fillStyle = parcel.enterable ? MINIMAP_PALETTE.enterable : MINIMAP_PALETTE.building;
    ctx.fillRect(a.x, a.y, w, h);
    // A hairline between neighbours, otherwise a terrace reads as one long slab.
    ctx.strokeStyle = MINIMAP_PALETTE.buildingEdge;
    ctx.lineWidth = 0.9;
    ctx.strokeRect(a.x + 0.45, a.y + 0.45, w - 0.9, h - 0.9);
  }

  /**
   * Draws every marker at a FIXED SIZE IN SCREEN PIXELS, on top of whatever
   * view is being composited.
   *
   * `project` maps world metres to that view's pixels. `edge`, when given,
   * clamps a marker that falls outside the view onto a ring of that radius
   * around the centre, so an off-screen gun store still tells the player which
   * way to walk instead of silently not existing.
   */
  /**
   * Points the map at somewhere, or clears it.
   *
   * REDRAWS BOTH VIEWS, and throws away the expanded map's cache.
   *
   * The waypoint moves when the mission stage changes, which usually happens
   * while the player is standing still listening to somebody - and `update`
   * returns early when nothing has moved. Worse, the pin is painted into the
   * full map's cached raster along with the streets and the district names,
   * which is only rebuilt when the viewport size changes. Without both of
   * these the dial kept pointing at the last destination until the player
   * turned their head, and the full map kept pointing at it until they resized
   * the window.
   */
  setWaypoint(waypoint: { readonly x: number; readonly z: number } | null): void {
    const same =
      (this.waypoint === null && waypoint === null) ||
      (this.waypoint !== null &&
        waypoint !== null &&
        this.waypoint.x === waypoint.x &&
        this.waypoint.z === waypoint.z);
    if (same) return;
    this.waypoint = waypoint;
    if (this.disposed) return;
    // A zero-width canvas fails the size check in `renderExpanded`, which is
    // what makes it rebuild - and frees the old raster on the way.
    this.expandedCache.width = 0;
    this.expandedCache.height = 0;
    this.dirty = true;
    this.render();
  }

  private drawMarkers(
    ctx: CanvasRenderingContext2D,
    project: (x: number, z: number) => MapPoint,
    unit: number,
    edge?: { cx: number; cy: number; radius: number },
  ): void {
    const clamp = (p: MapPoint): { x: number; y: number; off: boolean } => {
      if (!edge) return { x: p.x, y: p.y, off: false };
      const dx = p.x - edge.cx;
      const dy = p.y - edge.cy;
      const d = Math.hypot(dx, dy);
      if (d <= edge.radius) return { x: p.x, y: p.y, off: false };
      const k = edge.radius / d;
      return { x: edge.cx + dx * k, y: edge.cy + dy * k, off: true };
    };

    for (const landmark of this.plan.landmarks) {
      const p = clamp(project(landmark.x, landmark.z));
      if (p.off) continue; // Landmarks do not need an off-screen arrow.
      drawLandmarkPin(ctx, p.x, p.y, 6 * unit);
    }

    for (const parcel of this.plan.parcels) {
      if (!parcel.enterable) continue;
      const centre = project(
        (parcel.rect.minX + parcel.rect.maxX) * 0.5,
        (parcel.rect.minZ + parcel.rect.maxZ) * 0.5,
      );
      const isShop = parcel.interiorKind === 'gunStore';
      const p = clamp(centre);
      if (p.off && !isShop) continue;
      if (isShop) drawShopPin(ctx, p.x, p.y, 9 * unit, p.off);
      else drawDoorPin(ctx, p.x, p.y, 5.5 * unit);
    }

    /*
     * The mission waypoint, drawn LAST so it is on top of every other pin.
     *
     * It is the only marker that is allowed to survive being clamped to the
     * rim: the whole point of it is telling the player which way to drive, and
     * a waypoint that vanishes the moment it leaves the minimap is a waypoint
     * that is missing exactly when it is needed.
     */
    if (this.waypoint) {
      const p = clamp(project(this.waypoint.x, this.waypoint.z));
      drawWaypointPin(ctx, p.x, p.y, 8 * unit, p.off);
    }
  }



  // -- expanded raster ------------------------------------------------------

  /**
   * The expanded map: the static layer scaled to the display size with district
   * names, arterial street names, landmark labels and a scale bar drawn on top
   * at device resolution. Rebuilt only when the viewport changes.
   */
  private buildExpandedCache(): void {
    const width = this.expandedWidth;
    const height = this.expandedHeight;
    if (width <= 0 || height <= 0) return;
    this.expandedCache.width = width;
    this.expandedCache.height = height;
    const ctx = context2d(this.expandedCache);
    const scale = width / this.bounds.width;
    const unit = Math.max(1, this.dpr);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = MINIMAP_PALETTE.beyond;
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.staticLayer, 0, 0, width, height);

    const project = (x: number, z: number): MapPoint => worldToMap(x, z, this.bounds, scale);
    ctx.textBaseline = 'middle';

    // Painted smallest first so the district names, which carry the map, win
    // any collision with a street or a landmark caption.
    this.drawMarkers(ctx, project, unit);
    this.drawStreetLabels(ctx, project, unit);
    this.drawLandmarkLabels(ctx, project, width, unit);
    this.drawDistrictLabels(ctx, project, unit);
    this.drawScaleBar(ctx, height, scale, unit);
    this.drawLegend(ctx, width, height, unit);
  }

  private labelFont(size: number, weight: number, unit: number): string {
    return `${weight} ${size * unit}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  }

  private drawDistrictLabels(
    ctx: CanvasRenderingContext2D,
    project: (x: number, z: number) => MapPoint,
    unit: number,
  ): void {
    ctx.font = this.labelFont(11, 600, unit);
    ctx.fillStyle = MINIMAP_PALETTE.label;
    for (const anchor of districtAnchors(this.plan)) {
      const point = project(anchor.x, anchor.z);
      this.drawTrackedText(
        ctx,
        DISTRICT_LABELS[anchor.district].toUpperCase(),
        point.x,
        point.y,
        2.6 * unit,
        3.4 * unit,
      );
    }
  }

  private drawStreetLabels(
    ctx: CanvasRenderingContext2D,
    project: (x: number, z: number) => MapPoint,
    unit: number,
  ): void {
    ctx.font = this.labelFont(9, 500, unit);
    ctx.fillStyle = MINIMAP_PALETTE.labelDim;
    for (const street of labelledStreets(this.plan)) {
      const name = street.name.toUpperCase();
      if (street.axis === 'x') {
        // North-south street: the name runs up it, so the text is turned too.
        const along = (Math.max(street.from, this.bounds.minZ) + Math.min(street.to, this.bounds.maxZ)) / 2;
        const point = project(street.position, along);
        ctx.save();
        ctx.translate(point.x, point.y);
        ctx.rotate(-Math.PI / 2);
        this.drawTrackedText(ctx, name, 0, 0, 1.8 * unit, 2.8 * unit);
        ctx.restore();
      } else {
        const from = Math.max(street.from, this.bounds.minX);
        const to = Math.min(street.to, this.bounds.maxX);
        const point = project((from + to) / 2, street.position);
        this.drawTrackedText(ctx, name, point.x, point.y, 1.8 * unit, 2.8 * unit);
      }
    }
  }

  private drawLandmarkLabels(
    ctx: CanvasRenderingContext2D,
    project: (x: number, z: number) => MapPoint,
    width: number,
    unit: number,
  ): void {
    ctx.font = this.labelFont(9, 500, unit);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.8 * unit;
    ctx.strokeStyle = MINIMAP_PALETTE.labelHalo;
    ctx.fillStyle = MINIMAP_PALETTE.label;
    for (const landmark of this.plan.landmarks) {
      const point = project(landmark.x, landmark.z);
      // Labels near the east edge read inward so they cannot run off the sheet.
      const flip = point.x > width * 0.8;
      ctx.textAlign = flip ? 'right' : 'left';
      const tx = point.x + (flip ? -9 * unit : 9 * unit);
      ctx.strokeText(landmark.name, tx, point.y);
      ctx.fillText(landmark.name, tx, point.y);
    }
    ctx.textAlign = 'left';
  }

  /** Canvas has no letter-spacing everywhere yet, so labels are tracked by hand. */
  private drawTrackedText(
    ctx: CanvasRenderingContext2D,
    text: string,
    cx: number,
    cy: number,
    tracking: number,
    halo: number,
  ): void {
    const chars = [...text];
    let total = 0;
    const widths: number[] = [];
    for (const char of chars) {
      const w = ctx.measureText(char).width;
      widths.push(w);
      total += w;
    }
    total += tracking * Math.max(0, chars.length - 1);
    const align = ctx.textAlign;
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.lineWidth = halo;
    ctx.strokeStyle = MINIMAP_PALETTE.labelHalo;
    let cursor = cx - total * 0.5;
    for (let i = 0; i < chars.length; i += 1) {
      const char = chars[i];
      if (char === undefined) continue;
      if (halo > 0) ctx.strokeText(char, cursor, cy);
      ctx.fillText(char, cursor, cy);
      cursor += (widths[i] ?? 0) + tracking;
    }
    ctx.textAlign = align;
  }

  /**
   * A key for the map's symbols.
   *
   * Without it a warm ring is just a warm ring: the player has no way to learn
   * that it means "you can go inside this one", which is exactly the thing the
   * markers exist to say.
   */
  private drawLegend(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    unit: number,
  ): void {
    const rows: [string, (x: number, y: number) => void][] = [
      [
        'Gun store',
        (x, y) => drawShopPin(ctx, x, y, 7 * unit),
      ],
      [
        'Enter this building',
        (x, y) => {
          ctx.beginPath();
          ctx.arc(x, y, 5.5 * unit, 0, TAU);
          ctx.strokeStyle = MINIMAP_PALETTE.enterable;
          ctx.lineWidth = 2.2 * unit;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, 2.2 * unit, 0, TAU);
          ctx.fillStyle = MINIMAP_PALETTE.playerEdge;
          ctx.fill();
        },
      ],
      [
        'Landmark',
        (x, y) => {
          const r = 6 * unit;
          ctx.beginPath();
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.closePath();
          ctx.fillStyle = MINIMAP_PALETTE.landmark;
          ctx.fill();
          ctx.strokeStyle = MINIMAP_PALETTE.playerEdge;
          ctx.lineWidth = 1.4 * unit;
          ctx.stroke();
        },
      ],
    ];

    const pad = 14 * unit;
    const rowHeight = 20 * unit;
    const boxW = 168 * unit;
    const boxH = pad * 2 + rowHeight * rows.length;
    const x0 = width - boxW - pad;
    const y0 = height - boxH - pad;

    ctx.fillStyle = 'rgba(9, 12, 15, 0.82)';
    ctx.strokeStyle = 'rgba(200, 160, 106, 0.28)';
    ctx.lineWidth = 1 * unit;
    ctx.beginPath();
    ctx.rect(x0, y0, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = this.labelFont(10, 500, unit);
    rows.forEach(([label, glyph], i) => {
      const cy = y0 + pad + rowHeight * (i + 0.5);
      glyph(x0 + pad + 8 * unit, cy);
      ctx.fillStyle = MINIMAP_PALETTE.label;
      ctx.fillText(label, x0 + pad + 24 * unit, cy);
    });
  }

  private drawScaleBar(
    ctx: CanvasRenderingContext2D,
    height: number,
    scale: number,
    unit: number,
  ): void {
    const metres = 100;
    const length = metres * scale;
    const x = 16 * unit;
    const y = height - 20 * unit;
    ctx.strokeStyle = MINIMAP_PALETTE.labelDim;
    ctx.lineWidth = 1 * unit;
    ctx.beginPath();
    ctx.moveTo(x, y - 3 * unit);
    ctx.lineTo(x, y);
    ctx.lineTo(x + length, y);
    ctx.lineTo(x + length, y - 3 * unit);
    ctx.stroke();
    ctx.fillStyle = MINIMAP_PALETTE.labelDim;
    ctx.font = this.labelFont(9, 500, unit);
    ctx.textAlign = 'left';
    ctx.fillText(`${metres} m`, x + length + 6 * unit, y - 1 * unit);
  }
}

/**
 * The gun-store pin: a filled teardrop with a crosshair.
 *
 * Sized in SCREEN pixels by the caller, never in world units - baked at world
 * scale it collapsed to three pixels once the map was zoomed out. When `off`
 * is set the pin is riding the edge of the view and gains a ring, so it reads
 * as "this way" rather than "it is here".
 */
/**
 * The mission waypoint: a hollow diamond with a dot in it, in the club's own
 * magenta so it cannot be confused with the gun shop's red pin.
 *
 * `off` draws it as an arrow pointing off the rim instead, which is the state
 * it spends most of a cross-city drive in.
 */
function drawWaypointPin(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  off: boolean,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = Math.max(1.4, r * 0.22);
  ctx.strokeStyle = 'rgba(12, 14, 18, 0.85)';
  ctx.fillStyle = MINIMAP_PALETTE.waypoint;

  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.78, 0);
  ctx.lineTo(0, r);
  ctx.lineTo(-r * 0.78, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  if (!off) {
    // A dark pip in the middle, so a waypoint sitting on top of a building
    // block still reads as a marker rather than as a coloured tile.
    ctx.fillStyle = 'rgba(12, 14, 18, 0.9)';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.24, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawShopPin(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  off = false,
): void {
  if (off) {
    ctx.beginPath();
    ctx.arc(x, y, r * 1.05, 0, TAU);
    ctx.fillStyle = 'rgba(9, 12, 15, 0.85)';
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(x, y + r);
  ctx.bezierCurveTo(x - r * 0.95, y + r * 0.15, x - r * 0.85, y - r * 0.75, x, y - r * 0.8);
  ctx.bezierCurveTo(x + r * 0.85, y - r * 0.75, x + r * 0.95, y + r * 0.15, x, y + r);
  ctx.closePath();
  ctx.fillStyle = MINIMAP_PALETTE.gunStore;
  ctx.fill();
  ctx.strokeStyle = MINIMAP_PALETTE.playerEdge;
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.stroke();
  // Crosshair, only once the pin is big enough to carry it. Below that the
  // strokes eat the fill and the pin stops reading as red at all.
  if (r >= 7) {
    ctx.beginPath();
    ctx.arc(x, y - r * 0.12, r * 0.28, 0, TAU);
    ctx.moveTo(x - r * 0.44, y - r * 0.12);
    ctx.lineTo(x + r * 0.44, y - r * 0.12);
    ctx.moveTo(x, y - r * 0.56);
    ctx.lineTo(x, y + r * 0.32);
    ctx.strokeStyle = MINIMAP_PALETTE.playerEdge;
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.stroke();
  }
}

/** An ordinary enterable door: a warm ring with a dark centre. */
function drawDoorPin(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.strokeStyle = MINIMAP_PALETTE.enterable;
  ctx.lineWidth = Math.max(1.4, r * 0.4);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.4, 0, TAU);
  ctx.fillStyle = MINIMAP_PALETTE.playerEdge;
  ctx.fill();
}

/** A landmark: a pale diamond. */
function drawLandmarkPin(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = MINIMAP_PALETTE.landmark;
  ctx.fill();
  ctx.strokeStyle = MINIMAP_PALETTE.playerEdge;
  ctx.lineWidth = Math.max(1, r * 0.22);
  ctx.stroke();
}
