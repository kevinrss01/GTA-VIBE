# The police response

Two things changed: officers are now a real generated character instead of a
procedural one, and the pursuit builds instead of arriving.

Everything here is reproducible from the recorded task ids. No key is recorded,
in this file or anywhere else.

## The officer character

### Why it is not the procedural rig any more

Officers used to borrow `PedestrianProcRig` — the crowd's boxes-and-cylinders
character — with a navy palette written into its clothing slots. That was the
right call at the time and is worth recording, because the reasoning was sound:
the baked Tripo civilians carry their outfit in the ALBEDO with no per-garment
mask, so tinting one navy produces a civilian with a dark face, not an officer
in uniform. With no uniformed asset in the project, procedural was the better
of the two available options.

It stopped being the right call the moment a uniformed asset could exist. No
arrangement of six boxes reads as a police officer, and the whole point of an
officer is that the player recognises one instantly.

### Pipeline

The same one the crowd uses, in `docs/pedestrian-characters.md`:

```
tripo make "<prompt>" --model tripo-v3.1 -p face_limit=3000 -p texture_quality=standard
tripo anim check    <generation task>                      # riggable? rig_type?
tripo anim rig      <generation task> --rig-type biped --spec tripo \
                    --out-format glb -p model_version=v1.0-20240301
python3 .agents/skills/threejs-3d-generator/scripts/threejs_3d_asset.py \
        validate-rig <rig>/model.glb --rig-type biped      # before spending on clips
tripo anim retarget <rig task> --out-format fbx --animation preset:biped:walk
tripo anim retarget <rig task> --out-format fbx --animation preset:biped:idle
node tools/bake-pedestrian-vat.mjs --id ped-police --min-period idle=1.6 \
     --rig  tripo-out/mb-ped-police-rig/.../model.glb \
     --clip walk=tripo-out/mb-ped-police-walk/.../model.fbx:48 \
     --clip idle=tripo-out/mb-ped-police-idle/.../model.fbx:20
```

The flag reasoning is unchanged and is documented in
`docs/pedestrian-characters.md`: `--rig-type biped` routes to the anatomical
`v1.0-20240301` rigger, v1.0 retargets must be FBX, one animation per retarget
task, and `--animate-in-place` is never passed because it corrupts the bake.

### What was generated

The prompt asked for a dark navy uniform, peaked cap, silver chest badge,
shoulder epaulettes, duty belt and black boots, in a strict T-pose with arms
horizontal, legs separated, complete head to feet, nothing in the hands. The
rendered preview was inspected against that before any rig credits were spent:
it came back a genuine T-pose, symmetric, arms clear of the body.

| step | task id | credits |
| --- | --- | --- |
| `text_to_model` | `be19dc1e-efd7-4b69-9d50-e9e3f34cf19e` | 20 |
| `animate_prerigcheck` | `1cc0303b-62aa-4e12-8639-852cdf89e25d` | 0 |
| `animate_rig` | `fe2b199a-7fcb-42e7-ad1a-aa77ce2b5e76` | 25 |
| `animate_retarget` (walk) | `c62ca2f7-3634-4238-9efc-3a48a82c95a3` | 10 |
| `animate_retarget` (idle) | `19af4b52-c950-43bf-8cc9-c356346c9321` | 10 |

**Total: 65 credits.** No retries were needed at any step.

- `animate_prerigcheck` returned `riggable: true, rig_type: biped`.
- `validate-rig` passed FIRST TRY: "legacy anatomical skeleton, 16 paired L/R
  bones … Rig looks structurally valid." No 1-bone leg, no 2-bone arm, so no
  re-roll was bought.

### Runtime files and measured properties

`public/models/pedestrians/ped-police.{json,bin,jpg}`, written by
`tools/bake-pedestrian-vat.mjs` (unchanged — the officer is just another `--id`)
and loaded by `src/agents/PedestrianVat.ts`'s `loadPedestrianVat`.

| id | source verts | welded verts | triangles | VAT texture | .bin | .jpg |
| --- | --- | --- | --- | --- | --- | --- |
| `ped-police` | 8892 | 2290 | 2964 | 70 x 2290 | 1.91 MB | 42 KB |

Which puts it squarely among the four civilians (2844–2990 triangles).

| clip | loop | travel per loop | frames |
| --- | --- | --- | --- |
| walk | 1.867 s | 1.611 units | 48 |
| idle | 1.630 s | ~0 | 20 |

Foot slide, per-vertex over a footfall, on a 1.75 m person:

| id | median | p90 | worst |
| --- | --- | --- | --- |
| `ped-police` | 10 mm | 117 mm | 283 mm |

Better than `ped-a` (27/108/343) and `ped-c` (45/146/304), comparable to
`ped-d`. For scale, the procedural rig it replaces was measured in the browser
at a median of 283 mm.

### How it is rendered

`src/police/OfficerRig.ts`. It calls the crowd's own
`createPedestrianVatMesh(capacity, slot)` and `loadPedestrianVat('ped-police')`
— nothing in `src/agents/**` was changed. Because
`customProgramCacheKey` is a constant across every pedestrian VAT material, the
officer mesh SHARES the crowd's compiled program: no new shader, no new
material class, no second walk cycle to keep in step.

- ONE `InstancedMesh` for every officer in the city: one colour draw call and
  one shadow draw call, hidden entirely while nobody is wanted.
- No per-instance tint (`iTint` is 1,1,1,1). The uniform IS the albedo, and
  multiplying it is exactly the mistake that kept officers procedural.
- The walk cycle is driven by DISTANCE COVERED, inverted through the bake's
  travel curve, never by a clock — the same no-slide property the crowd has.
  The accumulator is in rig units, which means metres divided by GIRTH, because
  the instance matrix scales an officer horizontally by girth.
- Dismounting a car is a teleport, so `deploy` reseeds the accumulator's
  reference point and `advance` rejects any step over 1.5 m.

**It degrades.** The download is asynchronous and may fail; the procedural rig
is still constructed, still in the group, and is drawn until — or instead of —
the baked one. `PoliceStats.officerModel` reports which is live (`baked` or
`procedural`), and it read `baked` in the browser.

## Pacing

### What was wrong

Measured on the previous policy with a deterministic harness (the real
`PoliceSystem`, the real `RoadNetwork`, a stub fleet, perfect sight, no
occluders), seconds from the offence:

| stars | first dispatch | first unit within 30 m | first shot at the player |
| --- | --- | --- | --- |
| 1 | **0.0** | 13.5 | never (arrested at 18.0) |
| 2 | **0.0** | 13.5 | never (arrested at 18.0) |
| 3 | **0.0** | 13.5 | 16.5 |
| 4 | **0.0** | 13.5 | 16.5 |
| 5 | **0.0** | 13.5 | 16.5 |

One star and five stars were paced IDENTICALLY. A car was dispatched on the
same frame as the offence at every level, was within thirty metres at 13.5 s at
every level, and was shooting at 16.5 s at every level. The only thing a star
bought was more cars doing the same thing at the same time.

### What it is now

| stars | first dispatch | first unit within 30 m | first shot at the player |
| --- | --- | --- | --- |
| 1 | 9.0 | 39.7 | never — arrested at 43.9 |
| 2 | 6.0 | 20.1 | never — arrested at 24.3 |
| 3 | 3.5 | 13.1 | 16.7 |
| 4 | 1.6 | 12.2 | 15.4 |
| 5 | 0.6 | 11.9 | 14.8 |

Every column is now monotone in the wanted level, and the five-star row is
within a second of where the old policy put EVERY row. The ceiling did not
move; the floor did.

"First shot" above is with no attack on the police, so one and two stars end in
an arrest rather than gunfire. With the player shooting at officers — which
makes any officer hostile at any level — the first shot lands at 44.4 s (1
star), 24.5 s (2), 16.7 s (3), 15.4 s (4) and 14.8 s (5).

### The three changes

All three are in `src/police/policy.ts` as pure functions of the wanted level,
so the escalation is asserted in a unit test rather than inferred from watching
a chase.

| stars | `dispatchDelay` (s) | `dispatchDistance` (m) | `dispatchInterval` (s) | `officerAimTime` (s) |
| --- | --- | --- | --- | --- |
| 1 | 9.0 | 190 | 12 | 2.6 |
| 2 | 6.0 | 165 | 9 | 2.2 |
| 3 | 3.5 | 140 | 6 | 1.5 |
| 4 | 1.6 | 125 | 4 | 1.1 |
| 5 | 0.6 | 115 | 2.6 | 0.8 |

- **`dispatchDelay`** is new: nothing at all is sent until the call has had time
  to go out. It is measured from when the alarm was raised and reads the
  CURRENT level, so heat that climbs during the wait SHORTENS it rather than
  restarting it — a suspect cannot buy time by making things worse.
- **`dispatchDistance`** was the constant 115 m at every level. Distance is
  time: a one-star unit now starts two hundred metres of city driving away.
  The five-star value is the old constant.
- **`dispatchInterval`** roughly doubled at the bottom and is untouched at the
  top, so a second car is a separate event rather than part of the same
  arrival. Consecutive dispatches also get a deterministic ±15 per cent spread
  on the distance, so a four-car response comes from four streets.
- **`officerAimTime`** replaces the flat 0.8 s. At one and two stars an officer
  only ever gets here because the player shot at the police, and even then they
  challenge first. The timer is per officer and resets when they lose sight, so
  breaking the line of sight really does restart the count.

### Two bugs found on the way

**Banked dispatches.** The dispatch countdown kept running below zero while the
street already had its quota, so a player who sat at two stars for a minute had
banked a minute of credit: the instant a third star landed or a unit was
wrecked, replacements went out on consecutive frames. That is most of what
"three units dispatched within 2–4 seconds" was. The timer is now clamped at
zero, so the interval means the same thing whenever it is reached.

**Unroutable dispatch lanes.** `dispatchLane` picked purely on distance and its
pick is deterministic, so a wanted distance that happened to land on a lane with
no legal route back produced a unit that could never arrive, was written off
after the lost-patience timeout, and was replaced by an identical unit on the
identical lane. Measured at 21 dispatches in 150 seconds at three stars with not
one reaching the player. `dispatchLane` now takes the pursuit field's own
reachability test and only places a unit somewhere a car can actually drive out
of, falling back to the best unreachable lane if nothing reachable exists at
all. The sweep in `tests/police.test.ts` asserts both halves: every distance the
policy can ask for lands on a routable lane, AND the unfiltered search really
does pick unroutable ones.

This bug predates the pacing work — the old constant 115 m simply happened to
land on a good lane.

### Shoot-on-sight, verified

The existing rule (`shootsOnSight`: three stars and up, or any level once shot
at) was audited and is honoured. At one and two stars, with no attack on the
police, an officer never fires: the harness runs two minutes with the crew
standing over the player and records zero shots and 100 health, and in the
browser the chase ended in an arrest with full health. `tests/police.test.ts`
pins this.

## Measured cost

Production build, `npm run preview`, one camera on Vestry Street, 2880 x 2000
(5.76 MP), `renderBenchmark(120)`, best of four:

| | draw calls | triangles | median ms |
| --- | --- | --- | --- |
| no response | 321 | 6 545 630 | 7.9 |
| 5 units, 6 officers on foot | 324 | 6 581 538 | 7.8 |

**+3 draw calls**, unchanged from the procedural officers: two for the officer
mesh (colour and shadow) and one for the beacons. The extra hidden procedural
mesh costs none, because it is drawn with `count = 0` and `visible = false`.

**+35 908 triangles** for six officers, which matches the derivation: 6 x 2 964
x 2 passes = 35 568, plus 120 for ten beacon lenses. At the ten-officer ceiling
it is about **+59 400**, against roughly +11 300 for the procedural rig — so the
realism costs about 48 000 triangles on a 6.5 M-triangle frame, or 0.7 per cent.

**No measurable frame cost.** The loaded best-of-four median (7.8 ms) is inside
the idle best-of-four spread (7.6–8.1 ms across samples), so the added cost is
below this setup's noise floor. That is consistent with the documented profile:
the frame is pixel-bound, and half a per cent more triangles does not move it.

**A pursuit adds no vehicles.** The five pursuit cars are commandeered ambient
traffic, so they were already in the frame — the idle sample actually measured
327 draw calls to the pursuit's 324, because five cars had left ambient traffic.

**NO POINT LIGHTS were added.** Beacons remain unlit emissive boxes in one
instanced mesh.

## Limitations

- **No `run` clip.** `PedestrianVat` reads exactly two clips, `walk` and `idle`,
  and `src/agents/**` was out of scope for this change. An officer running at
  5.4 m/s therefore plays the walk cycle at a running rate — legs cycling fast,
  which is correct in phase and stride length but is a fast walk rather than a
  run. Idle was bought instead of run because officers STAND at their firing
  standoff, and a character holding a rest pose there would look broken. Adding
  a run clip is one 10-credit retarget plus a third clip slot in
  `PedestrianVat`/`PedestrianRig`.
- **One officer face.** Every officer is the same character, varied only by
  height (1.68–1.88 m) and girth. The crowd has four; the police have one.
- **No per-officer tint.** Deliberate — see above — but it means there is no
  cheap way to vary them without a second generated character.
- **The uniform is invented**, matching the patrol cars' original livery rather
  than any real force.
- **1.9 MB more download.** It streams in the background behind the loading
  screen like the four civilians, and the procedural officer covers the gap, so
  nothing waits on it.
- **The first star can now lapse before anyone is sent.** One pistol round is 12
  heat, the one-star threshold is 10, and heat starts decaying after 8 s of
  quiet — so a single shot fired in an empty street can decay to zero at about
  the same time the 9 s dispatch delay expires, and nobody comes. This is the
  requested behaviour taken to its edge rather than a defect, and any second
  offence removes it, but it is worth knowing that one round now genuinely
  costs nothing if the player walks away.
- **The timings above come from the deterministic harness**, which gives every
  watcher perfect line of sight and an empty collision world. Real streets have
  buildings and traffic, so in play the arrival times are the same or later,
  never earlier. The browser run agreed: one shot, one star, `dispatchIn` 8.8 s
  and nothing on the road.

## Officers who visibly shoot, 2026-08-27

The complaint was exact: "their arms are at their sides and I see them
shooting, but I don't see their weapons, I don't see their arms moving."

Both halves were true. The officer character was baked from two clips, walk and
idle, and neither has anything to do with firing a weapon; and a vertex
animation texture is a fixed mesh, so there was nowhere for a weapon to be.

### A third clip

`preset:biped:shoot`, retargeted from the same rig task that produced the walk
and the idle (`fe2b199a-7fcb-42e7-ad1a-aa77ce2b5e76`), FBX out, 10 credits.
Task `7b802028-d5b5-4766-8fb2-227e3d6f2da2`.

It is the ONLY shooting preset in Tripo's biped library — `preset:biped:aim`,
`:shoot_gun`, `:gunplay`, `:pistol` and `:attack` are all rejected by the API —
and it is a 7.2 s action rather than a loop: the character walks in, drops into
a crouch at about 1.4 s, and holds it for the remaining five and a half seconds.

That shape broke two assumptions in `tools/bake-pedestrian-vat.mjs`, and both
needed a real fix rather than a fudge:

- **Travel.** The bake fits a linear ramp to the body centroid over the cycle
  and subtracts it, which is exactly right for a walk and catastrophic for a
  clip that crouches once and holds: the fit read the crouch as 1.35 body
  heights of forward travel and would have slid the officer several metres
  backwards through their own animation. `--static name=start:end` samples a
  window of the source, keeps travel at zero and skips the travel-curve
  analysis entirely. The window shipped is 3.3–4.5 s, twelve frames.
- **Ground contact.** The normalisation is anchored to the idle clip's soles,
  which is right for locomotion because every locomotion clip shares that
  stance. The crouch does not: its lowest point is a shin, and it sat 159 mm
  THROUGH the pavement. Each static clip is now lifted by its own worst
  penetration.
- **Position.** A window cut out of the middle of an action clip is wherever
  the character had walked to by then — 2.75 body heights down −Z, in this
  case. Static clips are recentred on the reference clip's mean centroid.

The clip is a third layer in the same shader, blended over whatever the gait
produced, driven by a per-instance blend in `iAnim.w`. That blend is zero for
every civilian in the city, so the branch costs the crowd one comparison and
only ever fetches for an officer who is firing.

### A weapon in the hand

A VAT has no skeleton at runtime — that is what makes it one draw call — so the
right hand's path is measured at BAKE time and shipped in the clip table, in
rig units, alongside the texture. `OfficerRig` puts a sidearm there through
exactly the transform the instance matrix applies to the body, so the weapon
stays in the grip whatever height and build an officer is.

The sidearm is `models/shop/pistol.glb`, drawn as one `InstancedMesh` for every
officer in the city and hidden entirely while nobody is aiming.

**An honest limitation.** The baked hand sits at the STERNUM — that preset is a
crouched stance with the weapon hand drawn in to the chest, which is where a
long weapon's grip hand goes. A pistol drawn at the hand is therefore inside
the officer. It is pushed 0.22 body heights forward along the officer's own
heading to clear the torso, so it reads as a weapon held in front of the chest
in a compressed ready rather than as one in a fist. Fixing that properly needs
a shooting clip with an extended arm, and Tripo's library does not have one.

## Grounded pursuit, 2026-08-28

The report was that police *slide* toward the player and move at implausible
speed. Both were true, and both were measurable before anything was changed.

### Measured, before

Instrumenting the shipped `PoliceSystem` and sampling officer motion at 60 Hz:

| | Before | After | Bound |
| --- | --- | --- | --- |
| Peak speed | 6.40 m/s | **5.40 m/s** | `OFFICER_RUN_SPEED` |
| Peak acceleration | **384 m/s²** | **6.4 m/s²** | `OFFICER_BRAKE` |
| Peak turn rate | 7.1 rad/s | **4.5 rad/s** | `OFFICER_TURN_RATE` |

384 m/s² is 39 g. `updateOfficers` set `speed = wantsToMove ? OFFICER_RUN_SPEED
: 0` — a step function — so an officer went from a standstill to full run in a
single frame and back again, and `heading = Math.atan2(-dx, -dz)` was assigned
rather than rate-limited, so they pivoted instantly and homed straight in.

### The slide was not where it looked

`OfficerRig.advance` was already displacement-driven, which is the right design
and is why this was not obvious. It advanced the stride by the projection of the
frame's displacement **onto the officer's heading** — and the obstacle `detour`
moved the officer at `DETOUR_ANGLE` 1.15 rad (66°) to that heading. `cos(1.15) =
0.407`, so **59 % of the motion during every detour was unanimated**, and
`if (forward <= 0) return` froze the clip outright for any backward component
while the body kept moving. Feet slid exactly when an officer came round an
obstacle, which is exactly when a player is watching them.

The fix is structural rather than a correction factor: an officer now only ever
moves **along their own heading**, at a rate bounded by acceleration, and the
heading itself turns at a bounded rate. Nothing writes a position. The stride
therefore cannot disagree with the ground covered, and the test asserts it as
`|Δwalked × girth| ≤ displacement` over 20,000+ frame pairs.

### Rounds now leave the weapon

`fireAtPlayer` fired from `officer.y + OFFICER_EYE * 0.86` = 1.38 m at the body
centre. The drawn pistol was at ≈0.84 m and 0.3 m further forward — **0.54 m
from where the muzzle actually was**. `OfficerRig.muzzleOf` is now the single
authority, and the damage roll, the muzzle flash, the tracer, the audio event
and a second line-of-sight test all read it. An officer whose eyes clear a low
wall but whose weapon does not now holds fire.

### Behaviour states

An 11-state table in `src/police/locomotion.ts` — pure, no Three.js, directly
testable: `idle`, `notice`, `draw`, `pursue`, `close`, `hold`, `aim`, `fire`,
`reload`, `reposition`, `hit`. Running is used only beyond `OFFICER_RUN_RANGE`
(12 m, with a 2.5 m hysteresis band so the gait does not flicker), so an officer
walks the last few metres in, turns, stops and aims rather than charging.

`OFFICER_SPREAD` gives each officer a 1.8 m lateral slot, so a crew takes an
angle on the player instead of converging on one square metre.

### Deliberate: police on foot are slower than a sprinting player

`OFFICER_RUN_SPEED` 5.4 m/s sits below the player's 6.0 m/s sprint. A suspect
who commits to running on foot now outruns a foot pursuit and has to be cut off
by a car, which is the behaviour a human-scale speed implies. It is a design
consequence of the realism requirement, not an oversight.

### A bug found on the way

`draw` was reachable only from `notice`, so an officer who set out to arrest a
one- or two-star suspect and was then shot at could never draw and never fire
back. It is now reachable from `pursue`, `close` and `hold` as well.

### Coverage

`tests/policeOfficers.test.ts`, 39 tests, including the per-frame no-teleport
bound, the no-slide stride assertion, clip hysteresis, the full draw → aim →
fire → reload ordering, "fires from the weapon muzzle, not from the middle of
the officer", "holds fire when a wall is between the weapon and the suspect",
"never ends a frame inside a solid box", and "stands on a kerb rather than
sinking through it". Officers are now grounded through `collision.supportAt`
rather than bare `heightAt`, which is why the kerb test is possible at all.

**Still limited:** vertical grounding is a snap rather than a fall, so walking
off a raised platform drops instantly. Only the horizontal no-teleport property
is proven.
