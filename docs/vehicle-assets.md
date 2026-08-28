# Vehicle assets

Every silhouette in Meridian Bay's traffic is a generated Tripo model. This
file is the reproducibility record: what was asked for, what it cost, what came
back, and what had to be done to it before it could be driven around a city.

No API key appears here or in any generated metadata.

## Provider and recipe

Tripo CLI, profile `default`, region `ov`, model version `P1-20260311`.
One recipe for every asset:

```bash
tripo make "<prompt>" \
  --then "convert:format=GLTF,texture_size=1024" \
  -p face_limit=3000 --seed <seed> --name <name> \
  --out tripo-out/vehicles/<name> --json --yes --no-open --quiet
```

The prompt is one description plus a shared style clause:

> complete finished production road vehicle, fully fitted dark tinted glass in
> the windscreen and every window, closed doors and panels, plain neutral light
> grey paint, clear headlight lenses and red tail light lenses, front grille and
> bumpers, wheels not fitted so the wheel arches are empty openings, one solid
> sealed symmetric body, no roof antenna, clean low-poly game-ready topology,
> centred pivot, no text, no lettering, no logos, no background

Two clauses in there are load-bearing:

- **Plain neutral light grey paint.** The base colour map comes back close to
  greyscale, with the panels near white and the glazing, tyres, grille and lamp
  housings near black. That is what lets one body serve a street of differently
  painted cars: the shader tints only the bright half. A model generated in a
  colour cannot be repainted.
- **No text, no lettering, no logos.** Generators produce unreadable pseudo-text
  when they are not told not to, and a city full of gibberish badges reads as
  broken.

The one clause that did **not** work is `wheels not fitted`: every body except
the reused saloon came back with wheels. See "Wheels" below.

## Tasks and cost

| Body | generate task | convert task | credits | seed |
| --- | --- | --- | --- | --- |
| body-in-white saloon (generated earlier, **not shipped**) | `606f847e-73ac-443b-ba82-a475419648ce` | `e7566403-8d65-4fab-8db6-0dbc4cd01b8c` | 50 | - |
| city car (**discarded**) | `bab5567d-a005-4a9d-acb3-ac91ce82a7eb` | `420c0688-e9a9-4bb2-b6ee-a495aa2e9955` | 50 | 20260823 |
| saloon (`saloon.glb`) | `1c74c13f-0145-40be-a6bf-5e9ca34e4069` | `f0effca7-fa15-433c-8715-f52c64e28d28` | 50 | 20260824 |
| road wheel | `beebab36-dacd-4b7c-bc83-4a26ad226fd8` | `25d52a99-b47e-4642-9933-da6b1a8400c8` | 50 | 20260825 |
| hatchback | `c8558adb-8b81-493d-89bc-8e7d217b3bc6` | `947e1946-165a-4b1e-af9a-e6ec78bde91b` | 50 | 20260901 |
| crossover | `bb301cbe-12fe-4030-b5d2-b01dda9de8dc` | `eed72c4d-049b-4d58-8598-ad9905ef4be0` | 50 | 20260902 |
| estate | `59c48dd9-3fd3-401e-855b-591529463151` | `5dd2d140-2784-49ca-a0cb-f40e95107583` | 50 | 20260903 |
| pickup | `801e6a11-6249-48e0-aa7d-470f00ce14e6` | `0a49dccc-bf9c-4ad9-b49b-23f7d7a97cfa` | 50 | 20260904 |
| van | `f67d14ef-fb82-482f-9c58-4dfbc0af9ea6` | `151954af-4812-47b3-9a5d-9d6a905a1086` | 50 | 20260905 |
| box lorry | `ffd9b3b5-e9b5-43f1-88fb-56df9dc150e7` | `d1718313-d349-45f0-9531-329317048100` | 50 | 20260906 |
| patrol | `beb17d88-3dcf-4dac-84d8-8713dd161cc2` | `3e18e135-29f2-4c65-a0d0-8d3f69f72e2e` | 50 | 20260907 |

Each row is 40 credits to generate and 10 to convert to GLTF with a 1024
texture. **500 credits were spent for this change**; the first row's 50 predates
it. Two of the eleven are not on the street:

- The **city car** was discarded. It came back as a tall micro-MPV, 0.52 as high
  as it was long against the 0.38 the compact blueprint wants, and no amount of
  fitting turns that into a hatchback without squashing it. The prompt was
  rewritten with "low roofline" for the shipped saloon, and again for the
  shipped hatchback.
- The **body-in-white saloon** was generated before this change with a blunter
  prompt - "car body shell ... no wheels and empty wheel arches" - and the
  generator took it literally: a factory shell with open window apertures, no
  glass, and a base colour map with no red on it anywhere. It is the only body
  that obliged on the wheels and the only one that reads as broken from across
  the street. See the limitations.

## What each kind is drawn with

Eight bodies cover eleven kinds.

| Kind | Weight | Body | Note |
| --- | --- | --- | --- |
| sedan | 16 | `saloon.glb` | |
| compact | 15 | `compact.glb` | |
| crossover | 13 | `crossover.glb` | |
| wagon | 8 | `wagon.glb` | |
| pickup | 8 | `pickup.glb` | |
| coupe | 7 | `saloon.glb` | Same low four-door body, 22 cm shorter. |
| van | 7 | `van.glb` | |
| taxi | 6 | `wagon.glb` | An estate taxi, painted the taxi's gold. |
| boxTruck | 4 | `box-truck.glb` | |
| patrolSedan | 2 | `patrol.glb` | |
| patrolSuv | 1.5 | `patrol.glb` | One liveried body only; see the limitations. |

Sharing costs less variety than it looks. The busiest body carries 23 of the
87.5 selection weight, against 22 when the saloon and the taxi shared the
body-in-white shell, so the street is no more repetitive than it was - it just
has one silhouette fewer and no unglazed cars in it.

The patrol livery is invented: white bodywork, a navy flank, a thin gold
shoulder stripe, and a plain blue and red roof bar. It carries no insignia, no
lettering, and no reference to any real force.

## Fitting

`src/traffic/VehicleModelFit.ts` measures and places every asset;
`tests/vehicleModels.test.ts` runs the same code over the shipped files on every
test run, so a re-generated asset that no longer fits fails the build.

Measured on the shipped GLBs, in model units where the longest axis is 1.000:

| Asset | body width | roof height | tris | file |
| --- | --- | --- | --- | --- |
| saloon | 0.428 | 0.293 | 2952 | 638 KiB |
| compact | 0.455 | 0.412 | 2841 | 556 KiB |
| crossover | 0.436 | 0.395 | 2913 | 650 KiB |
| wagon | 0.412 | 0.334 | 2789 | 650 KiB |
| pickup | 0.385 | 0.408 | 2966 | 547 KiB |
| van | 0.396 | 0.465 | 2865 | 642 KiB |
| box-truck | 0.322 | 0.414 | 2685 | 664 KiB |
| patrol | 0.420 | 0.391 | 2930 | 581 KiB |
| wheel | - | - | 858 | 524 KiB |

Both figures are robust rather than bounding-box measurements. The raw box lies
about a car twice over: wing mirrors add 10-15 per cent to the width, so the
body width is the 99th percentile of the lower half of the model, below the belt
line; and a roof aerial adds up to 10 per cent to the height, so the roof is the
99th percentile over the middle 60 per cent of the length.

Every model came back systematically wider than a real car for its length -
0.39 to 0.46 against the 0.32 to 0.44 the blueprints ask for. The fit therefore
matches **length exactly** and lets width and height miss their target by up to
12 per cent rather than distort the model, on the grounds that a queue makes any
error in nose-to-tail size obvious while a car three per cent wider than its
collision box is invisible. Every shipped kind fits inside that band with room
to spare except the pickup, which stands 6 per cent taller than its blueprint;
`tests/vehicleModels.test.ts` fails the build if any of them drifts past 10 per
cent on width or 15 on height.

## Wheels

Every body was asked for with empty arches. Only the body-in-white shell -
generated with an earlier, blunter prompt that also cost it its glazing -
obliged, and it is not shipped. Every shipped body came back with wheels
modelled in, which is unusable: wheels have to spin and steer, so they cannot be
part of the body mesh.

`detectAndCutWheels` removes them without knowing anything else about the model.
A tyre is the only part of a car that touches the road, and it does so in two
short runs along the length out at the flanks, so the tyres are found by
binning the length and looking for where the flank geometry reaches the ground.
Between 15 and 46 per cent of each body's triangles are wheel, which is also
why the shipped bodies draw 1742-3004 triangles rather than the ~2900 they
arrived with.

Two things fall out of the same measurement:

- **The arches, not the blueprint, decide where the wheels are drawn.** The
  generated wheelbases are up to a metre away from the blueprint's - the lorry's
  worst - and a wheel that misses its arch is far more visible than a wheelbase
  the simulation only uses internally. `TrafficSim` is untouched.
- **A model with no wheels would be lifted onto them.** Such a model's lowest
  point is its underbody, so it is raised by the blueprint's ride height. No
  shipped body needs this; it is kept for the next asset that does.

The lorry model has three axles. The renderer draws four wheels, so its rear
bogie keeps one baked pair, which does not turn. An empty arch would read worse.

### Wheel wells

Cutting a wheel out of a single-surface body leaves a hole, and a generated
body has no interior behind it. Measured with rays against the fitted body
before and after the cut - counting only sight lines the solid body blocked,
and only above the vehicle's own underbody - between 1.4 and 14.3 per cent of
those sight lines went straight through the shell and out the other side. From
beside a car it read as a black ring around every wheel; from any low angle you
could see the far side of the street through the sills.

Each shell therefore carries a wheel well behind each arch and a plate under
the floor, built by `VehicleMeshBuilder.wheelWell` into the SAME geometry as
the body, so the fleet still draws in twelve calls. Three details are load
bearing:

- **The well is sized to what the cut REACHED, not what it swept.** A triangle
  is dropped when its centroid lands inside the wheel, so a triangle straddling
  the boundary takes bodywork out past the circle - by up to a fifth of the
  wheel's radius on these assets. `detectAndCutWheels` now measures the true
  reach and reports it as the arch radius.
- **The inner wing is clipped to the bodywork.** Unclipped it hung below the
  sills as a pair of black skirts, visible from across the street.
- **It is never painted.** A wheel well is moulded liner and a floorpan is
  underseal; a yellow taxi with yellow wheel arches would be a worse lie than
  the hole.

It costs 122 triangles a shell - 1662-2321 becomes 1784-2443, about six per
cent - and no draw calls, no materials and no lights.
`tests/vehicleModels.test.ts` fires the same rays at every shipped kind and
requires that at most one in two hundred still passes through.

## What the shader had to recover

A fused single-material mesh cannot express any of the per-instance behaviour
the fleet had, so `VehicleMaterial` recovers what it can from the texture:

- **Paint.** The instance tint multiplies only texels above a luminance
  threshold, which on a body generated in plain grey means the panels and not
  the glazing, tyres or grille. Fourteen paints per shell still work.
- **Brake lamps.** The loader samples the base colour map at every vertex and
  flags the red-dominant texels in the back of the car. Those vertices carry the
  brake channel, so `vehicle.braking` still lights the model's own lenses. No
  geometry is added and no light is created.
- **Tyre rubber.** The generated wheel's tyre came back sandy brown. The wheel
  material pulls everything the tint does not reach towards rubber black.

## Limitations

- **One silhouette short.** The body-in-white saloon was meant to carry the
  saloon and the taxi, a quarter of the fleet, and it cannot: at 15 m its open
  window apertures read as a see-through car parked next to properly glazed
  ones, and with no red anywhere on its texture it had no brake lights either.
  Both kinds were moved onto bodies that do have glass. Re-generating it with
  the current prompt would give the fleet its ninth silhouette back and cost 50
  credits; the file is not shipped but the task IDs above will fetch it again.
- **The pickup's cab side windows are open apertures.** The windscreen is
  glazed, the door windows are not. It is the only shipped body with the fault
  and it reads as a wound-down window rather than as missing glass, so it was
  left alone.
- **Headlamps no longer light.** `vehicle.headlights` is still simulated and
  still written to the instance buffer, but nothing reads it: there is no
  reliable way to tell a headlight from bodywork in a greyscale texture, and the
  flat emissive faces tried first read as white stickers on the bumper. The
  models' own headlights are drawn, they just do not glow.
- **The patrol SUV is drawn as the patrol saloon.** A second liveried body was
  outside the budget. It is 1.7 per cent of traffic and its visual is 14 per
  cent shorter than its collision box, which nothing keys off.
- **Download size.** The fleet adds 5.3 MB of GLB and 27 textures. It loads
  behind the loading screen, in parallel with the street lamp and the fountain,
  and a failure at any point falls the whole fleet back to the authored shells
  rather than mixing two looks on one street.

## The wheel arch, corrected 2026-08-27

Reported as "some 3D element around the wheels, hidden, but really visible. It
looks very ugly." Nothing had been added. What was visible was the INSIDE of
the car, through bodywork that should never have been removed.

`detectAndCutWheels` opened each arch by dropping a whole triangle whenever its
CENTROID fell inside the tyre. On a generated body of about fifteen hundred
triangles a triangle is 10–20 cm across, so the hole that leaves is up to a
triangle's width wider than the tyre in every direction — a 33 cm wheel in a
49 cm hole. Something has to be behind an opening that size or you can see
straight through the car, and what was behind it was the wheel-well liner:
`#33373b` moulded plastic, correct for a wheel arch and 16 cm too much of it.

Three changes, and the first is the one that matters:

1. **The cut clips the triangles instead of dropping them.** Each triangle that
   straddles an arch is split against the sixteen edges of a polygon inscribed
   in the tyre; the pieces outside are kept, the piece inside is discarded, and
   the vertices the split needs are appended to the model. The opening is now
   the polygon and nothing else. Inscribed rather than circumscribed on
   purpose: an inscribed polygon is never wider than the wheel that fills it,
   at the cost of up to 1.9 per cent of a radius of the model's own tyre
   surviving at each corner — about 6 mm of black rubber, sitting inside the
   black rubber of the wheel drawn over it.
2. **The arch is open below the wheel.** A real wing sweeps down past the tyre
   and stops; you can see the road under the sill. The six edges whose normals
   point downwards are left out of the cut, so it runs straight down to the
   road and past it. Closing them left a skirt of sheet metal reaching the
   ground on both sides of every wheel.
3. **The wheel is drawn at the radius its own arch was cut at**, not at the
   simulation's blueprint figure. A cluster is accepted anywhere between 0.72
   and 1.6 of the blueprint radius, so those two numbers need not agree, and a
   wheel smaller than its arch leaves a ring of liner showing all the way
   round. `tests/vehicleModels.test.ts` pins the detected radius to within a
   fifth of the blueprint on every shipped body.

The liner behind it is now sized just INSIDE the wheel (0.985) rather than six
per cent proud of it, so it is hidden from every angle outside the car while
still closing the oblique sight lines that pass along the flank and miss the
wheel. The inner wing that closes the arch from inboard reaches the road rather
than the floorpan, because the open bottom left a band between the sill and the
tarmac that a low horizontal sight line went straight through: measured on the
saloon, twenty of 758 rays, all of them between 5 and 17 cm off the ground.

`tests/wheelArch.test.ts` asserts the geometric properties on synthetic
bodywork; `tests/vehicleModels.test.ts` asserts them on the shipped assets.

## Abandoned cars, wrecks and localized damage

### A car the player gets out of stays where they left it

`Driving.exit` finishes by giving the vehicle up, and what "giving it up" means
used to be `TrafficSim.attach`: the traffic AI searched the whole lane graph
for the nearest lane pointing roughly the way the car happened to be facing,
wrote the car onto it, zeroed its velocity and picked it a new destination.
Within a frame or two the pure-pursuit steering and the 1.6 m centreline snap
had dragged the body onto that lane, rotated it to the lane's heading and
driven it away. When no lane scored well enough — a forecourt, a car park, a
car left at an angle — `attach` called `recycle` instead, so the car the player
had just parked disappeared and reappeared somewhere across the city in a
different colour.

Releasing now **parks** the vehicle instead. `VehicleState` gains `'parked'`
alongside `'ambient'`, `'player'` and `'loose'`, and `TrafficSim.park` touches
nothing about the transform: same x, z and yaw, same resting height, pitch and
roll, same damage. Whatever speed the car still had becomes real velocity, so
one let go of at a roll coasts to a stop against the road rather than stopping
dead in mid-air, and once it stops it is latched — the pose is frozen and the
only thing that still runs is the ground contact.

A parked car is published as an obstacle exactly as a wreck or a driven car is,
so traffic queues behind it and steers around it; it collides; and it can be
got back into. `VehicleView.control` still publishes `'loose'` for it, because
that is the honest answer to the question `control` asks — nobody is driving —
and it keeps every existing consumer correct. `VehicleView.state` carries the
difference.

**Lifecycle.** At most `PARKED_LIMIT` = 12 abandoned cars and wrecks are kept,
out of a fleet of about 120. Removal is oldest-first and only beyond
`detailDistance + 20` m — that is, strictly beyond the renderer's own render
distance, 170 to 280 m by quality — so nothing is ever tidied away on screen.
A player who abandons more than twelve cars inside that radius leaves nothing
out of sight to remove, so the pool is allowed to reach `PARKED_HARD_LIMIT` =
16 before the oldest goes regardless; that is a visible pop for a player who
went out of their way to cause it, and it is the only thing standing between
the pool and unbounded growth. `TrafficSystem.stats` reports `parked`,
`wrecks`, `parkedLimit` and `parkedRemoveDistance`.

### Damage is somewhere, and does something

`integrity` is still the whole shell on the `VEHICLE_INTEGRITY` scale, and it
still decides when a car is a write-off. Alongside it every hit is now recorded
against the part of the body it landed on:

| Region | Capacity | What it does |
| --- | --- | --- |
| front, rear, left, right | `REGION_CAPACITY` = 156 pts | front is the engine bay: power falls off past `ENGINE_SOFT` = 0.55 and is gone at 1.0 |
| glass | `GLASS_CAPACITY` = 40 pts | glazing goes dark and opaque |
| tyres, per corner | `TYRE_CAPACITY` = 30 pts | `TYRE_GRIP_LOSS` = 0.22 of grip each, `TYRE_PULL` = 0.055 rad of steering bias, and the wheel visibly squats |

The two accounts are deliberately not a partition of each other: five carbine
rounds (34 points apiece) concentrated on a bonnet finish the engine bay while
the shell still has 90 of its 260 points left, which is exactly what "shot the
engine out" should mean. The same five rounds spread over the car destroy
nothing. `VehicleView.regions` publishes the fractions and
`VehicleView.handling` the one rule that turns them into power, grip and pull —
shared by the traffic AI and the player's own driving layer, so a damaged car
drives the same whoever is in it.

The public seam is unchanged in shape and widened in place:

```ts
applyImpact(vehicleId: number, hit: VehicleImpact): boolean;
applyDamage(vehicleId: number, amount: number, x?: number, y?: number, z?: number): boolean;
```

Passing the world point the round landed on is what makes the damage local.
Without it the points are spread evenly over the four panels, which is the
right answer for damage that genuinely has no location and a poor one for a
bullet.

**A blast is not a bullet.** One blow costing more than `BLAST_SHARE` = 0.25 of
the shell — the launcher's warhead is 190 points, a rifle round is 34, and
nothing sits between them — puts every window out, shreds the tyres on the side
it came from and wraps the panel damage around the body instead of marking one
panel. Everything else about it already came out of the impulse.

**Destruction.** Zero integrity flags the vehicle abandoned, cuts an ambient
one loose so it coasts to a stop where it was rather than carrying on with no
engine, and starts the fire: it smoulders for 1.2 s, burns for 14 s and then
goes out, leaving a permanently blackened shell that smoulders away over
another 10 s. The shell itself never leaves except through the parked
lifecycle above.

### It all stays inside one draw call

Damage is instanced. How wrecked each region is travels on the instance
(`aDamage`, `aWear`); where each vertex sits on the body travels on the vertex
(`aSurf.zw`); their dot product is how bad it is at that fragment, and it
drives an inward crumple of up to 9 cm along the normal, the loss of gloss and
colour, the dark glazing and the soot. A wrecked car is the same draw an
undamaged one is.

Smoke, fire and sparks share ONE further instanced batch capped at
`MAX_PARTICLES` = 96 billboards, emitted only within 110 m and staggered per
vehicle so a dozen burning cars cannot starve the pool in a single frame. The
fleet's colour-pass draw calls go from 12 to 13, and never higher.

**The vertex attribute budget is the constraint that shapes all of this.**
WebGL guarantees sixteen attribute slots and an attribute of one component
costs the same slot as one of four; an instanced vehicle spends four on
`instanceMatrix` before declaring anything of its own. Adding the damage
attributes took the shell to eighteen and the driver refused the program with
"Too many attributes" — which draws no cars at all, silently, with nothing
failing where a test would normally look. `aPaint`, `aChan` and `aTex` are
therefore packed into one `aMask`, and `aSurf` grew from two components to four
to carry the body coordinates, for a total of fifteen.
`tests/traffic.test.ts` asserts the ceiling on every batch the system adds to
the scene.

### Measured

Production build, Meridian Bay promenade, 3840x2160 at pixel ratio 2, 150
rendered frames per sample, same session and same scene:

| | mean | median | p95 | draw calls | triangles |
| --- | --- | --- | --- | --- | --- |
| before this work | 15.62 / 15.97 ms | 15.5 / 16.0 | 17.3 / 17.8 | 374 | 7.089 M |
| after, clean city | 14.97 ms | 14.7 | 17.2 | 373 | 7.103 M |
| after, 16 parked / 6 burning / 93 particles | 14.82 ms | 14.9 | 16.4 | 375 | 7.184 M |

The traffic system's own draw calls are 12 before and 13 after, and stay at 13
with a street full of burnt-out wrecks.
