# The story, the cast, and "Last Call"

The city came first. `CityPlan` has generated Meridian Bay from a seed since
the beginning and knows nothing about people; this workstream added the other
half — a name for the game, a name for the person holding the controller, three
people worth meeting, a nightclub to meet them in, and one job to do.

This file is the reproducibility record for all of it: what was written, what
was generated, what it cost, and what was measured on the shipped files.

**No API key, signed URL, or other secret appears in this file, in any tool in
`tools/`, in any committed asset, or in the browser bundle.** Every generator
reads its key from the environment or from the untracked `.env` and never
prints it. `tests/audio.test.ts` asserts the manifest carries no secret.

## Where it lives in the code

| Thing | File |
| --- | --- |
| Game name, city name, premise, cast | [`src/story.ts`](../src/story.ts) |
| The mission as data — stages, objectives, lines, fee | [`src/mission/script.ts`](../src/mission/script.ts) |
| The state machine that plays it | [`src/mission/Mission.ts`](../src/mission/Mission.ts) |
| Subtitles and voice playback | [`src/mission/Dialogue.ts`](../src/mission/Dialogue.ts) |
| Sable, Teo and the shop's clerk, standing still | [`src/agents/StandingCharacter.ts`](../src/agents/StandingCharacter.ts) |
| The club interior | [`src/world/build/interiorProps.ts`](../src/world/build/interiorProps.ts) |
| Played start to finish with no browser | [`tests/mission.test.ts`](../tests/mission.test.ts) |

`src/story.ts` is one file of plain data with no Three.js, no DOM and no import
from the simulation, so the loading screen, the pause menu, the mission and the
tests all read the same names instead of each spelling them out.

**Everything here is invented.** Meridian Bay, its districts, its businesses and
its people are original to this project; none of them refers to a real place,
company or person, and neither voice is a clone of one.

## The story

> **GTA Vibe.** Meridian Bay is a working coastal city: a container harbour, a
> close-grained old quarter, a small downtown, and terraced streets climbing the
> ridge behind it. The money comes off the water, and it belongs to whoever
> holds the lock-ups it passes through on the way inland.
>
> You are **Marlo Vance**. You have been away eight years, you own a car you did
> not pay for, and everybody you used to know is either running something now or
> working for somebody who is. Sable Ruiz has a job. It is not a favour.

The player has no avatar and is never drawn, but is named everywhere else.

### The cast

| Who | Role | Stands in | Seen |
| --- | --- | --- | --- |
| **Sable Ruiz** | Owner, The Vibe | `ped-sable` (generated for her) | Behind the bar in the nightclub, Harbourside |
| **Teodor Krall** | Watchman, Cannery lock-up | `ped-a` (crowd bake, reused) | Beside the crate in the lock-up, the Cannery |
| **Ilse Bellhouse** | Proprietor, Bellhouse Arms | `ped-c` (crowd bake, reused) | Behind the counter of the gun shop, Old Quarter |

Two of the three reuse a baked crowd character rather than getting their own: a
generated head costs credits and a two-megabyte download, and a shopkeeper
behind a counter is somebody the player looks at for about four seconds. Sable
is the exception, because the game is named after her club and the player is
sent to her twice.

## The mission: "Last Call"

Seven stages, three conversations, two interiors, one drive across two
districts, and $7,500 at the end.

```
offered  → see Sable at The Vibe              waypoint: the club
briefing → three lines from Sable             (she asks for the box)
collect  → the lock-up in the Cannery         waypoint: the lock-up
handover → two lines from Teo                 (he admits he talked)
deliver  → get the box back to The Vibe       waypoint: the club, two stars
payout   → two lines from Sable
complete → paid
```

Three decisions in there are deliberate and are pinned by tests:

- **The waypoint is a building, not a coordinate.** The city is generated from a
  seed, so the mission asks the plan where the club is rather than carrying a
  position that would be wrong the moment the seed changed.
- **The heat lands when Teo *admits* it, not when the box is lifted.** The
  player hears why they are suddenly wanted instead of being handed two stars by
  a room they are still standing in.
- **The fee is worth the drive but does not make the armoury free.** $7,500 buys
  the SMG and a magazine, and not much more. `tests/mission.test.ts` asserts it
  stays between $2,000 and one starting wallet.

Measured on the real plan: the club (parcel-58, Harbourside) and the lock-up
(parcel-106, the Cannery) are **110 m apart** in a straight line and further by
road. The test's lower bound is 90 m, so a future change that puts the lock-up
next door to the club fails rather than quietly turning the mission into a walk.

### The nightclub had to be added last

`ENTERABLE_TARGETS` in [`src/world/CityPlan.ts`](../src/world/CityPlan.ts) is
consumed by one shared RNG stream, one `rng.pick` per target. Inserting the
nightclub anywhere but the END of that list moved every building chosen after it
— the first attempt relocated the gun shop to another district and pushed an Old
Quarter interior within earshot of the sea. The target is appended, and the file
says why.

## Voices

Seven lines, 38.55 s of audio, 608 characters billed.

- Provider: **ElevenLabs**, `POST /v1/text-to-speech/{voiceId}`.
- Model: `eleven_multilingual_v2`. Output format: `mp3_44100_128`.
- Generator: [`tools/generate-mission-voices.mjs`](../tools/generate-mission-voices.mjs)
  (`node tools/generate-mission-voices.mjs`; existing files are skipped, so a
  rerun is free).
- Runtime manifest: `DIALOGUE_SPECS` in
  [`src/audio/manifest.ts`](../src/audio/manifest.ts).

Voices were chosen from the account's own library (658 voices, listed with
`GET /v1/voices`) rather than assumed:

| Speaker | Voice | ID | Settings |
| --- | --- | --- | --- |
| Sable | Lily — Velvety Actress | `pFZP5JQG7iQjIQuC4Bku` | stability 0.42, similarity 0.85, style 0.25, speaker boost |
| Teo | Callum — Husky Trickster | `N2lVS1w4EtoT3dr4eOWO` | stability 0.30, similarity 0.85, style 0.45, speaker boost |

Sable is steadier than Teo on purpose: she is in charge of the room and he is
not.

### What shipped

Measured with `ffprobe` and `ffmpeg -af volumedetect` on the committed files,
not copied from the generation request. All seven are mono 44.1 kHz MP3s at
~129 kbps with distinct MD5 sums.

| File | Speaker | Duration | Bytes | Mean | Peak |
| --- | --- | --- | --- | --- | --- |
| `sable-brief-1.mp3` | Sable | 5.20 s | 84,471 | −24.7 dB | −7.6 dB |
| `sable-brief-2.mp3` | Sable | 9.85 s | 158,450 | −22.4 dB | −6.9 dB |
| `sable-brief-3.mp3` | Sable | 4.60 s | 74,440 | −23.6 dB | −4.6 dB |
| `teo-handover-1.mp3` | Teo | 6.59 s | 106,623 | −24.3 dB | −4.5 dB |
| `teo-handover-2.mp3` | Teo | 5.34 s | 86,561 | −21.4 dB | −1.8 dB |
| `sable-paid-1.mp3` | Sable | 3.90 s | 63,573 | −23.8 dB | −7.6 dB |
| `sable-paid-2.mp3` | Sable | 3.07 s | 50,199 | −21.5 dB | −2.9 dB |

**Total: 38.55 s, 610 KiB.**

Playback goes through the effects bus **unpanned**. A voice at a fixed world
position would swing across the stereo field every time the player turned their
head at the bar, which reads as a fault rather than as a person talking.
`Dialogue` is driven by `dt` rather than by a clock, so a conversation is
deterministic and steppable — which is what lets the whole job run in a unit
test.

## Generated 3D assets

Tripo CLI, model version `P1-20260311`, PBR on, `texture_alignment: geometry`.
All five props were converted to GLTF at `texture_size=1024` and arrive
normalised into a unit box with a centre pivot; `Furnishings` measures each one
and rescales it to the real metres in `FURNISHING_SPECS`, so the transform in
the file is never trusted.

| Asset | Task | Face limit | Credits | Shipped |
| --- | --- | --- | --- | --- |
| Club bar counter | `eda7e3a9-bd0d-4f05-bdc5-3d438c1171b4` | 1400 | 40 | `public/models/club/bar.glb`, 586 KiB |
| Club booth | `eba71c4d-4025-4d61-8e1f-828e4087dd1e` | 1400 | 40 | `public/models/club/booth.glb`, 388 KiB |
| DJ booth | `4bec5aab-30e0-429f-971c-3751d8507da1` | 1400 | 40 | `public/models/club/dj-booth.glb`, 516 KiB |
| PA speaker stack | `02795cfa-3097-4a17-a1e5-342aead7161e` | 1000 | 40 | `public/models/club/speaker.glb`, 479 KiB |
| Steel cash box | `f2ed8a5d-4c46-48fc-bbf5-cb0c38ca301a` | 1000 | 40 | `public/models/club/cash-box.glb`, 481 KiB |

Every prompt ends with the same clause the rest of the project uses — *clean
readable silhouette, single fused mesh, PBR materials, neutral studio lighting,
no stand, no base, no text* — because a generator that is not told to omit
lettering produces unreadable pseudo-text, and a base turns a bar counter into
an ornament on a plinth.

### Sable

One character, generated and animated the same way the crowd was.

| Task | Type | Credits |
| --- | --- | --- |
| `b6a93347-592d-43e6-b11f-cd5e9949b03d` | `text_to_model` (face limit 3000) | 20 |
| `74f538cb-1309-4df1-b56b-7c2c546783f2` | `animate_rig` | 25 |
| `120831dc-6a9a-4fe7-83f5-61029e1a3c56` | `animate_retarget` — idle | 10 |
| `c90ad9a9-6b00-49ad-95aa-13ddd68965c0` | `animate_retarget` — walk | 10 |

Prompted in a strict T-pose with nothing in her hands, which is what the rigger
needs. Baked to a vertex animation texture like every other pedestrian:
`public/models/pedestrians/ped-sable.{json,bin,jpg}`, 2,250 vertices, a 70×2,250
texture, two clips (walk 48 frames, idle 20 frames), 1.9 MB total.

She only ever stands still behind her bar, so only the idle clip is played — but
both were retargeted, because a character that cannot walk is a character that
cannot be reused, and the walk bake is what the VAT's ground-lift and
recentring are calibrated against.

**Total Tripo cost for this workstream: 265 credits.**

## The club interior

A new `InteriorKind`, `'nightclub'`, with its own palette (dark metal and
concrete), a 3.9 m ceiling, and magenta emissive strips instead of lights.

Emissive geometry rather than point lights is not a stylistic choice: point
lights were measured at 61% of frame cost earlier in the project, and a club lit
by six of them would have cost more than the rest of the city put together. The
neon runs at `CLUB_NEON_Y = 2.15`, the stage lip is a `CLUB_STAGE_HEIGHT = 0.34`
solid, and the DJ console standing on it is declared **non-solid** precisely
because it does not stand on the floor — the stage underneath it is already the
collider.

## Blocked: the loading-screen key art

[`tools/generate-key-art.mjs`](../tools/generate-key-art.mjs) renders a
1536×1024 painterly backdrop of the harbour at dusk with OpenAI `gpt-image-2`,
for the loading screen to sit a title over. It could not be run:

```
HTTP 429  billing_hard_limit_reached / credit_balance_exhausted
```

This is an account credit balance, not a code fault, and it was not retried.
The tool is committed and correct; `node tools/generate-key-art.mjs` will write
`public/art/key-art.jpg` once the account has credit.

The loading screen was made to not need it. `LoadingScreen.adoptKeyArt()` probes
for the file with an `Image` and adds a scrim only if it loads, so a missing
backdrop produces no 404 and no broken layout — the screen currently ships as
the title on black, which is what the screenshots show.

## Verified in the browser

Played end to end on the dev server at 780×480, with screenshots at each step:

1. Loading screen — "MERIDIAN BAY" over "GTA Vibe", tab title `GTA Vibe`.
2. Spawn on Harbour Walk with the objective card up: *SEE SABLE AT THE VIBE*,
   and a magenta waypoint diamond on the minimap distinct from the shop's pin.
3. Inside the club: neon, stage, DJ console, speaker stacks, and Sable behind
   the bar. Prompt: *Press E to speak to Sable*.
4. Briefing — three subtitled lines with her name above them; objective advances
   to *COLLECT THE TAKINGS* and the waypoint moves to the Cannery.
5. Drove a wagon south down Dock Street at 9.8 m/s with the pin tracking.
6. In the lock-up: Teo beside the bench, the cash box on it, *Press E to take
   the takings*. After taking it the box is **gone from the bench**.
7. Teo's confession ends → two stars, objective *GET THE BOX BACK TO THE VIBE*,
   and the crate now reads *The lock-up crate is padlocked*.
8. Back at the bar: *Press E to hand over the takings* → payout →
   **LAST CALL — PAID, $7,500 from Sable Ruiz**, wallet $25,000 → $32,500,
   stars cleared.

Gate at the time of writing: 563 tests pass, `tsc --noEmit` clean, ESLint 0
errors, production build succeeds.
