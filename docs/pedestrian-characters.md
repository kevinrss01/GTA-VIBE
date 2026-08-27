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

## Limitations

- The characters ship as 7.2 MB across four `.bin` files. They download in
  the background while the world builds and the procedural crowd covers the gap,
  so nothing waits on them, but it is real bandwidth.
- Only the base colour is used. The rig GLBs also carry normal and
  metallic-roughness maps; sampling them would need tangents and two more
  fetches per fragment, and this frame is already pixel-bound.
- `ped-c`'s walk slides more than the other two. The preset's leg sweep does
  not fit his proportions; a second rig produced identical output, so fixing it
  means a different character rather than a different roll.
- Four characters plus a per-instance tint is not three hundred different
  people. Body shape repeats every fourth person.
- `ped-d`'s generated texture is mottled - the hoodie reads as tie-dyed rather
  than plain mustard. It was kept because it is plausible street clothing and a
  re-roll costs another generation.
