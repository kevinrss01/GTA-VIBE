/**
 * The counter interface: what the shop sells and what the player can afford.
 *
 * The same layer as the pause menu in every way that matters - the same
 * panel, the same typography, the same focus discipline - because this is the
 * second modal surface in the product and two modal surfaces that disagree
 * about their own design read as two different games.
 *
 * ## It owns no state
 *
 * Money, weapons and ammunition all live in `PlayerState`. This class reads a
 * snapshot to draw and calls back to buy; it never caches a balance, so it
 * cannot disagree with the HUD or with a purchase made anywhere else.
 * `refresh()` redraws from the current snapshot and is safe to call at any
 * time, including from `PlayerState.onChange`.
 *
 * ## Focus
 *
 * Pointer lock is released by the caller before this opens, so the keyboard is
 * ours. Every action is a real `<button>`: Tab and Enter work for free, arrow
 * keys move between rows and between the two actions in a row, and the panel
 * swallows every other key so W/A/S/D and E never reach the game underneath.
 *
 * ## The showcase
 *
 * Above the list is the weapon the keyboard is currently on, drawn as the REAL
 * asset on a slow turntable with its stats as bars beside it - the display
 * case, not the price list. Selection is not a separate thing to learn: it
 * follows focus, so the arrow keys that already moved between rows now also
 * turn the weapon on the stand, and clicking a row does the same.
 *
 * `WeaponPreview` owns its own small renderer; see that file for why, and for
 * why it contains no point light.
 */

import './ui.css';
import { ALL_WEAPONS, WEAPONS, type PlayerSnapshot, type WeaponId } from '../player/PlayerState';
import { WeaponPreview } from '../shop/WeaponPreview';
import { weaponBars, type WeaponBarKey } from '../shop/weaponStats';

export interface GunShopUiCallbacks {
  /** Buys the weapon outright. Returns true when the sale went through. */
  onBuyWeapon(id: WeaponId): boolean;
  /** Buys one magazine for a weapon already owned. */
  onBuyAmmo(id: WeaponId): boolean;
  onClose(): void;
}

/** The shop's own name. It is a licensed dealer in the Old Quarter, not an armoury. */
export const SHOP_NAME = 'Bellhouse Arms';
const SHOP_EYEBROW = 'Licensed dealer · Old Quarter';

export function formatMoney(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

interface Row {
  readonly id: WeaponId;
  readonly element: HTMLElement;
  readonly name: HTMLElement;
  readonly held: HTMLElement;
  readonly buy: HTMLButtonElement;
  readonly ammo: HTMLButtonElement;
}

/** One stat bar in the showcase: its track fill and its printed number. */
interface Bar {
  readonly fill: HTMLElement;
  readonly value: HTMLElement;
  readonly row: HTMLElement;
}

export class GunShopUi {
  readonly element: HTMLElement;

  private readonly callbacks: GunShopUiCallbacks;
  private readonly panel: HTMLElement;
  private readonly wallet: HTMLElement;
  private readonly status: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly rows: Row[] = [];

  private readonly preview: WeaponPreview;
  private readonly stage: HTMLElement;
  private readonly showName: HTMLElement;
  private readonly showClass: HTMLElement;
  private readonly showPrice: HTMLElement;
  private readonly showNote: HTMLElement;
  private readonly bars = new Map<WeaponBarKey, Bar>();
  private selected: WeaponId | null = null;
  /** The last snapshot drawn, so the showcase can redraw on selection alone. */
  private snapshot: PlayerSnapshot | null = null;

  private isVisible = false;
  private focusHandle = 0;
  private statusTimer = 0;
  private disposed = false;

  constructor(callbacks: GunShopUiCallbacks, baseUrl = '/') {
    this.callbacks = callbacks;
    this.preview = new WeaponPreview(baseUrl);

    this.element = document.createElement('div');
    this.element.className = 'mb-shop';
    this.element.setAttribute('aria-hidden', 'true');
    // Same reason as the pause menu: the fade is a transition, and a closed
    // panel must not keep a place in the tab order while it runs.
    this.element.setAttribute('inert', '');

    this.panel = document.createElement('section');
    this.panel.className = 'mb-shop__panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-label', `${SHOP_NAME} counter`);

    const head = document.createElement('header');
    head.className = 'mb-shop__head';
    const titles = document.createElement('div');
    const eyebrow = document.createElement('p');
    eyebrow.className = 'mb-shop__eyebrow';
    eyebrow.textContent = SHOP_EYEBROW;
    const title = document.createElement('h2');
    title.className = 'mb-shop__title';
    title.textContent = SHOP_NAME;
    titles.append(eyebrow, title);

    const purse = document.createElement('div');
    purse.className = 'mb-shop__purse';
    const purseLabel = document.createElement('p');
    purseLabel.className = 'mb-shop__eyebrow';
    purseLabel.textContent = 'Cash';
    this.wallet = document.createElement('p');
    this.wallet.className = 'mb-shop__wallet';
    this.wallet.setAttribute('aria-live', 'polite');
    this.wallet.textContent = formatMoney(0);
    purse.append(purseLabel, this.wallet);
    head.append(titles, purse);

    // -- the display case ---------------------------------------------------
    const showcase = document.createElement('div');
    showcase.className = 'mb-shop__showcase';

    this.stage = document.createElement('div');
    this.stage.className = 'mb-shop__stage';
    this.stage.append(this.preview.element);
    // No WebGL, no stand: an empty bordered box beside the stats would read as
    // a failed image rather than as a panel that never had one.
    if (!this.preview.available) this.stage.classList.add('is-empty');

    const figures = document.createElement('div');
    figures.className = 'mb-shop__figures';

    const figureHead = document.createElement('div');
    figureHead.className = 'mb-shop__figurehead';
    const naming = document.createElement('div');
    this.showClass = document.createElement('p');
    this.showClass.className = 'mb-shop__eyebrow';
    this.showName = document.createElement('h3');
    this.showName.className = 'mb-shop__showname';
    naming.append(this.showClass, this.showName);
    this.showPrice = document.createElement('p');
    this.showPrice.className = 'mb-shop__showprice';
    figureHead.append(naming, this.showPrice);

    const bars = document.createElement('dl');
    bars.className = 'mb-shop__bars';
    // Built from the first weapon's bar list so the rows exist in the right
    // order before anything is selected; only the widths and numbers change.
    for (const bar of weaponBars(ALL_WEAPONS[0] ?? 'pistol')) {
      const row = document.createElement('div');
      row.className = 'mb-shop__bar';
      const label = document.createElement('dt');
      label.className = 'mb-shop__barlabel';
      label.textContent = bar.label;
      const holder = document.createElement('dd');
      holder.className = 'mb-shop__barvalue';
      const track = document.createElement('span');
      track.className = 'mb-shop__track';
      const fill = document.createElement('span');
      fill.className = 'mb-shop__fill';
      track.append(fill);
      const value = document.createElement('span');
      value.className = 'mb-shop__number';
      holder.append(track, value);
      row.append(label, holder);
      bars.append(row);
      this.bars.set(bar.key, { fill, value, row });
    }

    this.showNote = document.createElement('p');
    this.showNote.className = 'mb-shop__shownote';
    figures.append(figureHead, bars, this.showNote);
    showcase.append(this.stage, figures);

    const list = document.createElement('div');
    list.className = 'mb-shop__list';
    for (const id of ALL_WEAPONS) list.append(this.buildRow(id));

    this.status = document.createElement('p');
    this.status.className = 'mb-shop__status';
    this.status.setAttribute('aria-live', 'polite');

    const foot = document.createElement('footer');
    foot.className = 'mb-shop__foot';
    const hints = document.createElement('dl');
    hints.className = 'mb-keylist';
    for (const [keys, action] of [
      ['↑ ↓ ← →', 'Choose'],
      ['Enter', 'Buy'],
      ['Esc', 'Leave the counter'],
    ] as const) {
      const dt = document.createElement('dt');
      dt.textContent = keys;
      const dd = document.createElement('dd');
      dd.textContent = action;
      hints.append(dt, dd);
    }
    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.className = 'mb-button mb-button--primary';
    this.closeButton.textContent = 'Done';
    this.closeButton.addEventListener('click', this.onCloseClick);
    foot.append(hints, this.closeButton);

    this.panel.append(head, showcase, list, this.status, foot);
    this.element.append(this.panel);

    this.element.addEventListener('keydown', this.onKeyDown);
    // Selection follows focus rather than being a second thing to drive: the
    // arrow keys already move between rows, and this is what makes them also
    // change what is on the stand.
    this.panel.addEventListener('focusin', this.onFocusIn);
    // Modal: no click behind this may reach the canvas and re-lock the pointer.
    this.element.addEventListener('pointerdown', stopEvent);
    this.element.addEventListener('mousedown', stopEvent);
    this.element.addEventListener('click', stopEvent);
  }

  get visible(): boolean {
    return this.isVisible;
  }

  /** Opens the counter on the given snapshot. */
  open(snapshot: PlayerSnapshot): void {
    if (this.disposed || this.isVisible) return;
    this.isVisible = true;
    this.setStatus('');
    // Something has to be on the stand before the panel is visible, or the
    // first frame shows an empty case. Focus moves onto a row a moment later
    // and takes selection with it.
    this.select(this.selected ?? ALL_WEAPONS[0] ?? 'pistol');
    this.preview.setActive(true);
    this.update(snapshot);
    this.element.classList.add('is-open');
    this.element.setAttribute('aria-hidden', 'false');
    this.element.removeAttribute('inert');
    /*
     * Focus twice on purpose. The synchronous call is what actually lands in a
     * backgrounded or throttled tab, where `requestAnimationFrame` may not run
     * for seconds; the frame callback is the belt-and-braces retry for the case
     * where the panel is still mid-transition and refuses focus. The retry
     * checks that focus is still outside the panel first, so it can never steal
     * it back from a player who has already moved.
     */
    this.focusFirst();
    this.focusHandle = window.requestAnimationFrame(() => {
      this.focusHandle = 0;
      if (!this.isVisible) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.panel.contains(active)) return;
      this.focusFirst();
    });
  }

  close(): void {
    if (this.disposed || !this.isVisible) return;
    this.isVisible = false;
    this.preview.setActive(false);
    this.element.classList.remove('is-open');
    this.element.setAttribute('aria-hidden', 'true');
    this.element.setAttribute('inert', '');
    if (this.focusHandle !== 0) {
      window.cancelAnimationFrame(this.focusHandle);
      this.focusHandle = 0;
    }
    // Hand the keyboard back before the caller re-takes pointer lock; a button
    // that still had focus would eat the next Space or Enter.
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.panel.contains(active)) active.blur();
  }

  /**
   * One frame of the display case, from the game's own loop.
   *
   * Deliberately not a private `requestAnimationFrame`: the game already has a
   * clock, and a second one would keep turning in a tab the browser has
   * throttled, or stop in an automated pane where the compositor is idle but
   * the game is being stepped by hand.
   */
  tick(dt: number): void {
    if (this.disposed || !this.isVisible) return;
    this.preview.tick(dt);
  }

  /** Puts a weapon on the stand. Idempotent; safe to call from focus. */
  select(id: WeaponId): void {
    if (this.disposed || this.selected === id) return;
    this.selected = id;
    this.preview.select(id);
    for (const row of this.rows) row.element.classList.toggle('is-selected', row.id === id);
    this.drawShowcase();
  }

  /** The weapon currently on the stand. Exposed for automated QA. */
  get selectedWeapon(): WeaponId | null {
    return this.selected;
  }

  /** Redraws from a snapshot. Cheap enough to call on every state change. */
  update(snapshot: PlayerSnapshot): void {
    if (this.disposed) return;
    this.wallet.textContent = formatMoney(snapshot.money);
    this.snapshot = snapshot;
    this.drawShowcase();

    for (const row of this.rows) {
      const spec = WEAPONS[row.id];
      const owned = snapshot.owned.includes(row.id);
      const rounds = snapshot.ammo[row.id];
      const equipped = snapshot.equipped === row.id;

      row.element.classList.toggle('is-owned', owned);
      row.name.textContent = spec.name;

      row.held.textContent = owned
        ? `${equipped ? 'Carrying' : 'Owned'} · ${rounds} rounds`
        : 'Not owned';
      row.held.classList.toggle('is-live', owned);

      const canBuy = !owned && snapshot.money >= spec.price;
      row.buy.disabled = owned || !canBuy;
      row.buy.textContent = owned ? 'Owned' : formatMoney(spec.price);
      row.buy.classList.toggle('is-unaffordable', !owned && !canBuy);
      row.buy.setAttribute(
        'aria-label',
        owned ? `${spec.name} already owned` : `Buy ${spec.name} for ${formatMoney(spec.price)}`,
      );

      const canAmmo = owned && snapshot.money >= spec.ammoPrice;
      row.ammo.disabled = !canAmmo;
      row.ammo.textContent = `Ammo ${formatMoney(spec.ammoPrice)}`;
      row.ammo.classList.toggle('is-unaffordable', owned && !canAmmo);
      row.ammo.setAttribute(
        'aria-label',
        owned
          ? `Buy ${spec.magazine} rounds for the ${spec.name}, ${formatMoney(spec.ammoPrice)}`
          : `${spec.name} ammunition, weapon not owned`,
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.focusHandle !== 0) window.cancelAnimationFrame(this.focusHandle);
    if (this.statusTimer !== 0) window.clearTimeout(this.statusTimer);
    for (const row of this.rows) {
      row.buy.removeEventListener('click', this.onBuyClick);
      row.ammo.removeEventListener('click', this.onAmmoClick);
      row.element.removeEventListener('click', this.onRowClick);
    }
    this.preview.dispose();
    this.closeButton.removeEventListener('click', this.onCloseClick);
    this.element.removeEventListener('keydown', this.onKeyDown);
    this.panel.removeEventListener('focusin', this.onFocusIn);
    this.element.removeEventListener('pointerdown', stopEvent);
    this.element.removeEventListener('mousedown', stopEvent);
    this.element.removeEventListener('click', stopEvent);
    this.element.remove();
  }

  // -- construction ---------------------------------------------------------

  private buildRow(id: WeaponId): HTMLElement {
    const spec = WEAPONS[id];

    const element = document.createElement('div');
    element.className = 'mb-shop__row';
    element.dataset.weapon = id;
    // The numbers that used to live here are bars in the showcase now, so a
    // click anywhere on the row - not only on a button - has to be able to put
    // this weapon on the stand.
    element.addEventListener('click', this.onRowClick);

    const detail = document.createElement('div');
    detail.className = 'mb-shop__detail';
    const name = document.createElement('p');
    name.className = 'mb-shop__name';
    name.textContent = spec.name;
    const held = document.createElement('p');
    held.className = 'mb-shop__held';
    detail.append(name, held);

    const actions = document.createElement('div');
    actions.className = 'mb-shop__actions';
    const buy = document.createElement('button');
    buy.type = 'button';
    buy.className = 'mb-button mb-shop__action';
    buy.dataset.weapon = id;
    buy.addEventListener('click', this.onBuyClick);
    const ammo = document.createElement('button');
    ammo.type = 'button';
    ammo.className = 'mb-button mb-button--ghost mb-shop__action';
    ammo.dataset.weapon = id;
    ammo.addEventListener('click', this.onAmmoClick);
    actions.append(buy, ammo);

    element.append(detail, actions);
    this.rows.push({ id, element, name, held, buy, ammo });
    return element;
  }

  /**
   * Draws the display case for whatever is selected.
   *
   * Five bars, each one this weapon's value over the best in the catalogue -
   * see `weaponStats.ts` for why that normalisation is the honest one - plus
   * the real number beside it, so nothing about the comparison can mislead.
   */
  private drawShowcase(): void {
    const id = this.selected;
    if (!id) return;
    const spec = WEAPONS[id];
    this.showClass.textContent = spec.pellets > 1 ? `${spec.pellets}-pellet shell` : 'Single round';
    this.showName.textContent = spec.name;

    const owned = this.snapshot?.owned.includes(id) ?? false;
    this.showPrice.textContent = owned ? 'Owned' : formatMoney(spec.price);
    this.showPrice.classList.toggle('is-owned', owned);

    for (const bar of weaponBars(id)) {
      const target = this.bars.get(bar.key);
      if (!target) continue;
      target.fill.style.width = `${(bar.fraction * 100).toFixed(1)}%`;
      // The catalogue's best in this row, so a full bar says why it is full.
      target.row.classList.toggle('is-best', bar.fraction >= 1);
      target.value.textContent = bar.value;
    }

    const rounds = this.snapshot?.ammo[id] ?? 0;
    this.showNote.textContent = owned
      ? `${rounds} rounds held · reload ${spec.reloadSeconds.toFixed(1)}s · ammunition ${formatMoney(spec.ammoPrice)}`
      : `Reload ${spec.reloadSeconds.toFixed(1)}s · ammunition ${formatMoney(spec.ammoPrice)} for ${spec.magazine}`;
  }

  // -- events ---------------------------------------------------------------

  /** Selection follows focus: the arrow keys already move it between rows. */
  private readonly onFocusIn = (event: FocusEvent): void => {
    const id = weaponOf(event.target);
    if (id) this.select(id);
  };

  private readonly onRowClick = (event: MouseEvent): void => {
    const id = weaponOf(event.currentTarget);
    if (id) this.select(id);
  };

  private readonly onBuyClick = (event: MouseEvent): void => {
    event.stopPropagation();
    const id = weaponOf(event.currentTarget);
    if (!id) return;
    const spec = WEAPONS[id];
    if (this.callbacks.onBuyWeapon(id)) {
      this.setStatus(`${spec.name} — sold. ${spec.magazine} rounds in the box.`);
    } else {
      this.setStatus(`Not enough for the ${spec.name}.`);
    }
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) this.recoverFocus(row);
  };

  private readonly onAmmoClick = (event: MouseEvent): void => {
    event.stopPropagation();
    const id = weaponOf(event.currentTarget);
    if (!id) return;
    const spec = WEAPONS[id];
    if (this.callbacks.onBuyAmmo(id)) {
      this.setStatus(`${spec.magazine} rounds for the ${spec.name}.`);
    } else {
      this.setStatus(`No sale: ${spec.name} ammunition is ${formatMoney(spec.ammoPrice)}.`);
    }
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) this.recoverFocus(row);
  };

  private readonly onCloseClick = (event: MouseEvent): void => {
    event.stopPropagation();
    this.callbacks.onClose();
  };

  /**
   * Arrow keys move between rows and between the two actions in a row; every
   * other key except Tab is swallowed so nothing reaches the game behind.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isVisible) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.onClose();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = this.focusableElements();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    event.stopPropagation();

    /*
     * Activate explicitly rather than leaning on the browser's own
     * Enter-activates-a-button behaviour. Two reasons: Space activates on
     * keyUP natively and Enter on keyDOWN, which makes the two keys behave
     * differently for no reason a player would understand; and the default
     * action is suppressed here anyway so a stray Enter can never reach the
     * game underneath. `preventDefault` is what stops this double-firing with
     * the native activation.
     */
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      const active = document.activeElement;
      if (
        active instanceof HTMLButtonElement &&
        this.panel.contains(active) &&
        !active.disabled
      ) {
        event.preventDefault();
        active.click();
      }
      return;
    }

    const vertical = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    const horizontal = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (vertical === 0 && horizontal === 0) return;
    event.preventDefault();

    const focusable = this.focusableElements();
    if (focusable.length === 0) return;
    const active = document.activeElement;
    const here = active instanceof HTMLElement ? focusable.indexOf(active) : -1;

    if (horizontal !== 0) {
      const next = focusable[(here + horizontal + focusable.length) % focusable.length];
      if (next) this.focusAndSelect(next);
      return;
    }

    // Vertically, move a whole row at a time and keep the column if it is
    // still available; falling back to whatever that row does offer.
    const rowIndex = this.rows.findIndex(
      (row) => row.buy === active || row.ammo === active,
    );
    if (rowIndex < 0) {
      const edge = focusable[vertical > 0 ? 0 : focusable.length - 1];
      if (edge) this.focusAndSelect(edge);
      return;
    }
    const wantAmmo = this.rows[rowIndex]?.ammo === active;
    const count = this.rows.length;
    for (let step = 1; step <= count; step += 1) {
      const row = this.rows[(((rowIndex + vertical * step) % count) + count) % count];
      if (!row) continue;
      const preferred = wantAmmo ? row.ammo : row.buy;
      const other = wantAmmo ? row.buy : row.ammo;
      if (!preferred.disabled) {
        this.focusAndSelect(preferred);
        return;
      }
      if (!other.disabled) {
        this.focusAndSelect(other);
        return;
      }
    }
    this.closeButton.focus();
  };

  /**
   * Moves the keyboard AND the display case together.
   *
   * `focusin` normally carries selection, but a browser suppresses focus
   * events entirely while its own window is in the background - which is
   * exactly the state an automated harness drives the game in. Selecting
   * explicitly here makes the arrow keys authoritative rather than dependent
   * on an event the platform may decline to fire.
   */
  private focusAndSelect(element: HTMLElement): void {
    element.focus();
    const id = weaponOf(element);
    if (id) this.select(id);
  }

  /** Puts the keyboard on the first thing worth buying. */
  private focusFirst(): void {
    const first = this.rows.find((row) => !row.buy.disabled) ?? this.rows[0];
    const target = first && !first.buy.disabled ? first.buy : this.closeButton;
    this.focusAndSelect(target);
  }

  /**
   * Buying a weapon disables the button that bought it, and a disabled element
   * cannot hold focus - the browser drops it on `<body>`, where the next arrow
   * key has nothing to move from. Land it on the next thing the player is
   * actually likely to want, which after buying a gun is ammunition for it.
   */
  private recoverFocus(row: Row): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.panel.contains(active) && active !== document.body) {
      if (!(active instanceof HTMLButtonElement) || !active.disabled) return;
    }
    for (const candidate of [row.ammo, row.buy, ...this.focusableElements()]) {
      if (candidate instanceof HTMLButtonElement && candidate.disabled) continue;
      candidate.focus();
      return;
    }
    this.closeButton.focus();
  }

  private focusableElements(): HTMLElement[] {
    return [...this.panel.querySelectorAll<HTMLElement>('button')].filter(
      (node) => !node.hasAttribute('disabled'),
    );
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
    this.status.classList.toggle('is-visible', text.length > 0);
    if (this.statusTimer !== 0) window.clearTimeout(this.statusTimer);
    if (text.length === 0) return;
    this.statusTimer = window.setTimeout(() => {
      this.statusTimer = 0;
      this.status.textContent = '';
      this.status.classList.remove('is-visible');
    }, 4200);
  }
}

function weaponOf(target: EventTarget | null): WeaponId | null {
  if (!(target instanceof HTMLElement)) return null;
  const id = target.dataset.weapon;
  return id !== undefined && (ALL_WEAPONS as readonly string[]).includes(id)
    ? (id as WeaponId)
    : null;
}

function stopEvent(event: Event): void {
  event.stopPropagation();
}
