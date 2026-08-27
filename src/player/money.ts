/**
 * How money is written down, once.
 *
 * The HUD's corner, the gun shop's wallet and price list, and the mission's
 * payment banner all show the same currency, so they all have to agree about
 * what it looks like - and the mission is deliberately free of the DOM, so it
 * cannot reach into `ui/` for it. This module is the shared answer: no
 * imports, no side effects, and a home next to the state that owns the number.
 *
 * `en-US` grouping rather than the locale's, because the amounts are Meridian
 * Bay dollars and the display must not change shape with the browser's region.
 */
export function formatMoney(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}
