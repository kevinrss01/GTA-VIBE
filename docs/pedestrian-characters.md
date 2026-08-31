# Pedestrian characters

The crowd is Tripo-generated, auto-rigged, motion-retargeted people, baked into
vertex animation textures so that 270 of them still cost one draw call each per
character rather than one per person.

Everything here is reproducible from the recorded task ids. No key is recorded,
in this file or anywhere else.

## Pipeline

```
tripo make "<prompt>"  --model tripo-v3.1 -p face_limit=3000 -p texture_quality=standard
tripo anim check   <generation task>                       # riggable? rig_type?
tripo anim rig     <generation task> --rig-type biped --spec tripo \
                   --out-format glb -p model_version=v1.0-20240301
python3 .agents/skills/threejs-3d-generator/scripts/threejs_3d_asset.py \
        validate-rig <rig>/model.glb --rig-type biped      # before spending on clips
tripo anim retarget <rig task> --out-format fbx --animation preset:biped:walk
tripo anim retarget <rig task> --out-format fbx --animation preset:biped:idle
node tools/bake-pedestrian-vat.mjs --id ped-x --min-period idle=1.6 \
     --rig  tripo-out/.../model.glb \
     --clip walk=tripo-out/.../model.fbx:48 \
     --clip idle=tripo-out/.../model.fbx:20
```

Why each of those flags, from `.agents/skills/threejs-3d-generator`:

- `--rig-type biped` routes to `v1.0-20240301`. The v2.x limb-chain rigger is
  measured at 0/16 on humanoids.
- `--spec tripo`, because only a `tripo`-spec rig accepts Tripo's own presets.
- v1.0 retargets must be FBX. Tripo's GLB bake of a v1.0 rig exports twist-bone
  transforms in the wrong space and the limbs collapse into the torso.
- ONE animation per retarget task on a v1.0 rig. Batching produces one armature
  per clip with name-colliding bones.
- `--animate-in-place` is never passed. It corrupts the bake; the bake tool
  removes the root motion itself.

## What was generated

Prompts all asked for a strict T-pose, arms horizontal, legs separated, no
props, complete head to feet, and the rendered preview was checked against that
before any rig credits were spent.

| character | who | generation | prerigcheck | rig | walk retarget | idle retarget |
| --- | --- | --- | --- | --- | --- | --- |
| `ped-a` | young man, grey t-shirt, jeans | `9900b71a-ced7-463e-ac23-8cb3a80f539f` | `851cf56f-af2d-4776-9055-c8371aecfe60` | `b3b8d8fc-333e-41c8-bf61-4b97bd4cf4e2` | `989ff727-c2d4-41f1-af71-7f90a9ba487d` | `e0164dd4-cc76-41e7-9c9c-e04afcdc63aa` |
| `ped-b` | young woman, navy jacket, auburn hair | `878eab0f-ab21-4b2e-8f99-993de4202b01` | `f3886ea7-f3e0-42c7-885c-000a558d928f` | `9b4df339-1de1-4e19-8d2f-8fc346405d5e` | `310045d9-c130-471d-9fe3-5c4479621881` | `d80040b2-9881-4466-823e-922899f1c279` |
| `ped-c` | middle-aged man, heavier build, green shirt | `cbecb735-a536-46a2-8054-b82f8b05e55a` | `28556232-4db3-4bc0-99af-c4cfd035fcb3` | `c58075d3-cc83-4be3-9138-3d7775de2b56` | `bd7937c6-7256-4d58-acff-0777cdbe71fe` | `d81808db-ad3b-4f1d-9613-3b4b1404e126` |
| `ped-d` | young woman, mustard hoodie, ponytail | `b516c865-bb55-43b8-975d-bd62be55a7b2` | `466d9e63-e70e-43b6-9a00-fc9b6476b125` | `0876c9cb-c14a-4ee0-8395-bc42a9483650` | `02286807-fe66-47fe-9292-b61eda234125` | `6eb88e95-9a71-43dd-8a10-498d2c4323c5` |

Every prerigcheck returned `riggable: true, rig_type: biped`, and every rig
passed `validate-rig` first time: "legacy anatomical skeleton, 16 paired L/R
bones".

### Spend

| task | count | credits each | total |
| --- | --- | --- | --- |
| `text_to_model` | 4 | 20 | 80 |
| `animate_prerigcheck` | 4 | 0 | 0 |
| `animate_rig` | 4 | 25 | 100 |
| `animate_retarget` | 8 | 10 | 80 |

Plus one investigation that did not change the outcome: `ped-c`'s walk was
measured sliding, so its model was rigged a second time
(`19c2a78d-f45a-40d0-9d3b-91efabe5e83f`, 25) and re-retargeted
(`2aa2df25-1cfa-4f21-b53d-8aa5e30a1a64`,
`ea1673c8-473a-4c58-8b96-647ee5f481e1`, 10 each). The second rig produced
bit-identical results: the retarget is deterministic given a model, so the
slide is the preset meeting that character's proportions, not a bad rig roll.
That is 45 credits of negative result, recorded so nobody repeats it. `ped-d`
was then generated as a fourth character rather than as a replacement, because
it measured better than `ped-c` and four faces beat three.

Total: **305 credits** for this work. The shared account went 1125 -> 320 over
the same period; the difference is a concurrent vehicle workstream on the same
key, so the balance is not this change's ledger - the task ids above are.

## Runtime files

`public/models/pedestrians/<id>.{json,bin,jpg}` — written by
`tools/bake-pedestrian-vat.mjs`, loaded by `src/agents/PedestrianVat.ts`.

- `.json` — vertex/index counts, texture size, and the clip table. Each clip
  records its first column, frame count, loop duration, travel per cycle, and
  the CUMULATIVE TRAVEL CURVE the runtime inverts.
- `.bin` — uv, indices, the position VAT (RGBA half float) and the normal VAT
  (RGBA8), in that order, at the byte offsets `layout` gives.
- `.jpg` — the base-colour texture, lifted out of the rig GLB and downscaled to
  512 px with `sips`. Note the rig GLB's `images[0]` is the NORMAL map; the
  tool follows `materials[0].pbrMetallicRoughness.baseColorTexture` instead.

| id | source verts | welded verts | triangles | VAT texture | .bin | .jpg |
| --- | --- | --- | --- | --- | --- | --- |
| `ped-a` | 8856 | 2197 | 2952 | 70 x 2197 | 1.84 MB | 57 KB |
| `ped-b` | 8586 | 2137 | 2862 | 70 x 2137 | 1.79 MB | 50 KB |
| `ped-c` | 8532 | 2029 | 2844 | 70 x 2029 | 1.70 MB | 43 KB |
| `ped-d` | 8970 | 2209 | 2990 | 70 x 2209 | 1.85 MB | 65 KB |

Welding matters: Tripo's FBX arrives fully split, three unique vertices per
triangle, and the VAT costs one texture row per vertex.

## Measured properties of the bake

Everything below is in rig units where the body is 1.0 tall; the millimetre
figures are for a 1.75 m person.

| id | walk loop | travel per loop | rest height | feet at | worst walk float |
| --- | --- | --- | --- | --- | --- |
| `ped-a` | 2.333 s (2 gait cycles), 48 frames | 1.582 | 1.001 | -0.004 | +0.011 |
| `ped-b` | 2.333 s, 48 frames | 1.608 | 1.006 | -0.004 | +0.006 |
| `ped-c` | 2.333 s, 48 frames | 1.622 | 1.001 | -0.004 | +0.009 |
| `ped-d` | 2.333 s, 48 frames | 1.556 | 1.010 | -0.004 | +0.006 |

Idle loops are 1.60-1.65 s at 20 frames, found by searching for the shortest
sub-loop of Tripo's 12-15 s idle whose pose repeats to within 0.011 units.

### Foot slide

The runtime never plays these clips on a clock. It integrates the distance each
person has actually covered and inverts the travel curve to get a cycle
position, so a planted foot is planted by construction - the same property
`gait.ts` gives the procedural rig, for the same reason.

What remains is the provider's own clip quality, measured as the horizontal
excursion of an individual sole vertex over one footfall:

| id | median | p90 | worst |
| --- | --- | --- | --- |
| `ped-a` | 27 mm | 108 mm | 343 mm |
| `ped-b` | 9 mm | 25 mm | 35 mm |
| `ped-c` | 45 mm | 146 mm | 304 mm |
| `ped-d` | 17 mm | 63 mm | 189 mm |

For scale: the PROCEDURAL crowd this replaced was measured in the browser at a
median of **283 mm** and a p90 of **418 mm** of forward slide per stance. Its
`stanceSlip` unit test reports exactly zero, and that is true of the arithmetic
- but `gait.ts` derives the stride from the person's HEIGHT while the instance
matrix scales them horizontally by their GIRTH, so about 40 per cent of the
stride never reached the screen. The baked crowd is several times better, not
worse, and it is the first time the number has been measured on what is drawn
rather than on the formula behind it.

## The airport travellers

A second batch, generated for Meridian Bay Regional so that a concourse is not
four faces repeating. Eight were approved; **seven shipped and one was dropped**
after failing the foot-slide gate twice. The recipe is unchanged from the four
above - same prompt shape, same flags, same reasons - so only what differs is
recorded here.

Every prompt asked for a strict T-pose, arms horizontal, legs separated, no
props, complete head to feet, and every rendered preview was checked against
that before rig credits were spent. **No luggage is modelled into any of them**:
a bag fused into the silhouette is exactly what the rigger cannot see past, and
the crowd attaches the separate prop models instead.

Two deliberate departures from the brief's suggested cast, both for the rigger's
sake: the teenager carries **no backpack** (straps across the chest fuse the
arms into the torso in the source mesh) and the older woman stands **upright
rather than stooped**, her age carried by grey hair and a long coat. A stoop is
not a T-pose, and the rig is the only thing the source pose exists for.

| id | who | seed | generation | prerigcheck | rig | walk retarget | idle retarget |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ped-e` | businessman, dark charcoal suit, slim | 20260931 | `7a600bbd-0cbf-4fec-a673-53404e8357ad` | `079c5c1f-9193-4a1f-8d96-c201bf44284e` | `8dd62c59-6563-4b16-80d1-bbd18a928e17` | `fab76518-7495-4ef7-9ca6-a0e71fdac695` | `e0610f80-0817-4f91-8fc4-178e3a43d751` |
| `ped-f` | elderly woman, long grey-blue coat, grey hair | 20260932 | `0cdd9b46-5118-4e55-9c43-20210b5b3a25` | `2f15544c-cf12-4553-8160-3dcca6b53e15` | `da0f6bfa-4555-43ad-a0e1-3dbc670ebf80` | `1ac89cb7-c839-4d2b-ba57-5e8903062e03` | `9c453d2a-c6fb-4a88-a560-221cd0880a23` |
| `ped-g` | teenager, oversized red hoodie, shorts | 20260942 | `a30bd815-ac5f-4446-a9f0-3ce26d48cd7b` | `6dafec2a-c7c3-447b-990d-20631ba69d46` | `f26cc7b7-f605-4ed1-b381-8e03443f4693` | `00973d42-0daf-43ff-a0fe-9eaed7727fc4` | `3c02572b-2c9f-4963-9597-93d93aaa6ef9` |
| `ped-h` | ground crew, hi-vis vest, navy cap | 20260934 | `07271ba6-618c-4ab3-ad04-5660a8737da6` | `e3b168bd-131f-496e-b824-faf1d4d2b7ae` | `724313c2-2415-41b1-9bde-bde87c5966fc` | `2de612b0-8790-45ef-be46-9d7b016fd86f` | `b18e0ac0-5cab-472b-8c52-856571f3f2fa` |
| `ped-i` | woman, pale turquoise summer dress, sandals | 20260935 | `1366bdd7-af66-4a2a-8383-a500c3c606c3` | `f01c85a0-2835-474b-9dbf-d92fc6882c2b` | `c7d5e3a4-4592-4bc2-83ea-83f76d66e394` | `1832c53f-7cf1-4bcd-838c-9d25a3591a38` | `7536ffb0-482b-4915-9aea-37a8ee6aa5a1` |
| `ped-k` | tall lean young man, denim jacket, cargo trousers | 20260937 | `412e893d-7fa8-4b7b-875a-26cd125d1a94` | `7f3227f3-8254-4ce3-a6ec-28cec36c0634` | `28cf12ef-7572-4102-b2c1-7a0b4b85ca37` | `a0d4102a-1fa7-42dd-a534-c218f2d1b144` | `6c79d779-b4a0-45ef-9519-2118ebc0daa2` |
| `ped-l` | woman, athletic wear, high ponytail | 20260938 | `69f8ee71-6e88-4f68-8d51-612508e78127` | `a1c54e6f-f1b2-41c9-91fc-03d9389504a0` | `dc03870a-e26f-423c-87ab-b83bbe615a4c` | `0630a700-c464-4813-bf55-a9256764bccf` | `5476c78f-a882-4bfe-ba48-e052766b1290` |

There is no `ped-j`; see "The one that was dropped" below. The gap in the letters
is deliberate, so that the ids keep matching the task ids that made them.

Every prerigcheck returned `riggable: true, rig_type: biped`, and **all ten rigs
in this batch passed `validate-rig` first try** - "legacy anatomical skeleton,
16 paired L/R bones" - including the woman in the long coat and the woman in the
dress, the two whose silhouettes were expected to give the rigger trouble.

### Runtime files

| id | source verts | welded verts | triangles | VAT texture | `.bin` | `.jpg` |
| --- | --- | --- | --- | --- | --- | --- |
| `ped-e` | 8754 | 2199 | 2918 | 70 x 2199 | 1.80 MB | 39 KB |
| `ped-f` | 8745 | 2301 | 2915 | 70 x 2301 | 1.88 MB | 48 KB |
| `ped-g` | 8532 | 2198 | 2844 | **86** x 2198 | 2.20 MB | 61 KB |
| `ped-h` | 8388 | 1983 | 2796 | 70 x 1983 | 1.62 MB | 53 KB |
| `ped-i` | 8832 | 2236 | 2944 | 70 x 2236 | 1.83 MB | 58 KB |
| `ped-k` | 8490 | 2171 | 2830 | 70 x 2171 | 1.77 MB | 58 KB |
| `ped-l` | 8856 | 2243 | 2952 | 70 x 2243 | 1.83 MB | 64 KB |

**13.4 MB across seven characters.** Triangle counts run 2796-2952 against the
shipped 2844-2990, so each of these costs the same as an existing person: one
colour draw call and one shadow draw call, +7 of each with all seven resident.

`ped-g` is the one exception in the batch: its walk is baked at **64 frames**
rather than 48, which is why its texture is 86 columns wide and its `.bin` is
0.4 MB heavier. That is not a preference. Measured on the same clip, 48 frames
gave a worst-case sole excursion of 694 mm and 64 frames gave 159 mm - the
travel curve simply cannot follow that gait at 48 samples. The same sweep on the
other six moved the median by 1-6 mm either way, which is not worth 23 per cent
more bandwidth each, so they stay at 48.

Every one of these seven carries a **hand track** on both clips (the four
originals have `hand: null`, having been baked before the tool measured it).
`src/agents/travellers/props.ts` currently trails luggage on the floor at a body
relative offset because there was no wrist to attach to; for these seven there
now is one.

### Measured properties

Rig units, where the body is 1.0 tall; millimetres are for a 1.75 m person.
"Rest height" is the idle reference pose's own height before normalisation, and
"depth" its front-to-back extent - a heavier or coated character is deeper.

| id | walk loop | travel per loop | rest height | depth | walk feet at | worst walk float | idle feet at |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ped-e` | 1.867 s, 48 frames | 1.623 | 1.020 | 0.232 | -0.004 | +0.008 | -0.010 |
| `ped-f` | 2.333 s, 48 frames | 1.578 | 1.009 | 0.322 | -0.004 | +0.004 | -0.005 |
| `ped-g` | 2.333 s, 64 frames | 1.590 | 1.012 | 0.248 | -0.004 | +0.004 | -0.009 |
| `ped-h` | 2.333 s, 48 frames | 1.596 | 1.008 | 0.232 | -0.004 | +0.013 | +0.005 |
| `ped-i` | 2.333 s, 48 frames | 1.605 | 1.008 | 0.214 | -0.004 | +0.010 | +0.001 |
| `ped-k` | 2.333 s, 48 frames | 1.606 | 1.003 | 0.233 | -0.004 | +0.011 | +0.004 |
| `ped-l` | 2.333 s, 48 frames | 1.555 | 1.020 | 0.228 | -0.004 | +0.024 | +0.011 |

Two things in that table are new information about the provider.

**`preset:biped:walk` is not one clip.** It comes back either 2.333 s or 1.867 s
long - the same 126 tracks, a visibly faster cadence over a similar stride. Which
one a character gets is fixed by its rig: re-running `ped-j`'s walk retarget on
the same rig task (`4785856c-663d-47dc-8f2b-7a6bc0e41420`, 10 credits) returned
the 1.867 s variant again, byte for byte the same length. That matches what the
second `ped-c` rig found - the retarget is deterministic given a model - and it
is 10 credits of negative result recorded so nobody re-rolls for a different
clip. The four originals and five of these seven got 2.333 s; `ped-e` and both
`ped-j` attempts got 1.867 s.

**`preset:biped:idle` does not always contain a short loop.** The bake searches
Tripo's 12-15 s idle for the shortest sub-loop of at least 1.6 s whose pose
repeats to within 0.012 units, and six of the seven found one at 1.60-1.65 s as
the originals did. `ped-e` found none anywhere in 1.4-6.0 s and fell back to the
whole 12.267 s clip - 20 frames spread over twelve seconds, which is not an idle,
it is a slideshow. Lowering the floor to 1.0 s found a clean 1.02 s loop
(seam error 0.0114, against `ped-a`'s shipped 0.0109), and that is what ships.
The difference is measurable rather than cosmetic: at 12.267 s his idle feet slid
a median of 31 mm and a p90 of 89 mm; at 1.02 s they slide 5 mm, the same as
everybody else's. So `ped-e` is baked with `--min-period idle=1.0` and sways
about half again as fast as the rest of the crowd, which reads as a restless man
in a suit rather than as a fault.

### Foot slide

The acceptance gate for this batch was `ped-c`, the character the first batch
recorded as sliding: **45 mm median, 146 mm p90, 304 mm worst**. Same measurement
as above - the horizontal excursion of an individual sole vertex over one
footfall, on a 1.75 m person.

| id | median | p90 | worst | vs `ped-c` |
| --- | --- | --- | --- | --- |
| `ped-i` | 7 mm | 18 mm | 44 mm | better on all three |
| `ped-f` | 8 mm | 41 mm | 330 mm | better median and p90 |
| `ped-k` | 10 mm | 66 mm | 300 mm | better on all three |
| `ped-h` | 14 mm | 33 mm | 314 mm | better median and p90 |
| `ped-l` | 21 mm | 63 mm | 72 mm | better on all three |
| `ped-g` | 23 mm | 69 mm | 159 mm | better on all three (at 64 frames) |
| `ped-e` | 28 mm | 52 mm | 190 mm | better on all three |

`ped-i` is the best character in the game on this measure, better than `ped-b`'s
9/25/35 on median and p90. Nothing in the shipped batch is worse than `ped-c` on
either robust statistic. Two of the seven have a single sole vertex that travels
about 300 mm over one footfall, which is `ped-a` and `ped-c` territory and is a
99.9th-percentile outlier rather than the skate a player sees.

Idle slide is 4-6 mm median for all seven, in line with the originals.

### The one that was dropped

`ped-j` was to be the heavier-set older man in a sun hat and shorts - the body
type the roster most obviously lacks. It was generated twice and failed the
gate both times.

| attempt | seed | generation | prerigcheck | rig | walk retarget | idle retarget | measured |
| --- | --- | --- | --- | --- | --- | --- | --- |
| first | 20260936 | `0958c8fe-f6db-42e1-b535-3064920a1c8c` | `136b511f-0512-47b9-9806-a284177ccbf1` | `44bc7d61-3a73-40ad-b755-5bb2bdc6a64e` | `5aaab6a7-4174-4428-85f5-e1f86613e582` | `a107b6a0-4314-4915-a3e5-f42fd516e1e1` | 68 / 164 / 797 mm |
| second | 20260943 | `47f9b0a8-13a3-4b6d-8875-e634097e3de9` | `43cf1d68-82ce-45f0-91f7-5be7ec123866` | `9fac09f7-c8bb-4895-bbde-1e5154f90634` | `060eae72-19ba-4b95-bb3c-752741459952` | `1dfd2bb3-b349-4ce9-ad69-3d2760892fa4` | 50 / 157 / 617 mm |

The first attempt was short and wide - the generator normalises to a unit box, so
his height came out 0.930 of it against everyone else's 1.01 - and the contact
search found a plantable foot in only **6 of 48 frames**. With almost nothing to
integrate, the travel curve fell back to a constant rate, which is precisely the
one-stride-fits-all assumption the curve exists to replace. The second attempt
asked for the same build with longer legs and closed shoes instead of sandals,
which fixed the contact search (44 of 48 frames) but not the slide: still worse
than `ped-c` on median, p90 and worst. Re-sampling the walk at 64, 80 and 96
frames moved nothing (47-58 mm median at every count), so it is the clip against
that body rather than the bake against the clip - the same conclusion the first
batch reached about `ped-c`, arrived at independently.

Per the retry policy it was dropped rather than rolled a third time. **130
credits of negative result**, recorded so the next person does not spend them
again. The lesson is narrow and reusable: **a short, wide humanoid slides under
`preset:biped:walk`**, and no amount of re-rigging, re-retargeting or re-sampling
fixes it. A heavier character can still work - `ped-c` and `ped-j`'s second
attempt both prove the generation is easy - but it has to be heavy at ordinary
height, not compressed.

The first `ped-g` generation was replaced for the same reason and its tasks are
recorded here too: seed 20260933, generation
`9b1ea128-af46-46ca-a519-a74fbeaf1dd9`, prerigcheck
`c5b5b304-4f3e-4a9f-af8f-9a9001b04b6b`, rig
`99a67297-2099-483f-9f63-79115b7b8262`, walk
`e1efcfdb-5c55-4b2a-a7de-55aa351fb6d8`, idle
`656f9eec-998c-4e3e-b0e1-e84ca89f6594`. It measured 61 / 120 / 621 mm as a
short, baggy teenager; asking for the same character taller, with shorts above
the knee and low trainers, brought it to 23 / 69 / 159 mm. Unlike `ped-j`, that
one worked.

### Two more pieces of luggage

`public/models/airport/backpack.glb` and `garment-bag.glb`, generated with the
static-prop recipe from `docs/airport-and-flight.md` - model version
`P1-20260311`, `face_limit=1200`, converted to GLTF at `texture_size=1024` -
and the same shared style clause, including *plain neutral paintwork* and *no
text, no lettering, no logos*.

| asset | seed | generation | convert | triangles | vertices | bounds (unit box) |
| --- | --- | --- | --- | --- | --- | --- |
| `backpack` | 20260940 | `3b0f9127-56c1-424a-90bf-95d2d226fdec` | `4b0cc76f-043c-48de-a2fa-cdc2965326e4` | 1110 | 1015 | 0.873 x 0.998 x 0.701 |
| `garment-bag` | 20260941 | `279a838c-1d0c-4dee-8053-0407ef9e8282` | `a60276d2-6b36-4780-b4a9-f8c65154a2d0` | 1041 | 1441 | 0.381 x 0.998 x 0.424 |

372 KiB and 398 KiB, one mesh, one material and three textures each, which is
the same shape as `suitcase` (822 triangles), `duffel` (757) and `trolley`
(1132). Both arrive normalised into a unit box with a centre pivot, like every
other generated model here, so the runtime measures and rescales them.

Rendered orthographically along each axis before being accepted, which is the
only way to settle which axis is which:

- **`backpack`** stands on **+Y**, the grab handle at the top; the front pocket
  faces **-Z** and the shoulder straps are on +Z. Suggested fit: `axis: 'y'`,
  `metres: 0.50`, `front: '-z'`. It is a chunky pack - 0.44 x 0.35 m in plan at
  that height - which reads correctly at crowd distance.
- **`garment-bag`** stands on **+Y**, padded handle at the top, full-length zip
  down the **-Z** face and a strap buckled across the middle. Suggested fit:
  `axis: 'y'`, `metres: 0.90`, `front: '-z'`, giving a 0.34 x 0.38 m footprint -
  a stuffed upright carrier rather than a flat suit sleeve.

### Placing them

The bake normalises every character to exactly 1.0 unit tall with its feet on
y = 0, so **none of these files carries a height**: `appearance.ts` samples
`1.54 + tall * 0.38` metres and the instance matrix supplies it. Which means a
teenager and a tall man come out the same size unless whoever places them says
otherwise. These are the heights the characters were drawn at, all inside the
crowd's existing 1.54-1.92 m band:

| id | suggested height | why |
| --- | --- | --- |
| `ped-e` | 1.80 m | slim, long-limbed; the tallest silhouette after `ped-k` |
| `ped-f` | 1.60 m | elderly; the coat reads wrong on a tall frame |
| `ped-g` | 1.72 m | a teenager who has already grown, not a child |
| `ped-h` | 1.68 m | uniformed, unremarkable |
| `ped-i` | 1.66 m | the narrowest build in the batch (0.306 wide) |
| `ped-k` | 1.88 m | generated explicitly as the tall one |
| `ped-l` | 1.70 m | athletic |

Two other things worth knowing before placing them:

- **`ped-f` is the deepest character in the game** at 0.322 front-to-back
  against everyone else's 0.21-0.25, because of the coat. Anywhere the crowd
  packs shoulder to shoulder she will intersect a neighbour sooner than the
  others do.
- **`ped-e`'s idle runs at 1.02 s** where every other character's runs at
  1.60-1.65 s. In a line of stationary people he is visibly the twitchy one.
  That is measured, not accidental - see "Measured properties" - and if it reads
  badly in a queue, the fix is to bake him with a longer floor and accept the
  slideshow, not to retime him at runtime.

### Spend

| task | count | credits each | total |
| --- | --- | --- | --- |
| `text_to_model` (characters) | 10 | 20 | 200 |
| `animate_prerigcheck` | 10 | 0 | 0 |
| `animate_rig` | 10 | 25 | 250 |
| `animate_retarget` | 21 | 10 | 210 |
| `text_to_model` (props) | 2 | 40 | 80 |
| `convert_model` (props) | 2 | 10 | 20 |

**760 credits.** Balance 1410 before, **650** after, and the two agree exactly,
so unlike the first batch nothing else was drawing on the key while this ran.

Of that, 140 is the retry budget: 130 for the two characters that were
regenerated once each after failing the slide gate, and 10 for the retarget
re-roll that proved the walk variant is fixed by the rig. The seven shipped
characters and the two props account for the other 620.

### How it was checked

`tools/render-pedestrian-vat.mjs` was written for this batch. It reads the
shipped `.json` and `.bin` - not the provider's preview, not the source GLB -
decodes the position and normal textures for a chosen clip and frame, and
rasterises them to a PNG with a ground line at y = 0. Several ids can be drawn
side by side at one scale, which is how each new face was compared against the
shipped four before it was accepted.

That is what makes "no T-pose leaks into the game" a measurement rather than a
hope. The T-pose is the source mesh's bind pose; the VAT contains nothing but
sampled walk and idle frames, and `PedestrianVat` selects the clip named `idle`
for a stationary person. Rendering column 0 of every clip of every character
shows seven people standing and seven people mid-stride, and no arms held out.

## Rendering

`src/agents/PedestrianRig.ts`. One `InstancedMesh` per character; the vertex
shader looks the pose up in the VAT instead of skinning. The bake lays each
clip out one row per vertex and one column per frame, with the first frame
duplicated after the last, so consecutive frames are adjacent texels and the
sampler's linear filter interpolates between them for nothing.

Cost per vertex is ONE texture fetch for position and one for normal while a
person is walking or standing, two of each only during the short blend as they
start or stop. Sampling bone matrices instead would be 16 to 32.

Measured at one vantage point in the Old Quarter with 266 people in view, three
resolutions, same camera, alternating:

| crowd | draw calls | triangles | best of 6 at 2.31 MP |
| --- | --- | --- | --- |
| none | 281 | 4.58 M | 4.55 ms |
| procedural | 283 | 5.01 M | 4.62 ms |
| four Tripo characters | 289 | 6.15 M | 4.89 ms |

So the whole change is +6 draw calls over the procedural crowd (+8 over none:
four colour, four shadow) and about +0.27 ms of GPU time, and the simulation
cost is unchanged - 0.198 to 0.218 ms either way for 270 people, measured by
swapping the write path under a settled crowd. The population was NOT reduced:
still 270 at 'high', 180 at 'medium', 90 at 'low'.

An earlier three-character build measured the same way at 4.30 MP with 266
people in view: 347/349/353 draw calls and 7.42/7.41/7.72 ms, so the cost is
about 0.07 ms per additional character at this population.

## The street batch

A third batch, generated for the CITY rather than for the airport, because a
player who asked for "more avatars, more different avatars" was looking at a
crowd of four. The recipe is unchanged from the eleven above - same model, same
`face_limit`, same `texture_quality`, same prompt shape, same flags, same slide
gate - so only what differs is recorded here.

The cast was chosen for SILHOUETTE, not for faces. Silhouette is what reads at
the distance a pedestrian is actually seen from, and the four originals are
four people in ordinary clothes with the same outline. These are a docker in
overalls, a cafe worker in an apron, a cyclist in a jersey, a woman in a
full-length summer dress, a construction worker in a hard hat, a man in a loose
linen suit and a woman in a t-shirt and shorts.

| id | who | seed | generation | prerigcheck | rig | walk retarget | idle retarget |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ped-m` | stocky dock worker, orange overalls | 20260951 | `07e24c32-9982-4cc1-9e60-d6400c65530d` | `b1c79bcc-d928-4d6c-aec2-1b86740acb79` | `b715c56b-27db-4643-825f-c33f38c9c162` | `10a7a450-35c7-48f9-8639-65e8a0010f69` | `8610e891-c666-4fe1-8c49-c17221526ed6` |
| `ped-o` | cafe worker, chef jacket and green apron | 20260953 | `25285a29-075c-4ba7-8a4d-c3110cd6b5c2` | `b3ff964a-9c03-40c5-b9e4-2680c0f16e10` | `6ab10ee1-104b-4739-a806-f1db581bf7e2` | `3bbb0681-14c8-422c-9bbd-fcf58889690f` | `39d4291a-e804-439b-abf0-79f33fc2660f` |
| `ped-p` | cycle courier, red and black jersey | 20260954 | `bb64c1aa-bfd6-45d2-b78e-8c7b01db8984` | `76762188-7988-4c6a-8ea6-554e28dfb00f` | `c25cda93-0171-4182-89f2-54c590fcb187` | `d4b1343a-1b53-4fa9-901c-6779ca318fd2` | `72b1d070-c87d-4958-88b5-34bef2f5d745` |
| `ped-q` | woman, floor-length floral dress, sun hat | 20260955 | `164a2102-2912-4e9b-aaaf-b523fecd6e0a` | `20d9f2fd-df07-4a15-941e-37c664c33080` | `6c8f37a8-8dea-4afd-9930-e6bf03309337` | `7c91b860-4eb5-47df-8eef-bf2cae139d33` | `4b272bdf-7764-49d2-a8c4-1b9a932f47c3` |
| `ped-r` | construction worker, hi-vis and hard hat | 20260956 | `a19da3d8-8e2a-4e06-84a9-522e4eeee297` | `7277703d-3100-4eb0-be25-4b0c2becff30` | `8262e38b-2d02-45ac-8584-efd7e3183728` | `8190bd5f-65c1-49d7-9503-6b781cc07a43` | `f603a931-99cf-459c-9c6a-306d59cb230c` |
| `ped-s` | man, pale linen suit, close-cropped hair | 20260957 | `cf1d5516-3be7-409b-813a-8d01fadce3b2` | `484639b7-9b41-4f74-b9d6-24cf39efcf70` | `49ef99aa-ffc9-496a-80b7-cc2a0655002f` | `074af5b3-247b-459a-9383-996c7bb79a86` | `ca7dc441-b1a1-4605-8f21-0508cd8a2341` |
| `ped-t` | young woman, striped tee, denim shorts | 20260958 | `899a4718-b5df-4da4-92eb-494a5eda5c2c` | `0e0a93bc-4abb-494d-aea4-d74dbf83086e` | `c09b2e4c-1203-4256-8a66-84ef4cf270d9` | `60acbb9a-1767-440c-a227-6a46c8f197a5` | `1370d860-f6e1-4f64-9991-ef8ca1925746` |

Every prerigcheck returned `riggable: true, rig_type: biped`, and all eight rigs
in the batch passed `validate-rig` first try - "legacy anatomical skeleton, 16
paired L/R bones" - including the woman in the floor-length dress, whose legs
are not separated anywhere below the knee in the source mesh.

### The one that was dropped, again

**There is no `ped-n`.** An older man in a flat cap and a corduroy jacket was
generated, rigged and retargeted, and his walk measured a worst-case sole
excursion of **448 mm** on a 1.75 m person against the 420 mm `MAX_WALK_SLIP`
gate. Following the `ped-j` precedent - a re-rig is pointless, because the
retarget is deterministic given a model - he was REGENERATED on a different
seed (20260962) with the coat shortened so the preset's leg sweep had less
cloth to drag. That attempt measured **926 mm**, twice as bad, and was dropped.

| attempt | generation | rig | walk | idle | worst slide |
| --- | --- | --- | --- | --- | --- |
| first | `c71beba9-a35f-4951-a3b9-5013c084f88c` | `efd55071-59f6-4d5f-9119-a55cfdf6e989` | `ba0eb85b-9b48-4f4f-ab50-3c925264b753` | `aeea90a6-5a77-4d3d-9a35-2165b328e93a` | 448 mm |
| re-roll | `4dc3c1c7-4a57-4c44-b7e6-f3df11bceb50` | `58102f84-a31a-4f27-8087-bd1bf802810f` | `44b5e88e-71d5-4128-9122-172b2b4143f9` | `cc895955-aaf2-4301-a849-4ffa8f65aaf7` | 926 mm |

That is **110 credits of negative result**, recorded so the next person does not
spend them again. The gap in the letters is the record, not an oversight.

### Runtime files

| id | welded verts | triangles | VAT texture | `.bin` | `.jpg` | worst walk slide |
| --- | --- | --- | --- | --- | --- | --- |
| `ped-m` | 2003 | 2856 | 70 x 2003 | 1.64 MB | 49 KB | 167 mm |
| `ped-o` | 2096 | 2796 | 70 x 2096 | 1.71 MB | 45 KB | 155 mm |
| `ped-p` | 2037 | 2884 | 70 x 2037 | 1.66 MB | 51 KB | 89 mm |
| `ped-q` | 2470 | 2922 | 70 x 2470 | 2.01 MB | 112 KB | **26 mm** |
| `ped-r` | 2066 | 2936 | 70 x 2066 | 1.69 MB | 62 KB | 209 mm |
| `ped-s` | 2132 | 2962 | 70 x 2132 | 1.74 MB | 43 KB | 161 mm |
| `ped-t` | 3117 | 2878 | 70 x 3117 | 2.54 MB | 62 KB | 144 mm |

**13.0 MB across seven characters.** Triangle counts run 2796-2962 against the
shipped 2796-2990, so each costs exactly what an existing person does.

`ped-q` is the best walk in the repository by a wide margin - 26 mm worst
against a shipped range of 89 to 343 - which is not what anybody would have
predicted from a floor-length dress. The skirt is one volume that swings as a
unit, so there is no sole vertex to slide; the slide gate measures cloth here
rather than feet. `ped-t` is the heaviest bake at 2.54 MB because her hair is
modelled rather than implied, which costs 3,117 welded vertices against the
batch's 2,003-2,470.

### Spend

| task | count | credits each | total |
| --- | --- | --- | --- |
| `text_to_model` | 9 | 20 | 180 |
| `animate_prerigcheck` | 9 | 0 | 0 |
| `animate_rig` | 9 | 25 | 225 |
| `animate_retarget` | 18 | 10 | 180 |

**585 credits.** Balance 650 before, **65** after, and the two agree exactly.
Of that, 110 is the `ped-n` retry budget above; the seven shipped characters
account for the other 475.

## Limitations

- The characters ship as 7.2 MB across four `.bin` files, the seven travellers
  add **13.4 MB more** and the street batch **13.0 MB** on top of that. They
  download in the background while the world builds and the procedural crowd
  covers the gap, so nothing waits on them, but it is real bandwidth. The CITY
  roster is now eleven of the eighteen, and `PedestrianSystem.loadCharacters`
  fetches them **two at a time** rather than all at once: eleven characters is
  thirty-three requests, and issuing them during the world build is exactly the
  contention the cold-load work removed.
- Only the base colour is used. The rig GLBs also carry normal and
  metallic-roughness maps; sampling them would need tangents and two more
  fetches per fragment, and this frame is already pixel-bound.
- `ped-c`'s walk slides more than the other two. The preset's leg sweep does
  not fit his proportions; a second rig produced identical output, so fixing it
  means a different character rather than a different roll.
- Eleven characters plus a per-instance tint is not three hundred different
  people. Body shape repeats every eleventh person on the street rather than
  every fourth - better, still finite, and two people in the same summer dress
  standing near each other is a thing a player will occasionally see.
- `ped-d`'s generated texture is mottled - the hoodie reads as tie-dyed rather
  than plain mustard. It was kept because it is plausible street clothing and a
  re-roll costs another generation. `ped-l`'s running top came back the same
  way, a peach-to-purple gradient instead of plain purple, and was kept for the
  same reason: gradient sportswear is a real thing, and the alternative is
  20 credits for a colour preference.
- **No heavy-set body type in the traveller batch.** `ped-j` was meant to be it
  and was dropped; see "The one that was dropped". `ped-m`, the docker, is the
  street batch's answer and is broad rather than heavy; `ped-c` remains the only
  genuinely heavy person in the crowd, and he is the one that slides.
- **Nobody older than middle-aged walks the street.** `ped-n` was to be the
  elderly man and failed the slide gate twice; `ped-f`, the elderly woman, is on
  the airport roster. The city's own cast runs young.
- The travellers' silhouettes vary but their HEIGHT does not: the bake
  normalises every character to 1.0 unit tall, so a teenager and a tall man are
  the same size until the runtime scales them. Height variety is the crowd's job,
  not the asset's, and the per-character suggestions are in the integration note
  above rather than baked into the files.

## Rosters, zoning and the crowd at the airport

*Appended by the airport-population workstream. Everything above this heading
belongs to the asset pipeline; everything below is about what the runtime does
with it.*

### The defect: a wall of people on an airport access road

A player photographed "an implausibly large wall-like crowd gathered across the
airport road and parking area". It reproduced immediately and the cause was one
sentence: **the city crowd had no idea the airport existed.** Grepping
`src/agents` for `airport` returned nothing. `CityPlan` authors Airport
Approach, Airport Way, the two forecourt roads and the car park roads as
ordinary `Street` records - deliberately, so the traffic simulation, the signal
heads, the minimap and the pavement graph pick them up with no special case -
so `buildPavementGraph` produced pavement there and `Crowd` populated it at
downtown density.

A fixed population recycled inside a fixed radius is a *linear* density once
you know how much pavement is in the radius. Measured on the shipped build, in
one-way metres inside the crowd's own 142 m seed radius:

| vantage | pavement | people | people per metre |
| --- | ---: | ---: | ---: |
| Old Quarter (-60, -40) | 3324 m | 270 | 0.081 |
| city spawn | 2037 m | 270 | 0.133 |
| South Circuit (120, 132) | 1870 m | 270 | 0.144 |
| airport approach (140, 300) | 1241 m | 270 | **0.218** |
| terminal forecourt (183, 330) | 1241 m | 270 | **0.218** |
| car park (183, 600) | 597 m | 270 | **0.452** |

One person every 2.2 m on a 2.08 m footway is a continuous file of bodies, and
the approach road is 570 m of it across open ground with no frontage and no
reason to be on foot.

### The rules

`src/agents/travellers/zones.ts` reads the airport survey and answers two
questions per point: which zone is this, and what may happen here. Every number
comes from `world/airport/layout.ts`; nothing is a literal coordinate.

| zone | share | cap | what it is |
| --- | ---: | ---: | --- |
| `airside` | 0 | 0 | runway, overruns, taxiway and its links, apron, hangars, tower pad, and everything on the platform east of the terminal's east wall |
| `terminal` | 0 | 0 | the building interior - `TerminalCrowd` owns that population |
| `forecourt` | 0.60 | 30 | drop-off, terminal frontage and the crossings between them |
| `carPark` | 0.30 | 14 | the car park's footways |
| `approach` | 0.12 | 14 | Airport Approach and Airport Way |
| `airportGrounds` | 0.10 | 10 | hangar road, service verges, mown grass |
| `city` | 1 | none | Meridian Bay, untouched |

`share` scales density: it multiplies a link's length when the crowd works out
how many people the ground can carry, and multiplies that link's weight when it
picks somewhere to put one, so the head count and the distribution fall
together. `cap` is a hard ceiling on simultaneous occupancy. A `forbidden` zone
closes every link that touches it, through the same flag street furniture
already uses - so `linksNear`, `chooseNext` and `respawn` all refuse it for
free and nobody is ever steered off a taxiway after the fact.

Population is then `clamp(round(supply * 0.15), 10, budget)` where `supply` is
the zone-weighted metres in range. 0.15 was chosen so **the city does not
move**: the thinnest city vantage there is (South Circuit, 1870 m) still asks
for 281 people against a budget of 270.

### Measured, before and after

Production build, `renderBenchmark(60, 1280, 720)`, forced GPU sync per frame.

| vantage | crowd active | zone-weighted supply | forecourt / approach occupancy |
| --- | ---: | ---: | --- |
| forecourt (183, 330) | 270 -> **50** | 330.6 m | 30 / 14 |
| approach (140, 300) | 270 -> **50** | 330.6 m | 30 / 14 |
| inside the terminal | 270 -> **20** | 132.9 m | - |
| Old Quarter | 270 -> **270** | 3324 m | 0 / 0 |

| vantage | draw calls | triangles | crowd `updateMs` |
| --- | --- | --- | --- |
| forecourt | 282 -> 297 | 6.78 M -> 5.81 M | 1.43 -> 0.05 |
| terminal interior | 331 -> 345 | 7.10 M -> 5.75 M | 0.40 -> 0.02 |
| Old Quarter | 335 -> 335 | 7.29 M -> 7.39 M | 0.44 -> 0.10 |

The +15 draw calls at the airport are the terminal's own roster (seven
characters instead of four, plus two more luggage models); the triangles fall
anyway because 220 fewer people are drawn. **Downtown is byte-identical in
draw calls**, which is the claim the density figure was calibrated to protect.

Wall-clock frame times are NOT comparable between the two captures: the "before"
was taken while several other workstreams were building on the same machine
(27-35 ms) and the "after" while it was idle (4.1-5.6 ms). The structural
columns above are the honest comparison.

### Two rosters, because a character is a draw call

`PEDESTRIAN_VAT_IDS` used to be one list of four, iterated by both the street
crowd and the terminal crowd. Adding seven airport characters to it would have
cost the DOWNTOWN street fourteen draw calls for people it never shows. So:

- `CITY_VAT_IDS` - `ped-a` to `ped-d`, budget 4. Unchanged.
- `AIRPORT_VAT_IDS` - `ped-e` to `ped-l` (no `ped-j`), budget 7.
- `TERMINAL_VAT_IDS` - the airport list, topped up from the city's only if it
  is short of the budget.

Adding a character is one line in `AIRPORT_VAT_IDS`; the mesh count, the
instance buffers, the variant assignment, the stature table and the tests all
read from it.

Three per-character facts the runtime applies, all of them measured by the
asset workstream rather than guessed:

- `VAT_STATURE` correlates height with the mesh. The bake normalises everyone
  to 1.0 unit tall, so without it the tall man in cargo trousers comes out
  1.56 m as often as not.
- `VAT_FOOTPRINT` gives `ped-f` 1.3x the personal space, because her coat makes
  her 0.322 m deep against everyone else's 0.21 to 0.25.
- `IDLE_MIN_PERIOD` stretches `ped-e`'s 1.02 s idle to the 1.55 s the rest run
  at. Invisible walking past; impossible to miss in a queue of people standing
  still.

`MAX_WALK_SLIP` (0.24 rig units) is a **gate**: `loadPedestrianVat` refuses a
bake whose walk slides more than that and the caller degrades exactly as it
does for a missing file. The runtime cannot fix a bad clip - it already drives
the cycle from distance travelled rather than from a clock - so the only useful
thing to do with the number is refuse. The shipped roster's worst is `ped-a` at
0.196.

### Nobody pops

The head count is now a function of where the player is standing, so people are
introduced and retired continuously rather than only out past the 152 m recycle
ring. A hard `active = false` in the middle of the drawn set would be a body
vanishing in front of the player, so every activation and retirement runs
through a **dissolve**: `Pedestrian.fade`, half a second, carried to the shader
in the spare `iTint.w` (and `iExtra.z` for the procedural fallback) and applied
as a screen-space stipple against interleaved gradient noise.

A stipple rather than alpha blending, because blending would need the crowd
sorted against itself and against the city and would not work in the shadow
pass at all; the `discard` is order-independent and the depth material carries
the same test, so a fading person's shadow fades with them. The cost it does
carry is that `discard` disables early-Z for those draws. That was not isolated
against a controlled baseline - see the note about machine load above - and
downtown, with an identical 335 draw calls and 270 people, runs at 5.4 ms mean
and 6.1 ms p95 in the after build.

Walking the approach road with the crowd converging, measured in the browser:
178 -> 50 southbound and 46 -> 173 back, with
`tests/airportPopulation.test.ts` asserting that not one agent inside the draw
radius went inactive without dissolving first.

### Being shot

`downAt` still behaves exactly as it did. Added beside it:

- `casualtyAt(x, z, { radius, dirX, dirZ, lethal, alarm, floor })`. Lethal by
  default and **permanent**: `fatal` is set and `stepDown` never runs the rise.
- `lethal: false` **staggers** rather than floors. A lean folded into the same
  instance matrix a topple uses, a stumble along the round's line of travel
  applied as displacement (so the steering speed cap cannot erase it), a broken
  stride, and then a run. They stay upright, which matters because a wounded
  civilian lying on the pavement is indistinguishable from a dead one and is
  skipped by the combat layer's own targeting. `floor: true` restores the old
  behaviour for a blow that genuinely takes somebody off their feet.
- `alarmAt(x, z, radius, seconds)`. Everybody within 26 m stops dawdling,
  hurries, turns round if they were walking into it, and prefers routes away
  from it for nine seconds. Stamped onto each person once per shot rather than
  tested per frame, so a firefight costs one pass over the pool per round.
- Bodies are bounded: at most `CASUALTY_LIMIT` (14) at once, `CASUALTY_TIME`
  (60 s, or 20 s once the street is already at the limit), and only cleared
  beyond `CASUALTY_CLEAR` (42 m) - and then by dissolving, never by blinking
  out.

### Limitations of this workstream

- **The forecourt is uniform, not grouped.** The brief asked for "smaller
  groups at entrances, drop-off areas and crossings"; what is implemented is a
  lower, capped, zone-weighted density spread evenly along the footways. The
  mechanism for grouping is a per-zone focus point folded into `linkShare` at
  construction; it is not built.
- **The seated lounge reads pale.** `seated-a` / `seated-b` arrive nearly
  white, and raising the occupancy from 0.58 to 0.74 makes that more visible
  than it was. The models are the asset pipeline's, not this workstream's.
- **`ped-f`'s footprint is handled by separation, not by seating.** She still
  takes an ordinary queue slot; she simply pushes her neighbours a little
  further off when she does.
- **The city crowd never enters the terminal and the traveller crowd never
  leaves it.** There is no door either population walks through; the terminal's
  count is a function of the player's distance to the building, not of anybody
  arriving.
