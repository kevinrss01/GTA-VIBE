# Weapons in hand, and on the counter

Frames from the running game, captured at the renderer's own resolution
(2360x1440) rather than screenshotted from a browser pane, so nothing here is
rescaled or recompressed by a tool.

## How these were captured

`tools/capture-server.py` serves a production build AND accepts
`POST /shot?name=...` with a data URL, which it decodes into this directory.
The page posts `canvas.toDataURL('image/png')` from the same origin, so there
is no CORS step and the PNG is exactly what WebGL produced:

```bash
npx vite build --outDir dist
python3 tools/capture-server.py dist docs/provider-evidence/weapons-hands 4184
```

```js
// In the page, with the game booted:
window.__meridian.step(1);
await fetch('/shot?name=hands-carbine', {
  method: 'POST',
  body: document.getElementById('viewport').toDataURL('image/png'),
});
```

`step(1)` renders synchronously, and `toDataURL` is called in the same task, so
the drawing buffer is still intact without `preserveDrawingBuffer`. This exists
because a browser pane stops compositing whenever it is not displayed, which
makes ordinary screenshots unreliable while anything else is using it.

These frames are the 3D layer only. The HUD, the counter panel and the stat
bars are DOM and are not in the canvas.

## The held weapon

| File | What it shows |
| --- | --- |
| `hands-pistol.png` | Sidearm, both fists on the grip |
| `hands-smg.png` | Compact SMG, support hand on the magazine well |
| `hands-shotgun.png` | Dock Sweeper, support hand on the fore-end |
| `hands-carbine.png` | Meridian Carbine, hands 30 cm apart on stock and fore-end |
| `hands-shotgun-firing.png` | One shell: muzzle flash at the BARREL end, recoil kick, tracer down the street |
| `hands-holstered.png` | After `H`. Nothing drawn; the HUD reads "Stowed" |
| `hands-raising.png` | Nine frames into the draw: the muzzle is still entering frame from below |
| `hands-wall-tuck.png` | Shoulder to a wall: the carbine stands up vertically, pivoting about the trigger hand |
| `hands-wall-clear.png` | The same spot three metres back, for comparison |

## The counter's display case

`shop-preview-*.png` are the display-case canvas on its own, with its alpha
channel intact - in the panel it composites over a dark stage with a warm pool
of light behind it. Each is the real runtime GLB on the turntable, lit by the
preview's own baked environment. No point light exists in that scene.

The Dock Sweeper is the one to look at: the generator painted it cobalt blue,
and the same `tint` the held weapon uses is applied here so the shop cannot
sell a blue shotgun and hand over a grey one.
