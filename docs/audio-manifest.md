# Audio asset manifest

Reproducibility record for every sound Meridian Bay ships, as required by
`AGENTS.md`. Every number below was measured on the shipped file with `ffprobe`
and `ffmpeg -af volumedetect`, not copied from the generation request.

- Provider: ElevenLabs, via the ElevenCreative MCP flow `5wd4nJrjlOEJWXqifsp0`.
- Generated: 2026-08-17.
- Runtime manifest: [`src/audio/manifest.ts`](../src/audio/manifest.ts) — the
  same data in typed form, which the engine and the tests both read.
- **Total charged: 1,062.67 credits (USD 21.25).**

No API key, signed URL or other secret appears in this file, in the runtime
manifest, or in any committed asset. `tests/audio.test.ts` asserts this.

## Validation

Every file was checked with:

```bash
ffprobe -v error -show_entries format=duration,bit_rate \
  -show_entries stream=sample_rate,channels -of default=noprint_wrappers=1 <file>
```

All 23 files are real MP3s at the requested durations, all with distinct MD5
sums (no silent duplicates), and none is silent — measured mean levels run from
-49.4 dBFS (the deliberately soft grass footstep) to -15.4 dBFS (the music).
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
| `steps/pavement-1` | `/audio/steps/pavement-1.mp3` | -5.7 dB | one single footstep on a dry concrete paving slab, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/pavement-2` | `/audio/steps/pavement-2.mp3` | -5.6 dB | one single footstep landing heel first on a dry concrete paving slab, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/asphalt-1` | `/audio/steps/asphalt-1.mp3` | +2.6 dB | one single footstep on worn asphalt road surface, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/asphalt-2` | `/audio/steps/asphalt-2.mp3` | -6.0 dB | one single scuffing footstep on worn gritty asphalt road surface, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/boardwalk-1` | `/audio/steps/boardwalk-1.mp3` | +4.0 dB | one single footstep on hollow wooden decking boards, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/boardwalk-2` | `/audio/steps/boardwalk-2.mp3` | -3.4 dB | one single footstep on a creaking hollow wooden boardwalk plank, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/gravel-1` | `/audio/steps/gravel-1.mp3` | -6.0 dB | one single footstep crunching on loose gravel, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/gravel-2` | `/audio/steps/gravel-2.mp3` | +2.8 dB | one single footstep shifting on loose gravel and small stones, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/grass-1` | `/audio/steps/grass-1.mp3` | +10.0 dB | one single footstep on soft grass and soil, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/grass-2` | `/audio/steps/grass-2.mp3` | +10.0 dB | one single muffled footstep pressing into damp grass and soft earth, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/interior-1` | `/audio/steps/interior-1.mp3` | +5.1 dB | one single footstep on a hard indoor tiled floor, walking pace, close dry recording, no reverb, no music, no other sound |
| `steps/interior-2` | `/audio/steps/interior-2.mp3` | -3.2 dB | one single hard-soled footstep tapping on a smooth indoor ceramic tile floor, walking pace, close dry recording, no reverb, no music, no other sound |

**Subtotal: 28 credits (USD 0.56).**

### Surface mapping

`SurfaceId` has nine members and all nine are covered without generating extra
clips. `plaza` reuses the pavement pair (a paved plaza reads as paving slabs),
`sand` reuses gravel (closest match for dry sand), and `water` is mapped to
gravel for completeness only — the player controller stops the player before
they can wade. `tests/audio.test.ts` parses `SurfaceId` straight out of
`src/world/CityGround.ts`, so adding a surface without a mapping fails the suite.

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
