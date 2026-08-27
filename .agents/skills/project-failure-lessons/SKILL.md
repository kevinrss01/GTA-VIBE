---
name: project-failure-lessons
description: Failures that cost real diagnosis time in this repository, with the cause and the check that prevents a repeat. Read before generating provider assets, before writing terrain or street geometry, and before trusting an imported model's transform.
---

# Project failure lessons

Only material failures are recorded here. Typos and harmless experiments are not.
Each entry is symptom, cause, fix, prevention.

## 1. Flat block pads beside level carriageways tear the ground open

**Symptom.** A unit test that walked the ground field found a 2.4 m vertical step
at the uphill kerb of most blocks. From the street it would have read as a wall
of nothing, and the player could neither climb it nor see why.

**Cause.** The first elevation model tried to hold two things true at once: every
carriageway level across its width, and every block interior a flat pad. On a
6 per cent grade a 28 m block spans about 1.7 m, and a 29 m-wide avenue spans
another 0.9 m. Those two flattenings have to disagree somewhere, and they
disagree exactly at the kerb, where the player walks.

**Fix.** One continuous analytic ground surface, `landElevation(x, z)`, used by
the terrain, the streets, the block interiors, the collision and the tests.
Nothing is flattened. Carriageways carry a cross-fall equal to the local
gradient, which is what a real road does, and the main grade is capped near
3 per cent so the widest street banks by about half a metre over sixteen - a
camber, not a ramp. The steeper ground was pushed outside the street grid, where
no wide road has to cross it.

**Prevention.** `tests/cityPlan.test.ts` asserts that no two adjacent walkable
samples differ by more than the controller's 0.45 m step height, and that no
carriageway cross-fall exceeds 4 per cent. Any future attempt to flatten a
surface will fail one of those two.

## 2. `tripo make --for ar-web` returns USDZ, not GLB

**Symptom.** A completed, successful generation whose only artifact was
`model.usdz`. `GLTFLoader` cannot read it, so the asset was unusable.

**Cause.** The `ar-web` scenario preset targets AR Quick Look and ends its chain
with `convert_model` to USDZ. The GLB exists, but on the *previous* task in the
chain, not on the task the command reports.

**Fix.** Read the `chain` array in the result JSON and fetch the artifact from
the `highpoly_to_lowpoly` step:
`tripo task get <chain-task-id> --download --json`. Note that `tripo task get`
has no `--out-dir`; it writes into `tripo-out/`.

**Prevention.** For Three.js work use `--for game-pc` or `--for game-mobile`, and
always confirm the downloaded file is a `.glb` before integrating it.

## 3. Generated models arrive normalised, with a centre pivot

**Symptom.** The generated street lamp measured exactly 1.000 units tall, with
its bounding box running from y = -0.5 to y = +0.5.

**Cause.** The provider normalises output to a unit box centred on the origin.
The origin is *not* the base of the object and the units are *not* metres.
Placing it at a ground sample would have left a 1 m lamp half sunk in the
pavement.

**Fix.** `src/world/ModelLibrary.ts` measures the transformed bounds of every
loaded model, scales it to a stated real-world height, and moves the origin to
the centre of the footprint at ground level, so callers only need a position.

**Prevention.** `tools/inspect-glb.mjs` prints the transformed bounding box,
`pivotAboveBottom` and `pivotOffsetXZ` for any GLB without needing a renderer.
Run it on every downloaded asset before integrating it.

## 4. Aggressive decimation deletes thin structures rather than simplifying them

**Symptom.** The street lamp decimated to 2 200 triangles came back as a bare
column. Its lantern head - the entire point of the asset - was gone. The
bounding box gave it away before the preview did: height dropped from 1.000 to
0.689 while the base stayed put.

**Cause.** A quadric-style simplifier collapses a thin, hollow, high-detail
sub-structure like a glazed lantern cage long before it touches a large smooth
form like the column. At a low triangle budget the cage costs more error to keep
than the column does, so it goes first.

**Fix.** Decimate to a budget generous enough to keep the silhouette, verify the
result, and fall back to instancing the full-resolution asset in a small number
of hero positions rather than shipping a broken one.

**Prevention.** After any decimation, compare the bounding box against the
source with `tools/inspect-glb.mjs`. A height or footprint change of more than a
few per cent means a feature was deleted, not simplified - look at
`preview.png` before believing the triangle count.

## 5. npm blocks esbuild's install script, which silently breaks Vite

**Symptom.** `npm install` succeeded but `vite` could not run.

**Cause.** This npm version blocks post-install scripts unless the package is
listed in `allowScripts`; esbuild needs its post-install to place its native
binary.

**Fix.** `npm install-scripts approve esbuild`, which records the approval in
`package.json`.

**Prevention.** After a fresh install in this repository, run `npx vite --version`
before assuming the toolchain works.

## 6. Optimising the wrong thing: triangles are nearly free here, pixels are not

**Symptom.** The city submitted 3.8 M triangles per frame, and the number barely
changed with camera direction - the signature of culling being switched off.
Restoring it (per-chunk prop instancing plus `frustumCulled = true`) cut that to
2.9 M and moved the frame time by 0.03 ms, which is inside the run-to-run noise.

**Cause.** The bottleneck was never geometry. Measured by rendering the same
view at three resolutions, the frame is about **3.6 ms of fixed cost plus
2.7 ms per megapixel**. On a Retina Mac the canvas is 1542x818 at
`devicePixelRatio` 2 - just over 5 megapixels - so roughly 13 ms goes on
shading pixels. Of that, **18 point lights cost 5.1 ms of an 8.4 ms frame**,
because every fragment of every material evaluates all of them.

**Fix.** None applied. Every candidate either changed the picture or did not pay
for itself, and each was rejected on measurement rather than taste:

- Cutting the light pool 18 -> 12 looked free across eight sample viewpoints
  (max difference 1/255), but the densest part of the Old Quarter - where up to
  29 lights are in range at once - showed differences of 116-255 levels. A
  sparse sample gave a false negative.
- A depth prepass only pays when overdraw is high. Measured overdraw is 1.5-2.1
  layers, so the extra geometry pass costs about what it saves.
- Merging world geometry into one batch per material cut 132 draw calls and made
  the frame 1.4 ms *slower*: chunking is what lets far geometry stop casting
  shadows, and pushing all 317 K triangles through the shadow map costs more.
- Frustum-culling the props deleted real shadows - see `WorldBuilder`.

**Prevention.** Before optimising, find the bottleneck by measuring the same
view at several resolutions: a flat curve means CPU or draw calls, a steep one
means shading. Then subtract one suspect at a time. And when checking that an
optimisation is invisible, diff actual pixels at the *worst case* - the densest
lighting, not a handful of convenient viewpoints - and prove the harness is
sound first by capturing the same view twice and confirming a zero delta.
Two things silently corrupt such a diff here: an unequal settle time (the frame
loop is still settling the player onto the floor) and reading the background
clear colour as if it were data.

## 7. A 200 ms freeze on the first playable frame: shaders compile lazily

**Symptom.** The screen froze for about a fifth of a second the instant the
loading screen was dismissed and the player took control - the worst possible
moment for a stall, and easily mistaken for "the game is slow".

**Cause.** Three.js builds a material's GPU program the first time that material
is actually rendered, not when it is created. Measured at boot: `info.programs`
held **1** program until the first gameplay frame, which then compiled all
**16** and took **202.9 ms**. Every later frame, from every other vantage point
in the city, took 2-5 ms and compiled nothing. So the whole cost was one
unavoidable spike, paid at the moment the player started moving.

**Fix.** Compile behind the loading screen, in `main.ts` just before `Ready`:

1. `await renderer.compileAsync(scene, camera)`, raced against an 8 s timeout so
   a driver that never reports through `KHR_parallel_shader_compile` cannot hang
   the boot.
2. Then two warm-up `renderer.render(...)` calls. `compileAsync` only walks the
   scene's own materials, so it misses the shadow pass's depth variants - it got
   12 of 14. The warm-up frames force the rest, and they land under the loading
   overlay where nothing is visible.

First gameplay frame: **202.9 ms -> 22.7 ms**, with all 14 programs ready
beforehand. The total work is unchanged; it just happens where a pause is
expected.

**Prevention.** Check `renderer.info.programs.length` immediately before the
first interactive frame. If it is far below the count after a walk around the
city, shaders are still compiling during play. Never measure this with a
single warmed-up render - the cost only appears on the very first one.

## 8. TesterArmy's visual tools cannot read this 3D scene

**Symptom.** A local `--headed` run reaches the city, then fails every visual
assertion with `VLM extraction failed` and `Invalid input` from
`scene_understand({visual:true})` and `scene_assert`. The run reports FAILED
with `issues: []` and no screenshots. Seen twice, months apart, on two
different saved tests.

**Cause.** TesterArmy's own vision pipeline, not the product. The run agent
diagnosed it the same way and called `message_testerarmy_team` about it. DOM
tools keep working throughout, which is how the same run still observed the
HUD reading `Harbourside Harbour Walk` and the prompt `Press E to drive the
taxi` in the shipped build.

**Fix.** None available from this side. `--headed` is still required (headless
Chrome ships without WebGL - see the run notes), but it does not help the VLM.

**Prevention.** Write steps for this project so the *pass* condition can be
reached through the DOM where possible: the HUD district and street labels, the
interaction prompt, and the music control are all real text and all readable.
Keep purely visual assertions to a minimum and never treat a VLM failure as a
product defect - check `issues` and the step summaries before concluding
anything. Verify the visual half locally with `renderBenchmark`, pixel
sampling, and screenshots instead.

## 9. A viewmodel cannot share a depth buffer with the world it stands in

**Symptom.** The held weapon drew through the gun shop's counter and its till:
the barrel came out of the far side of a solid object the player was standing
at. Reported as "a weapon clipping through the cash machine and slightly over
the counter."

**Cause.** Not a bug in the viewmodel's pose. A held weapon reaches most of a
metre out of the eye and the player's collision cylinder is only 0.34 m of
radius, so anything a player can stand next to is geometrically INSIDE the
weapon. Two solids occupying one volume, resolved by the depth buffer the only
way it can be.

**Fix.** The one every first-person game uses: render the world, throw the
depth buffer away with `clearDepth()`, then render the viewmodel into the empty
one with `autoClear = false`. `Engine.overlayScene` and `Engine.overlayCamera`
are that pass. The overlay camera shares the main camera's field of view and
aspect and differs only in its near plane, so the weapon appears exactly where
the single-pass version put it and the muzzle world position used for tracers
stays correct.

Two things a second scene does not inherit and has to be given: LIGHTS (it saw
none of the world's, and the first attempt drew a black silhouette) and the
ENVIRONMENT map. The lights are parented to the overlay camera so the weapon is
lit the same way everywhere in the city.

**Prevention.** Before tuning a viewmodel's offsets to avoid geometry, ask
whether it shares a depth buffer with that geometry. If it does, no arrangement
of offsets is a fix - the previous attempt tucked the barrel back and stood it
up 57 degrees, which still left a tenth of a metre inside the wall and read as
a second bug. `Engine.overlayScene.children.length` is the guard that keeps the
extra pass free when nothing is held.

## 10. An "ugly element" was the inside of the car, seen through a hole

**Symptom.** A flat dark grey band, about 16 cm wide, ringing every wheel of
every vehicle. Reported as a 3D element somebody had added around the wheels.

**Cause.** Nothing had been added. `detectAndCutWheels` opened each wheel arch
by dropping a whole triangle whenever its CENTROID fell inside the tyre, and on
a body of about fifteen hundred triangles a triangle is 10-20 cm across - so
the hole was up to a triangle's width wider than the tyre in every direction. A
33 cm wheel in a 49 cm hole. The wheel-well liner behind it, which exists so
you cannot see through the car, was doing exactly its job over 16 cm of opening
that should never have been open.

**Fix.** Clip the triangles instead of dropping them: split each straddling
triangle against a sixteen-sided polygon INSCRIBED in the tyre, keep the pieces
outside, append the vertices the split needs. Inscribed and not circumscribed,
so the opening is never wider than the wheel that fills it. Then draw the wheel
at the radius its own arch was cut at rather than at the simulation's blueprint
figure, because the two need not agree and a wheel smaller than its arch leaves
the same ring by a different route.

**Prevention.** When a fix is "put something behind the hole", measure the hole
first. And when a report says something was ADDED, check whether it was in fact
REVEALED - the visible artefact and the code change that caused it were in
different modules and eighteen months of naming apart.

## 11. A generated action clip is not a locomotion clip, and the bake assumed it was

**Symptom.** Baking Tripo's `preset:biped:shoot` as a third clip for the police
character produced a figure sliding backwards through its own animation, 159 mm
below the pavement, and 2.75 body heights away from where the officer was
standing.

**Cause.** Three separate assumptions in `tools/bake-pedestrian-vat.mjs`, all
correct for a walk and all wrong for an action:
- travel is fitted as a linear ramp over the cycle and subtracted, which reads
  a one-off crouch as 1.35 body heights of forward travel;
- the ground is anchored to the idle clip's soles, and a crouch's lowest point
  is a shin, not a sole;
- a window cut out of the MIDDLE of an action clip is wherever the character
  had walked to by that second.

**Fix.** A `--static name=start:end` flag: sample a window, force travel to
zero, skip the travel-curve analysis, lift the clip by its own worst ground
penetration, and recentre it on the reference clip's mean centroid.

**Prevention.** Before adding a clip to a bake built for walking, ask whether
it loops, whether it travels, and whether it stands on the same part of the
body. `--report` prints all three (`travel ... u/cycle`, `lowest vertex`, the
per-foot contact table) without writing anything.
