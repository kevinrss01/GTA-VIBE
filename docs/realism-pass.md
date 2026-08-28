# The realism pass, 2026-08-28

Four reported defects, fixed at their own roots rather than compensated for
downstream. Each section states what was actually wrong, with the measurement
that showed it, because in three of the four cases the obvious explanation was
not the real one.

Per-area detail lives with the code and in the older documents:
[`audio-manifest.md`](./audio-manifest.md) for the footstep set,
[`police-response.md`](./police-response.md) for the pursuit.

## 1. The road that sounded like grass

**The trap: the classification was already right.** Two previous passes had
fixed the surface rule and the loudness, and `tests/footsteps.test.ts` proves
the rule over the world that ships — all 5,000+ carriageway sample points
resolve to the `asphalt` family, and no outdoor point plays a domestic tile.
The set was levelled to a 3 dB spread. The road still sounded like grass.

Neither of those says anything about **timbre**, so a third measurement was
needed. Band-passing each shipped 0.32 s file gives two derived numbers:

```
body   = mean(180-800 Hz) - mean(8 kHz+)      the contact standing over the air
crunch = mean(0.8-3 kHz)  - mean(180-800 Hz)  whether it peaks in the grit band
```

| Asset | body | crunch | class |
| --- | --- | --- | --- |
| `steps/asphalt-1` **before** | **+4.2 dB** | **+3.9 dB** | **rustle** |
| `steps/asphalt-2` **before** | +11.6 dB | +2.4 dB | borderline |
| `steps/grass-1` | -12.4 dB | +5.7 dB | rustle |
| `steps/gravel-1` | +4.7 dB | +0.8 dB | loose |
| `steps/pavement-1` | +25.5 dB | -14.5 dB | hard |
| `steps/asphalt-1` **after** | **+29.9 dB** | **-9.5 dB** | **hard** |
| `steps/asphalt-2` **after** | **+28.9 dB** | **+1.2 dB** | **hard** |

Spectrograms agree independently: the old pair is a broadband wash for the full
0.32 s, exactly like `grass-1`; the new pair is a fast low transient with a dark
top, exactly like `pavement-1`.

Also in this pass:

- **Cut stone is its own family.** `plazaStone`, `stoneAshlar` and the `plaza`
  terrain all played the pavement pair; stone carries 9-15 dB more 0.8-3 kHz
  than a poured slab.
- **`--takes N` puts take selection in the tool.** Over five takes of one
  asphalt prompt, measured body ran from **-0.1 dB to +29.9 dB** — take 0 was a
  rustle and take 2 is what ships. Accepting take 1 is the trap the previous
  pass fell into, so the selection is now reproducible and recorded.
- **`--steps` refuses to re-cut an already-cut file.** Doing it twice re-seeks
  the transient inside the trimmed file and silently eats the head of the step.
  Measured by accident: 418 bytes shorter and 1.6 dB louder.

`STEP_BAND_DB` and `HARD_SURFACE_BODY_DB` pin the class in the manifest, with
the threshold at 10 dB — in the gap between the two classes (weakest hard
+14.4 dB, strongest loose +4.7 dB) rather than on a sample.

## 2. Police that slid

**Measured before anything was changed**, by sampling officer motion at 60 Hz
in the shipped build:

| | Before | After | Bound |
| --- | --- | --- | --- |
| Peak speed | 6.40 m/s | **5.40 m/s** | `OFFICER_RUN_SPEED` |
| Peak acceleration | **384 m/s²** | 6.4 m/s² | `OFFICER_BRAKE` |
| Peak turn rate | 7.1 rad/s | 4.5 rad/s | `OFFICER_TURN_RATE` |

384 m/s² is 39 g: `speed = wantsToMove ? RUN : 0` was a step function, and
`heading` was assigned rather than rate-limited.

**The slide was not where it looked.** `OfficerRig.advance` was already
displacement-driven, which is why this was not obvious. It advanced the stride
by the projection of the frame's displacement **onto the officer's heading** —
and the obstacle detour moved the officer at 1.15 rad (66°) to that heading, so
`cos(1.15) = 0.407` and **59 % of the motion during every detour was
unanimated**. Feet slid exactly when an officer came round an obstacle, which is
when a player is watching them.

The fix is structural: an officer only ever moves **along their own heading**,
at a rate bounded by acceleration, and the heading turns at a bounded rate.
Nothing writes a position, so the stride cannot disagree with the ground
covered.

Rounds also left the chest — `officer.y + OFFICER_EYE * 0.86`, 0.54 m from the
drawn pistol. `OfficerRig.muzzleOf` is now the single authority for the damage
roll, the flash, the tracer, the audio event and a second line-of-sight test.

## 3. Cars made of glass

`impactDamage` was **linear in impulse with no deadband**, and the same shared
number was charged to both cars — so a hatchback and a box truck took identical
damage from one collision.

| closing | old damage | old outcome |
| --- | --- | --- |
| 3 m/s parking shunt | 52 pts | **20 % of the shell** |
| 8 m/s urban | 140 pts | **54 %, dead in two** |

Severity is now each shell's **own delta-v** (barrier-equivalent velocity, the
standard crash-reconstruction metric), with a yield threshold at 2 m/s and an
energy-square response above it, times a `crushShare` that separates a square
hit from a glancing one.

| closing | damage | stage | drivable |
| --- | --- | --- | --- |
| 3 m/s | 0.7 % | pristine | yes |
| 8 m/s | 17 % | scuffed | yes, full power |
| 8 m/s x 6 | 100 % | wrecked | no |
| 22 m/s | 270 % | wrecked | no |

The impulse arithmetic is untouched, and that separation is asserted: the same
impulse with damage 0 and damage 260 produces identical `vx/vz/yawRate`. How
hard cars are can no longer change how they move.

## 4. Rockets that could not lift a car

`VehicleImpact` carried only `dirX`/`dirZ`, and `settleBody` assigns
`vehicle.y` outright from the terrain under each axle **every frame** — so a
blast could yaw a car, roll it, overturn it and throw it down the street, and
never lift one. Anything that wrote `y` was overwritten before it was drawn.

`lift` is an impulse in newton-seconds, **added to the horizontal one rather
than taken out of it**: making the direction three-dimensional would have
redistributed a fixed magnitude and silently changed every horizontal number
already calibrated. `Vehicle.hop`/`hopRate` is a ballistic layer riding on top
of the ground assignment under real gravity, landing nearly inelastically.

A lift under one sill is a **couple** — the half-track as the arm — and that,
not the lateral term, is what actually puts a car onto its roof.

The negative invariant matters as much as the positive one and is tested: an
ordinary collision passes no lift at all. A car that hops when it is rear-ended
is a worse defect than one that cannot be thrown.

`probeRocket` had also discarded every field but `t`, so a rocket into a wall
left a horizontal scorch floating in mid-air and the struck vehicle was
indistinguishable from one parked beside it. One authoritative hit result now
feeds damage, impulse, decal, debris and orientation.

### Ownership, and four rounds of review

The blast lift crosses an ownership boundary, and every crossing was wrong the
first time. All four were found by the Greptile review, and all four were real:

1. **The player's own car never lifted.** `applyImpact` routes a
   player-controlled vehicle into `pendingImpulses`, which carried the shove,
   the yaw and the damage and dropped the lift. The identical car was thrown
   when parked and merely shoved when the player was in it.
2. **An airborne car collided at ground level.** `setPose` published the raised
   position while `moveBox` tested the footprint at the sampled road height, so
   a car a blast had visibly thrown was stopped dead by a kerb it had cleared —
   and charged for the collision.
3. **Exit dropped the arc.** `release()` transferred the height and not the
   rate, and a blast landing in the same frame as the exit had its queued
   impulse thrown away entirely. `exit()` now drains the queue and publishes the
   whole arc before releasing.
4. **Re-entry snapped it to the road.** The mirror of (3). `takeControl` now
   refuses an airborne body alongside the write-off and the overturned one it
   already refused, and `VehicleView.airborne` keeps the prompt honest. The
   driving model is kinematic and starts from the ground; there is no truthful
   way for it to continue somebody else's trajectory.

A fifth round flagged that the arc was stepped *after* the move, leaving the
collision volume one frame under the drawn body on exactly the launch and
landing frames. The sixth round was clean at 5/5.

## What was measured in the browser

Against a production build, through `window.__meridian`:

| Claim | Measurement |
| --- | --- |
| Roads sound like asphalt | Walking the harbour carriageway plays `steps/asphalt-2`; the tar roof plays `asphalt-1` |
| Every surface is distinct | pavement, boardwalk, **stone**, grass, concrete, terminal each play their own pair |
| Police never exceed a human speed | max 5.40 m/s, exactly the bound |
| Police never teleport | max 0.09 m per frame = 5.4 m/s at 60 Hz |
| Police feet do not slide | worst stride overrun **0** over 7,564 samples |
| Police handle weapons | 9 of 11 behaviour states seen live; armed in 81 % of samples |
| A parking bump is survivable | 2.41 m/s → **0.71 %** of the shell, still `pristine` |
| A glancing hit costs little | 7.51 m/s glancing → 0.8 pts |
| A hard crash does not destroy | 7.21 m/s square → `crippled`, still driving |
| A rocket destroys and throws | van integrity 250 → **0**, **lifted 0.98 m**, yawed 19.7° |
| Shots leave aligned marks | 23 shots → 23 marks, unit normals, ~1 cm proud of the surface |
| Effects are bounded | glows peaked **207/208**, smoke 56/56, marks never above 96 |
| Nothing leaks | after 50 shots and 60 blasts: 117 FPS, p95 11.3 ms, 118 MB |

The `fps` field of `__meridian.stats` is meaningless when frames are driven
manually outside `requestAnimationFrame`; `renderBenchmark` is the number to
read, and it is the one quoted above.

## Provider cost

85 ElevenLabs credits (USD 1.70) for the footstep work: 35 on candidate
exploration and rejected renders, 50 on the four take-selected finals. No image
or 3D generation was needed.
