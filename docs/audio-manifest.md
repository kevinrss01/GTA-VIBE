# Audio asset manifest

Reproducibility record for every sound Meridian Bay ships, as required by
`AGENTS.md`. Every number below was measured on the shipped file with `ffprobe`
and `ffmpeg -af volumedetect`, not copied from the generation request.

- Provider: ElevenLabs, via the ElevenCreative MCP flow `5wd4nJrjlOEJWXqifsp0`.
- Generated: 2026-08-17.
- Runtime manifest: [`src/audio/manifest.ts`](../src/audio/manifest.ts) — the
  same data in typed form, which the engine and the tests both read.
- **Total charged: 1,666.00 credits (USD 33.32)** — 1,062.67 for the original
  manifest, 323.67 for the 2026-08-27 pursuit/airfield batch and 279.66 for the
  2026-08-28 vehicle-class batch. The airport dialogue is charged per character
  and is recorded with those lines.

No API key, signed URL or other secret appears in this file, in the runtime
manifest, or in any committed asset. `tests/audio.test.ts` asserts this.

## Validation

Every file was checked with:

```bash
ffprobe -v error -show_entries format=duration,bit_rate \
  -show_entries stream=sample_rate,channels -of default=noprint_wrappers=1 <file>
```

All files are real MP3s at the durations recorded here, all with distinct MD5
sums (no silent duplicates), and none is silent. The -49.4 dBFS grass footstep
that used to be the quietest file in the manifest was the defect fixed by the
2026-08-27 rebalance; see
[The 2026-08-27 rebalance](#the-2026-08-27-rebalance-measured-before-and-after).
`tests/audio.test.ts` re-checks on every run that each manifest entry exists on
disk at exactly the recorded byte size, so the manifest cannot drift from the
shipped assets.

Every looping asset was additionally seam-checked by comparing the mean level of
its first and last 200 ms, since a loop that fades or pads to silence clicks or
drops out at the wrap. The seven ambience beds all matched within 4 dB and needed
no work. The music track did not, and was repaired — see
[Post-processing](#post-processing-the-shipped-track-is-a-crossfade-loop).

| Bed | Head 200 ms | Tail 200 ms |
| --- | --- | --- |
| `harbour` | -41.0 dB | -42.8 dB |
| `street` | -35.5 dB | -39.0 dB |
| `old-quarter` | -37.5 dB | -38.8 dB |
| `park` | -31.5 dB | -35.6 dB |
| `cannery` | -26.5 dB | -26.5 dB |
| `ridge` | -34.4 dB | -35.2 dB |
| `interior` | -43.8 dB | -46.6 dB |

### About `trimDb`

Generated clips came back with peaks spread over roughly 22 dB, which would make
footsteps jump in volume between surfaces and beds jump between districts. Each
asset therefore carries a `trimDb` derived from its measured level: one-shots
are peak-normalised towards -6 dBFS and ambience beds are mean-normalised
towards -34 dBFS, with boosts capped at +10 dB so a quiet clip cannot drag its
own noise floor up with it. This is measurement-driven correction, not taste.

## Cost model actually observed

The estimates returned by `creative_run_flow_nodes --estimate-only` are **3×**
the amount actually charged for sound effects. Confirmed against four different
clip lengths, so budget from the charged figures below, not from the estimate:

| Model | Estimated | Actually charged |
| --- | --- | --- |
| `eleven_text_to_sound_v2` | 10 credits/s | **3.333 credits/s** |
| `eleven_music_v2` | 25 credits/s | **15 credits/s** |

## Ambience beds

Looping district beds, crossfaded over 2 s. All: `eleven_text_to_sound_v2`,
44100 Hz, 2 ch, 15.000 s, 258,042 bytes, 50 credits each, generated with
`duration_seconds: 15, prompt_influence: 0.4, loop: true`.

| Asset | Path | Trim | Prompt |
| --- | --- | --- | --- |
| `ambience/harbour` | `/audio/ambience/harbour.mp3` | +0.6 dB | Seamless looping harbour ambience: small waves lapping against a stone seawall, distant seagulls calling, boat rigging and halyards tapping lightly against metal masts, one very distant boat engine far out in the bay. Steady even background texture, no music, no speech, no sirens. |
| `ambience/street` | `/audio/ambience/street.mp3` | +0.1 dB | Seamless looping general city street room tone: distant traffic hum several blocks away, air-conditioning condenser units humming on nearby walls, faint far-off construction work, an occasional distant door closing. Even, unobtrusive background texture, no music, no speech, no sirens, no car horns close by. |
| `ambience/old-quarter` | `/audio/ambience/old-quarter.mp3` | +1.5 dB | Seamless looping ambience of a narrow reverberant old-town street between tall stone buildings: pigeons cooing and fluttering, a faint indistinct radio muffled behind a closed window, distant crockery clinking in a kitchen, footsteps echoing far away down the alley. Reverberant and calm, no music, no clear speech, no sirens. |
| `ambience/park` | `/audio/ambience/park.mp3` | +2.4 dB | Seamless looping city park ambience: leaves and branches moving in a light wind, several small songbirds chirping in the trees, a stone water fountain splashing gently a short distance away. Peaceful and continuous, no music, no speech, no traffic, no sirens. |
| `ambience/cannery` | `/audio/ambience/cannery.mp3` | -10.3 dB | Seamless looping industrial yard ambience: a low steady electric motor hum, corrugated metal sheeting creaking and ticking as it flexes, an occasional distant metallic clank from across the yard, wind whistling through a chain-link fence. Sparse, low and continuous, no music, no speech, no sirens, no alarms. |
| `ambience/ridge` | `/audio/ambience/ridge.mp3` | -2.5 dB | Seamless looping ambience high on an exposed hillside above a city: steady gusting wind over open grassy ground, overhead power lines and wires humming and singing in the wind, the faint distant murmur of the city far below. Airy and wide, no music, no speech, no sirens. |
| `ambience/interior` | `/audio/ambience/interior.mp3` | +8.3 dB | Seamless looping quiet indoor room tone: the muffled dull rumble of the city heard through closed windows and thick walls, a faint refrigerator compressor humming in the corner, very low broadband air. Extremely calm and enclosed, no music, no speech, no sirens. |

**Subtotal: 350 credits (USD 7.00).**

## Footsteps

Two variants per surface so the runtime can alternate. All:
`eleven_text_to_sound_v2`, 44100 Hz, 2 ch, **0.680249 s**, 29,000 bytes, 2.3333
credits each, generated with `duration_seconds: 0.7, prompt_influence: 0.75,
loop: false`. The model rounds a 0.7 s request down to a whole number of frames,
so the measured duration is recorded rather than the requested one.

| Asset | Path | Trim | Prompt |
| --- | --- | --- | --- |
| `steps/pavement-1` | `/audio/steps/pavement-1.mp3` | -0.8 dB | one single footstep on a dry concrete paving slab, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/pavement-2` | `/audio/steps/pavement-2.mp3` | -0.7 dB | one single footstep landing heel first on a dry concrete paving slab, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/boardwalk-1` | `/audio/steps/boardwalk-1.mp3` | +8.6 dB | one single footstep on hollow wooden decking boards, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/boardwalk-2` | `/audio/steps/boardwalk-2.mp3` | +1.6 dB | one single footstep on a creaking hollow wooden boardwalk plank, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/gravel-1` | `/audio/steps/gravel-1.mp3` | -1.5 dB | one single footstep crunching on loose gravel, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/gravel-2` | `/audio/steps/gravel-2.mp3` | +8.1 dB | one single footstep shifting on loose gravel and small stones, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/interior-1` | `/audio/steps/interior-1.mp3` | +8.4 dB | one single footstep on a hard indoor tiled floor, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/interior-2` | `/audio/steps/interior-2.mp3` | +1.6 dB | one single hard-soled footstep tapping on a smooth indoor ceramic tile floor, walking pace, close dry recording, no reverb, no music, no other sound |

Four surfaces were re-rendered on 2026-08-27 at `duration_seconds: 0.5,
prompt_influence: 0.85` — the grass pair because it was unusable, and the two
airfield materials because they did not exist. 1.6667 credits each.

| Asset | Path | Trim | Prompt |
| --- | --- | --- | --- |
| `steps/grass-1` | `/audio/steps/grass-1.mp3` | +9.4 dB | one single footstep pressing down into short dry grass over firm soil, a crisp rustle of grass blades with a dull earth thud underneath it, walking pace, recorded loud and close, close dry recording, no reverb, no music, no speech, no other sound |
| `steps/grass-2` | `/audio/steps/grass-2.mp3` | +3.0 dB | one single footstep landing in longer damp grass and soft earth, a muffled swishing rustle with a soft low thump under it, walking pace, recorded loud and close, close dry recording, no reverb, no music, no speech, no other sound |
| `steps/concrete-1` | `/audio/steps/concrete-1.mp3` | -0.7 dB | one single heavy hard-soled work boot stamping down on a bare poured concrete apron, one loud flat hard slap at full volume with a little grit under the sole, recorded very close with the microphone at the shoe, close dry recording, no reverb, no music, no speech, no other sound |
| `steps/concrete-2` | `/audio/steps/concrete-2.mp3` | +6.4 dB | one single boot step scuffing on a bare dusty concrete apron outdoors, a hard flat contact ending in a short gritty scrape, walking pace, recorded loud and close, close dry recording, no reverb, no music, no speech, no other sound |
| `steps/terminal-1` | `/audio/steps/terminal-1.mp3` | -4.2 dB | one single loud sharp footstep on a hard polished tiled floor, a bright flat slap of a leather sole at full volume with a very short tail, recorded extremely close, no music, no speech, no other sound |
| `steps/terminal-2` | `/audio/steps/terminal-2.mp3` | -0.5 dB | one single hard leather heel striking a polished marble floor, one loud crisp high click at full volume with a very short tail, recorded extremely close with the microphone right at the shoe, no music, no speech, no other sound |

All eighteen ship at 0.320 s and 6,313 bytes (the asphalt pair was replaced and the stone pair added on 2026-08-28; see below). Six retries were needed to get the
four new surfaces above the noise floor; `terminal-1` took three, and each
retry costs 1.6667 credits.

### The 2026-08-27 rebalance: measured before and after

The set had two independent defects and both are fixed at the asset, not in the
mixer.

**Loudness, not peak.** Peak-normalising a transient does not equalise its
loudness: a sharp slap and a soft rustle with the same peak are nowhere near the
same volume. Measured post-trim MEAN level spanned 15.5 dB, and the two GRASS
variants sat at opposite ends of it — `grass-2` was the loudest footstep in the
game and `grass-1` the quietest, alternating on every other step, which is heard
as a limp rather than as variation.

**Overlap, not gain.** Every render was 0.680249 s. The player controller emits
a step per `strideLength` metres walked: 1.45 m at `WALK_SPEED` 2.8 m/s is one
every 0.518 s, and 1.95 m at `RUN_SPEED` 6.0 m/s is one every 0.325 s. At a run
every footstep therefore overlapped the previous one and part of the one before
it — two to three voices summing, +6 to +9.5 dB, into a graph that had no
limiter anywhere in it. That, not the trim, was why footsteps were too loud.
Measured per 26 ms window, every render had fallen at least 25 dB below its own
peak by 0.30 s, so the overlap was buying tail and near-silence.

Each file is now cut to 0.32 s around its own transient with a 5 ms/70 ms fade
pair — under the running cadence — and then levelled towards a mean of -22 dBFS
with a -1.5 dBFS peak guard, so a hard transient is never pushed into clipping
to hit the target.

| Asset | Mean before | Post-trim before | Mean after | Trim after | Post-trim after |
| --- | --- | --- | --- | --- | --- |
| `steps/pavement-1` | -25.9 dB | -31.6 dB | -23.1 dB | -0.8 dB | **-23.9 dB** |
| `steps/pavement-2` | -27.1 dB | -32.7 dB | -24.3 dB | -0.7 dB | **-25.0 dB** |
| `steps/asphalt-1` | -34.6 dB | -32.0 dB | *replaced 2026-08-28* | — | — |
| `steps/asphalt-2` | -21.4 dB | -27.4 dB | *replaced 2026-08-28* | — | — |
| `steps/boardwalk-1` | -32.1 dB | -28.1 dB | -30.6 dB | +8.6 dB | **-22.0 dB** |
| `steps/boardwalk-2` | -26.3 dB | -29.7 dB | -23.6 dB | +1.6 dB | **-22.0 dB** |
| `steps/gravel-1` | -25.3 dB | -31.3 dB | -22.5 dB | -1.5 dB | **-24.0 dB** |
| `steps/gravel-2` | -33.6 dB | -30.8 dB | -31.2 dB | +8.1 dB | **-23.1 dB** |
| `steps/grass-1` | -49.4 dB | **-39.4 dB** | -31.4 dB | +9.4 dB | **-22.0 dB** |
| `steps/grass-2` | -33.9 dB | **-23.9 dB** | -25.0 dB | +3.0 dB | **-22.0 dB** |
| `steps/interior-1` | -33.0 dB | -27.9 dB | -30.4 dB | +8.4 dB | **-22.0 dB** |
| `steps/interior-2` | -29.4 dB | -32.6 dB | -26.5 dB | +1.6 dB | **-24.9 dB** |
| `steps/concrete-1` | — | — | -22.5 dB | -0.7 dB | **-23.2 dB** |
| `steps/concrete-2` | — | — | -29.0 dB | +6.4 dB | **-22.6 dB** |
| `steps/terminal-1` | — | — | -17.8 dB | -4.2 dB | **-22.0 dB** |
| `steps/terminal-2` | — | — | -22.1 dB | -0.5 dB | **-22.6 dB** |

**Spread across the set: 15.5 dB before, 3.0 dB after.** The grass pair alone
was 15.5 dB apart and is now 0.0 dB apart. The residual spread is entirely the
peak guard doing its job on the sharpest transients, and 3.0 dB is inside the
+/-2 dB per-step jitter the runtime already applies, so it is not audible as a
difference between surfaces. `tests/audio.test.ts` asserts both the whole-set
spread and the within-pair spread from `STEP_MEAN_DB`, so a re-render that
regresses either one fails the suite.

Two files needed offline work beyond the cut, both recorded in the runtime
manifest's `postProcess`: `steps/grass-1` was boosted 6 dB because its render
was past the +10 dB the trim is allowed to apply, and `air/runway-roll` was
rebuilt as a crossfade loop.

The cost of the cut is real and is recorded rather than hidden: the hollow ring
of the boardwalk and the reflection on the terminal floor are shortened. At a
run that tail was never audible on its own, because the next footstep landed on
top of it.

**Subtotal: 28 credits for the original twelve, plus 16.67 credits of re-renders
(six new files and four retries): 44.67 credits (USD 0.89).**

### The 2026-08-28 asphalt replacement: the road that sounded like grass

The 2026-08-27 pass fixed two real defects and the road still sounded like a
verge, because neither of them was the defect being reported.

- The **classifier** was already right. `tests/footsteps.test.ts` sweeps the
  built world and asserts that all 5,000+ carriageway sample points resolve to
  the `asphalt` family, and that no outdoor point plays a domestic tile.
- The **levels** were already right: a 3.0 dB spread across the set.
- The **recordings** were wrong. Both asphalt renders were rustles.

Neither loudness nor classification says anything about **timbre**, so a third
measurement was needed. Band-passing each shipped 0.32 s file and taking the
mean level of each band gives two derived numbers that separate a hard contact
from a loose one:

```
body   = mean(180-800 Hz) - mean(8 kHz+)     the contact standing over the air
crunch = mean(0.8-3 kHz)  - mean(180-800 Hz) whether it peaks in the grit band
```

Measured over the shipped set with `node tools/generate-world-sfx.mjs --bands`:

| Asset | body | crunch | class |
| --- | --- | --- | --- |
| `steps/pavement-1` | +25.5 dB | -14.5 dB | hard |
| `steps/pavement-2` | +32.6 dB | -8.7 dB | hard |
| `steps/concrete-1` | +17.7 dB | -3.7 dB | hard |
| `steps/concrete-2` | +14.4 dB | -4.6 dB | hard |
| `steps/asphalt-1` **(was)** | **+4.2 dB** | **+3.9 dB** | **loose** |
| `steps/asphalt-2` **(was)** | **+11.6 dB** | **+2.4 dB** | borderline |
| `steps/gravel-1` | +4.7 dB | +0.8 dB | loose |
| `steps/gravel-2` | -4.0 dB | +1.5 dB | loose |
| `steps/grass-1` | -12.4 dB | +5.7 dB | loose |
| `steps/grass-2` | +2.5 dB | -0.5 dB | loose |
| `steps/asphalt-1` **(now)** | **+29.9 dB** | **-9.5 dB** | **hard** |
| `steps/asphalt-2` **(now)** | **+28.9 dB** | **+1.2 dB** | **hard** |
| `steps/stone-1` **(new)** | +22.4 dB | +0.3 dB | hard |
| `steps/stone-2` **(new)** | +23.6 dB | +1.0 dB | hard |

The old asphalt-1 measured a rustle with a grit peak - numerically nearer
`grass-1` than `pavement-1` - which is exactly what was reported. The
replacements sit in the hard class, nearest `concrete`, which is the right
neighbour for a bituminous aggregate: it keeps some of a poured slab's grit and
none of a paving slab's ring.

Spectrograms confirm the class change independently of the band arithmetic: the
old pair is a broadband wash for the full 0.32 s, like `grass-1`; the new pair
is a fast low transient with a dark top, like `pavement-1`.

What changed in the prompt was naming the **damping** and excluding the failure
modes by name. Asphalt is a bound, slightly porous surface, so a shoe on it is a
dull blunt low contact with almost no ring and only a trace of grit - not a
crunch of loose stones and not a rustle.

| Asset | Path | Trim | Prompt |
| --- | --- | --- | --- |
| `steps/asphalt-1` | `/audio/steps/asphalt-1.mp3` | +3.0 dB | one single shoe stepping down onto worn asphalt road, a dull blunt low thud on hard bitumen with a short dry sandy grit texture over it, damped with no ring and no tail, walking pace, recorded loud and very close, no crunch, no loose gravel, no stones, no rustling, close dry recording, no reverb, no music, no speech, no other sound |
| `steps/asphalt-2` | `/audio/steps/asphalt-2.mp3` | -2.5 dB | one single boot heel rolling onto dry tarmac and scraping briefly on road dust, a thick low blunt contact with a short gritty rubber drag, dead and damped, walking pace, recorded loud and very close, no crunch, no gravel, no stones, no grass, no rustle, close dry recording, no reverb, no music, no speech, no other sound |

Rendered at `eleven_text_to_sound_v2`, `duration_seconds: 0.5`,
`prompt_influence: 0.85`, `mp3_44100_128`, then cut and levelled by the same
`--steps` path as the rest of the set. Post-trim mean: `asphalt-1` **-25.4 dB**,
`asphalt-2` **-22.0 dB**, which keeps the whole-set spread at 3.4 dB, inside the
4 dB the loudness test allows.

### Cut stone becomes its own family

`plazaStone` and `stoneAshlar` are their own materials in the world, and `plaza`
is its own terrain surface, and all three played the pavement pair. Cut stone is
denser and brighter than a poured slab: measured, the stone pair carries 9 to
15 dB more 0.8-3 kHz relative to its contact band than pavement does, which is
why a paving-slab recording reads as wrong on a stone square. Two recordings
rather than a remap.

| Asset | Path | Trim | Prompt |
| --- | --- | --- | --- |
| `steps/stone-1` | `/audio/steps/stone-1.mp3` | -0.9 dB | one single leather-soled shoe landing on a worn stone flagstone in an old town square, a hard bright stony knock with a short natural click and no grit, walking pace, recorded loud and very close, no crunch, no gravel, no loose stones, no rustling, close dry recording, no reverb, no music, no speech, no other sound |
| `steps/stone-2` | `/audio/steps/stone-2.mp3` | -1.0 dB | one single footstep pivoting on a smooth worn limestone slab, a hard bright stone contact with a brief dry sole scuff, dense and solid, walking pace, recorded loud and very close, no crunch, no gravel, no dirt, no rustling, close dry recording, no reverb, no music, no speech, no other sound |

`SURFACE_STEP_FAMILY.plaza`, `MATERIAL_STEP_FAMILY.plazaStone` and
`MATERIAL_STEP_FAMILY.stoneAshlar` now all resolve to `stone`.

### Takes, and why the tool now chooses

A footstep has to satisfy three measured constraints at once - level to the
set's -22 dBFS mean under a -1.5 dBFS peak guard, body >= 10 dB, crunch <= +2 dB
- and a single take from a stochastic generator frequently misses one. Over five
takes of `asphalt-1`, measured body ran from **-0.1 dB to +29.9 dB**: take 0 was
a rustle and take 2 is the shipped file. Two `stone-1` renders in a row came back
with a peak already at -0.4 dBFS and a mean at -27 dB, which the peak guard makes
impossible to level at all.

`node tools/generate-world-sfx.mjs --takes 5 <id>` renders N takes, cuts and
measures each, keeps the best by penalty against those three targets and deletes
the rest, so the selection is reproducible and recorded rather than a hand
re-roll. `--steps` also now refuses to re-cut a file that is already at the
window; doing so a second time re-seeks the transient inside the trimmed file and
silently throws away the head of the step.

**Credits: 35 for candidate exploration and the first, rejected renders; 50 for
the four take-selected finals (four ids x five takes x 1.6667). 85 credits
(USD 1.70).** Every render was 0.5 s at 3.3333 credits per second.

The measurements are pinned as data in `src/audio/manifest.ts` (`STEP_BAND_DB`,
`HARD_SURFACE_BODY_DB`) and asserted in `tests/audio.test.ts`, in the same way
`STEP_MEAN_DB` pins the loudness rebalance. The threshold sits at 10 dB, in the
gap between the classes rather than on a sample: the weakest hard surface
measures +12.1 dB and the strongest loose one +4.7 dB. Re-measure with `--bands`
after any re-render.

### Surface mapping

`SurfaceId` has nine members and all nine are covered. `plaza` reuses the
pavement pair (a paved plaza reads as paving slabs), `sand` reuses gravel
(closest match for dry sand), and `water` is mapped to gravel for completeness
only — the player controller stops the player before they can wade.
`tests/audio.test.ts` parses `SurfaceId` straight out of
`src/world/CityGround.ts`, so adding a surface without a mapping fails the suite.

The two airfield pairs are exported as `CONCRETE_STEPS` and `TERMINAL_STEPS`
rather than mapped, because the surfaces that use them do not exist yet: bare
apron concrete is not the same as a pavement slab, and a polished terminal floor
is not the same as a domestic interior tile, so whoever adds those `SurfaceId`
members should point them at these rather than at the nearest existing pair.

### Surface classification, and the death of `onRoad`

**Rewritten on 2026-08-28.** The two mechanisms this section used to describe -
`GroundSample.onRoad` as an override, and a two-footstep hold - are both gone,
and the numbers below are why.

**The bug was not on roads.** `FirstPersonController` derived the surface as

```ts
this.surface = support.built && support.y > here.y + 0.05 ? 'interior' : here.surface;
```

which collapses EVERY built platform standing more than 5 cm proud of the
terrain into one bucket: the domestic ceramic-tile pair. Swept over the whole
map at 1.5 m, **6,276 walkable points hit that branch and only 372 of them are
indoors.** The rest are shop plinths, boardwalk decks, apron edges and the whole
terminal, so the game played a kitchen-tile footstep on the runway, on the
harbour decking and on open gravel. Meanwhile `STEP_SURFACES.concrete` pointed
at the pavement pair while `steps/concrete-*` sat in the manifest unreferenced,
so the runway, the taxiway, the apron and every hangar floor were a city paving
slab.

**`onRoad` was dead weight.** It was passed from `main.ts` as a third argument
"because the surface classification alone was wrong on roads". Swept over the
same map: of **28,875 carriageway points, zero** were misclassified without it.
It was a fossil of an already-fixed bug in `openGroundSurface`, which is now
value noise on a 34 m lattice rather than a hash that re-rolled every half
millimetre. `tests/footsteps.test.ts` runs both sweeps.

**What replaced them.** `ColliderBox.surface` already existed, documented as
being there "so a footstep on a hangar floor is not decided by guessing from the
terrain underneath it", and nothing in audio read it. It is now the authority:

| Underfoot | Heard |
| --- | --- |
| bare terrain | the ground sampler's `SurfaceId` |
| a built floor the world tagged | that collider's `MaterialKey` |
| an untagged built floor, indoors | `interior` (domestic tile) |
| an untagged built floor, outdoors | the terrain it stands on |

`MATERIAL_STEP_FAMILY` maps 28 materials onto the eight recorded families.
`timber`/`timberDark` map to the boardwalk pair, which is the only wood in the
manifest and is acoustically what a club floor on joists is; the metals and
`tileFloor`/`stoneAshlar` map to the polished terminal pair. 115 of the world's
1,762 colliders carry a material, so the controller keeps them in an index of
their own rather than paying for the other 1,647.

**Hysteresis is now measured in seconds, not footsteps.** A hold counted in
footsteps cannot be prompt and stable at once: two steps is one step late on
every genuine crossing, one step flickers on every boundary. The controller
samples the ground 120 times a second, so it debounces the CONTINUOUS signal
instead - `SURFACE_COMMIT_TIME` is 0.1 s, which is 0.28 m at a walk and 0.6 m at
a run, both far inside the 1.45 m / 1.95 m stride. A genuine crossing therefore
commits before the next footfall (prompt), and chatter reverts before the timer
expires and is never heard (stable). `tests/footsteps.test.ts` asserts both:
the first footfall after a kerb is the new material, and a boundary weaving at
60 Hz changes the family **zero** times in 10 s.

### Integration note: the two lines `main.ts` owes this

The footstep path was changed from "a surface plus a re-derived road flag" to
"one authoritative event", and `src/main.ts` is owned by another workstream, so
the two edits it needs are recorded here rather than applied. Until they land,
`tsc` reports four errors in the one block below and every footstep resolves to
the pavement pair.

1. Give the controller the collider list, so a built floor can report its own
   material (`src/main.ts`, the `new FirstPersonController({...})` call):

```ts
    spawn: plan.spawn,
    // The same boxes `collision` was built from. The controller indexes the
    // ~115 of them that carry a `surface` so a footstep on a terminal floor is
    // decided by that floor rather than by the apron underneath the building.
    colliders: sink.colliders,
  });
```

2. Stop re-deriving the surface at the call site (`controller.onFootstep`):

```ts
  controller.onFootstep = (step) => {
    // A driver has no feet on the pavement, and neither does a pilot. The
    // controller is paused in both, but its velocity DAMPS to zero rather than
    // snapping there, so it can still cross the footstep threshold for a
    // moment after getting in - which is audible as walking while seated.
    if (driving.driving || flying.flying) return;
    /*
     * The event already carries the AUTHORITATIVE surface and, where the world
     * tagged one, the material of the floor under the sole. Nothing here may
     * re-derive it: the `onRoad` flag this used to sample and pass down was a
     * second guess at something the world already knew, and a dead one - swept
     * over the map, none of the 28,875 carriageway points needed it.
     */
    audio.footstep(step);
  };
```

Both were applied temporarily to run the browser verification recorded below,
then reverted so the file stays with its owner.

### Player footstep level

The report was that footsteps are too loud, and they were: every step played at
its full authored level, which is the level a CLOSE microphone at the shoe was
normalised to. What the player hears is their own feet from eye height. They now
carry `PLAYER_STEP_DB` = **-8 dB**, with `PLAYER_STEP_CEILING_DB` = -2 dB as a
guard on the mixer's OFFSET.

The offset/total distinction is load-bearing, and getting it wrong the first
time quietly undid the 2026-08-27 rebalance. A step asset's `trimDb` is a
per-file CORRECTION towards a -22 dBFS mean, not a level, and those corrections
run from -4.2 dB to +9.4 dB. Clamping `trimDb + offset` therefore attenuates
exactly the files whose correction is largest: measured in the browser before it
was caught, grass lost 3.4 dB and boardwalk 2.6 dB while terminal and concrete
lost nothing - which is the 15.5 dB spread the rebalance existed to remove,
coming back through the mixer. The ceiling now applies to the offset alone, and
`tests/audio.test.ts` asserts the invariant `gainDb - offsetDb === trimDb` for
every family in both walking and running.

Three other changes to the same path:

- **Running lands heavier, not higher.** The old constants raised the playback
  rate 5 per cent, which is what a LIGHTER contact sounds like. A run is now
  +3.5 dB and rate 0.94, and the "faster" comes from the controller's stride
  length as it always did.
- **Left and right.** The controller alternates `foot`, and the mixer places the
  step at a stereo pan of -+0.28 with the trailing foot 1.1 dB down and 3.5 per
  cent lower. One `StereoPannerNode` per step, and it is what turns two samples
  into a gait rather than a metronome.
- **A QA field.** `AudioDirector.debug` reports the last footstep's family,
  asset, gain, rate and pan, and a count per family. It is published on
  `window.__meridianAudio` once the context is unlocked, for the same reason
  `main.ts` publishes `window.__meridian`: so "the runway sounds like concrete"
  can be proven from a browser rather than asserted from a screenshot.

## Interaction and UI

All `eleven_text_to_sound_v2`, 44100 Hz, 2 ch, `prompt_influence: 0.75,
loop: false`.

| Asset | Path | Duration | Size | Credits | Trim | Prompt |
| --- | --- | --- | --- | --- | --- | --- |
| `sfx/door-open` | `/audio/sfx/door-open.mp3` | 1.200 s | 36,942 B | 4 | +0.1 dB | a wooden door latch turning and the door swinging open on its hinges, close dry interior recording, no music, no speech, no other sound |
| `sfx/door-close` | `/audio/sfx/door-close.mp3` | 1.200 s | 36,942 B | 4 | -5.2 dB | a wooden door swinging closed and the latch clicking shut, close dry interior recording, no music, no speech, no other sound |
| `sfx/ui-tick` | `/audio/sfx/ui-tick.mp3` | 0.480 s | 25,657 B | 1.6667 | -1.5 dB | a very soft short neutral interface tick, a single restrained dry click, quiet and understated, not a musical chime, no reverb, no music, no other sound |

**Subtotal: 9.67 credits (USD 0.19).**

## Music

| Asset | Path | Model | Generated | Shipped | Sample rate | Size | Credits |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `music/meridian-theme` | `/audio/music/meridian-theme.mp3` | `eleven_music_v2` | 45.000 s | **35.000 s** | 48000 Hz, 2 ch | 841,581 B | 675 |

Parameters: `duration_seconds: 45, instrumental: true, lyrics_type: instrumental`.

Prompt:

> An original, unhurried instrumental exploration theme for an open-world coastal
> city at golden hour. Warm analogue synthesiser pad as a bed, muted nylon-string
> guitar playing a simple melancholy but hopeful motif, soft upright bass, brushed
> percussion kept low and steady. Even dynamics throughout with no big climax and
> no dramatic build, designed to loop seamlessly as background music. Gentle,
> reflective, spacious. Fully instrumental, no vocals, no singing, no spoken word.

The prompt names no artist, band, game or existing track; it describes
instrumentation and mood only, so the result is an original composition.
Generated exactly once — no retries were run, since each attempt is charged.

**Subtotal: 675 credits (USD 13.50).**

### Post-processing: the shipped track is a crossfade loop

Despite the prompt asking for a loopable bed, `eleven_music_v2` ended the track
with a fade-out: the last 300 ms measured -73.1 dBFS against a -10.9 dBFS
opening, so looping it as delivered would have dropped the music out completely
once every 45 seconds. Measured decay across the tail:

| Position | 30 s | 38 s | 40 s | 42 s | 43.5 s | 44.5 s |
| --- | --- | --- | --- | --- | --- | --- |
| Mean level | -14.5 dB | -17.4 dB | -22.7 dB | -28.6 dB | -40.1 dB | -63.3 dB |

Rather than spend another 675 credits on a regeneration that might do the same
thing, the shipped file is a standard crossfade loop cut from the musical body
(0–39 s, before the fade begins) with a 4 s triangular crossfade:

```bash
ffmpeg -ss 35 -t 4  -i raw.mp3 \
       -ss 0  -t 4  -i raw.mp3 \
       -ss 4  -t 31 -i raw.mp3 \
       -filter_complex "[0:a][1:a]acrossfade=d=4:c1=tri:c2=tri[x];[x][2:a]concat=n=2:v=0:a=1[out]" \
       -map "[out]" -c:a libmp3lame -b:a 192k -ar 48000 meridian-theme.mp3
```

The wrap is continuous by construction: the output ends on the source at 35 s and
restarts on the same material, and the crossfade resolves to the source at 4 s,
which the middle section continues from. Result: 35.000 s, head -17.1 dBFS
against tail -15.2 dBFS — a 1.9 dB match instead of a 62 dB cliff.

The raw 45 s generation is not committed (it would add 1.07 MB of dead weight to
every build). The prompt, parameters and the exact command above reproduce both
the generation and the edit.

### Music is off by default

This is a product requirement, enforced in `AudioDirector` and covered by tests:

1. `musicEnabled` is `false` on every fresh load, and nothing persists it — no
   `localStorage`, no cookie, no query parameter. A reload always comes back
   silent, even if the previous session had music on.
2. The music file is **not fetched or decoded** until `setMusicEnabled(true)` is
   called for the first time. Construction and `unlock()` both skip it: the
   preload set is defined as every asset whose kind is not `music`. A player who
   never enables music never downloads the 1.07 MB track.
3. Enabling starts it looping with a 1.2 s fade-in; disabling fades out over
   0.8 s, stops the source and releases it.
4. Only `setMusicEnabled` ever changes music state. Pointer-lock changes, window
   blur and focus, visibility changes and pause do not. The single lifecycle hook
   installed suspends and resumes the whole `AudioContext` to save CPU while the
   tab is hidden, which leaves a stopped track stopped and lets a playing track
   continue rather than restart.

## Environmental voice

| Asset | Path | Duration | Sample rate | Size | Credits |
| --- | --- | --- | --- | --- | --- |
| `voice/harbour-pa-01` | `/audio/voice/harbour-pa-01.mp3` | 6.502 s | 44100 Hz, 1 ch | 121,787 B | not recorded |

A harbour ferry announcement, generated in an earlier session before this
manifest existed. Its model, voice and prompt were not recorded at the time and
are stored as `null` rather than guessed; the measured file properties are real.
No further speech was generated.

It plays as a positional one-shot at the ferry terminal (x -172, z 12, matching
the `ferry-terminal` landmark in `CityPlan.ts`, with the speaker 5 m up), on a
deterministic 70–140 s schedule, and only when the listener is within 55 m. The
schedule runs on its own clock whether or not anyone is nearby, so arriving at
the quay never triggers an immediate announcement.

## Deviations from the original asset brief

- **Ambience loops are 15 s, not 18 s.** The pre-flight cost estimate reported
  10 credits/s for sound effects, which put seven 18 s beds at 1,260 credits —
  over the whole 1,200-credit budget before footsteps, UI or music. The loops
  were shortened to 15 s to fit. Charging then revealed the estimate to be 3×
  the true rate, so 18 s would in fact have fitted; the beds were left at 15 s
  rather than spending a further ~420 credits to regenerate assets that already
  work, since re-running a node is charged again. 15 s is ample for a background
  bed and no seam is audible.
- **`plaza`, `sand` and `water` reuse neighbouring footstep pairs** instead of
  getting their own recordings, as directed.
- **No additional speech was generated**; the existing harbour PA is the single
  environmental voice element.

## Combat, 2026-08-27

Twenty-two more clips: firing a weapon, what the round arrives at, and being on
the receiving end of one. Rendered by
[`tools/generate-combat-sfx.mjs`](../tools/generate-combat-sfx.mjs), which is
the runnable form of every prompt below and can be re-run clip by clip. Same
provider, same model (`eleven_text_to_sound_v2`), same output format
(`mp3_44100_128`), measured the same way.

| Family | Clips | Charged |
| --- | --- | --- |
| `wpn/*` — the gun in somebody's hands | 12 | 60.0 |
| `imp/*` — where the round lands | 6 | 21.7 |
| `plr/*` — the player's own body | 4 | 23.7 |
| **Total** | **22** | **105.4 credits** |

Four clips were rendered more than once and the cost of the rejected takes is
included above (26.7 credits over four re-renders).

### What had to be corrected, and why

- **`wpn/smg` is the only clip that is not its own generation.** Four separate
  submachine-gun renders came back between -39 and -49 dBFS peak with a noise
  floor only 24 dB below that. Bringing one up to a usable level would have
  brought an audible hiss up with it under a weapon that fires thirteen times a
  second. The shipped file is the pistol render — the same 9 mm cartridge, and
  an excellent take at 0.1 dBFS peak with a -74.8 dB floor — resampled up 18 per
  cent and cut to 0.55 s, which is what a shorter barrel and a lighter bolt
  actually sound like. The exact `ffmpeg` command is in the runtime manifest's
  `postProcess` field.
- **`wpn/rifle` and `imp/flesh` were peak-normalised offline** (+15.7 dB and
  +13.3 dB). Both rendered further below the trim's +10 dB cap than it is
  allowed to correct; the alternative was a rifle you could not hear.
- **`wpn/dry` and `imp/concrete` were re-rendered** with the level asked for in
  the prompt itself ("loud", "recorded close up"), which worked where trimming
  would have raised the noise floor.

### Mixing

One-shots are peak-normalised towards -6 dBFS and the two driven loops
(`plr/heartbeat`, `plr/tinnitus`) mean-normalised towards -34 dBFS, exactly as
the rest of the manifest is. The heartbeat and the ringing are not played, they
are DRIVEN: they run silently from the first time they are needed and their gain
follows health and blast proximity, because a loop that is started and stopped
clicks on every transition and restarts mid-beat.

`src/audio/CombatAudio.ts` is the layer that plays them. Like `StreetAudio` it
builds on the director's existing buses rather than opening a context of its
own, so the volume sliders still reach all of it.

## The pursuit and the airfield, 2026-08-27

Rendered by [`tools/generate-world-sfx.mjs`](../tools/generate-world-sfx.mjs),
which is also where the prompts live in runnable form. All
`eleven_text_to_sound_v2`, `mp3_44100_128`, 44100 Hz, 2 ch. Durations, byte
counts and the levels behind every `trimDb` are ffprobe/volumedetect
measurements of the shipped files, not of the request.

### Why the REST API and not the MCP

The ElevenLabs MCP was checked in this session before falling back. It exposes
sound effects through `creative_generate_in_flow` with `node_type: 'sfx'`, which
builds variation sets on a shared editing canvas and returns node and session
ids; it has no endpoint that returns a single file. That is the wrong shape for
twenty-one deterministic renders that must land at fixed paths with recorded
parameters, and it is the same conclusion `tools/generate-combat-sfx.mjs`
reached, so matching it keeps the provenance uniform across the whole manifest.

### The probe

One 3 s looping siren was rendered first and measured before any batch:
3.000 s, 48,945 B, -0.5 dBFS peak, -9.7 dBFS mean. It confirmed the model, the
parameters and the level, and cost 10 credits. It was deleted rather than
shipped.

### Police

| Asset | Path | Duration | Size | Credits | Trim | Prompt |
| --- | --- | --- | --- | --- | --- | --- |
| `police/siren` | `/audio/police/siren.mp3` | 8.000 s | 129,193 B | 26.67 | -20.4 dB | seamless looping police car siren, a single electronic siren speaker sweeping up and down in a steady continuous wail cycle at a constant close distance, no engine, no tyres, no traffic, no doppler, no approach and no departure, absolutely even and continuous, no music, no speech, no other sound |
| `police/engine` | `/audio/police/engine.mp3` | 8.000 s | 129,193 B | 26.67 | -25.3 dB | seamless looping large V8 police interceptor engine held at high revs under hard acceleration, a hard aggressive exhaust drone with an urgent edge to it, steady pitch with no gear change and no rise or fall, no siren, no tyres, absolutely even and continuous, no music, no speech, no other sound |

Two assets and not one, because a parked patrol car is an engine with no siren
and a unit that has just lost the player is a siren with no engine near enough
to hear. `src/audio/PoliceAudio.ts` drives both per unit and shares one panner
between them, since they are one object in space.

**Subtotal: 53.33 credits (USD 1.07).**

### Aircraft and the airfield

| Asset | Path | Duration | Size | Credits | Trim | Prompt |
| --- | --- | --- | --- | --- | --- | --- |
| `air/prop-single` | `/audio/air/prop-single.mp3` | 8.000 s | 129,193 B | 26.67 | -24.1 dB | seamless looping single-engine light aircraft propeller, a small four-cylinder piston aero engine turning a two-blade propeller at steady cruise power, a hard regular blade chop over a rough mechanical engine beat, constant speed with no rise or fall, no wind, no radio |
| `air/turboprop` | `/audio/air/turboprop.mp3` | 8.000 s | 129,193 B | 26.67 | -22.5 dB | seamless looping twin turboprop commuter aircraft engines at steady cruise power, two large multi-blade propellers beating slightly out of phase with a smooth turbine whine behind them, constant speed with no rise or fall, no wind, no radio |
| `air/turbofan` | `/audio/air/turbofan.mp3` | 8.000 s | 129,193 B | 26.67 | -22.1 dB | seamless looping small business jet turbofan engines at steady cruise thrust, a smooth high tonal fan whine over a broad jet efflux roar, no propeller and no blade beat, constant thrust with no spool up or down, no wind, no radio |
| `air/airliner` | `/audio/air/airliner.mp3` | 8.000 s | 129,193 B | 26.67 | -21.3 dB | seamless looping large narrowbody airliner turbofan engines at steady high thrust heard from outside the aircraft, an enormous deep jet roar with a heavy low rumble and a distant fan tone in it, constant thrust with no spool up or down, no wind, no radio |
| `air/wind` | `/audio/air/wind.mp3` | 10.000 s | 160,958 B | 33.33 | -21.5 dB | seamless looping smooth rushing airflow over an aircraft airframe in flight, a broad even wind roar with no gusting and no whistling, no engine, no propeller, no turbine |
| `air/runway-roll` | `/audio/air/runway-roll.mp3` | 7.000 s | 112,893 B | 26.67 | -19.2 dB | seamless looping aircraft main landing gear tyres rolling fast along a concrete runway, a heavy continuous rumble with regular thumps as the wheels cross the expansion joints, no engine, no wind, no brakes |
| `air/touchdown` | `/audio/air/touchdown.mp3` | 1.200 s | 20,106 B | 4.00 | -3.2 dB | an aircraft main landing gear touching down on a runway, a sharp rubber chirp as the tyres spin up with a puff of smoke and a heavy suspension thump straight after it, one touchdown only |
| `air/brake` | `/audio/air/brake.mp3` | 1.760 s | 29,301 B | 6.00 | -5.7 dB | an airliner slowing hard on the runway after landing, heavy wheel brakes grinding and rumbling with a rising roar of reverse thrust over them, decaying away as the aircraft slows, no engine idle |
| `ambience/airport` | `/audio/ambience/airport.mp3` | 15.000 s | 241,206 B | 50.00 | +3.8 dB | seamless looping airport ambience heard on the apron outside a terminal building, a steady low rumble of distant jet engines idling far across the field, ground power units and air conditioning plant humming nearby, a very distant aircraft taking off at the far end of the runway, faint wind over open concrete, no announcements, no speech, no music, no vehicles close by |

Four powerplant loops rather than one pitched four ways: a piston single, a
turboprop, a business jet and a narrowbody are four different machines and a
playback rate cannot fake the difference between them. Everything else is shared
across the types, because airflow over an airframe and rubber on concrete do not
care what is pulling the aeroplane along. Take-off is the rpm and throttle
response rather than an asset of its own, and braking is derived inside
`src/audio/AircraftAudio.ts` from two consecutive airspeed samples rather than
needing a fourth callback from the flight model.

`ambience/airport` also replaces the placeholder in `DISTRICT_AMBIENCE`, where
the `airport` district was pointed at the generic street bed.

**Subtotal: 226.68 credits (USD 4.53).**

#### Loop seams

Every looping render was seam-checked by comparing the mean level of its first
and last 150 ms, since a loop that fades or pads clicks at the wrap. Anything
over 3 dB was repaired rather than shipped.

| Asset | Seam delta | Action |
| --- | --- | --- |
| `police/siren` | 0.6 dB | none |
| `police/engine` | 0.3 dB | none |
| `air/prop-single` | 2.9 dB | none |
| `air/turboprop` | 0.6 dB | none |
| `air/turbofan` | 2.1 dB | none |
| `air/airliner` | 1.3 dB | none |
| `air/wind` | 2.3 dB | none |
| `air/runway-roll` | **5.7 dB** | rebuilt as a 7 s crossfade loop; 2.7 dB after |
| `ambience/airport` | 2.4 dB | none |

The exact `ffmpeg` command for `air/runway-roll` is in the runtime manifest's
`postProcess` field. It is the same treatment the music track needed.

#### Lazy loading, deliberately

The eight aircraft assets and the apron bed are 1.08 MB, and the airfield is one
corner of the map most sessions never visit, so they are the only non-music
entries in `LAZY_ASSET_IDS` and are excluded from `PRELOAD_ASSET_IDS`. Every
consumer already survives a null buffer for a frame — `AircraftAudio` requests
and stays silent exactly as the sea bed does — so the cost is one quiet frame on
first approach rather than a slower unlock for every player.
`AircraftAudio.preload()` exists for a caller that wants to hide even that.

The police siren is deliberately NOT deferred, which is why the deferral is a
declared set rather than a rule about `kind`: a pursuit starts without warning,
and a siren that arrives a second late has stopped being a warning.

`tests/audio.test.ts` used to assert `PRELOAD.length === ASSETS.length - 1`.
It now asserts against `LAZY_ASSET_IDS` itself and separately pins exactly which
assets are in it, so deferring a tenth asset cannot silently change what is
fetched without saying so in the manifest.

### Collisions

| Asset | Path | Duration | Size | Credits | Trim | Prompt |
| --- | --- | --- | --- | --- | --- | --- |
| `veh/impact-light` | `/audio/veh/impact-light.mp3` | 1.000 s | 17,180 B | 3.33 | -2.9 dB | a car nudging something at walking pace, one dull soft plastic bumper knock with a faint creak of trim afterwards, quiet and unimpressive, no glass, no alarm |
| `veh/impact-heavy` | `/audio/veh/impact-heavy.mp3` | 2.000 s | 33,062 B | 6.67 | -6.0 dB | a violent high speed car crash, an enormous crunch of sheet metal folding and tearing with a deep structural boom through it, debris and trim clattering onto the road afterwards, no alarm |
| `imp/wood` | `/audio/imp/wood.mp3` | 0.680 s | 12,164 B | 4.67 (2 renders) | -6.0 dB | a rifle bullet slamming into a thick timber plank at full volume, one loud hard dry woody crack with splinters tearing off and a short hollow ring afterwards, recorded very close |
| `imp/foliage` | `/audio/imp/foliage.mp3` | 0.680 s | 12,164 B | 2.33 | +1.5 dB | a bullet tearing through dense leafy foliage, a sharp burst of leaves and thin twigs snapping and shaking, soft and papery with no hard surface hit |

Vehicle collisions used to be one asset scaled 0.5 to 1.0 by severity, unpanned
and unpitched: a 6 dB range on a single recording, which reads as one event heard
from two distances rather than as two different events. `intensity` now picks the
recording as well as the level, the bands overlap so crossing a boundary changes
the recording at the quietest point of the one being left, hitting scenery is a
playback-rate step below hitting another car, and a hit above 0.72 brings glass
down with it as a summed layer rather than as a fourth recording.

Bullet impacts already varied by material but had no intensity variation at all.
`CombatAudio.impact` now takes an optional `intensity` (defaulting to 1, so no
existing call site changes) and a weak hit is 8 dB down and 8 per cent sharp
against a full-energy one. `impactSoundFor` resolves a kind, including the
`stone`, `concrete`, `timber`, `wood` and `foliage` kinds the combat layer is
adding, and falls back to concrete for a material nobody has recorded — a round
has to make a noise, and a silent impact reads as broken ballistics rather than
as a missing asset.

**Subtotal: 17.00 credits (USD 0.34).** `imp/wood` was re-rendered: the first
came back at -38.8 dBFS peak, far past the trim's +10 dB cap.

### Batch total

| Group | Credits |
| --- | --- |
| Probe | 10.00 |
| Footsteps (6 new + 4 retries) | 16.67 |
| Police | 53.33 |
| Aircraft and the airfield | 226.68 |
| Collisions | 17.00 |
| **Total** | **323.67 credits (USD 6.47)** |

## Verified in the browser, 2026-08-28

Production build (`vite build`), served by the running preview on port 4183,
driven through `window.__meridian` and read back from `window.__meridianAudio`.
Eight footfalls were walked at each location with real time between bursts, so
the three-voice cap did not swallow them.

| Walked on | `position.surface` | Footstep family heard | Asset |
| --- | --- | --- | --- |
| harbour carriageway (-158, 12) | `asphalt` | asphalt x6 | `steps/asphalt-1` |
| Harbour Walk (-151, 18) | `boardwalk` | boardwalk x5 | `steps/boardwalk-1` |
| terminal concourse (180, 450) | `concrete`, indoors | **terminal x4** | `steps/terminal-2` |
| apron (240, 450) | `concrete` | **concrete x6** | `steps/concrete-1` |
| runway centreline (340, 450) | `concrete` | **concrete x5** | `steps/concrete-2` |
| airfield verge (300, 450) | `grass` | grass x5 | `steps/grass-1` |
| city pavement (-126, 12) | `pavement` | pavement x4 | `steps/pavement-2` |

No family ever bled into another, and `interior` never fired outdoors. The three
bold rows are the ones that were wrong before: the concourse played domestic
kitchen tile and the whole airfield played a city paving slab.

Walking west off Harbour Walk onto the carriageway and back, one footfall per
reading:

```
boardwalk boardwalk boardwalk | boardwalk asphalt asphalt asphalt asphalt
asphalt asphalt asphalt | boardwalk boardwalk boardwalk boardwalk
```

One footfall of the old material at the crossing, none after it, and no flicker
in either direction.

Vehicle classes, read from the network log while driving three different shells:

| Driven | `driving.kind` | Fetched |
| --- | --- | --- |
| pickup | `pickup` | `engine-diesel-idle`, `engine-diesel-load`, `tyre-roll` |
| hatchback | `compact` | `engine-small-idle`, `engine-small-load` |
| coupe | `coupe` | `engine-sport-idle`, `engine-sport-load` |

Nothing else was fetched: the truck and interceptor pairs stayed on disk, which
is the deferral working. All 86 audio requests in the session succeeded at
exactly the byte sizes this manifest records. No audio-related console error.

## Vehicle classes, 2026-08-28

Thirteen clips so that a hatchback, a coupe, a van, a box truck and a police
interceptor are five different engines rather than one engine at five playback
rates, plus the Foley the driving mix had no asset for at all. Rendered by
[`tools/generate-vehicle-sfx.mjs`](../tools/generate-vehicle-sfx.mjs), which is
the runnable form of every prompt and parameter below. All
`eleven_text_to_sound_v2`, `mp3_44100_128`, 44100 Hz, 2 ch. Every number is an
ffprobe/volumedetect measurement of the shipped file.

### Why the REST API and not an MCP

Checked in this session, not assumed from the last one. There is **no
`elevenlabs` MCP server configured here** - `.mcp.json` declares only `tripo` -
and the ElevenCreative server that IS reachable exposes sound effects only
through `creative_generate_in_flow` with `node_type: 'sfx'`, which builds
variation sets on a shared editing canvas and returns node and session ids
rather than a file at a fixed path. That is the wrong shape for thirteen
deterministic renders that must land at fixed paths with recorded parameters,
and it is the same boundary the 2026-08-27 batch recorded.

### The probe

One 4 s looping truck idle was rendered first and measured before any batch:
4.000 s, 65,245 B, 44100 Hz, 2 ch, -1.7 dBFS peak, -14.0 dBFS mean, 2.1 dB seam,
no leading or trailing silence. 13.33 credits. It was deleted rather than
shipped.

### The engine layers

All ten: 6.000 s, 97,010 B, `duration_seconds: 6, prompt_influence: 0.6,
loop: true`, 20 credits each.

| Asset | Peak | Mean | Trim | Post-trim mean | Post-trim peak | Seam |
| --- | --- | --- | --- | --- | --- | --- |
| `veh/engine-small-idle` | -10.2 dB | -28.1 dB | +6.9 dB | -21.2 dB | -3.3 dB | 1.2 dB |
| `veh/engine-small-load` | -0.2 dB | -13.4 dB | -4.8 dB | -18.2 dB | -5.0 dB | 1.7 dB |
| `veh/engine-sport-idle` | -2.6 dB | -16.4 dB | -4.8 dB | -21.2 dB | -7.4 dB | 0.6 dB |
| `veh/engine-sport-load` | -0.5 dB | -16.3 dB | -1.9 dB | -18.2 dB | -2.4 dB | 0.0 dB |
| `veh/engine-diesel-idle` | -3.7 dB | -17.9 dB | -3.3 dB | -21.2 dB | -7.0 dB | 1.3 dB |
| `veh/engine-diesel-load` | 0.0 dB | -12.9 dB | -5.3 dB | -18.2 dB | -5.3 dB | 0.8 dB |
| `veh/engine-truck-idle` | -4.5 dB | -16.5 dB | -4.7 dB | -21.2 dB | -9.2 dB | 0.2 dB |
| `veh/engine-truck-load` | -1.4 dB | -15.3 dB | -2.9 dB | -18.2 dB | -4.3 dB | 1.7 dB |
| `veh/engine-v8-idle` | -2.5 dB | -17.2 dB | -4.0 dB | -21.2 dB | -6.5 dB | 2.8 dB |
| `veh/engine-v8-load` | 0.0 dB | -10.4 dB | -7.8 dB | -18.2 dB | -7.8 dB | 0.5 dB |

The three renders at 0.0 dBFS were checked for real clipping with
`astats`: `Flat factor 0`, `Peak count 2` on each, i.e. two isolated samples at
the peak and no flat-topped plateau. That is MP3 decode overshoot, and the trim
takes all three to -5.3 dBFS or below.

**Levelled by loudness, not by peak.** Every `-idle` layer is brought to
-21.2 dBFS mean and every `-load` layer to -18.2 dBFS, which is exactly where the
shipped saloon pair sits (`veh/engine-idle` measures -21.0 at -0.2 dB trim,
`veh/engine-load` -14.3 at -3.9 dB). Peak-normalising instead - which is what the
one-shots get - put the coupe's idle 4.8 dB over the saloon's purely because that
render came back hotter, and the class difference is supposed to come from
`engineCurve.ts`. Same lesson the footstep set learned, applied to loops. A
-1.5 dBFS peak guard sits under the loudness target so a transient is never
pushed into clipping to hit it.

### The Foley

| Asset | Duration | Size | Credits | Peak | Mean | Trim | Seam |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `veh/tyre-roll` | 6.000 s | 97,010 B | 20.00 | -1.5 dB | -17.3 dB | -6.7 dB | 3.5 dB |
| `veh/gear-shift` | 0.680249 s | 12,164 B | 2.33 | -1.9 dB | -20.8 dB | -4.1 dB | n/a |
| `veh/brake-squeal` | 1.200 s | 20,106 B | 4.00 | -5.0 dB | -21.4 dB | -1.0 dB | n/a |

`veh/tyre-roll` is mean-normalised to -24 dBFS, six under the load layers,
because it is a bed under the engine rather than a voice beside it. Its 3.5 dB
seam is the worst in the batch; it sits at -8.2 dBFS post-trim under a
continuously sounding engine, where a 3.5 dB step at the wrap is inaudible, so
it was shipped rather than rebuilt. Every other loop is inside 3 dB.

No asset has any leading or trailing silence (`silencedetect` at -50 dBFS over
50 ms found none on any of the thirteen).

### Two re-renders, and why

Band split, measured as the share of total power in each band with
`ffmpeg -af lowpass/highpass,volumedetect`, is what caught them.

- **`veh/engine-small-load`** came back **1.8 % below 200 Hz and 78.1 % above
  1.5 kHz** - an induction hiss with no engine under it. The rewritten prompt
  names the exhaust, the firing pulses and the four-cylinder thrum and rules out
  the whistle; the shipped render is 52.9 / 37.5 / 9.6 %.
- **`veh/engine-sport-idle`** came back 82.2 % below 200 Hz and 0.2 % above
  1.5 kHz - a low drone, indistinguishable in band terms from the truck idle.
  The rewrite asked for the valvetrain and the rasp and moved it to
  80.4 / 18.8 / 0.8 %, which is **still bass-dominant**. It was accepted rather
  than chased further: the separation at idle is carried by the filter corner
  (900 Hz for the coupe against 380 Hz for the truck) and the playback rate, and
  the coupe is unmistakable the moment it is on load (14.7 / 64.1 / 21.2 %). The
  full table for all thirteen is in `src/audio/manifest.ts`.

### Cost and weight

| Group | Credits |
| --- | --- |
| Probe | 13.33 |
| Ten engine layers | 200.00 |
| Foley (tyre roll, upshift, brake squeal) | 26.33 |
| Two re-renders | 40.00 |
| **Total** | **279.66 credits (USD 5.59)** |

**Added weight: 1,099,380 bytes (1.048 MiB).** Eleven of the thirteen are
deferred - the ten class layers and the tyre bed, 1.07 MB - and are requested on
the frame the player takes control of a car. The saloon pair stays eager because
it is the fallback voice while a class's own layers are still in flight.

### How the mix uses them

`src/audio/engineCurve.ts` carries an `EngineProfile` per voice, and two of its
fields do most of the identity work:

| Voice | Gears top out at (m/s) | Idle cutoff | Weight | Kinds |
| --- | --- | --- | --- | --- |
| `small` | 6, 11, 18, 27 | 760 Hz | 0.82 | compact |
| `saloon` | 7, 13, 21, 32 | 700 Hz | 1.00 | sedan, wagon, crossover, taxi |
| `sport` | 10, 18, 28, 40, 52 | 900 Hz | 1.06 | coupe |
| `diesel` | 6, 11, 17, 25, 33 | 480 Hz | 1.04 | van, pickup |
| `truck` | 4, 7, 10.5, 15, 20, 26 | 380 Hz | 1.18 | boxTruck |
| `interceptor` | 9, 17, 27, 38 | 640 Hz | 1.12 | patrolSedan, patrolSuv |

A truck runs out of gear at 4 m/s and shifts six times before a coupe has left
first, which is most of what makes the two audibly different things under
acceleration. `tests/vehicleAudio.test.ts` pins the mapping against the
catalogue itself, so a body shell added to `VehicleCatalogue.ts` without a voice
fails the suite rather than silently becoming a saloon.

Three things were added to the graph beside the class swap:

- **The tyre layer** sums AFTER the engine's lowpass, not through it: the filter
  is the throttle's colour, and routing the tyres through it would duck them
  every time the driver lifted off. It tracks road speed rather than revs, so it
  holds steady across an upshift while the engine note drops - which is the
  whole reason it is a separate layer.
- **The upshift** fires `veh/gear-shift` on the rising edge of the gear number,
  under power and above walking pace, and dips the level 32 % and the filter
  40 % for 0.2 s. A car rolling to a stop drops through every gear it owns and
  must not clunk on the way down.
- **Brake pad squeal** covers ordinary stopping, which had no sound at all: the
  layer's only braking asset was an emergency skid, so everything short of one
  was silent. It is gated on rolling to a stop (under 5.5 m/s, over 1.6 m/s²)
  and is mutually exclusive with the skid.

**Ambient traffic keeps one recording and gets its class from a filter.** The
pool is five sources and an `AudioBufferSourceNode` cannot change its buffer, so
each voice now owns a lowpass whose corner comes from the class and a playback
rate scaled by it. That is 5 nodes, and it is the only thing separating a box
truck from a hatchback across a junction.

## The node budget, measured

`tests/streetAudio.test.ts` asserts `stats.liveNodes <= 72` for the street layer
over a 3600-frame busy run, and the comment there records a regression where 420
nodes existed when only rate limiters were in place. **The ceiling moved from 65
to 72 on 2026-08-28**, for seven persistent nodes that each buy something: the
tyre layer (1 source, 1 gain) and one class filter per ambient voice (5). The
measured peak over that run, with every catalogue class in the fleet and the
deferred layers resident, is **58**. The two new layers hold their own pools and report their own
`stats.liveNodes`, each asserted in `tests/policeAudio.test.ts`.

Measured over 3600 frames with all four layers running at once — 40 cars (four
of them police units), 30 pedestrians, six pursuit units churning in and out of
earshot, eight aircraft of four types, plus touchdowns and heavy collisions
landing on top:

| Layer | Peak live nodes | Ceiling |
| --- | --- | --- |
| `StreetAudio` | 58 | 72 (was 65 before the vehicle batch) |
| `PoliceAudio` | 12 | 12 = 2 units x 6 |
| `AircraftAudio` | 29 | 29 = 20 persistent + 3 one-shots x 3 |
| **Combined** | **98** | **106** |

Every layer returns to exactly 0 on `dispose`, which is the leak check. On top of
this the director itself holds a fixed graph: a master gain, the limiter, five
buses, up to two land beds and the sea layer.

The police layer is capped at two units on purpose. A pursuit is one or two cars
on you and the rest converging from streets away; a third siren adds level and
no information, and six nodes each is not free against a graph the street layer
already holds 30 persistent nodes in.

## The output limiter

There was no compressor or limiter anywhere in the graph before this batch
(verified: zero `createDynamicsCompressor` in `src/`), and the buses are trimmed
for the average case. A burst of gunfire, an explosion and its debris, five
engines and a siren can all land inside the same 50 ms with every individual
voice being correct, and the sum clipped at the sound card.

`AudioDirector` now puts a `DynamicsCompressorNode` between the master gain and
the destination: -3 dBFS threshold, 20:1 ratio, 8 dB knee, 3 ms attack, 250 ms
release. It is a guard rail rather than a mix stage — it does nothing until the
sum is already within 7 dB of full scale, and the release is long enough that it
cannot pump the ambience beds. The footstep cut, the loudness normalisation and
the per-layer voice budgets are what actually keep the level right; this only
catches the sum.

## Pausing

`AudioDirector.setGamePaused(boolean)` and the `visibilitychange` handler are two
independent named HOLDS on the same context-level suspend, not a counter.
Pausing, tabbing away and tabbing back leaves a paused game silent, and a counter
gets that wrong the moment either source fires twice in a row — which
`visibilitychange` does, since it fires on every focus change rather than only on
the transitions the game asked about. Named booleans are idempotent by
construction.

It goes through `ctx.suspend()` rather than the music switch, because the music
contract says suspend and resume must never touch music STATE: suspending
freezes the whole graph including a playing track's position, so resuming
continues it from where it was, and a stopped track stays stopped because nothing
in that path starts one.

`ctx.suspend()` also freezes `ctx.currentTime`, so every `ramp()` in
`AudioDirector`, `PoliceAudio` and `AircraftAudio` assigns the value outright
while the context is suspended instead of scheduling a zero-length ramp against a
frozen clock. The frame loop is gated while paused, but none of these layers
depends on that being true to stay correct.
