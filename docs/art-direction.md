# Art direction brief: first-person open-world coastal city

Status: reference analysis and proposed direction. No implementation implied.

Five third-party promotional screenshots were studied as a lighting, material
and density study only. Nothing from them is reproduced: no map, street layout,
place name, brand, sign copy, character, logo, vehicle or landmark. Only
transferable qualities cross over, and all in-world text must be invented for
this project. Hex values in section 1 are pixels sampled from the reference
files (sRGB, as compressed) — observations, not targets to match.

---

## 1. Reference read-outs

### 1.1 Beachfront strip at night (`GTA-6.jpg`)

Light: ~45 min after sunset, no sun. A flat sourceless light-pollution lid
(`#A17380` low, `#966B75` mid, `#91666D` high) — no stars, no banding.
Everything readable is lit artificially: continuous ~2100K cove strips tucked
under each floor slab, magenta and violet storefront neon, cyan wall washers,
green palm uplights. Shadows are numerous, short, soft, multi-directional; none
dominates. Bloom is generous — every tube carries a 6-12 px halo and the damp
road smears source colour vertically.

Grade: magenta/cyan bias, not teal/orange. Warm anchor is amber cove light on
façades, cool anchor is cyan/green at street level. Blacks lifted and
violet-tinted (`#201A28` in unlit foliage, never 0,0,0). High saturation in
emitters, low in surfaces — pavement samples `#CDAFB7`, neutral concrete pushed
pink purely by bounce.

Materials: chalky painted stucco dominates (high roughness, no sheen); polished
car paint is the only mirror specular; sidewalk concrete is matte with a faint
damp sheen; shopfront glass reads as dark panels holding bright reflected line
sources. Maintained-but-old — repainted, not new.

Structure: 3-5 storeys, continuous street wall, zero setback, 18-30 m
frontages; every third or fourth building breaks with a rounded corner bay or a
vertical fin; rooflines vary by 1-2 storeys with stepped parapets and blade
signs. Rhythm is horizontal — eyebrow slabs at every floor line, punched
windows on a ~3.5 m module. Ground floors are recessed loggias with awnings and
café seating spilling onto the walk.

Street and planting: 2+2 lanes, kerb parking fully occupied, yellow painted
kerb bands, 6-8 m sidewalk in scored concrete panels, drain grate and utility
covers in the pavement, a low planted strip between road and walk. Feather
palms with 10-16 m clear trunks at 8-14 m spacing, clustered not even; crowns
read as dark commas, only frond undersides catch uplight.

Storytelling and depth: crowd density does the heaviest lifting — silhouettes
at tables and on the walk, someone sitting on the kerb with a bag, open car
doors, a scooter wedged between cars. Three depth layers (saturated foreground
vehicles, a mid-block neon band, a pale distant hotel mass against the pink
lid), separated mostly by neon scattering in the air.

### 1.2 Downtown at civil twilight, elevated (`gta-6-screenshot-b-scaled.jpg`)

Light and grade: sun fully down. The violet sky (`#7B658C` high, `#624E73` mid,
`#41354A` over water) is brighter than most of the city, so buildings read as
silhouettes with light punched through them. Light arrives in discrete coloured
pools — chartreuse fluorescent offices, teal wash on a civic concrete block,
sodium orange in a parking structure, a cool white billboard, warm lobbies.
Base saturation low, all colour from sources; blacks near `#151515` in unlit
asphalt, so nothing crushes.

Materials: precast and board-formed concrete (chalky, lightly stained), glass
curtain wall as the only glossy surface, painted metal louvres, asphalt
`#5E5F4D` under sodium and `#20201E` unlit.

Structure and street: a mid-rise field (4-8 storeys, 30-70 m footprints)
between a few 25-40 storey towers at the frame edges; faceted civic masses with
chamfered corners and stepped setbacks; banded parking podiums do most of the
base-level work. Blocks 100-140 m, an elevated freeway threading past. Roads
are 2+2 plus turn lanes: white dashes, double yellow centre, zebra crossings,
stop bars, painted arrows, cobra-heads at ~30 m, palms in the median.

Storytelling and depth: headlight cones and taillight streaks are the main life
signal; a helicopter crosses; harbour cranes and a Ferris wheel shape the far
field. Aerial perspective is aggressive — by 1.5 km the port is silhouettes
plus point lights, and overlapping rooflines stack 6-8 depth layers.

### 1.3 Wetland at late afternoon (`gta-6-screenshot-g-scaled.jpg`)

Light and grade: sun at 20-25 deg, low and behind-left, strongly warm; sky near
it blows to `#FDFCF9`, zenith a pale `#DBE0E5`. Shadows long, soft, filled by a
very bright sky so their interiors stay legible; water specular glitter is the
dominant highlight and bloom is restrained. Low-contrast, high-key,
near-neutral with a warm lift; blacks never near zero.

Materials and vegetation: water (mirror plus silt refraction), wet mud, waxy
mangrove leaves, straw-dry grass (`#98845C`), muddy vehicle paint — everything
reads damp, high specular and low roughness across all ground planes.
Vegetation is the architecture: bands of 0.8 m reeds, 2 m mangrove and 8-12 m
hammock trees, irregularly clumped with clear gaps.

Storytelling and depth: spray plumes, wheel wakes, wading birds, an alligator,
low mist ribbons, tyre-torn grass. A haze band sits exactly at the treeline and
the treeline nearly matches sky value — that sells distance, not detail.

### 1.4 Roadside motel at deep dusk (`gta-6-screenshot-h-scaled.jpg`)

Light and grade: blue hour, ~25 min after sunset. Sky sampled zenith down:
`#172530`, `#1F313F`, `#253B49`, `#344B5B`, `#53696F`, `#6D8180` at the horizon
— navy to pale grey-teal with a faint warm residue behind cloud; trees are
near-black cutouts. Key is one warm cobra-head with a strong bloom halo; fill
is the orange neon sign plus a cold porch spot; sky adds a weak cool ambient
from above only. Strongest teal/orange separation in the set; blacks dark but
uncrushed (`#0E1B21`).

Materials: corrugated siding, standing-seam metal roof, stucco columns,
weathered timber, gravel and mud, a wet concrete apron with puddles carrying
inverted sign reflections. Rust, mould streaks, chipped paint, sagging cables.

Structure and street: 1-2 storeys, 15-20 deg metal roof with 0.8 m eaves, rooms
on a ~4 m module, an oversized 10 m pole sign at the driveway edge, pool and
fence behind. Unmarked apron, kerbless gravel edges, orange barrels and jersey
barriers around dug-up ground, one utility pole with drooping drop lines.

Storytelling: richest in the set — bulb-chase arrow with dead bulbs, jalousie
blinds leaking warm light between slats, satellite dish on the eave, rubbish
bag, dog, a person with a torch, an open pool umbrella, ivy up the wall.

### 1.5 Bay and skyline from the air (`...5snx.1200.webp`)

Light and grade: midday, high sun; sky column top to horizon `#598CBD`,
`#73A4CA`, `#93BDD4`, `#B7D1DD`, `#D2DDE0`. Cumulus with flat bases, short hard
shadows, intense water specular. Cool, clean, high-key; sand and roofs are the
only warm notes.

Materials and structure: water in three depth bands (shallow `#52889D` to
`#68879A`, mid `#2D6B94`, deep `#1F2B37`), pale concrete causeway on piers at
~20 m spacing, dark mangrove mass (`#1D222E` in shade), light sand with a
darker wet tideline band.

Depth, the key lesson: the distant skyline (`#ADC6D6`) sits within a few
percent of the horizon sky (`#A8C4D4`). Distance comes almost entirely from
contrast fading toward sky colour, not geometric detail.

---

## 2. Proposed original art direction

### 2.1 The place

**Salterra** — an invented subtropical port city on the *west*-facing shore of
**Verano Bay**, so the sun sets over water. Humid, storm-prone, salt-worn;
founded on shipping, re-skinned by tourism, never fully repainted.

| District | Character | Archetypes |
| --- | --- | --- |
| Solaz Strip | Beachfront hotel wall, promenade, neon | A1, A3 |
| Calle Verde | Low-rise commercial grid, bodegas, murals | A3, A8, A2 |
| Mirador | Mid-rise offices, towers, plazas | A5, A6, A10 |
| Old Quay | Working port, warehouses, rail spur | A7, A10 |
| Cypress Flats | Motels, stilt cottages, wetland edge | A4, A9 |

> **SUPERSEDED — the shipped build is a high summer afternoon, not golden hour.**
> The golden-hour direction below is kept because the sampled references and the
> grammar still hold, but the time of day was changed on request: the city read
> as too dark. A sun at 11 degrees puts most north and east facades in their own
> shadow and pushes everything through an orange filter that ACES then crushes.
>
> Shipped values (see `src/render/Sky.ts`, `src/render/Lighting.ts`, `src/core/Engine.ts`):
>
> | | golden hour (was) | summer afternoon (now) |
> |---|---|---|
> | Sun elevation / azimuth | 11 deg / 255 deg | **54 deg / 246 deg** |
> | Sun colour / intensity | `#FFD2A1` / 3.1 | **`#FFF4E4` / 3.5** |
> | Hemisphere sky / ground | `#9CC4E8` / `#8A7358` @1.7 | **`#B2D4F2` / `#9C8A70` @2.5** |
> | Bounce | `#C98A57` @0.52 | **`#BFAB8E` @0.6** |
> | Horizon and fog colour | `#D8C3A4` | **`#DDE6EA`** |
> | Fog density | 0.0022 | **0.0016** |
> | Tone-mapping exposure | 1.12 | **1.15** |
>
> Exposure was set by measurement rather than eye: across six street-level
> vantages the shipped grade gives a mean luma of 55-106 out of 255 with zero
> blown-out pixels and under 7 per cent crushed to black.

**Hero time for the build: 17:40, late golden hour** — long readable shadows,
strong warm/cool separation, one cheap directional light, and it flatters
pastel stucco. **Stretch preset: 19:55 "Neon Dusk"**, the references' strongest
look, but it costs a light budget and a bloom pass.

### 2.2 Lighting recipe — preset A, "Golden Hour" (primary)

Renderer: `outputColorSpace = SRGBColorSpace`; albedo/emissive textures
`SRGBColorSpace`, roughness/metalness/normal/AO `NoColorSpace`;
`toneMapping = ACESFilmicToneMapping`, `toneMappingExposure = 1.05`;
`shadowMap.type = PCFSoftShadowMap` with exactly one shadow-casting light.

Sun (`DirectionalLight`): elevation **11 deg**, azimuth **255 deg** (clockwise
from north; north = −Z, east = +X), direction `(−0.948, 0.191, 0.254)`. Place
the light at `dir * 400`, re-target to the player each frame. Colour `#FFD2A1`,
intensity **3.1**. Shadow: ortho half-extent 90 m, near 1, far 900, map 2048,
`bias −0.0005`, `normalBias 0.02`; never widen past 120 m.

Fill and bounce, as ratios of sun = 1.00:

- `HemisphereLight` sky `#9CC4E8`, ground `#8A7358`, intensity **0.85** (0.27).
- Fake bounce `DirectionalLight` from `(0.62, −0.10, −0.78)`, colour `#C98A57`,
  intensity **0.34** (0.11), `castShadow = false`.
- No `AmbientLight`. With an environment map, replace the hemisphere light and
  set `envMapIntensity = 0.9`.

Sky gradient stops by elevation angle — 90 deg `#2E6DA8`, 60 deg `#4E8FBE`,
35 deg `#7BA8C4`, 15 deg `#C0B49B`, 6 deg `#E7B77C`, 0 deg `#F7D8A6`, sun disc
bloom `#FFEBC8`. Dither ±1/255 to kill banding; never a flat background colour.

Fog: `FogExp2`, colour `#D8C3A4` — must equal the 6-15 deg sky stops or the
silhouette-against-sky trick fails — density **0.00095**. With
`f = 1 − exp(−(d·rho)²)` that is 50 % at 876 m, 90 % at 1597 m; push toward
0.0016 for a storm mood. Stretch: height-attenuated fog so towers rise out of a
ground haze layer.

Grade targets: moderate saturation; warm anchor in sunlit stucco and sand, cool
anchor in shadow and glass; black level lifted to ~`#101418`; bloom threshold
**0.85**, strength **0.35**, radius 0.4.

### 2.3 Lighting recipe — preset B, "Neon Dusk" (stretch)

Sun elevation **−5.5 deg**, azimuth 262 deg; `DirectionalLight` `#4C6FA6` at
intensity **0.30**, still the only shadow caster (long, very soft, low
contrast). `HemisphereLight` sky `#6B5A86`, ground `#2A2230`, intensity
**0.55**. Sky stops zenith to horizon `#172530`, `#1F313F`, `#253B49`,
`#344B5B`, `#53696F`, `#6D8180`, blending toward a light-pollution lid of
`#9A6E78` within 25 deg of the city-centre direction. `FogExp2` `#4B3E58` at
density **0.0016**; exposure **1.15**; bloom threshold **0.62**, strength
**0.62**. Budget **28** dynamic point/spot lights allocated by distance; beyond
that use emissive material plus a painted bounce quad on the ground. Sign
emissive 2.5-4.0, never fully saturated — `#FF3EA5` not `#FF00FF`, `#3FE8E0`
not `#00FFFF`.

### 2.4 Material palette (albedo sRGB; metalness 0 unless stated)

| Surface | Albedo | Rough | Notes |
| --- | --- | --- | --- |
| Asphalt fresh | `#3A3A38` | 0.92 | wheel paths 0.68, 6 % lighter |
| Asphalt weathered | `#4A4945` | 0.95 | patch quads `#2E2E2D` |
| Sidewalk concrete | `#C4BEB2` | 0.88 | 1.5 m scored panels |
| Kerb face | `#CFC9BD` | 0.85 | painted band `#E0B341` |
| Stucco pastels | `#BFD9C8` `#E4A8A0` `#EFE3C8` `#E0CBA6` `#B9D2DE` `#E08A6E` | 0.90 | six-colour set |
| Board-formed concrete | `#A8A49B` | 0.82 | 1.8 m board lines |
| Painted metal | `#2C6E7A` `#B4433C` `#D9D4C8` | 0.45 | metalness 0.6 |
| Corrugated siding | `#8E8C84` | 0.55 | metalness 0.4, rust below fixings |
| Glass | `#22303A` | 0.06 | env reflection carries it |
| Roof gravel/tar | `#55534C` | 0.98 | always seen from towers |
| Sand dry / wet | `#DCCDA9` / `#A89574` | 0.95 | tideline band |
| Palm frond lit / shade | `#4E6B3A` / `#2C3E24` | 0.75 | dry frond `#8A7A46` |
| Broadleaf, mangrove | `#3D5A34` | 0.80 | deep shade `#1D222E` |
| Grass patchy | `#6E7A4A` | 0.90 | bare wear `#7A6A4E` |
| Water shallow / deep | `#2E9AA8` / `#17394F` | 0.05 | three depth bands |

Nothing ships at roughness 0.5 with a single flat colour: every material needs
a texture, a ±6 % vertex-colour tint variation, or a large-scale noise multiply.

### 2.5 Architectural archetypes

**A1 — Deco Eyebrow Hotel** (Solaz Strip). 3-5 storeys at 3.4 m; 18-30 m
frontage x 26-40 m deep; painted pastel stucco; windows 1.2 x 1.6 m on a 3.6 m
module grouped 3-4-3 around a wider centre bay; eyebrow slab at every floor line
projecting 0.9 m; rounded corner bay on 30 %; stepped parapet 1.0-1.8 m with a
fin carrying a blade sign; ground floor recessed 3 m as a loggia, three steps
up, canvas awning, 6-12 café tables.

**A2 — Stucco Courtyard Walk-Up.** 2-3 storeys; 22-34 x 22-30 m around an
8 x 10 m open court; painted CMU; external 1.4 m gallery corridor with steel
rail on one long side; jalousie windows on a 3.0 m module, one per unit plus a
door; flat roof, 0.4 m parapet, rooftop tank and AC cluster; ground floor is
undercroft parking or a fenced court with laundry lines and bikes.

**A3 — Taxpayer Strip.** 1-2 storeys; 30-60 m frontage x 14-20 m deep; painted
concrete with a continuous 1.2 m fascia band carrying all signage; 4-7 tenant
bays of 6-9 m, each full-height glazing plus a roll-down shutter box; continuous
awning at 3.2 m projecting 2.2 m; blank rear wall onto a service alley with
dumpsters and a stooped rear door.

**A4 — Neon Motor Lodge** (Cypress Flats). 1-2 storeys, L or U plan around a
parking court, wings 40-70 x 12 m; corrugated or board-and-batten siding;
standing-seam roof at 16 deg with 0.8 m eaves; room module 4.2 m (door, 1.5 m
window, wall AC sleeve); 9-12 m pole sign at the driveway with a bulb-chase
arrow; pool, fence, ice machine, vending alcove in the court.

**A5 — Mid-Rise Slab** (Mirador). 8-16 storeys at 3.6 m; 24-40 x 18-26 m;
ribbon curtain wall on a 1.5 m mullion module with spandrel panels; 2-3 storey
board-formed podium with 1.5 m reveals; roof carries a mechanical penthouse
3-4 m tall inset 3 m, a comms mast and a washing rail; ground floor is
double-height lobby glazing on a 6 m stone plinth, porte-cochère on 40 %.

**A6 — Waterfront Tower.** 22-40 storeys at 3.2 m; 28-40 x 28-40 m; continuous
balcony slabs projecting 2.2 m on the bay side with glass balustrades; blank
service-core wall on one side; flat crown with a 6 m parapet ring uplit at
night; base is a five-storey parking podium screened with horizontal louvres —
put the affordable detail there, since it is what the player actually sees.

**A7 — Warehouse / Working Quay.** One storey but 7-11 m tall; 40-90 x 25-45 m;
tilt-up concrete panels with joints every 6-8 m, or corrugated steel; shallow
gable or sawtooth roof; no openings below 4.5 m except a three-window office bay
at a corner; 3-5 roll-up doors at 1.2 m dock height with rubber bumpers,
bollards, pallets, stacked crates and a stencilled door number.

**A8 — Corner Bodega / Filling Station.** One storey, 8-14 x 10-16 m; painted
CMU with one blank side carrying a hand-painted mural or faded ghost sign; two
windows plus a full-glass door, security bars on 50 %; flat roof, 0.5 m
parapet, oversized box sign, coolers and crates outside. Filling-station variant
adds a 12 x 8 m canopy at 5 m clear with two pump islands.

**A9 — Stilt Cottage** (Cypress Flats). 1-2 storeys, 9-14 x 8-12 m, raised
1.2-2.4 m on concrete piers; lap siding; hipped metal roof at 22 deg; wrap porch
2.4 m deep with slender posts and a screened section; shell or gravel driveway,
a boat trailer on 30 % of lots, propane tank, leaning mailbox post.

**A10 — Civic Concrete Block.** 3-6 storeys, 40-70 x 30-50 m; faceted massing
with stepped plan offsets of 3-6 m; board-formed or precast concrete; few but
very large openings with 1.5 m reveals; ground floor is a colonnade of 0.9 m
square piers on a 7.2 m grid with a raised plaza, steps, low planter walls and
one large lit panel on a blank flank.

Distribution: A3 and A2 together ~55 % of buildings by count; A1 concentrated in
one district; A5 and A6 under 8 % of the total but placed to close every long
sightline.

### 2.6 Street and block grammar

- Blocks 110 x 70 m, short side to the avenue; 4 m service alleys splitting 35 %
  of them; offset every fourth cross-street by 8-14 m so no sightline runs
  perfectly straight beyond ~600 m.
- Right of way: local 16 m (2 x 3.2 m lanes, 2.2 m kerb parking each side, 2.5 m
  sidewalks); collector 24 m (4 x 3.3 m, 2 m median, 3.5 m sidewalks); Solaz
  Boulevard 34 m (4 lanes, 4 m planted median with palms at 12 m, 8 m promenade
  on the beach side).
- Kerb 0.15 m high with a 0.45 m gutter pan 8 % darker than the lane; sidewalk in
  1.5 x 1.5 m scored panels with 0.02 m joints; tree pits 1.2 x 1.2 m.
- Markings: dashes 3 m painted / 9 m gap at 0.12 m wide; edge lines 0.15 m;
  double yellow centre 2 x 0.10 m with a 0.10 m gap; stop bars 0.6 m; zebra bars
  0.6 m wide at 0.6 m gaps; turn arrows 25 m back from the stop bar.
- Kerb inlets every 40-60 m at low points, each with a dark stain fan downstream.
- Streetlights: 9 m mast, 2.4 m arm; 32 m staggered on collectors, 26 m
  single-side on locals; 2200K on the strip, 3800K elsewhere.
- Utility poles: 11 m, every 40 m on alleys and secondary streets, three sag
  catenaries plus drop lines to buildings, a transformer can on every fourth.
- Wear: one 1.5-4 m patch quad per 30 m of lane; two 0.9 m polished wheel paths
  per lane; a lighter 0.6 m strip along the kerb where tyres never run.

### 2.7 Vegetation rules

- Tall feather/fan palms: 9-16 m clear trunk tapering from 0.35 m, crown 5-7 m
  across with 14-22 fronds and 1-3 dead brown ones hanging. Beyond 120 m they
  must still read as a dark comma against the sky — build the LOD backwards from
  that silhouette.
- Short fan palms 2.5-4 m as planter understory; broadleaf street trees 7-11 m
  with dense round crowns at 9 m spacing in the residential grid; mangrove and
  scrub hedges 1.2-2.5 m along water edges and vacant lots; reeds 0.8-1.6 m in
  wetland.
- Never a uniform grid: ±1.8 m jitter, a 12 % skip rate and a 15 % double rate so
  clumps and gaps emerge; random yaw, ±15 % scale, per-instance vertex-colour hue
  ±4 deg and value ±8 %.
- One flowering vine mass (magenta `#C43C86` or coral `#E0704E`) per ~3
  residential buildings, always on a fence or wall corner, never centred.
- Turf is never uniform: mix `#6E7A4A` with bare `#7A6A4E` wear paths along
  desire lines.

### 2.8 The 20 highest-payoff details, ranked

Effort: S = texture/decal/param, M = small mesh plus placement rule, L = system.

1. **Wheel-path polish and kerb dust strips on asphalt** (S) — roughness map
   alone converts a flat grey plane into a used road.
2. **Kerb, gutter pan, 0.15 m step, painted kerb bands** (S) — strongest "real
   street" cue available; three extruded quads.
3. **Emissive signs with a bounce quad painted on the ground below** (M) — fakes
   GI and carries the entire night look.
4. **Awnings and roll-down shutters on every ground-floor bay** (M) — two quads
   and a box redefine the street-level read.
5. **Wall AC units and rooftop condenser clusters** (S/M) — one instanced box
   sells "lived-in tropical" better than any other prop.
6. **Utility poles with sagging catenary cables** (M) — 3-segment quadratic sag;
   adds foreground overlap and breaks empty sky.
7. **Sidewalk panel joints plus a crack and stain decal set** (S) — tri-planar on
   a 1.5 m grid; kills the extruded-plane look.
8. **Palms clumped, one hero silhouette per view** (S) — placement rule only.
9. **Kerb parking at 60-70 % occupancy, yaw jitter ±3 deg** (M) — fills the
   street edge and gives scale reference everywhere.
10. **Alley clutter kit: dumpster, pallets, crates, barrels, cable spool** (M).
11. **Roof clutter: parapet, vent stack, water tank, dish** (M) — decides every
    elevated view.
12. **Storefront interior parallax cards behind glass** (S) — removes dead black
    windows; one texture per shop type.
13. **Puddle decals with a cheap planar or cube reflection** (M) — doubles the
    perceived light count at night.
14. **Balcony clutter on 30 % of balconies: chair, towel, plant** (S/M).
15. **Ground decals: manhole, grate, oil stain, skid, spill, stencil** (S) — one
    per 15-25 m of road.
16. **Dirt dado: 0.6 m grime gradient at the base of every stucco wall** (S) —
    one shader term applied globally.
17. **Rust and water streaks below every sill, drain and roof fixing** (S).
18. **Kerb-drifted litter and leaf scatter from three alpha cards** (S).
19. **Vertical blade signs on corner buildings** (M) — reads as "city" at 200 m.
20. **Far-field motion: bird flocks, one distant aircraft, swaying fronds** (M) —
    cheap, and its absence is what makes worlds feel dead.

### 2.9 What to avoid (the AI/low-poly demo tells)

- Flat-colour untextured boxes with sharp 90 deg corners at every scale; every
  mass needs a parapet, a base plinth and at least one reveal or setback.
- Uniform heights, identical footprints and spacing, instances repeating on a
  visible cadence.
- A single white `DirectionalLight` at 45/45 plus a strong `AmbientLight` — the
  most recognisable tell of all.
- `NoToneMapping` or linear tone mapping at exposure 1.0: the sky clips and
  every surface reads plastic.
- Colour-space mistakes — albedo not flagged `SRGBColorSpace`, or data maps
  wrongly flagged as sRGB.
- Fog colour that does not match the horizon sky; grey fog under a blue sky is
  the second most common tell.
- Roads with no kerb, sidewalks with no height step, intersections meeting at a
  perfect 90 deg with no offset, missing road markings.
- Vegetation as green cones and spheres, palms as a cylinder plus a sphere,
  identical trees at identical spacing.
- Sky as a flat background colour, or a gradient with visible banding.
- Neon at fully saturated `#FF00FF`/`#00FFFF` with no falloff and no coloured
  bounce; equally, bloom on everything via a low threshold, or emissives with no
  bloom at all.
- Visible 1-2 m texture tiling with no large-scale break-up.
- Wear on 100 % of surfaces; keep ~70 % clean and let 30 % carry the story, or it
  reads as an apocalypse rather than a city.
- Chromatic aberration, heavy vignette and film grain as a substitute for art
  direction.
- An empty horizon: no distant skyline plate, no water, no elevated road.
- Any sign copy, brand, wordmark, place name, character or landmark taken from a
  reference. Invent every piece of in-world text.

### 2.10 Verification checklist

1. Distant skyline within ~10 % value of the horizon sky, fog colour equal to
   the 6-15 deg sky stop.
2. Shadows long, soft, warm-lit, never pure black.
3. At least four different roof heights in any street view.
4. Ground shows wheel paths, a kerb step and at least one decal.
5. Something overlaps the frame edge in the foreground.
6. At least three depth layers with haze between them.
7. A random one-second crop reads as a specific place, not a demo.

---

## 3. The sky, 2026-08-31

### 3.1 The defect: it had never been drawn

`Sky` builds a five-stop dithered gradient, a broad sun glow and a tighter
core, on a dome of radius **4000 m**. `Engine`'s camera has a far plane of
**1200 m**. The dome was outside it, was clipped in its entirety on every frame
the game has ever rendered, and every sky pixel came from `scene.background` -
a single flat `HORIZON_COLOR`.

That is item one on the "what to avoid" list in section 2.9, and it was in the
build the whole time. Nothing about it was visible in a screenshot review,
because a flat pale sky under a hazy summer brief looks like a deliberate hazy
summer sky.

**The fix is the radius, and only the radius.** The dome follows the camera and
is drawn first with `depthWrite: false` and `renderOrder: -1000`, so how far
away it is has nothing to do with what it can occlude: everything in the world
draws over it regardless of distance. It only has to be INSIDE the far plane.
1000 m leaves 200 m of margin at the frustum corners.

The image-based lighting was never affected: `createEnvironment` renders the
same dome in its own scene with an explicit far plane of `radius * 2`, which is
why the city's PBR surfaces have always been lit by a sky nobody could see.

### 3.2 And it was never tone-mapped either

Two more things about the sky turned out to be wrong the moment it became
visible, and both are in the same category: the sky was not going through the
pipeline every other surface goes through.

**The shader wrote raw linear values.** The gradient stops are authored in sRGB
and converted to linear, which is right - and then the fragment shader assigned
them straight to `gl_FragColor`, skipping the ACES curve and the
linear-to-sRGB conversion that `MeshStandardMaterial` gets for free. The sky
therefore rendered about a stop and a half dark and noticeably more saturated
than the values it was sampled from, and - the part that matters - it could not
match the scene fog at the horizon, because the fog colour DOES go through the
standard path. `#include <tonemapping_fragment>` and
`#include <colorspace_fragment>` at the end of `main` fix it; `ShaderMaterial`
already gets `toneMapping()` and `linearToOutputTexel()` in its prefix.

The stops were then re-tuned deeper and more saturated, because ACES lifts and
desaturates a mid blue hard: the sampled `0x2f6ec2` zenith came out as a pale
wash. `uHorizon` is the one that must NOT move - it is `HORIZON_COLOR`, the
same constant the fog is built from, and equal inputs through equal curves is
what makes the two meet invisibly.

**The environment map was tagged with the wrong mapping.**
`PMREMGenerator.fromScene` returns a CubeUV atlas and has already set
`CubeUVReflectionMapping` on it; `createEnvironment` overwrote that with
`EquirectangularReflectionMapping`, which told every PBR shader in the city to
read a packed cube atlas as a latitude-and-longitude image. Every reflection in
the game was sampling the wrong texels, and it went unnoticed for exactly as
long as the sky dome was clipped away and there was nothing recognisable in the
reflection to be wrong.

### 3.3 Clouds

A cloudless gradient is the second tell in 2.9 and the sky is about a third of
an outdoor frame, so the dome now carries broken cumulus:

- **Projection.** A view direction is pierced through a horizontal plane above
  the camera - `dir.xz / dir.y` - so cells compress towards the horizon the way
  real ones do. The layer is faded out below 9 deg, where that compression turns
  into aliasing AND where the fog has to match the sky exactly, and again above
  72 deg where the projection stretches.
- **Shape.** Three octaves of value noise, domain-warped by a fourth sample, so
  the cells have torn edges rather than the smooth blobs a raw fbm gives.
- **Light.** The same field sampled 0.35 units towards the sun stands in for
  self-shadowing: where the sunward sample is thinner this is an edge and takes
  the light, where it is thicker it is in shade. That one extra sample is the
  whole difference between cumulus with volume and grey paint. A `cos^6` term
  on the sun direction adds the silver lining.
- **Motion.** A few metres per second at the notional altitude, from the same
  `elapsed` clock everything else animates on. Item 20 on the ranked list is
  "far-field motion... its absence is what makes worlds feel dead".

Three octaves rather than four is a measured choice: the fourth contributes an
amplitude of 0.0625 to a value that is then put through a `smoothstep` with a
0.15 window, so it is worth about a third of a shade of grey and a quarter of
the layer's cost.

**Measured**, Harbourside promenade looking north-west over the bay, 1206 x 1968
drawing buffer, 90 frames: mean 3.43 ms, median 3.30, p95 4.10, worst 4.60;
323 draw calls; 172 MB. The sky is one draw call and the clouds are a fragment
cost on it.

### 3.4 Shopfronts

Item 12 on the ranked list - "storefront interior parallax cards behind glass,
removes dead black windows" - implemented as geometry rather than as a texture,
because the city has no texture pipeline and a 0.85 m diorama is nine quads.

Every shopfront bay now holds a closed box behind its glazing: back wall,
floor, ceiling, two returns, a counter across the front third, two shelves of
stock in alternating tones, and a warm strip light against the ceiling. The
glass went from opaque near-black to a tinted transparent pane with a raised
`envMapIntensity`, so it picks up the sky as well as showing the shop.

The box is closed on every side on purpose: an open one shows the inside of the
building's own shell at any angle off the perpendicular. At 0.85 m it is inside
the wall and threshold zone of every archetype and can never meet an enterable
building's real interior.

The strip light matters more than it sounds. No light in this scene reaches
through a 1 m opening in a facade, so without an emissive INSIDE the box every
shop is a black room whatever colour its wall is.

### 3.5 Planting

The street planters were a concrete trough, a gravel bed and two foliage lumps
with nothing in them, which is a shrub in a box rather than planting. They now
carry blooms: small icosahedra sitting ON the canopy hull rather than inside
it, spread by the golden angle so they never land on a lattice, biased to the
upper half of each lobe because that is where a bedding plant flowers.

**Two colours, alternating.** One saturated colour repeated in every planter on
every street reads as a decal; warm against cool is also the pair that survives
the tone map, since a single mid-pink goes to mud in shadow and to white in the
sun. `blossom` and `blossomWarm` are the only fully saturated albedos in the
palette outside the signage, and that is deliberate: a flower bed that is not
brighter than the leaf behind it is just more leaf.

Nine blooms is 180 triangles against the props' 400-triangle ceiling, and two
draw calls for every planter in the city. The placement is deterministic in the
prop's own coordinates, because the variety in an instanced prop has to come
from the arrangement rather than from a per-instance roll.

### 3.6 Ghost signs

A party wall's blind bay - "the panel a real party wall carries a ghost sign
on" - was filled edge to edge in the building's trim colour. On a four-storey
flank that is a two-by-six-metre rectangle of flat grey in the middle of a
coloured facade, and it reads as a texture that failed to load: the single
largest untextured surface anywhere in the city.

It is now a painted field with a border and two bands at the proportions a real
painted sign uses, in colours the building already carries - six quads and no
new material key. **No text is drawn**, here or anywhere else in the city, so
nothing has to be invented, translated or licensed.
