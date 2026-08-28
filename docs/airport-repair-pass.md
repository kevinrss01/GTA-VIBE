# The airport repair and realism pass

What was broken, how it was reproduced, what the root cause turned out to be,
and what it cost. No API key appears here or in any generated metadata.

This document is the lead's record. The workstream detail lives in the
documents each area already owns — `airport-and-flight.md`,
`pedestrian-characters.md`, `vehicle-assets.md`, `audio-manifest.md`,
`weapon-assets.md`.

## How the defects were reproduced

A production build (`npm run build`) served by `vite preview` on
`http://localhost:4183`, driven through the `window.__meridian` QA harness.

The automation pane does not composite between tool calls, so
`requestAnimationFrame` never fires and the game looks frozen to a naive
screenshot. Every measurement below therefore drives the simulation with
`__meridian.step(frames)`, which runs the same update path the frame loop runs
and returns how many frames actually advanced. Frame costs come from
`__meridian.renderBenchmark(90)`, which forces a GPU sync per frame.

**Absolute frame numbers measured in the automation pane are not comparable to
the numbers in `airport-and-flight.md`**, which were measured in a real window.
The pane renders at 2560x1440 with `pixelRatio` 2 and serialises on the sync,
and read about 4x slower than the same build in a real browser window. They are
recorded here only as a like-for-like before/after baseline.

### Baseline, before any of this work

| vantage | mean | p95 | worst | draws | triangles | memory |
| --- | --- | --- | --- | --- | --- | --- |
| city spawn `(-153, 18)` | 29.78 ms | 33.9 | 37.8 | 230 | 6.25 M | 102.8 MB |
| terminal north `(183, 380)` | 30.08 ms | 35.5 | 43.4 | 223 | 6.21 M | 104.2 MB |
| terminal south `(183, 470)` | 31.09 ms | 36.9 | 42.3 | 217 | 6.21 M | 103.9 MB |
| forecourt `(183, 330)` | 31.65 ms | 41.2 | 47.8 | 215 | 6.17 M | 103.2 MB |
| apron `(250, 450)` | 32.84 ms | 41.3 | 44.8 | 215 | 6.19 M | 103.7 MB |

Static world at that point: 121 parcels, 24 streets, 1,763 colliders, 2,748
instances, 404,870 static triangles, 14 chunks, 291 geometries, 113 textures.

Crowd at that point: `population` 270, `rendered` 267, **`characters` 4**,
2,952 triangles per person, 1,092 pavement links.
Travellers at that point: `population` 52, **`characters` 4**, `seated` 30,
`walking` 36, `queueing` 16, 8-9 draw calls, 133-176 k triangles.

## The Vercel deployment

The last three production deployments failed. The cause was not the game:

```
Detected `pnpm-lock.yaml` 9 ... Using pnpm@10.x based on project creation date
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"
  because pnpm-lock.yaml is not up to date with <ROOT>/package.json
  specifiers in the lockfile don't match specifiers in package.json:
  * 1 dependencies were added: jsdom@^26.1.0
Error: Command "pnpm install" exited with 1
```

The repository carried **two** lockfiles. `package-lock.json` was current —
`jsdom` was added to `devDependencies` for the Vitest jsdom environment and npm
recorded it. `pnpm-lock.yaml` was last written before that and never caught up.
Vercel's package-manager detection prefers `pnpm-lock.yaml`, so every build ran
`pnpm install --frozen-lockfile` against a lockfile that disagreed with
`package.json` and stopped in six seconds, before a single line of the game was
compiled. `node_modules/` locally carried BOTH `.package-lock.json` and
`.modules.yaml`, so both managers really had been used here at some point.

`AGENTS.md` says npm unless a lockfile establishes otherwise; the npm lockfile
is the one that is actually maintained. So:

- `pnpm-lock.yaml` and `pnpm-workspace.yaml` were deleted. The workspace file
  additionally contained the literal placeholder `allowBuilds: esbuild: set
  this to true or false`, which is not a value pnpm can act on.
- `vercel.json` now pins `framework`, `installCommand: npm ci`,
  `buildCommand: npm run build` and `outputDirectory: dist`, so package-manager
  detection can never choose again.
- `npm ci` was verified to resolve cleanly against the committed lockfile,
  which is the exact command the build now runs.

`npm ci` fails loudly if `package.json` and `package-lock.json` ever drift
again, which is the intended behaviour: a deployment that installs the wrong
tree is worse than one that stops. The build command keeps `tsc --noEmit`
ahead of `vite build` for the same reason.

## Footsteps

The reported bug was "roads sound wrong". The measured cause was larger than
that. `FirstPersonController` classified the surface as

```ts
this.surface = support.built && support.y > here.y + 0.05 ? 'interior' : here.surface;
```

which collapses **every** built platform standing more than 5 cm proud of the
terrain into one bucket — and that bucket was mapped to a domestic ceramic-tile
pair. Swept over the whole map at 1.5 m spacing, **6,276 walkable points took
that branch and only 372 of them are actually indoors**: shop plinths, boardwalk
decks, apron edges and the whole terminal played a kitchen floor. Separately,
`STEP_SURFACES.concrete` pointed at the *pavement* pair while the
`steps/concrete-*` assets sat in the manifest unreferenced, so the runway, the
taxiway, the apron and every hangar floor were a city paving slab.

The fix reads `ColliderBox.surface` — the field that already exists so that "a
footstep on a hangar floor is not decided by guessing from the terrain
underneath it" — through an index over the tagged colliders.

The `onRoad` flag `main.ts` used to sample and pass down turned out to be
**dead**: of 28,875 carriageway points, zero were misclassified without it. It
was a fossil of an already-fixed bug in `openGroundSurface`. Both sweeps are
regression tests now, so neither defect can come back quietly.

Hysteresis was replaced rather than tuned. A hold counted in *footsteps* cannot
be both prompt and stable; the debounce now runs on the continuous 120 Hz
signal with a 0.1 s commit — 0.28 m walking, well inside a 1.45 m stride — so a
boundary commits before the next footfall and chatter never reaches the mixer.
Measured: crossing off Harbour Walk reads `boardwalk x4 | asphalt x7 |
boardwalk x4`, one footfall of lag and no flicker; a 60 Hz weave across a
boundary produces **zero** family changes in 10 s.

Volume is down to −8 dB, footsteps strictly alternate left/right with a ±0.28
stereo pan, and running is now **heavier and lower** (+3.5 dB, rate 0.94) rather
than the old higher-pitched variant, which is the wrong direction for a heavier
contact.

Two city-interior edits were applied by the lead outside the audio workstream's
ownership, so a club's timber deck is no longer classified as generic
`interior`: `addCollider` in `world/build/interiorProps.ts` now takes an
optional surface, and `addFloor` in `world/build/InteriorBuilder.ts` passes
`room.palette.floor`.

Verified in a production build by reading back which asset actually fired:
asphalt on the carriageway, boardwalk on Harbour Walk, the terminal pair on the
concourse, **concrete on the apron and the runway**, grass on the verge,
pavement in the city. No bleed; `interior` never fired outdoors.

## Vehicle audio

Ten engine layers plus tyre roll, an upshift clunk and a brake squeal, from
ElevenLabs `eleven_text_to_sound_v2` at `mp3_44100_128` via the skill's
documented REST fallback (`tools/generate-vehicle-sfx.mjs`) — the `elevenlabs`
MCP server is not present in this session; `.mcp.json` declares only `tripo`.

**279.66 credits (USD 5.59)**, 1.048 MiB, of which 1.07 MB is deferred and
fetched only when the player gets into a car of that class.

Levelled by **loudness, not peak** (idle to −21.2 dB mean, load to −18.2,
matching the shipped saloon pair) with a −1.5 dBFS peak guard. Peak-normalising
had put the coupe's idle 4.8 dB above the saloon's on render luck alone. Three
renders came back at 0.0 dBFS and were checked with `astats` — `Flat factor 0`,
`Peak count 2`, i.e. MP3 decode overshoot rather than a clipping plateau — and
trim takes all three to −5.3 dBFS or lower.

Two assets were re-rendered after band analysis caught them: `engine-small-load`
arrived 78 % above 1.5 kHz (induction hiss, no engine). `engine-sport-idle` is
**the weakest asset in the batch** — still bass-dominant after a second render,
accepted rather than chased, because idle separation is carried by the filter
corner (900 Hz against the truck's 380 Hz) and the coupe is unmistakable on load.

Six voices, mapped from `VehicleCatalogue` and pinned by a test so a new vehicle
shell fails the suite rather than silently becoming a saloon:

| Voice | Kinds | Gears top at (m/s) | Idle cutoff |
| --- | --- | --- | --- |
| small | compact | 6, 11, 18, 27 | 760 Hz |
| saloon | sedan, wagon, crossover, taxi | 7, 13, 21, 32 | 700 Hz |
| sport | coupe | 10, 18, 28, 40, 52 | 900 Hz |
| diesel | van, pickup | 6, 11, 17, 25, 33 | 480 Hz |
| truck | boxTruck | 4, 7, 10.5, 15, 20, 26 | 380 Hz |
| interceptor | patrolSedan, patrolSuv | 9, 17, 27, 38 | 640 Hz |

A truck shifts six times before a coupe leaves first gear, and that gearing
difference carries most of the identity. Persistent audio nodes went 23 to 30
against a measured stress peak of 58 and a ceiling raised to 72.

**Honest limitation: nobody listened to these files.** Every claim above is a
measurement — band split, loudness, true peak, loop seam, leading and trailing
silence — or an in-game readback of which asset fired. The tyre-roll loop seam
is 3.5 dB, the only one over 3 dB; it sits at −8.2 dBFS under a continuous
engine and was shipped rather than rebuilt.

## Aircraft controls

The reported defect — "the aircraft does not respond after boarding" — was real,
and the cause is a collision between two bindings rather than anything wrong
with the flight model.

**`Shift` is the game's run key. `Shift` is also the throttle.** `Flying`'s
`onKeyDown` began `if (!this.handle) return;`, so a keydown was recorded only
while an aircraft was *already* held, and `board()` then called
`this.keys.clear()`. The ordinary way a player reaches an aeroplane is at a
sprint, so the ordinary sequence is: hold Shift, press E, keep holding Shift —
and `Flying` had never seen that keydown and never would.

Measured live at the Light single on stand 4:

| | throttle | ground speed | distance in 5 s |
| --- | --- | --- | --- |
| board with Shift held, keep holding | **0.000** | **0.000 m/s** | **0.00 m** |
| release Shift, press it again | 1.000 | 8.908 m/s | 18.69 m |

The stick behaves the same way: `S` held across boarding gave −0.047 rad of
pitch in two seconds — just the trim settling — against +1.243 rad for the same
key pressed after boarding. The key set is now a faithful mirror of the keyboard
at all times, and neither boarding nor leaving clears it. `KeyG`'s edge latch is
seeded from the live key state so a held G is not read as a fresh press.

Two further faults were found on the way:

**A ground-power cart welded the twin to stand 3.** `apronEquipment` puts a
`gpuCart` at `stand.x + 9.5`; the stands face +X, so on stand 3 the cart's
`minX` is 248.5 against the twin's nose at 247.9. Full throttle for five
seconds moved the aeroplane **exactly 0.60 m** — the cart's own `minX`, not a
tuned number — and left it at 0.000 m/s with `crashed: false` and nothing said
to the player. At rest a pinned aeroplane cannot even turn away: nose-wheel
steering scales with ground speed and the rudder's moment with dynamic
pressure, and both are zero. `impact` only fires above 0.2 m/s of closing
speed, which a creeping aeroplane never reaches, which is why the jam was
silent. A jam is now tracked and surfaced ("Blocked — something solid ahead"),
and after one second of pushing, on the ground, below 8 m/s, the footprint is
re-tested from 2.2 m above the wheels upward: the obstruction yields **only**
when everything refusing it is shorter than a person. Carts (1.3 m), baggage
carts (1.6 m), tugs (1.9 m) and bollards (0.6 m) yield; air stairs (3.4 m), the
fuel bowser (2.9 m), buildings and other aircraft never do, and nothing yields
in the air or above taxi speed.

**`AircraftSystem.blockedBy` had no containment waiver** although
`CollisionWorld.blockedBox` has had one all along, so an aircraft spawned
overlapping another was pinned with no way out.

Walking up to the airliner also showed no prompt at all and E did nothing;
`Flying` now words that prompt itself, so the aeroplane says why it cannot be
taken.

A contextual control panel now appears on boarding, is held while the aeroplane
is stopped or jammed, and fades once it is under way. It reuses the walking
hint's classes and corner and is shown instead of it, so no CSS change was
needed.

### The journey, flown end to end in a production build

Light single, Vs 25.1, Vr 28.1, Vref 32.6 m/s:

| Stage | Result |
| --- | --- |
| Board | sprint up with Shift held; prompt read "Press E to board the Light single"; boarded, panel appeared |
| Taxi | 104 m stand to runway on throttle and brakes, two rudder turns and a backtrack; never blocked, never crashed |
| Take-off | **239.7 m ground roll**, lift-off at **30.0 m/s** (1.20 Vs), 16.0 s |
| Climb | 4.0–5.4 m/s at 42 m/s, nose 8.8° up, 42 to 298 m AGL |
| Turn | 180° at 25° bank in 45 s, speed steady |
| Cruise and descent | 7.7 km at 55 m/s and 450 m, then 450 to 90 m at 2.6° |
| Landing | touchdown **on the runway** at (340, 396), **31.4 m/s** (0.96 Vref), **1.33 m/s** vertical, nose up 4.5° |
| Stop | **125.2 m** braked rollout |
| Exit | placed 7.1 m off the wingtip on concrete; panel cleared, walking hint returned |

The twin was then taken off stand 3 the same way: blocked at 0.63 s with the
warning on screen, moving again at t=3 s, and 112 m down the runway at 26.2 m/s
by t=12 s.

An earlier unbraked rollout ran 215 m off the north end and wrote the aeroplane
off. The model was right; the pilot was not. Landing is no longer only covered
by unit tests.

**Honest limitation: no real hardware key event was ever delivered.** The
automation pane's synthetic key action produces `KeyboardEvent`s with `code`,
`key` and `keyCode` all empty, so it cannot exercise `event.code` bindings at
all. Every keyboard result above comes from `window.dispatchEvent`, which
reaches the same listeners in the same order with the same `preventDefault`
semantics. What that cannot prove is a real modifier whose `keyup` is never
delivered by the OS; `onBlur` clearing the set is covered by a test instead.
Pointer lock was never granted in the pane, so mouse-look under lock was read
rather than exercised.

## Generated travellers

Seven new rigged, animated traveller characters and two luggage props, through
the pipeline `docs/pedestrian-characters.md` already records. The full task-id
table, per-stage credits and validation detail live in that document; this is
the summary and the honest parts.

| id | who | tris | walk loop | foot slide med / p90 / worst |
| --- | --- | --- | --- | --- |
| `ped-e` | businessman, charcoal suit | 2918 | 1.867 s, 48f | 28 / 52 / 190 mm |
| `ped-f` | elderly woman, long coat | 2915 | 2.333 s, 48f | 8 / 41 / 330 mm |
| `ped-g` | teenager, red hoodie | 2844 | 2.333 s, **64f** | 23 / 69 / 159 mm |
| `ped-h` | ground crew, hi-vis, cap | 2796 | 2.333 s, 48f | 14 / 33 / 314 mm |
| `ped-i` | woman, summer dress | 2944 | 2.333 s, 48f | 7 / 18 / 44 mm |
| `ped-k` | tall man, denim and cargo | 2830 | 2.333 s, 48f | 10 / 66 / 300 mm |
| `ped-l` | woman, athletic wear | 2952 | 2.333 s, 48f | 21 / 63 / 72 mm |

The acceptance gate was the previously shipped `ped-c`, measured at 45 / 146 /
304 mm. **Every character above beats it on median and p90**; `ped-i` is now
the best-grounded person in the game. Triangle counts are 2,796–2,952 against
the existing 2,844–2,990, so each costs one colour and one shadow draw call
exactly like a person already in the crowd.

All ten rigs passed `validate-rig` first try. Grounding and pose were checked
over **every column of every clip**, not at frame 0: feet land in −0.010 to
−0.004, heads at 0.994 to 1.011, travel curves monotonic and ending exactly at
`travelPerCycle`. **No T-pose can leak**, because a VAT contains only sampled
walk and idle frames and no bind pose. All seven albedo atlases were viewed.

All seven carry **hand tracks on both clips** — the original four have
`hand: null` — which is what allows a suitcase, duffel, trolley, backpack or
garment bag to be attached to a measured wrist rather than guessed at.

Two new props: `backpack.glb` (372 KiB) and `garment-bag.glb` (398 KiB), same
convention as the existing luggage.

### What failed, and the gap it leaves

`ped-j`, the heavy-set older man, was generated **twice** and failed both times
— 68 / 164 / 797 mm, then 50 / 157 / 617 mm, worse than the gate on all three
figures each time. Re-sampling at 64, 80 and 96 frames moved nothing. A short,
wide humanoid slides under `preset:biped:walk`; on the first attempt the
contact search found a plantable foot in only 6 of 48 frames. It was dropped
under the agreed retry-once policy and there is deliberately no `ped-j`.

**The roster therefore has no heavy-set traveller.** That is a real gap in the
body-type spread that was asked for, and it is not worth faking by scaling one
of the seven non-uniformly.

Two provider findings worth keeping: `preset:biped:walk` returns either a
2.333 s or a 1.867 s clip, fixed by the rig — a 10-credit re-roll returned the
identical variant — and `preset:biped:idle` does not always contain a short
sub-loop, so `ped-e` needed `--min-period idle=1.0` or its idle baked as 20
frames spread over 12.3 seconds.

`ped-g`'s 64-frame walk is measured, not arbitrary: re-baking him at 48 frames
takes his worst slide from 159 mm to **694 mm**.

### Spend

**760 credits. Balance 1410 → 650**, independently confirmed by
`tripo balance --json` after the fact, so nothing else drew on the key.
200 generation + 250 rig + 210 retarget + 100 props; prerigchecks are free.

That is **140 more than the ~620 estimated** when the batch was approved. 130 of
it is the two mandated single regenerations — the approved policy was "retry
once, then drop", and two characters needed that retry — and 10 is a retarget
determinism probe that returned a negative result and is recorded as one. No
character was retried more than once.

## Abandoned vehicles

`Driving.exit()` called `handle.release()`, which reached
`TrafficSystem.releaseControl` and then `TrafficSim.attach`. `attach` searched
the whole lane graph, wrote `laneId` and `along`, zeroed the velocities, picked
a new desired speed and called `chooseNext` — after which pure pursuit and the
1.6 m centreline snap in `steerAndMove` dragged the body onto the lane, rotated
it to the lane heading and drove it away. When nothing scored under 14 it
called `recycle` and the car the player had just parked simply vanished.

`VehicleState` is now `'ambient' | 'player' | 'loose' | 'parked'`.
`VehicleView.control` deliberately still publishes the old three values — a
parked car reports `'loose'`, because nobody is driving it — and the new
`VehicleView.state` carries the difference, so `StreetAudio` and `PoliceSystem`
needed no edit at all and stayed correct.

Every `control ===` comparison was audited: `rebuildIndexes` (a parked car joins
the driven set inside the render distance so traffic can still collide with it),
a new `stepParked` branch, `movementsConflict`, `applyImpact` (a parked car
absorbs a nudge into its velocity; a hard hit sends it loose), `goLoose`,
`recycle`, `detach`, `attach`, `placeVehicle`, `resetBody`, `syncView`, and
`settleLoose` — where wrecks, rolled cars and abandoned cars now park instead of
re-attaching. `takeControl` accepts a parked car, so the player can get back in.

Lifecycle: **12 parked vehicles**, removed oldest first and **only beyond the
renderer's own detail distance plus 20 m** (280 m at high quality), with a
documented hard limit of 16 for the case where the player has left nothing out
of sight.

Measured in a production build: a coupe driven off-lane to (−153.71, 41.60) at
yaw −2.2088, exited, walked away from, then stepped **840 frames** — moved
**6 mm and 5 mm**, yaw delta **exactly 0**, integrity unchanged at 138.19,
`parked: 1`. A second run parked at (−157.252, −42.295) was byte-identical
after nine seconds, and `E` put the player back in.

## Vehicle damage

Damage accumulates per region — front, rear, left, right, glass and four tyres
— beside the existing scalar integrity. Engine power falls away above 55 %
front damage and reaches zero at 100 %; each flat tyre costs grip and adds a
steering pull, and **both the traffic AI and the player's own driving obey the
same rule**. A write-off is cut loose, coasts to a stop, burns for 1.2 s, smokes
for 14 s, smoulders for 10 s and stays as a blackened shell.

A rocket is told from a bullet by **blow size, not weapon id**: any single blow
costing more than a quarter of the shell blows every window, shreds the tyres on
the struck side and wraps damage round the body (a warhead is 190 points against
a rifle round's 34). Nothing special-cases the launcher.

Measured: six rifle rounds took a sedan 260 → 56 with visible dulling; four more
destroyed it, with fire and a smoke column; a patrol SUV went 260 → 0 on the
same model; a rocket left a fully sooted burnt-out taxi where it stopped. Under
a sustained rocket rampage the parked count held at its hard limit of 16,
particles never exceeded 96, and traffic draw calls stayed at 13.

### A latent hazard found on the way

Adding the damage attributes took the vehicle shell to **18 vertex attributes**,
past WebGL's 16-slot guarantee. The driver refused the program and **the entire
fleet stopped rendering** — silently, with every test still green. Three
attributes are now packed into one and the shell sits at 15 slots.
`tests/traffic.test.ts` asserts the ceiling on every batch, so the next
per-instance attribute fails a test instead of emptying the streets. This is the
`Too many attributes (aDamage)` console error two other workstreams reported.

## The gun through death, and pedestrian hits

**The gun loss was not an inventory bug.** `PlayerState.respawn()` genuinely
keeps the owned set, the equipped weapon and the ammunition counts, and on-foot
death and respawn preserve all three.

The fault is a **missed dismount when the player dies flying**.
`RespawnDirector.finish()` left exactly one seat, through `isDriving` /
`exitVehicle`, and `main.ts` wired those to the driving layer alone — the flight
layer was added later and was invisible to it. `CombatSystem.update` is then
told `driving: drive.driving || air.flying`, and it hides the viewmodel and
refuses the trigger for as long as it believes the player is in a vehicle. So a
pilot killed in the air came back to the spawn point **still nominally flying**:
the weapon owned, equipped, invisible and unusable, and `Flying.exit()` refuses
in the air so they could not even get out.

```
before: { flying: true, equipped: "pistol", ammo: 95, pos: { x: -153, z: 18 } }
after:  { flying: false, equipped: "pistol", owned: ["pistol"], ammo: 95 }
        firedAfterRespawn: true, ammoAfterShot: 94
```

`RespawnDirector` now takes a list of mounts and leaves **every** occupied seat.
`Flying.exit(true)` is the forced dismount — refusing in the air is right for a
living player pressing a key and wrong for a corpse.

**Why no test caught it:** `pullTrigger()` did not check the in-vehicle latch —
only the held-trigger polling did — so the QA harness's `fire()` returned `true`
from a cockpit while the player saw nothing at all. The instrument agreed with
the bug. That is fixed.

### The explosion

`IMPACT_STYLE.body` was the **largest** effect in the table — nine fast dark-red
embers with no drag plus a pool up to 0.6 m across — and it was spent **once per
pellet**. A single shotgun shell put **72 of the 176 glow slots and 8
overlapping pools** on one civilian in one frame and played eight body impact
sounds simultaneously.

Body impacts and their sounds are now coalesced per victim per trigger pull, and
the effect itself is three slow, small, high-drag specks with a 0.2 m mark.

Three further defects were found with it: the crowd was handed the victim's
**feet** rather than the round's contact point; a hit that wounded but did not
kill produced **no reaction at all**; and the casualty list recycled its
**oldest** record on overflow — usually a corpse — after which that body became
a live target and a live witness again, while the tracker could re-home a
corpse's record onto a passer-by and delete them from the game.

`CrowdTargets` now reads prone state from the instance matrix itself, so a body
on the ground can never be re-targeted regardless of bookkeeping. Corpse records
are pinned, claim only 0.35 m so they cannot shadow a neighbour, and are cleaned
up only after **60 s AND 48 m** — delay and distance, not either alone.

Bodies were never actually disappearing on the crowd side: `crowd.down` holds at
1 across 60 s of stepped simulation with the body visible on the pavement and
the population unchanged.

## The terminal floor

Two independent faults, both confirmed in a production build before anything was
changed.

**Coplanar overlap.** The plinth in `buildings.ts` was one box with its top face
at exactly `TERMINAL_FLOOR`, and the interior slab in `terminal.ts` had its top
face also at exactly `TERMINAL_FLOOR`, fully inside it. Moving the camera 40 cm
— z 420 to 420.4 — turned a clean floor into a stippled wedge across the whole
hall.

**Sub-quantum separation.** The bands and the walking line sat 4 mm above the
slab. With `PerspectiveCamera(62, 1, 0.1, 1200)` on a 24-bit buffer the
resolvable depth step is `z^2 * 6.0e-7` m: 3.8 mm at 80 m and **24 mm across the
building's own 200 m diagonal**. They read as broken dashed bands from (160, 420).

The fix uses no fog, no `polygonOffset`, no depth-write tricks, and deletes
nothing:

- The plinth is now an **apron** — four boxes around the wall line, inner edge at
  the inner wall face — so it emits no top face beneath the interior at all. The
  non-solid collider over the whole footprint is unchanged, so the building is
  still walkable and still reads as `interior`.
- The floor is a **mosaic**. A new `layFloor()` takes a base rectangle and an
  ordered zone list and returns rectangles that *tile* the footprint; bands, the
  walking line, shop floors, lounge pads and retail frontage strips are cut
  **into** the floor at exactly `TERMINAL_FLOOR`. Two rectangles that share no
  area cannot share a pixel — that is exact, not a tolerance, and it does not
  depend on depth precision at all. A new `WorldBatch.top()` emits two-triangle
  up-quads, so the floor costs 320 triangles rather than six times that as boxes.
- `MIN_SURFACE_SEPARATION = 0.025` is exported and enforced everywhere else.

### The sweep found twelve more, none of them the same line of code

Tower cab mullions against their glazing head; the east and west walls
overlapping the north wall and south gable at the corners; the roof "parapet"
being a second slab over the whole deck, so `roofTar` was never visible at all;
the ceiling step lying in the plane of the hall slab; **every column top in the
plane of the beam it carried**; **every ceiling light run against the down-stand
beams — 10 mm, in 34 places**; a truss web inside its own chord; the security
archway head oversailing the partition; retail unit walls overlapping at corners
and the fascia header over the side walls; hangar walls at the corners; apron
floodlight masts flush with their heads; the mezzanine fascia against the
escalator top tread.

The sweep now reports **zero** across the shell, the interior, the tower, the
hangars, the airfield lighting and the signage. It measures real polygon overlap
area rather than comparing bounding boxes, so it catches the class rather than
the instance.

## The terminal, as a place

The magenta `signEmissive` — the city's nightclub neon key — is gone from the
terminal entirely. The 18 x 3.2 m cream frontage board that filled the whole
view of the building from the forecourt is replaced by a 14 m name band set into
the canopy fascia and two 3.4 m kerbside pylons.

Added: check-in islands, a kiosk bank, an information desk, a cafe and hall
shop, a mezzanine with a glazed balustrade and an escalator, dropped soffits
with cove lighting over both retail edges, a security queue snake with roller
beds, lane lightboxes and re-composure benches, five retail units with glazed
fronts, gates with glazed vestibules and numbered lightboxes, a baggage hall
with carousels, arrivals screens, a clerestory and a customs channel, clad
columns, planters, and a three-layer lighting scheme. Outside: PAPI at both
thresholds and painted stand numbers. The two new Tripo bags are placed at bench
ends, against the check-in islands and on the reclaim belts.

| | before | after |
| --- | --- | --- |
| interior triangles | 8,656 | **17,326** (budget 24,000, enforced by test) |
| light requests | 11 | 13 (budget 16, enforced) |
| colliders | 68 | 110 |
| terminal-chunk draw calls | 21 | **28** |

Clearance tests forced real plan changes rather than being relaxed to fit:
security lanes moved from 166/183/200 to **170/183/196** because the columns at
x 165 and 199 stood inside the outer lanes; the column phase moved because one
column was 0.5 m from a published check-in queue line; tray tables moved out of
the lane exits; the carousels were shortened. The seat slab is now drawn
*downward* from `SEAT_PAD_HEIGHT` so the drawn surface matches the published
contract exactly.

## The apron stands

The clearance defect the aircraft workstream found was fixed at its source.
Nothing on the apron uses a fixed offset any more: `plan.ts` publishes
`STAND_ENVELOPE` — half length, span and fuselage width per aircraft class,
derived from `AircraftCatalogue` — plus `standTaxiCorridor()` and
`standFuselage()`, and the airstairs, ground power unit and baggage train are
placed off that envelope: port side at the door and abeam the nose, baggage aft
and starboard.

`tests/apronClearance.test.ts` asserts the envelope table still covers the
parked fleet, the taxi corridor is empty, nothing sits inside a fuselage, every
worked stand still has its equipment, and **every aircraft can roll at least
20 m off its stand**.

The same pass also removed a 43 m jet blast screen drafted earlier in this
workstream — a solid barrier on a movement area, which is exactly the defect
that had just been reported.

## The airport crowd

The city crowd had no idea the airport existed — grepping `src/agents` for
`airport` returned nothing.

`CityPlan` authors `airport-approach`, `airport-way`, the two forecourt roads,
the car-park roads and `hangar-road` as ordinary `Street` records, deliberately,
so traffic, signals and the minimap need no special case. `buildPavementGraph`
therefore produced pavement along all of them and the crowd sampled it at
downtown weight.

The population is a **constant** (270) recycled inside a **constant radius**, so
what actually varies from place to place is *linear density*. Measured, one-way
pavement metres inside the crowd's own 142 m seed radius:

| vantage | pavement | people | per metre |
| --- | ---: | ---: | ---: |
| Old Quarter | 3324 m | 270 | 0.081 |
| city spawn | 2037 m | 270 | 0.133 |
| airport forecourt / approach | 1241 m | 270 | **0.218** |
| car park | 597 m | 270 | **0.452** |

One person every 2.2 m on a 2.08 m footway is a continuous file of bodies. That
is the wall in the screenshot, and it is a consequence of holding the head count
fixed while the pavement supply collapses.

`src/agents/travellers/zones.ts` reads `world/airport/layout.ts` and nothing
else — no literal coordinates, no Three.js — and gives each zone a share and a
hard cap:

| zone | share | cap |
| --- | ---: | ---: |
| airside (runway, overruns, taxiway, apron, hangars, tower) | 0 | 0 |
| terminal interior | 0 | 0 |
| forecourt | 0.60 | 30 |
| car park | 0.30 | 14 |
| approach | 0.12 | 14 |
| airport grounds | 0.10 | 10 |
| city | 1 | unbounded |

A forbidden zone closes links through the same flag street furniture already
uses, so link selection, destination choice and respawn all refuse them for
free. The head count became supply-driven, with the constant chosen so the
thinnest *city* vantage still asks for more than 270 — **downtown is
untouched**, which is the point.

Measured at the forecourt after the change: 270 active becomes **50**, and the
live zone census reads `airside 0, terminal 0, forecourt 30, carPark 0,
approach 14, airportGrounds 5, city 1`. Walking the approach road, 178 becomes
50 southbound and 46 becomes 173 coming back, with no spawn pops.

The roster is now split — a city roster and a terminal roster — so eight airport
characters do not add sixteen draw calls to a downtown street.

## What was verified in the browser

Production build, `vite preview`, driven through `window.__meridian`.

- **The terminal floor is stable.** Screenshotted from four vantages and several
  yaws, including the 0.4 m camera move that used to flip a clean floor into a
  stippled wedge. No banding, no shimmer, no stripes.
- **The terminal reads as an airport** and is credibly populated: 78 travellers,
  7 characters, 43 pieces of luggage, 14 draw calls, 347 k triangles.
- **Roads, crossings and the car park are clear.** The forecourt census above.
- **Seven visibly different travellers with luggage**, all rendering, with five
  luggage models including the two new bags.
- **The aircraft answers the controls.** Boarding at a sprint with Shift held —
  the exact reported failure — now ramps the throttle immediately: 0.35 at
  0.5 s, 1.00 by 2 s, and the aeroplane rolls 240.0 to 251.4 m over four
  seconds. The previous build sat at 0.000 m/s indefinitely.
- **Footsteps follow the floor.** The runway plays `steps/concrete-2` and the
  concourse `steps/terminal-1`; harbour carriageway asphalt, city pavement.
  Before, the runway was a paving slab and the terminal a domestic tile.
- **An abandoned car stays put.** A van driven off-lane and parked at yaw 0.887
  moved **0.0000 m with a yaw delta of exactly 0** over 660 simulated frames
  with the player 45 m away, integrity preserved, state `parked`.
- **The gun survives death.** On foot: owned, equipped, 48 rounds, and a round
  actually left the barrel afterwards. **Killed in the air at 160 m**: the
  player comes back on foot (`flying: false`), pistol equipped, viewmodel
  present, and the trigger works — 47 to 46 rounds. Firing from the cockpit is
  correctly refused.
- **Cars take progressive, localised damage.** A patrol SUV at 0.33 damage read
  front 0.55, glass 1.00, left 0.19, rear 0.19, right 0.20, tyres
  [0, 0.52, 0, 0.52], with grip 0.77, power 0.99 and a −0.057 rad pull. A patrol
  sedan at 0.94 had power **0** and two flat tyres. Destroyed cars sit as
  blackened shells with `destroyed: true` and stay in the world.
- **A rocket is not a bullet.** One warhead at 11.3 m took a sedan from
  **260 to 70** integrity in a single hit, blew every window, shredded both
  tyres on the struck side, wrapped damage round the body, and **displaced the
  car 0.84 m**. A rifle round is 34 points against the warhead's 190.
- **Destruction stays bounded.** After a rampage: 12 wrecks, 16 parked at the
  documented hard limit, 44 particles, and traffic still drawing in **13 draw
  calls**.
- **No console errors, and every request returned 200** — all eleven pedestrian
  VATs, the new airport props and the new vehicle audio.

### What could NOT be verified in the browser, and why

- **A lethal civilian takedown persisting on the pavement.** Civilians are
  provably hittable — `civiliansHurt` goes 0 to 1 with a computed bearing — and
  a wounded record is still tracked 30 s later, and the population never drops.
  But the QA harness has no aiming primitive that tracks a moving target, and
  once a shot is fired the crowd is alarmed and runs, which is itself the
  requested behaviour. Follow-up rounds miss. The lethal path is covered by
  deterministic tests instead.
- **A flat tyre's visual and steering pull** were proven by unit test rather
  than screenshot, for the same aiming reason.
- **Grass footsteps.** Four families were confirmed live; the player-footstep
  voice pool drains on wall-clock time while `step()` compresses many simulated
  frames into a few milliseconds, so only the first few footfalls of any
  synchronous burst get a voice. Grass is covered by the deterministic sweep.

## Performance

Both builds measured the same way on the same quiet machine: production build,
`renderBenchmark(90)` forcing a GPU sync per frame, same five vantages, same
session.

**My first baseline in this document is not usable** — it was captured as seven
agents were starting and read 29–33 ms where the same build on a quiet machine
reads 2.8–4.6 ms. It is left above as a record of the mistake. The comparison
below is a clean rebuild of `HEAD` in a throwaway worktree, benchmarked minutes
apart from the new build.

| vantage | before | after | draws | triangles | memory |
| --- | --- | --- | --- | --- | --- |
| city spawn | 4.64 ms | 4.89 ms | 310 → 310 | 7.00 M → 7.00 M | 111.6 → 141.9 MB |
| terminal north | 3.37 ms | 4.15 ms | 303 → 328 | 6.81 M → **5.79 M** | 126.8 → 159.0 MB |
| terminal south | 4.08 ms | 4.22 ms | 327 → 347 | 7.03 M → **5.89 M** | 111.7 → 143.1 MB |
| forecourt | 3.68 ms | 4.38 ms | 279 → 299 | 6.63 M → **5.55 M** | 125.1 → 155.7 MB |
| apron | 2.76 ms | 2.74 ms | 269 → 297 | 6.69 M → **5.49 M** | 124.8 → 161.1 MB |

Frame cost is up 0.25–0.78 ms, worst case 23 %, for a terminal that went from
8,656 to 17,326 triangles of fit-out, seven more characters, regional vehicle
damage and a per-class engine mix. **Triangle counts fell at every airport
vantage** — thinning the crowd more than pays for the building.

**Memory is up 30–36 MB everywhere**, which is the honest cost: seven new
characters are 13.4 MB of VAT data and the terminal added 21 textures. The
traveller characters are loaded eagerly on boot even for a player who never
visits the airport; deferring them until the player is within about 220 m would
recover most of it and is the obvious next optimisation.

## Cross-agent review

Two independent reviewers ran against the committed diff: Codex CLI (gpt-5.6-sol,
high reasoning) and the Greptile CLI, the latter against a local
`pre-repair-baseline` branch because the work was committed straight onto `main`
and Greptile needs a branch delta.

**Both found the same P1 independently**, which is the strongest signal either of
them produced:

> `iExtra.z` became the crowd's stipple dissolve when spawn and retire fading was
> added, and the procedural shader discards a fragment whenever the noise
> exceeds it. `OfficerRig` still wrote the zero that slot used to hold, so
> **every fragment was discarded** — police officers that walk, shoot and arrest,
> and cannot be seen at all.

This only shows while the baked officer VAT is loading or if it fails to fetch,
which is exactly why nothing caught it: a healthy browser resolves the VAT and
never renders the fallback. `officerModel` reads `baked` in every live check.
Officers are now written fully opaque and `tests/police.test.ts` asserts every
drawn instance sits at or above the shader's own 0.996 threshold. The test was
confirmed load-bearing by reverting the fix and watching it fail.

Codex found two more, both real and both fixed:

- **The stagger was never wired.** `PedestrianSystem.staggerAt` and the
  `CrowdTargets` hook both existed, but `main.ts` connected only `removeAt` and
  `alarmAt`, so a wounding round recorded damage and produced no visible
  reaction. The combat workstream had deliberately withheld it until the crowd
  offered a reaction that keeps the victim upright instead of flooring them;
  the crowd workstream then built exactly that, and nobody joined the two ends.
  A good illustration of the risk in parallel workstreams: both halves correct,
  the seam missing.
- **Per-frame allocation while flying.** `Flying.hintState` built a fresh object
  every frame and `Hud.setFlightHints` mapped the unchanged hint list into new
  strings and joined them, purely to rediscover that nothing had changed. The
  state object is reused now and the hint list compared by identity.

Codex reported the remaining `parked` control comparisons, the crowd mesh
harvest, the footstep material-family contract and the disposal and bounded-pool
paths as clean. Greptile's second pass returned **5/5 confidence, no review
comments**.

## TesterArmy

Project *Youtube videos GTA - TOOLS* (`c152f076-e9b6-4708-a104-cdcd1c06b5cc`),
test *GTA Vibe - airport repair pass*
(`8a5bf3d6-0945-4a35-997d-797f1a0e48be`), run locally and headed against the
production preview. One run, as instructed, and it is reported as it came back.

**Result: `FAILED` — `5/23 steps passed, 0 failed`, zero issues raised.**

Every step it reached passed:

1. Boot, resume, HUD present.
2. Daylight; "Harbourside / Harbour Walk" top left, "$25,000" top right,
   "Music: Off".
3. Walked onto the road; "Press E to drive the compact" appeared.
4. Prompts confirmed for a second and third vehicle.
5. Pressed E, entered the compact, drove into traffic.

It then opened step 6 and stopped. **The run exhausted its agent budget; it did
not find a defect.** That is an infrastructure boundary rather than a product
failure, and the distinction matters because the run is not repeatable here —
the instruction was one run, and this was it.

The cause is a mistake in how the test was written rather than anything in the
game: the skill asks for three to ten meaningful steps and it had twenty-three.
A browser agent driving 600 m through traffic, walking into a terminal and
crossing to an apron spends a very large number of tool calls inside what reads
on paper as one step.

The saved test has been rewritten to 13 steps and reordered so the checks that
need no travel come first — the abandoned-car check now happens near the spawn
point, ahead of the drive south, so a budget-limited run still returns signal on
a headline repair. **It has not been re-run**, per the instruction.

So of the eight behaviours this run was meant to cover, it independently
confirmed boot, HUD and vehicle entry. The other seven rest on the deterministic
suite and on the browser verification recorded above, which covered all of them
except a lethal civilian takedown and grass footsteps.

## The second Vercel failure, and why it never showed up locally

Fixing the lockfile got the build past `pnpm install` and straight into a second,
unrelated failure:

```
tools/glbMesh.ts(14,30): error TS2307: Cannot find module 'node:fs'
tools/glbMesh.ts(82,27): error TS2591: Cannot find name 'Buffer'
tests/travellers.test.ts(16,30): error TS2307: Cannot find module 'node:fs'
... 12 errors
Error: Command "npm run build" exited with 2
```

`npm run build` passed on this machine and `vercel build` passed on this machine.
Reproducing Vercel's own sequence — `git archive HEAD` into an empty directory,
`npm ci`, `npm run build` — failed identically, which turned a puzzle into a
bug.

**`@types/node` was never a dependency of this repository.** `tools/` and six
test files import `node:fs`, `node:path` and `node:url` and use `Buffer`, and
nothing declared the types for them. TypeScript resolves `@types` by walking
*up* the directory tree, and it was finding

```
/Users/kevin/node_modules/@types/node   (25.0.8)
```

— a package in the home directory, three levels above the checkout and no part
of the project. Every local build has quietly depended on it. Any clean
machine — Vercel, CI, a fresh clone, another developer — fails.

The fix is two lines and both are needed: `@types/node` pinned in
`devDependencies`, and `"node"` added to the `types` array in `tsconfig.json`,
because an explicit `types` array suppresses the automatic global inclusion that
would otherwise supply `Buffer`.

Verified the way it should have been all along: `git archive HEAD` into an empty
directory, `npm ci`, `npm run build` — clean.

This one predates the repair pass entirely. It was only ever going to surface by
actually deploying, which is the argument for doing so rather than trusting a
local build.

### The deploy

```
Build Completed in /vercel/output [19s]
Deployment completed
status  ● Ready
```

`https://gta-vibe-ibibvqgy1-perso-6eecfc5e.vercel.app`, production, 34 s.

The remote build ran `tsc --noEmit && vite build` and emitted
`index-5I_3t3zS.js`, `three-BiQ7IOEf.js` and `index-yIq21Bm0.css` — the same
hashes as the local build, so the two trees are identical.

**The URL answers 302 to `vercel.com/sso-api`.** That is Vercel Deployment
Protection, a project setting, not a build failure: the site is up and gated to
the team. Turning it off is an account-level change and was not made.

`npm audit` reports 5 vulnerabilities (3 moderate, 1 high, 1 critical) in the
dependency tree during install. They are pre-existing, unrelated to this pass,
and were not touched.
