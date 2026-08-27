/**
 * Meridian Bay's gun shop.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { GunShop } from './shop/GunShop';
 *
 *   const shop = new GunShop({ plan, player, baseUrl: import.meta.env.BASE_URL });
 *   engine.scene.add(shop.group);          // the clerk and the stock
 *   document.body.appendChild(shop.element); // the counter interface
 *   void shop.load();                       // generated assets, off the critical path
 *
 *   // 1. Claim the counter before the door handler sees it.
 *   interactions.onActivate = ({ point }) => {
 *     if (shop.tryOpen(point)) return;
 *     ...existing door handling...
 *   };
 *
 *   // 2. Give up and take back the pointer, and keep the pause menu away.
 *   shop.onOpenChange = (open) => {
 *     controller.setPaused(open);
 *     if (open) document.exitPointerLock();
 *     else controller.requestPointerLock();
 *   };
 *   // in the pointerlockchange handler:  if (!locked && hadPointerLock && !shop.open)
 *   // in the Escape handler:             if (!shop.open) showPause();
 *
 *   // 3. One place redraws everything that shows money.
 *   player.onChange = () => {
 *     hud.setMoney(player.money);
 *     shop.refresh();
 *   };
 *   hud.setMoney(player.money);   // once, for the opening balance
 *
 *   // 4. Once per frame, after the controller has moved the player.
 *   shop.update(dt, { x: state.x, z: state.z });
 *
 *   shop.dispose();               // on unload
 *
 * `group` adds at most three draw calls (clerk, rifles, pistols) and NO
 * lights: the interior light budget is already at its cap, and this shop's
 * four fittings are requested by the world builder like every other room's.
 * The counter's display case renders in its OWN small context on its own tiny
 * canvas, and only while the counter is open; see `WeaponPreview.ts`.
 *
 * ============================================================================
 *
 * The shop is deliberately three separable things:
 *   `agents/StandingCharacter.ts`  Ilse, one instance of a baked character
 *   `WeaponDisplay.ts`  the generated stock, instanced
 *   `ui/GunShopUi.ts`   the counter interface
 * and this class is only the wiring between them, the interaction point, and
 * `PlayerState`. None of them owns any economy state; every purchase goes
 * straight to `PlayerState`, which is the single source of truth the HUD, the
 * combat layer and the police response all read.
 */

import { Group, type Object3D } from 'three';

import type { PlayerState, WeaponId } from '../player/PlayerState';
import { GunShopUi } from '../ui/GunShopUi';
import type { CityPlan, Parcel } from '../world/CityPlan';
import { gunStoreAnchors, type GunStoreAnchors } from '../world/build/interiorProps';
import type { InteractionPoint } from '../world/build/types';
import { StandingCharacter } from '../agents/StandingCharacter';
import { WeaponDisplay } from './WeaponDisplay';

export interface GunShopOptions {
  readonly plan: CityPlan;
  readonly player: PlayerState;
  /** `import.meta.env.BASE_URL`. Defaults to the site root. */
  readonly baseUrl?: string | undefined;
  /** Optional one-shot sound hook: `'ui-tick'` on open, close and purchase. */
  readonly onSound?: ((id: string) => void) | undefined;
}

export interface GunShopStats {
  readonly located: boolean;
  readonly parcelId: string | null;
  readonly clerk: boolean;
  readonly displays: number;
  readonly stockTriangles: number;
  readonly open: boolean;
}

export class GunShop {
  /** Everything the shop draws. Add once to the scene. */
  readonly group: Object3D;
  /** The counter interface. Append once to `document.body`. */
  readonly element: HTMLElement;

  /** Fires when the counter opens or closes, so the app can move pointer lock. */
  onOpenChange: ((open: boolean) => void) | null = null;

  private readonly player: PlayerState;
  private readonly ui: GunShopUi;
  private readonly clerk: StandingCharacter;
  private readonly stock: WeaponDisplay;
  private readonly parcel: Parcel | null;
  private readonly anchors: GunStoreAnchors | null;
  private readonly sound: ((id: string) => void) | null;
  private displays = 0;
  private isOpen = false;
  private disposed = false;

  constructor(options: GunShopOptions) {
    this.player = options.player;
    this.sound = options.onSound ?? null;

    this.parcel = options.plan.parcels.find((p) => p.interiorKind === 'gunStore') ?? null;
    this.anchors = this.parcel ? gunStoreAnchors(this.parcel) : null;

    this.group = new Group();
    this.group.name = 'gun-shop';

    this.clerk = new StandingCharacter();
    this.stock = new WeaponDisplay(options.baseUrl ?? '/');
    this.group.add(this.clerk.group, this.stock.group);
    // Nothing to draw until the counter is found and the assets land.
    this.clerk.group.visible = false;

    this.ui = new GunShopUi(
      {
        onBuyWeapon: (id) => this.buyWeapon(id),
        onBuyAmmo: (id) => this.buyAmmo(id),
        onClose: () => this.close(),
      },
      options.baseUrl ?? '/',
    );
    this.element = this.ui.element;

    if (this.anchors) {
      this.clerk.place({
        x: this.anchors.clerk.x,
        y: this.anchors.clerk.y,
        z: this.anchors.clerk.z,
        heading: this.anchors.clerkHeading,
      });
    }
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** Where the shop is, for the caller's own diagnostics. Null if unplaced. */
  get location(): { readonly x: number; readonly z: number } | null {
    return this.anchors ? { x: this.anchors.clerk.x, z: this.anchors.clerk.z } : null;
  }

  get stats(): GunShopStats {
    return {
      located: this.anchors !== null,
      parcelId: this.parcel?.id ?? null,
      clerk: this.clerk.ready,
      displays: this.displays,
      stockTriangles: this.stock.triangles,
      open: this.isOpen,
    };
  }

  /**
   * Downloads the clerk and the generated stock.
   *
   * Deliberately not awaited by the caller's boot sequence: a shop that is
   * short of a rifle for two seconds is better than a city that takes two
   * seconds longer to start. Every failure degrades to less furniture, never
   * to a broken counter.
   */
  async load(): Promise<void> {
    const anchors = this.anchors;
    if (!anchors) return;
    const [clerk, displays] = await Promise.all([
      this.clerk.load(),
      this.stock.load(anchors),
    ]);
    if (this.disposed) return;
    this.clerk.group.visible = clerk;
    this.displays = displays;
  }

  /**
   * Claims an interaction point. Returns true when this was the shop counter,
   * in which case the caller must not also treat it as a door.
   */
  tryOpen(point: InteractionPoint): boolean {
    if (this.disposed || !this.anchors) return false;
    if (point.id !== this.anchors.interactionId) return false;
    if (!this.isOpen) this.openCounter();
    return true;
  }

  /** Closes the counter. Safe to call when it is already closed. */
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.ui.close();
    this.sound?.('ui-tick');
    this.onOpenChange?.(false);
  }

  /** Redraws the interface from `PlayerState`. Safe at any time. */
  refresh(): void {
    if (this.disposed || !this.ui.visible) return;
    this.ui.update(this.player.snapshot());
  }

  /**
   * Per frame. Only two things need it: the clerk's idle clip, and whether the
   * stock is close enough to be worth drawing.
   */
  update(dt: number, at: { readonly x: number; readonly z: number }): void {
    if (this.disposed) return;
    // The display case turns on the game's clock, not on a private
    // `requestAnimationFrame`, so it stops exactly when the game stops and
    // steps exactly when an automated harness steps the game by hand. A no-op
    // while the counter is shut.
    this.ui.tick(dt);
    if (!this.anchors) return;
    const anchor = this.anchors.clerk;
    this.stock.update(at.x, at.z, anchor);
    // The clerk shares the stock's visibility rule: he is in the same room.
    this.clerk.group.visible = this.clerk.ready && this.stock.stockVisible;
    if (this.clerk.group.visible) this.clerk.update(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.isOpen = false;
    this.ui.dispose();
    this.clerk.dispose();
    this.stock.dispose();
    this.group.clear();
  }

  // -- internals ------------------------------------------------------------

  private openCounter(): void {
    this.isOpen = true;
    // The caller releases pointer lock first; the interface takes the keyboard
    // in the frame after it is shown, which is why the order matters here.
    this.onOpenChange?.(true);
    this.ui.open(this.player.snapshot());
    this.sound?.('ui-tick');
  }

  private buyWeapon(id: WeaponId): boolean {
    const sold = this.player.buyWeapon(id);
    // `PlayerState.onChange` is a single slot the application owns, so the
    // shop never relies on it: it redraws itself after every sale it makes.
    this.refresh();
    if (sold) this.sound?.('ui-tick');
    return sold;
  }

  private buyAmmo(id: WeaponId): boolean {
    const sold = this.player.buyAmmo(id);
    this.refresh();
    if (sold) this.sound?.('ui-tick');
    return sold;
  }
}
