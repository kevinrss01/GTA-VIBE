# Audio asset manifest

Reproducibility record for every sound Meridian Bay ships, as required by
`AGENTS.md`. Every number below was measured on the shipped file with `ffprobe`
and `ffmpeg -af volumedetect`, not copied from the generation request.

- Provider: ElevenLabs, via the ElevenCreative MCP flow `5wd4nJrjlOEJWXqifsp0`.
- Generated: 2026-08-17.
- Runtime manifest: [`src/audio/manifest.ts`](../src/audio/manifest.ts) — the
  same data in typed form, which the engine and the tests both read.
- **Total charged: 1,386.34 credits (USD 27.73)** — 1,062.67 for the original
  manifest plus 323.67 for the 2026-08-27 pursuit/airfield batch. The airport
  dialogue is charged per character and is recorded with those lines.

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
| `steps/asphalt-1` | `/audio/steps/asphalt-1.mp3` | +7.3 dB | one single footstep on worn asphalt road surface, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/asphalt-2` | `/audio/steps/asphalt-2.mp3` | -3.4 dB | one single scuffing footstep on worn gritty asphalt road surface, walking pace, close dry recording, no reverb, no music, no other sound |
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

All sixteen ship at 0.320 s and 6,313 bytes. Six retries were needed to get the
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
| `steps/asphalt-1` | -34.6 dB | -32.0 dB | -31.9 dB | +7.3 dB | **-24.6 dB** |
| `steps/asphalt-2` | -21.4 dB | -27.4 dB | -18.6 dB | -3.4 dB | **-22.0 dB** |
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

### Hysteresis, and `onRoad`

`GroundSample.onRoad` has always been documented as existing "so the footstep
mixer can pick the right variant" and was read by nothing in audio. It is now
the authoritative carriageway signal: when it is true the step is asphalt
whatever the sampler returned, and when it flips the held surface is abandoned
immediately, because stepping off a kerb is a real transition.

Everything else is held for two consecutive footsteps before it is heard. A
player walking a boundary — the edge of a path, the lip of an apron — is given a
different material on alternate steps by a per-point sampler, and without the
hold that is heard as the ground flickering underfoot. The cost is at most one
step of the old material on a genuine crossing.

Separately, the player's own footsteps are capped at three voices in flight. The
0.32 s cut means two should never genuinely overlap, but a frame-rate collapse
or a debug time step can stack them and there is no per-source limiter.

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

## The node budget, measured

`tests/streetAudio.test.ts` asserts `stats.liveNodes <= 65` for the street layer
over a 3600-frame busy run, and the comment there records a regression where 420
nodes existed when only rate limiters were in place. **That number did not have
to move.** The two new layers hold their own pools and report their own
`stats.liveNodes`, each asserted in `tests/policeAudio.test.ts`.

Measured over 3600 frames with all four layers running at once — 40 cars (four
of them police units), 30 pedestrians, six pursuit units churning in and out of
earshot, eight aircraft of four types, plus touchdowns and heavy collisions
landing on top:

| Layer | Peak live nodes | Ceiling |
| --- | --- | --- |
| `StreetAudio` | 57 | 65 (unchanged) |
| `PoliceAudio` | 12 | 12 = 2 units x 6 |
| `AircraftAudio` | 29 | 29 = 20 persistent + 3 one-shots x 3 |
| **Combined** | **98** | **106** |

Every layer returns to exactly 0 on `dispose`, which is the leak check. On top of
this the director itself holds a fixed graph: a master gain, the limiter, five
buses, up to two land beds and the sea layer.

The police layer is capped at two units on purpose. A pursuit is one or two cars
on you and the rest converging from streets away; a third siren adds level and
no information, and six nodes each is not free against a graph the street layer
already holds 23 persistent nodes in.

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
