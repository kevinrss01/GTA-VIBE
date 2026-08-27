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

### Airport props — 15 × 50 = 750 credits

`public/models/airport/`, 8.3 MB total, 699–2,949 triangles each.

| Airside | Terminal | Luggage / people |
| --- | --- | --- |
| `air-stairs` | `checkin-desk` | `suitcase` |
| `baggage-tug` | `gate-seats` | `duffel` |
| `baggage-cart` | `scanner` | `trolley` |
| `fuel-bowser` | `flight-board` | `seated-a` |
| `gpu-cart`, `windsock` | | `seated-b` |

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
