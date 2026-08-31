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
