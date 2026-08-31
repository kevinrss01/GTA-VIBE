# Arrival, and the map

Two defects a player reported in the same sitting, both about the first thirty
seconds of a session, and neither of them where it looked.

## "I am seeing under the map for a few seconds"

### What was happening

`PerspectiveCamera` starts at the world origin. `FirstPersonController` writes
the camera **only inside `update`**, and `update` does not run until the frame
loop starts. So the two warm-up renders that `main.ts` performs behind the
loading screen - the ones that exist to force the shadow-map depth variants to
compile, with the comment "The frames land under the loading overlay, so
nothing is seen" - drew Meridian Bay from (0, 0, 0).

The spawn is on Harbour Walk, whose ground sits several metres above y = 0. The
camera was therefore **under the pavement**, looking at the city from below,
with the ground back-face-culled away and the buildings apparently floating
over a flat sky.

And that framebuffer is exactly what the loading screen fades away to reveal.
The comment was wrong in one specific way: the frames land under the overlay,
but the overlay is a 180 ms opacity fade over a canvas that is still showing
the last thing drawn into it.

### The fix, in two parts

```ts
controller.update(0);        // before compileAsync and the warm-up renders
```

A zero delta runs no simulation - the fixed-step accumulator cannot reach a
step - so this only writes the camera from the spawn pose the constructor has
already resolved against collision. It also means the warm-up frames compile
the programs the **first real vantage** needs rather than the ones visible from
under the map, which is what they are there for.

Second, the frame loop now starts **before** the AudioContext and the deferred
downloads are awaited:

```ts
loading.hide();
engine.start();                       // frames first
controller.requestPointerLock();
for (const start of afterStart) start();
await audio.unlock();                 // then everything that can wait
```

Every `await` below `loading.hide()` was time the screen spent showing a still.
`unlock()` alone waits on `AudioContext.resume`, which on a cold profile is not
instant. The audio layer is inert until it is unlocked and every system already
tolerates being asked for a frame before its assets land, so this costs
nothing and is what makes the fade reveal a moving city.

### Verified

Reproduced from a cold load before the change: the frame under the fading
loading screen showed the city from below the ground, the sky filling the lower
half of the screen. After: the same moment shows Harbour Walk from eye height
with the crowd already moving.

## "When I click on the map it is too small, I cannot see anything"

### What was happening

Meridian Bay is **694 m across and 1,191 m from the north shore to the far end
of the airfield** - an aspect of 0.58, of which the built city is the top third
and the rest is runway, apron and grass.

The expanded map was sized from `min(viewportWidth, viewportHeight) * 0.62`,
capped at 780 px. On a 1,996 by 1,256 window that is a **454 by 779 pixel
strip** in the middle of the screen, using 23 per cent of its area, with six
districts squeezed into the top 200 pixels and every street label landing on
its neighbour.

Both halves of that are wrong, and the second is the one that matters:

1. **Sizing from the short axis throws away a landscape screen.** The city is
   taller than it is wide, so height is the constraint that binds and width is
   the one with room to spare.
2. **No amount of canvas fixes the scale.** A map that fits 1,191 m of city
   into any number of pixels a monitor has is a map at 1 px per metre or worse,
   and a street name does not survive that.

### What it does now

- **Fills the viewport.** 88 per cent of the height less room for the caption,
  92 per cent of the width, no absolute pixel cap - a bigger screen gets a
  bigger map - bounded only by a 5 megapixel ceiling on the canvas allocation.
- **Opens zoomed on the player**, at 3.2x, which is about 215 by 370 m: a
  district and its neighbours, at a scale a street name survives. Scroll or
  `+`/`-` steps through 1x, 1.8x, 3.2x and 5.5x; 1x is the whole plan.
- **Paints the city as vectors** at the viewport's own scale rather than
  scaling up the shared static raster. That removes the resolution ceiling
  entirely, and with the window cull it is CHEAPER than the old full-plan blit
  at every zoom above 1, because a zoomed view touches a fraction of the
  parcels.

The window is centred on the player and clamped inside the plan, so walking to
the edge of the city slides it against the boundary instead of showing a
screenful of nothing. The cached raster is repainted when the zoom changes or
when the player drifts an eighth of a window - which, while somebody is
standing still reading a map, is rarely.

### What did not change

- The corner dial still crops the shared static raster, which is what it is
  for: a per-frame blit.
- The pause menu's Map tab still shows the **whole plan** at any zoom the `M`
  overlay is on. It is an orientation view inside a menu, not a map anybody is
  navigating with, and a zoomed pane with no way to zoom it would only raise
  the question of where the rest of the city went.
- `STATIC_PIXEL_BUDGET` went from 3 MP to 4.5 MP (1.94 to 2.33 px/m, 12 MB to
  18 MB). The old ceiling was chosen against a map that was at most 780 px
  tall; a full-height map on a 1440p Retina display asks for about 2.05 device
  px/m, which 1.94 could only meet by upscaling a raster the player is now
  looking at closely.

### The wheel

The weapon selector listens for `wheel` on the canvas, and the map overlay is a
click-through layer above it, so without a capturing listener on the window the
same scroll would zoom the map **and** cycle the player's weapon behind it.
`main.ts` captures and stops propagation while the map is open, which is the
only place that can.

## "Make the percentage real, so the wait is less annoying"

### What was happening

The bar was **eleven hand-picked fractions**. `main.ts` called
`setProgress(0.22, 'Raising the buildings')` and so on, and the numbers had been
chosen by feel. Measured against the clock on a cold production load, they were
not close:

| Phase | Bar showed | Really took | Share of the wait |
| --- | --- | --- | --- |
| Planning Meridian Bay | 0 – 8 % | 1.11 s | 9 % |
| Raising the buildings | 22 – 44 % | 1.08 s | 9 % |
| Downloading assets | 74 – 86 % | 0.53 s | 4 % |
| **Compiling shaders** | **97 – 100 %** | **3.90 s** | **33 %** |

A third of the wait was spent watching a bar that said it had finished. That is
the part a player feels: the number is not just wrong, it is wrong in the
direction that makes the last third feel like a hang.

### Why a fixed weighting does not fix it either

The obvious repair - weight each phase by the seconds in that table - was
tried, and it is wrong for a reason worth writing down. **The phases do not
scale together.** The same production build, measured cold and then warm on the
same machine:

| | Cold | Warm | Ratio |
| --- | --- | --- | --- |
| Build loops (`plan` … `wake`) | 8.1 s | 0.27 s | **30x** |
| Download (`assets`) | 0.53 s | 0.02 s | 26x |
| Shader compile | 3.90 s | 1.70 s | **2.3x** |

A weighting that is right cold gives the compile 33 per cent of the bar; warm,
the compile is 85 per cent of a 2 s load and the bar races to 67 per cent in a
quarter of a second and then sits there. Both are the same lie with different
numbers. And a download is 0.02 s on localhost and can be most of a minute on a
hotel connection, which no fixed weighting survives at all.

### What it does now

**Position is time, not phases.** `elapsed / (elapsed + remaining)`, rebuilt
from scratch on every update. A machine five times slower reads the same
percentage at the same point in its own boot, which is the only definition of
"real progress" that survives leaving this laptop.

**Remaining is learned, per kind of work.** Each phase is tagged `cpu`, `net`
or `gpu`, and the estimator keeps a separate speed for each: seconds really
taken over seconds the prior expected, clamped to 0.1x - 8x. This is the
correction that mattered. A single factor learned from the build loops was
applied to the shader compile too, and per the table above they do not share a
bottleneck - the bar raced to two thirds and then sat there for the whole
compile. `tests/loadingScreen.test.ts` pins it: run every CPU phase at a
hundredth of its prior and the bar must still be reserving most of itself for
the compile that has not happened.

**The two phases that can count themselves do.** Neither is predicted:

- *Downloading generated assets* counts files off a `PerformanceObserver` on
  `resource` entries under `/models/`, against a total taken from the model
  tables (`STREET_PROP_MODEL_COUNT`, `AIRPORT_MODEL_COUNT`,
  `VEHICLE_MODEL_COUNT`). A cache hit fires the same entry, so a warm load
  counts to the same total rather than stalling.
- *Compiling shaders* compiles object by object instead of the whole scene in
  one call, reporting after each, so the phase that used to be a single
  multi-second `await` now moves the bar about twenty times.

An overrun in a counted phase pushes the whole estimate along: once a phase is
5 per cent in, its own observed rate (`elapsed / fraction`) becomes a lower
bound on what it will cost, so a slow download drags the rest of the bar out in
front of it rather than piling up at one boundary.

### The bar is a `transform`, and it has to be

Almost all of this load is **synchronous main-thread work**. Nothing JavaScript
writes can be painted while a build loop is running, so a bar animated with
`width` - a layout property - freezes for a second at a time and then jumps.

`transform: scaleX()` is animated **off the main thread**. One paint at a phase
boundary starts a glide the compositor runs alone, and it keeps moving smoothly
for the whole blocking phase behind it. That is the entire reason the bar looks
alive, and it costs nothing.

The number cannot ride the same animation: the compositor will not tell the
main thread where a transition has got to, and `getComputedStyle().transform`
does not reliably report one in flight - it was tried, and it froze the number
at 0 per cent. So `value()` runs the same linear interpolation by hand from the
same start, target and duration. Two clocks, agreeing to within a frame.

### Verified

Production build, cold profile, screenshots taken through a load with the
browser pane fronted: `GRADING THE AIRFIELD 5%` → `DOWNLOADING GENERATED ASSETS
7%` → `8%` → `10%` → `COMPILING SHADERS 13%` → `16%`, the gold bar advancing
alongside the label the whole way, and no phase where the number stands still
for more than about a second. The old bar reached 97 per cent before the
longest phase started.

### What is NOT asserted in the tests

How the bar looks moving. jsdom has no compositor and no layout, so the unit
tests pin the properties of the number - never backwards, never finished early,
a phase cannot spend the next phase's share, and one kind of work is never
predicted at another kind's speed. The smoothness is a browser judgement and it
was made in one.
