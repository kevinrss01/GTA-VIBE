# Meridian Bay Regional

The airport, the aircraft, the flight model, and the second half of "Last Call".
This is the reproducibility record: what was decided, what it cost, what was
measured, and what is still missing.

No API key appears here or in any generated metadata.

## Why the runway points north–south

The city sits on a ramp. `mainProfile(x)` climbs from 1.6 m at the western
shore to 18.4 m past the eastern outskirts; `minorProfile(z)` moves by under a
metre across the whole map. Measured over the chosen site before anything was
built:

| | west→east | north→south |
| --- | --- | --- |
| elevation change | 16.5 m over 760 m | 0.4 m over 210 m |
| grade | 2.2 % | **0.19 %** |

ICAO's limit for a runway longitudinal grade is 1 %. North–south is inside it
with the terrain untouched; east–west would have needed either an 8 m cut at
one threshold and an 8 m fill at the other, or a runway on a 2.2 % slope. So
the runway lies along z, and the airport is south of the city, which ends at
z = 186.

The apron and terminal still cross the ramp, which is what `AIRFIELD_LEVEL`
is for — a graded platform at 14.5 m, roughly 3 m of cut on the east side and
3 m of fill on the west, with a 46 m embankment skirt blending back to open
ground. `airfieldWeight()` returns 0 well away from the airport, so it is the
only route by which the airfield can touch the city's existing terrain, and
that is asserted.

## The survey

`src/world/airport/layout.ts` is the single source of truth. Every module that
needs to know where anything is — the geometry builder, the ground sampler,
the flight model, the traveller crowd, the mission and the minimap — reads it
from there. It imports nothing from Three.js, so a unit test can read it too.

| Element | Figure |
| --- | --- |
| Runway 18/36 | 600 × 45 m, centreline x = 340, thresholds z = 280 and z = 880 |
| Paved overrun | 60 m beyond each threshold |
| Parallel taxiway | centreline x = 275, 18 m wide, three runway links |
| Apron | x 215–266, z 300–620 |
| Terminal | 62 × 190 m, x 152–214, z 355–545 |
| Control tower | 27 m, at (232, 660) |
| Airfield platform | x 150–430, z 200–950, level 14.5 m |

600 m is short by airline standards and deliberately so: it is a regional
field. It is a real length — Courchevel is 537 m and takes twin turboprops —
and it is sized so the light single and the twin get airborne with room to
spare and the business jet has to fly it properly.

## Generated 3D assets

Tripo CLI, model version `P1-20260311`, the same recipe the vehicle fleet and
the club interior used:

```bash
tripo make "<prompt>, <style clause>" \
  --then "convert:format=GLTF,texture_size=1024" \
  -p face_limit=<n> --seed <seed> --name <name> \
  --out tripo-out/<dir>/<name> --json --yes --no-open --quiet
```

50 credits each — 40 to generate, 10 to convert. Every model arrives normalised
into a unit box with a centre pivot, so the runtime measures each one and
rescales it to real metres; the transform in the file is never trusted.

### Aircraft — 4 × 50 = 200 credits

| Asset | Task | Faces | Triangles | Shipped |
| --- | --- | --- | --- | --- |
| Light single, high wing | `dc18e062-4cb1-491e-96e5-b1acfdfb2a65` | 3000 | 2,985 | `public/models/aircraft/cessna.glb`, 622 KiB |
| Twin turboprop commuter | `0f47902c-27c8-4ce3-b427-3dcd8d08ea3f` | 3500 | 3,305 | `public/models/aircraft/twin.glb`, 825 KiB |
| Business jet, T-tail | `82ca5e16-c049-440c-842f-cb365651c05a` | 3500 | 3,340 | `public/models/aircraft/jet.glb`, 717 KiB |
| Narrowbody airliner | `a0600be5-c047-4505-b2aa-b3b8654573f7` | 4000 | 3,853 | `public/models/aircraft/liner.glb`, 706 KiB |

Inspected from a top-down render before integration: all four are visibly
different aircraft rather than one silhouette rescaled, and all four share one
orientation — **nose along +Z, wings on ±X, up +Y**. The game's forward is
`(-sin yaw, 0, -cos yaw)`, i.e. −Z at yaw 0, so every model carries a fixed
`Math.PI` yaw correction, exactly like `FRONT_TURNS` in `Furnishings`.

The style clause is shared and two of its clauses are load-bearing, for the
same reasons recorded in `docs/vehicle-assets.md`: *plain neutral light grey
paintwork* so the shader can tint one body into a fleet, and *no text, no
lettering, no logos, no registration marks* because a generator that is not
told to omit lettering produces unreadable pseudo-text.

### Airport props — 17 × 50 = 850 credits

`public/models/airport/`, 9.1 MB total, 699–2,949 triangles each.

| Airside | Terminal | Luggage / people |
| --- | --- | --- |
| `air-stairs` | `checkin-desk` | `suitcase` |
| `baggage-tug` | `gate-seats` | `duffel` |
| `baggage-cart` | `scanner` | `trolley` |
| `fuel-bowser` | `flight-board` | `seated-a`, `seated-b` |
| `gpu-cart`, `windsock` | | `backpack`, `garment-bag` |

`backpack` (372 KiB, fitted by height at 0.50 m) and `garment-bag` (398 KiB,
0.90 m) were added after the first pass, on the same static-prop recipe as
`suitcase` and `duffel`: standing on +Y with a centre pivot, so `models.ts`
fits them by `axis: 'y'` and turns them with `front: '-z'`. They are the bags
NOBODY is carrying — the traveller crowd carries its own — so they are placed
by `terminalModelAnchors()` at the end of each gate bench, against the check-in
islands, and riding the two reclaim belts at 0.79 m. Static, instanced, and
without colliders, because a bag the player trips over is worse than no bag.
Their Tripo task ids are recorded with the rest of the batch by the asset
workstream in `docs/pedestrian-characters.md`.

`seated-a` and `seated-b` are static posed figures — knees bent, feet flat, one
leaning forward at a phone. A correctly posed seated model reads far better in
a gate lounge than a standing VAT character forced into a chair, and costs one
instanced draw call instead of a new animation clip in every character's bake.

**One asset is weaker than the rest**: `fuel-bowser` came back as a tank without
much of a truck under it. It is used as a background apron prop and kept out of
the foreground rather than regenerated.

| Asset | Task |
| --- | --- |
| `air-stairs` | `16655458-194a-421b-b34c-482a900e5603` |
| `baggage-cart` | `8b1c119a-5c4f-4578-a6d1-051d9134ce36` |
| `baggage-tug` | `d0206de3-208a-42ab-956b-98bf50937788` |
| `checkin-desk` | `e1ffc600-a7ac-4676-b195-294ef1ae9991` |
| `duffel` | `ba0d02e3-2d37-4ffc-a2ad-9422e6a62239` |
| `flight-board` | `67bc8d0a-d746-43e5-bcea-68354f442fc7` |
| `fuel-bowser` | `2e414c91-7e89-489e-a6c3-2d6942a27014` |
| `gate-seats` | `bc5cb187-3da9-43ca-b2db-853662c11dd2` |
| `gpu-cart` | `b71af964-5ba6-46fa-9d4e-5233462a5109` |
| `scanner` | `fb7f6039-d6c2-42f2-b2e3-379f22f551c8` |
| `seated-a` | `db57ea35-e179-4db3-b996-41c3db22bf3c` |
| `seated-b` | `8146edf9-32ab-46a4-a2c6-e0410fddfeec` |
| `suitcase` | `1cf7d313-ccff-452c-a6be-13e9646db2c3` |
| `trolley` | `7f4bdc49-5c2a-46ce-8ff2-169073553725` |
| `windsock` | `7f4156b3-f308-4044-acbe-043971a4342c` |

**Total Tripo spend for this workstream: 950 credits.** Balance after: 1,410.

## Dialogue

Five new spoken lines (six files — one was split), ElevenLabs
`eleven_multilingual_v2`, `mp3_44100_128`, generated by
`tools/generate-airport-voices.mjs`. Sable keeps the voice she was cast with in
`tools/generate-mission-voices.mjs` — Lily, from the account's own library —
because these lines are the same person finishing the same conversation, and a
second voice for the second half of a job reads as a fault.

| File | Duration | Bytes | Peak | Mean |
| --- | --- | --- | --- | --- |
| `sable-charter-1.mp3` | 7.523 s | 121,252 | −5.8 dB | −23.7 dB |
| `sable-charter-2.mp3` | 8.406 s | 135,462 | −4.3 dB | −23.7 dB |
| `sable-charter-2b.mp3` | 5.433 s | 87,815 | −6.6 dB | −24.2 dB |
| `sable-charter-3.mp3` | 7.338 s | 118,326 | −5.4 dB | −22.3 dB |
| `sable-handoff-1.mp3` | 9.520 s | 153,435 | −6.1 dB | −23.4 dB |
| `sable-landed-1.mp3` | 5.108 s | 82,799 | −5.9 dB | −22.8 dB |

**Total 43.3 s, 689 KiB.** Levels sit inside the range of the seven lines
already shipped (peaks −4.3 to −6.6, means −22.3 to −24.2), so no further
treatment was needed. `sable-charter-2` was originally one 14.3 s take; it was
split because a fourteen-second subtitle is a wall of text, not a line.

## The mission, extended

"Last Call" is still **one** mission. Everything up to the payout is unchanged
— brief at the bar, drive to the Cannery, take the box, get two stars, drive
back — and the stage machine, the fee and the interruption rewind all behave
exactly as before.

What changed is that the payout is no longer the end. Sable pays for the run
across town and then says the takings cannot stay in the city, which is the
reason to go to the airport:

| Stage | Advances when |
| --- | --- |
| `payout` | Sable's existing lines finish → pays **$7,500** |
| `chartered` | the player presses E at the bar again |
| `briefingFlight` | the charter conversation ends |
| `toAirport` | within 22 m of the terminal's landside door |
| `concourse` | on the apron — i.e. having crossed the terminal |
| `boarding` | the player is in an aircraft |
| `departing` | airborne, 45 m above the field |
| `outbound` | within 90 m of the drop point over the bay |
| `handoff` | the radio call ends |
| `inbound` | down, under 2.5 m/s, on the field |
| `shutdown` | the last line ends → pays **$18,000** |

The box is **not** handed over at the bar. `carrying` stays true until the
aircraft reaches the drop point, which is the hinge the whole second half turns
on and is asserted in `tests/mission.test.ts`.

The first half of the job is *pressed* — walk up to somebody and press E. From
the charter onwards it is *measured*: stages advance on where the player is and
what they are flying. Only the current stage's own condition is ever evaluated,
so flying over the drop point while still being told to reach the airport does
nothing at all. That is tested.

The drop point is at (−215, 230), out over the water west of the shoreline and
about 550 m from the runway — far enough that the player has to climb, turn and
navigate, close enough that the round trip is minutes rather than a commute.
It is asserted to be below sea level, so it can only be reached by air.

`handoff` and `shutdown` are radio calls with nobody to walk back to, so they
rewind to the flying stage that triggers them again if the player is killed
mid-sentence — the same guarantee the three city conversations already had, and
for the same reason: dying during Sable's last line must not pay for the job.

## The pause

`Engine.setPaused()` is the whole of the simulation pause. Every system runs
off `engine.onUpdate`, so not calling it freezes physics, traffic, the crowd,
aircraft, projectiles, mission timers, animation and the audio listener
together, and no system needs to know a pause exists. Rendering continues, so
the world stays on screen behind the menu without advancing.

Two details that are not optional and are pinned by `tests/pauseWiring.test.ts`:

- **The frame delta is still read while paused.** `Clock.getDelta` reports the
  time since it was last asked, so skipping the call would hand the first
  resumed frame the whole length of the pause. The 0.1 s clamp would cap it,
  but a tenth of a second of traffic, gunfire and falling rockets still arrives
  in one step.
- **The clock the world is told about is a simulation clock, not wall time.**
  Traffic signals and pedestrian crossings phase off `elapsed` as an *absolute*
  time, so handing them wall-clock seconds after a two-minute pause would jump
  every light in the city on the first resumed frame.

`main.ts` has exactly one `engine.setPaused` call site and routes every pause
and resume through one `setGamePaused` helper, which stops the simulation, the
controller and the audio together. Regaining pointer lock no longer resumes on
its own — a stray click behind the overlay used to hand control back with the
menu still up.


## What was measured in a real browser

A production-like build at 1440x900 on a Retina Mac, so 2880x1800 drawing
buffer. `renderBenchmark` forces a GPU sync after every frame, so these are
real per-frame costs rather than a rAF average. All figures warm - the first
benchmark after a new vantage includes shader compilation and read 20.5 ms p95
against 9.5 ms once warm.

| | mean | p95 | draws | triangles |
| --- | --- | --- | --- | --- |
| **Before any of this work** | **5.58 ms** | 6.10 | 335 | 4.10 M |
| city spawn, high | 8.52 ms | 9.3 | 376 | 7.05 M |
| city spawn, medium | 4.20 ms | 4.7 | 366 | 6.24 M |
| city spawn, low | 2.54 ms | 2.5 | 244 | 2.88 M |
| downtown, high | 6.64 ms | 7.3 | 321 | 7.32 M |
| the apron, high | 5.18 ms | 5.8 | 277 | 6.21 M |
| inside the terminal, high | 7.13 ms | 8.5 | 295 | 6.97 M |

8.52 ms is 117 fps. The cost is up about half on the old figure, against a map
two and a half times the area with an airfield, a 62 x 190 m terminal, 52
travellers, five aircraft and richer impact effects in it. Geometry count went
219 to 328 and textures 62 to 149, which is where the memory went: 91.7 MB to
about 120 MB.

**The travellers cost 9 draw calls, 266 k triangles and 0.035 ms** inside the
terminal, and **nothing at all** from the city - `update` returns before it
simulates and the group is switched off, so `drawCalls` and `triangles` both
read 0 from downtown.

### The journey, verified

- **The pause is provable, not merely plausible.** `Engine.stepOnce` returns
  whether the world advanced, so a harness can count: **30 frames advanced
  while running, 0 of 120 while paused**, the simulation clock moved 0.0000 s,
  and the traffic and crowd statistics were byte-identical across the pause.
  The panel measured top 39, bottom 681 in a 720 px viewport.
- **Surfaces agree with what is drawn.** Probed live: the terminal concourse is
  `interior` and indoors at 14.66 m, the runway, taxiway and apron are
  `concrete` at exactly 14.50 m, the airfield verge is `grass`, Harbour Walk is
  `boardwalk`, and a harbour road is `asphalt`.
- **Boarding and take-off.** The prompt read *"Press E to board the Light
  single"*; E boarded it. Full throttle from the threshold got airborne after a
  **265-273 m ground roll at 30.4 m/s**, inside a 600 m runway.
- **Flight.** Screenshotted at 205 m over the field, the whole city drawn below
  - which is the altitude term added to `updateChunks` doing its job; without
  it the world switched itself off in a ring around the aircraft.
- **A shot officer stays.** Killed at 5 m: `officersDown` 1, `bodies` 1, and
  **still 1 after five more seconds**, still in the render list.
- **A rocket moves an ordinary car.** A `patrolSedan` under ambient control
  took a blast at 17 m: integrity **260 to 70**, displaced **1.33 m**, and it
  recovered to ambient control and drove on.

### What was NOT verified in the browser, and why

**Landing.** Three scripted approaches ended in crashes, and in each case the
model was right and the autopilot was not: the jet arrived at 155 m/s against a
71.3 m/s reference speed, and the Cessna at 46.5 m/s against 32.6. A real
aircraft flown 14 to 80 m/s fast floats, lands long and overruns, which is what
happened - it touched down 350 m past the threshold and ran off the end of a
600 m runway. Landing is covered instead by `tests/flight.test.ts`, which
measures touchdown vertical speeds of 0.90, 1.41 and 1.56 m/s and braking
distances of 133, 333 and 551 m for the three flyable types, and asserts the
whole descent is identical at 30 Hz and 240 Hz.

**Car versus car.** Covered by `tests/vehicleImpact.test.ts` (24) and
`tests/vehicleCollision.test.ts` (27). The browser attempt kept re-detecting a
car that an earlier rocket had already damaged, which proved nothing; the
rocket result above exercises the same `applyImpact` path in the live game.

### A defect found while verifying

`AudioDirector.updateListener` wrote the listener pose straight into
`AudioParam.value`, which **throws** on a non-finite number. It runs inside the
frame loop, so one NaN from anywhere upstream took down rendering, input and
the simulation together rather than making the sound wrong for a frame. It now
ignores a non-finite pose and keeps the last good one.

## Taking the controls: three defects and what they cost

Reported as "after the player enters any aircraft marked as flyable, the
aircraft does not respond to the documented keyboard controls". Three separate
faults produce that symptom, and all three were reproduced in a production
build at `http://localhost:4183` before anything was changed.

### 1. The key the player was already holding was invisible

`Flying.onKeyDown` began `if (!this.handle) return;`, so a keydown was only
recorded while an aircraft was already held, and `board()` then called
`this.keys.clear()`. **Shift is the game's run key and Shift is the throttle.**
The ordinary way a player reaches an aeroplane is at a sprint, so the ordinary
sequence was: hold Shift, press E, keep holding Shift - and `Flying` had never
seen the keydown and never would until the key was released and pressed again.

Measured in the browser, walking up to the Light single on stand 4:

| | throttle | ground speed | distance in 5 s |
| --- | --- | --- | --- |
| board with Shift held, keep holding | 0.000 | 0.000 m/s | **0.00 m** |
| release Shift, press it again | 1.000 | 8.908 m/s | 18.69 m |

The same applied to `W`, `S`, `A`, `D` and the arrows, which are the walking
keys: `S` held across boarding produced −0.047 rad of pitch in two seconds
(the trim settling) against +1.243 rad for the same key pressed after boarding.

The key set is now a faithful mirror of the keyboard, kept whether or not this
object owns an aeroplane, and `board` does not clear it. The gear latch is
seeded from the live `KeyG` state so a held `G` is not read as a fresh press.
After the fix, the same sprint-and-board run reads throttle 1.000, 8.979 m/s,
18.99 m.

### 2. The Light twin was welded to stand 3 by a ground-power cart

`apronEquipment` in `src/world/airport/props.ts` places a `gpuCart` at
`stand.x + 9.5`. The stands face +X, so on stand 3 that cart is **0.6 m in
front of the Light twin's nose**, and it is solid: `halfX 0.6, halfZ 1.0`,
rotated west, giving `minX = 248.5`. The twin's own half-length is 7.9 m, so
its nose starts at 247.9.

Measured before the fix: full throttle for five seconds moved the twin exactly
**0.60 m** and left it at **0.000 m/s**, `crashed` false, with nothing said.
Placed at x = 237 instead it moved 3.60 m and stopped at the same absolute
place. That is the cart's own minX, not a coincidence and not a tuned number.

Nothing could recover it. `flight.ts` answers a refusal by zeroing the refused
velocity components; at rest the nose-wheel steering target is
`along * tan(angle) / wheelBase`, which is zero, and the rudder's moment is
proportional to dynamic pressure, which is also zero. A pinned aeroplane cannot
even turn away from what is pinning it.

The jet on stand 2 escaped only by accident: its half-length is 8.6 m, so its
parked footprint already overlapped the cart and `CollisionWorld`'s containment
waiver let it drive straight through. The two Cessnas are on the light stands,
which `apronEquipment` deliberately leaves empty.

Two things answer it, both in `src/air`:

- **the jam is reported.** `FlightEvents.blocked` is set on every refusal,
  however gentle - `impact` only fires above 0.2 m/s of closing speed, which a
  creeping aeroplane never reaches - and `Flying` ages it into
  `state.blocked` / `state.blockedSeconds`, which the HUD shows as
  *Blocked — something solid ahead*;
- **ground clutter gives way.** After `JAM_SECONDS` (1 s) of pushing, on the
  ground, below 8 m/s, the same footprint is re-tested in the band from
  `CLUTTER_HEIGHT` (2.2 m) above the wheels upward. The obstruction only
  yields when that band is clear - i.e. when everything refusing the aeroplane
  is shorter than a person. Measured against the airport's own props: the
  ground-power cart is 1.3 m, a baggage cart 1.6 m, a tug 1.9 m, a bollard
  0.6 m; the air stairs are 3.4 m, the fuel bowser 2.9 m, and the terminal,
  hangars and tower are far taller. Another aeroplane is never clutter.

Measured after the fix, the twin boarded on stand 3 at full throttle:

| t | x | ground speed | blocked |
| --- | --- | --- | --- |
| 1 s | 240.25 | 0.77 m/s | no |
| 2 s | 240.60 | **0.00 m/s** | **yes**, 0.63 s |
| 3 s | 241.17 | 1.76 m/s | no |
| 12 s | 368.20 | 26.17 m/s | no |

It meets the cart, says so, and is moving again a second later.

**The world half of this is still open.** The cart is on the aircraft's only
exit from the stand, and `src/air` is not where that belongs; the right fix is
in `apronEquipment`, which should not place equipment on the taxi-out
centreline.

### 3. Two aircraft on one spot pinned each other

`AircraftSystem.blockedBy` had no containment waiver, though
`CollisionWorld.blockedBox` has had one all along and `Flying` was already
passing it one. An aeroplane whose footprint overlapped another - two spawned
on one stand, a wingtip over a neighbour's tail - was refused every direction
at once, silently and for ever. `blockedBy` now takes the same `fromX`/`fromZ`
waiver and skips only the aircraft it is already inside.

## What the player is told

- Walking up to the airliner used to show no prompt and `E` did nothing, which
  is indistinguishable from a broken key. `Flying.promptAt` now words both
  cases and the airliner reads
  *"Narrowbody airliner — needs about 1100 m of ground roll at 64 t; Meridian
  Bay Regional has 600 m"*, from `AircraftSpec.groundedReason`.
- **Contextual controls.** Boarding puts `FLIGHT_CONTROLS` on screen as a
  compact panel in the same corner, the same class and the same key/action
  rows as the walking hint, and instead of it - two control lists in one corner
  is worse than either. It holds while the aeroplane is stopped on the ground
  or jammed, and fades once it is under way; a jam adds a warning line. The
  labels are `flightControlHints(detectPlatform())`, so a Mac reads
  `⇧ Shift / ⌃ Control`.

## The journey, flown

A production build, `__meridian.step` driving the simulation and every control
input delivered as a real `keydown`/`keyup` on `window`. Reference speeds for
the Light single: Vs 25.1, Vr 28.1, Vref 32.6 m/s.

| Stage | Result |
| --- | --- |
| Board | Sprinted up with Shift held; prompt *"Press E to board the Light single"*; `E` boarded it and the control panel appeared |
| Taxi | 104 m from stand 5 to the runway centreline on the throttle and the wheel brakes, then two rudder turns and a backtrack. Never blocked, never crashed |
| Take-off | **239.7 m ground roll**, lift-off at **30.0 m/s** (1.20 Vs), 16.0 s from brake release |
| Climb | Steady **4.0–5.4 m/s at 42 m/s** with the nose 8.8° up, wings level, 42 → 298 m AGL |
| Turn | 180° at **25° of bank** (0.44 rad), heading π → 0 in 45 s, airspeed steady at 54 m/s |
| Cruise | 7.7 km back to the field at 55 m/s and 450 m |
| Descent | 450 → 90 m on the throttle, 2.6° glidepath at 35 m/s |
| Landing | Touchdown on the runway at **(340, 396)**, **31.4 m/s** (0.96 Vref), **1.33 m/s vertical**, nose up 4.5° |
| Stop | Brakes and idle: **125.2 m rollout**, stopped at z = 271 |
| Exit | `E` put the player out 7.1 m off the port wingtip on concrete; the panel cleared, the walking hint came back and Arrow Up walked 8.3 m |

An earlier unbraked rollout is worth recording because the model was right and
the pilot was not: touching down at z = 425 and never touching the brakes ran
the aeroplane 215 m off the north end and wrote it off. Brakes are not
decoration.

### What was NOT verified in the browser, and why

**Real hardware key events.** The browser automation's `computer` key action
delivers `KeyboardEvent`s with `code`, `key` and `keyCode` all empty - checked
directly, `isTrusted` true and `code === ""` - so it cannot exercise the
game's `event.code` bindings at all. Every keyboard result above is from
`window.dispatchEvent(new KeyboardEvent(...))`, which reaches the same
listeners in the same order and is subject to the same `preventDefault`;
what it cannot prove is the behaviour of a real modifier that never delivers
its `keyup`. `onBlur` clearing the key set is covered by
`tests/aircraftControl.test.ts` instead.

**Pointer lock.** Never granted in the automation pane, so the "mouse look only
under lock" path was read rather than exercised.

## The terminal floor, and the depth budget it is built to

The terminal interior shipped with 62 × 190 m of floor that flickered in grey
and white bands as the camera moved. Two independent causes, both of them the
depth buffer rather than the lighting:

1. **Coplanar overlap.** `buildTerminalShell` emitted the plinth as one box
   whose top face was at exactly `TERMINAL_FLOOR`, and `buildTerminalInterior`
   laid the interior floor slab with its top face at exactly `TERMINAL_FLOOR`
   too, entirely inside it. Two surfaces in the same plane over the same ground
   give the depth test nothing to choose between: which one wins is decided by
   floating-point noise, per pixel, and changes with the camera.
2. **Sub-quantum separation.** The floor bands and the walking line were drawn
   4 mm above the slab. The camera is `PerspectiveCamera(62, 1, 0.1, 1200)`, so
   on a 24-bit depth buffer the smallest resolvable step at range *z* is

   ```
   Δz ≈ z² · (far − near) / (far · near · 2²⁴) = z² · 6.0e−7 m
   ```

   3.8 mm at 80 m, 24 mm across this building's 200 m diagonal. The far half of
   every band was inside the buffer's own resolution.

| Range | Depth quantum |
| --- | --- |
| 20 m | 0.24 mm |
| 50 m | 1.5 mm |
| 80 m | 3.8 mm |
| 130 m | 10 mm |
| 200 m (interior diagonal) | 24 mm |

### The fix

Neither cause is papered over — no fog, no `polygonOffset`, no disabled depth
write, and nothing merely floated higher.

- The plinth is an **apron**: four boxes around the wall line whose inner edge
  stops at the inner wall face. It emits no top face under the interior at all.
  Its collider is unchanged — one non-solid box over the whole footprint, which
  is what makes the building walkable.
- The floor is a **mosaic**. `layFloor` in `terminal.ts` takes a base rectangle
  and a painting order of material zones and returns rectangles that *tile* the
  footprint: every point covered once, no two pieces overlapping. Bands, the
  walking line, shop floors and lounge pads are all cut *into* the floor at
  exactly `TERMINAL_FLOOR` rather than laid on top of it. Two rectangles that
  share no area cannot share a pixel, at any distance and on any depth buffer,
  so this is exact rather than a tolerance.
- `MIN_SURFACE_SEPARATION` = 25 mm is the floor for everything else, derived
  from the table above.

### What the tests assert

`tests/terminalSurfaces.test.ts` builds the shell, the interior, the tower, the
hangars, the airfield lighting and the signage into a sink that keeps geometry,
keeps every upward-facing triangle, and checks the whole set pairwise:

- no two overlapping horizontal surfaces are coplanar;
- no two overlapping horizontal surfaces are closer than
  `MIN_SURFACE_SEPARATION`;
- the threshold is re-derived from the camera in the test itself.

Overlap is real polygon area (Sutherland–Hodgman clip plus shoelace), not
bounding boxes: two triangles of one quad share an edge, and a cylinder cap is a
fan around one vertex — both have overlapping bounds and zero shared area.
Only upward faces are compared with upward faces, because materials are
`FrontSide` and a counter top resting exactly on the carcass below it is
construction, not a defect.

### The other coplanar defects the sweep found

All of them real, none of them the same line of code as the floor:

| Where | What |
| --- | --- |
| Tower cab | The mullions stopped flush with the glazing head; both tops in one plane over the mullion's whole width |
| Terminal shell | East and west walls ran into the corners of the north wall and the south gable, four 0.5 m squares of doubled wall top |
| Terminal roof | The "parapet" was a second slab over the whole deck, hiding the tar and sitting 0.35 m over it |
| Terminal ceiling | The step between the two ceiling heights was carried to the hall slab's top face — a 0.3 × 61 m strip in its plane |
| Structure | Columns ran to the ceiling, so every column top was in the plane of the beam it carried |
| Ceiling lighting | Every fitting sat 10 mm under the ceiling, and the down-stand beams' tops are at exactly the ceiling — so every run that crossed a beam fought it over 1.1 m |
| Roof trusses | The web posts were drawn inside the chord, sharing its top face |
| Security | The lane archway head oversailed the partition by 0.12 m at the same height |
| Retail units | Side walls and back wall overlapped at the corners; the fascia header ran over the side walls |
| Hangars | Same corner overlap as the terminal, at 27 m |
| Apron floodlights | The mast stopped flush with the top of its own head |
| Mezzanine | The deck fascia and the escalator's top tread both topped out at deck level over the same ground |

### Known limitation

The paved surfaces and painted markings in `surfaces.ts` are drawn through
`SurfaceBuffer` with the city-wide `MARKING_LIFT` of 12 mm, and are outside
this sweep. By the table above a marking becomes ambiguous beyond about 142 m,
so runway and apron paint at the far end of a 600 m runway is inside the
budget. It was inspected in a production build and the exponential fog has
washed it out well before it can be seen to fight; raising the lift enough to
survive 600 m would need 215 mm, which would be a visible step underfoot. The
robust fix is `polygonOffset` on the two paint materials, which lives in
`render/materials.ts` and is not this workstream's file.

## The terminal, fitted out

The shell was a warehouse: 62 × 190 m of empty floor, almost no furniture, and
`signEmissive` — the palette's magenta, authored for the nightclub — carrying
the flight board and the security signage. The frontage sign was one 18 × 3.2 m
board on legs 16 m out from the doors, which from anywhere on the forecourt was
a cream rectangle across the whole elevation.

| | Before | After |
| --- | --- | --- |
| Interior triangles | 8,656 | 17,326 (budget 24,000, enforced) |
| Light requests | 11 | 13 (budget 16, enforced) |
| Colliders | 68 | 110 |
| Material meshes in the terminal chunk | 21 | 28 |
| Floor materials | 3, overlapping | 8, tiling |

What the extra bought, in the order you walk through it: an entrance with
barriers, planters and a trolley bay; a landside hall with two free-standing
check-in islands, a six-position self-service kiosk bank, an information desk, a
café with tables, a shop, and a mezzanine deck with a glazed balustrade and an
escalator that breaks the double-height volume; two flight-information banks
either side of the route rather than one board standing on it; a security line
with a belt-post queue snake, roller beds, lane lightboxes and re-composure
benches placed in the bays between lane corridors; a concourse with dropped
soffits and cove lighting over both retail edges; five retail units with glazed
fronts, counters and fascias; gates with glazed boarding vestibules, podiums and
numbered lightboxes; and a baggage hall with two carousels, arrivals screens, a
glazed clerestory and a customs channel.

Outside: PAPI boxes at both thresholds, painted stand numbers, and a jet blast
screen across the north end of the apron.

### Routes, and the tests that hold them open

Adding furniture to the one building the traveller crowd lives in is how you
close it. Three plan facts moved as a result, and each is now asserted:

- **Security lanes moved from 166/183/200 to 170/183/196.** The structural
  column rows stand at x = 165 and x = 199, so the outer two lanes had a 0.9 m
  concrete column inside their 3.2 m width.
- **The column grid was re-phased** from `INNER.minZ + 6` to `INNER.minZ + 3`.
  At the old phase a column stood 0.5 m from the first check-in queue line, so
  the fifth person in that queue was standing inside it.
- **The tray tables moved out of the lane exits.** One stood squarely across the
  centre lane — the only route from the entrance to the gates.

`tests/terminalSurfaces.test.ts` asserts the concourse spine is clear of solid
colliders from the north wall to the baggage partition, that every security lane
is clear across its full width, that every door has 3.6 m of clear approach
inside it, that every published queue slot is unobstructed, and that the
traveller navigation graph still connects entrance → check-in → security → gate
lounge → gate 3 → baggage on one component.

## The apron, and why a ground power unit stopped a turboprop

`apronEquipment` placed the ground power unit at a flat `stand.x + 9.5`. Every
stand faces +X, so on stand 3 that put the cart's near face at x = 248.5 with
the parked twin turboprop's nose at 247.9 — **0.6 m of clearance directly
across the only way off the stand**. Measured in a production build before the
fix: the twin at full throttle for five seconds moved exactly 0.60 m and
stopped at 0.000 m/s, `crashed: false`, with nothing reported to the player. It
stopped at the cart's own `minX`, not at a tuned number; moved to x = 237 the
same aircraft rolled 3.60 m and stopped at the same absolute x. The business
jet on stand 2 escaped only because its longer fuselage already contained the
cart and a containment waiver let it through — the same defect with a luckier
outcome — and the Cessnas sit on the light stands, which are left undressed,
which is why it only showed on some aircraft.

The aircraft workstream made the jam recoverable and audible from its side. The
placement was still wrong, and that half is fixed here: no position on the
apron is a fixed offset any more. `plan.ts` publishes `STAND_ENVELOPE` — half
length, half span and half fuselage width for each stand class, taken from
`air/AircraftCatalogue.ts` and rounded up to the largest type that parks on a
stand of that size — plus `standTaxiCorridor()` and `standFuselage()`. Every
piece of equipment is placed off the envelope: the airstair at the forward door
and the ground power unit abeam the nose, both on the port side and both clear
of the fuselage; the baggage train aft of the wing root on the starboard side.
That is also where a real turnaround puts them, so it looks better as well as
working.

The envelope is deliberately NOT imported from the catalogue — the world
builder must not pull `AircraftSystem`, and therefore Three.js, into itself —
so `tests/apronClearance.test.ts` reads both and fails if the table ever stops
covering the fleet actually parked. It then asserts the invariant rather than
the fix: for every stand, the taxi-out corridor contains no solid prop
collider, nothing stands inside the fuselage, every worked stand still has its
airstair and its ground power unit, and every aircraft can roll at least 20 m
before meeting anything solid.

A jet blast screen across the north end of the apron was drafted in the same
pass and **removed before shipping**: it was a 43 m solid barrier on a movement
area, added for looks, and this is exactly the defect that had just been
reported. The apron keeps the PAPI boxes at both thresholds and the painted
stand numbers instead.
