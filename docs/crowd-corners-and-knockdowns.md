# Corners, crossings and knock-downs

Two things a player noticed about Meridian Bay's crowd: people got stuck at
corners and at the places you would cross the road, and driving into somebody
did nothing at all. Both are fixed. This is what was wrong, what was measured,
and what another workstream still has to connect.

## Part one: the sticking

### How it was found

Every existing crowd test ran with **no vehicles in the context**. The shipped
game passes 240 of them (`main.ts` builds `crowdCars` from `traffic.vehicles`
and hands them to `pedestrians.update`), and the whole crossing gate is a
function of that list, so the entire vehicle path was unexercised. Re-running
the ten-minute soak with a live `TrafficSim` alongside the crowd changed the
answer completely.

| stalls over 10 minutes, 270 people | before | after |
| --- | ---: | ---: |
| over 5 s | 857 | 391 |
| over 10 s | 571 | 124 |
| over 30 s | 339 | **0** |
| over 60 s | 202 | **0** |
| worst single stall | **581.8 s** | 25.5 s |

Measured on world displacement over a rolling four-second window and
**including the `wait` state**, because a player cannot see a state name - they
see a person at a corner who is not moving. The older
`tests/crowdDeadlock.test.ts` excludes `wait` on the grounds that waiting is
deliberate and bounded by the signal cycle. With no vehicles that was true.
With them it was false, and that exclusion is why the previous pass measured
zero stalls while the player was still watching people stand still.

Without traffic, for reference: 168 → 170 over 5 s, worst 13.6 s → 12.7 s. The
regression was never visible without cars.

### Mechanism 1 - the crossing gate vetoed on a circle

`Crowd.crossingClear` rejected a crossing whenever any vehicle's centre came
within `link.length / 2 + 2.4` of the crossing's centre. At a typical junction
here that is 11.15 m, which is larger than the junction. Inside it sit:

- the queue stopped at the red, whose nose `TrafficSim` parks 0.4 m short of
  the crossing by construction (`stopAlong = crossingAlong - 0.4`);
- the traffic on the cross street, confined to its own carriageway and unable
  to touch this strip at all;
- anything merely passing nearby.

And `walkSignal` is true *precisely when* the traffic on this carriageway is
stopped - which is when that queue exists. The two conditions were very nearly
mutually exclusive.

> Measured over three minutes with 240 vehicles and 270 people: of **118,098**
> frames in which somebody stood at a kerb with the walk signal in their
> favour, **117,809 were vetoed and 1 was clear**. 51.6 per cent of the vetoes
> were a *stopped* vehicle; 78.8 per cent were a vehicle nowhere near the
> strip; a moving vehicle actually on the crossing accounted for 1.1 per cent.

The test is now the crossing's own rectangle - `link.length` kerb to kerb by
twice the walkable half width along the street - swept against each vehicle's
own oriented box over the time we would be exposed. Two 1-D slab clips, exact
for a constant velocity, so no sampling interval can step over a fast car.

The margin matters more than the shape. Inflating the vehicle isotropically by
its circumradius - the obvious conservative choice - adds a car's half *length*
to the axis where only 0.4 m exists and puts every correctly stopped car back
inside the box; measured that way, 401 of 1,311 waits still ran to the full
patience timeout. So a **moving** vehicle gets a shoulder plus half a metre and
a **stopped** one gets only a shoulder: a car that is not moving cannot run
anybody over, and the only thing it can do is physically block the strip, which
needs no margin at all to detect.

### Mechanism 2 - half the pavement graph was disconnected

`buildPavementGraph` merges stations that land within 0.25 m of each other. At
every junction a *corner* station (at `roadHalf + sidewalk / 2`) and a
*crossing* station (at `roadHalf + 1.6`) land 0.20 m apart on this city's 2.8 m
pavements, so `sort` order alone decided which survived - and the survivor took
the other's place.

- An arm whose crossing sorted first lost the **corner turn**: `harbour-walk`'s
  node at z = -24.60 had no `cooper-street` link leaving it at all.
- An arm whose corner sorted first lost the **crossing**, which was then built
  0.20 m off the chain and shared no node with it.

> Measured on the unfixed graph: **100 of 964 links** - 50 whole crossings,
> more than a quarter of the city's - could reach nothing but themselves and
> their own reverse. Strongly connected components over the open links: **57,
> the largest holding 434 of 962**. Dead-end links: 128.
>
> After: **3 components, the largest holding 962 of 962** (the two singletons
> are the links street furniture has closed). Dead ends: 8. Zero links with a
> reachable world under 24 links.

The corner's position is now the one that survives a merge, whichever was seen
first, because it is where the cross street's own chain has its node and moving
it breaks the turn. Each crossing link is then built to the station its kerb
actually ended up on, rather than to the crossing's ideal coordinate.

### Mechanism 3 - a grazing contact was treated as a blockage

`ObstacleIndex.resolve` reports a hit for any overlap at all, including the
grazing one where the disc touches the box and the correction is a fraction of
a millimetre. `Crowd.step` treated that as something to walk around, and the
result was self-sustaining: the slide cancels exactly the velocity that would
have carried the walker into the prop, so they never penetrate, so the push
stays at zero, so the slide runs again - and `dodge`, refreshed on the same
branch, holds off the corner hand-off for as long as it lasts.

> Traced at the vestry-street corner: `resolve` returning true with a push of
> (0.00, 0.00) for hundreds of consecutive frames while the walker ground along
> at 0.1 m/s, covering 0.19 m in 12 s.

Below a centimetre of correction there is nothing to walk around.

### Mechanism 4 - the shuffling floor was applied too early

`step` has a deliberate floor of 0.22 m/s so a jam cannot be absorbing. It was
applied inside the neighbour block, where the vehicle factor then multiplied it
away. `avoidVehicles` measured from the chassis *centre* with an isotropic
clearance of nearly three metres - drawn to the long axis of a 4.6 m car - which
on this city's narrower streets reaches the far pavement. Anybody walking past
a queue at a red light was held at a tenth of a metre a second for as long as
the queue lasted.

The floor is now the last word, and only a vehicle bearing down (a factor of
exactly zero) may go below it. The near test is the chassis box, not a circle
round its centre, and on a carriageway a near miss makes somebody *run* rather
than stop dead - stopping in front of a car is the worst available option and
the branch below already knew that.

### Mechanism 5 - a wait was unbounded, and a give-up was not a give-up

`watchStall` deliberately does not police a `wait`, because waiting is a
decision rather than a failure. That made `wait` the one state that could last
for ever. There is now a hard bound of one signal cycle: somebody who has been
offered a complete walk phase and still has not moved walks on instead.

That alone was not enough. The corner stubs on this city's pavements are 0.9 to
1.7 m long, so a walker who declines a crossing reaches the next node a second
later and is offered the same crossing again - traced as two agents cycling
give-up, walk 1.6 m, wait 26 s, give up, for forty seconds at a stretch. A
give-up now carries a 14 s cool-down on crossings generally.

### What was tried and rejected

A "do not start what you cannot finish" gate is the obvious answer to people
being caught out mid-crossing: the walk phase is 14.5 s and the widest crossing
here is 27 m, which a slow walker cannot clear inside one phase however early
they set off. It was implemented, measured and removed.

> Over ten minutes with 240 vehicles, refusing every crossing somebody could
> not finish in time changed the number of people struck from 208 to 210 and
> more than doubled the number left standing at a kerb: stalls over 5 s went
> 379 → 888, give-ups 73 → 209.

It prevents nothing because the collisions are not caused by the lights
changing. Of 210 knock-downs classified by the striking vehicle: **20 per cent
were traffic turning off the cross street**, which has a green at exactly the
same time as the walk signal, and **37 per cent were cars clearing the junction
across the far crossing during the 1.5 s all-red**. Neither is visible to a
pedestrian in advance and neither is fixable from inside `src/agents`.

## Part two: knock-downs

A vehicle that touches somebody now knocks them off their feet.

- **Detection is a real collision.** `vehicleOverlap` is the chassis as an
  oriented box, aligned with where the vehicle is going, grown by a shoulder
  and six centimetres. A vehicle below 1.6 m/s cannot knock anybody over. This
  is what makes it safe to hang a wanted level on: driving past a bus queue
  cannot fire it. `tests/crowdKnockdown.test.ts` holds that contract.
- **They are thrown along the vehicle's line of travel** at 55 per cent of its
  speed, capped at 6 m/s, and scrub off on the ground. They topple *away* from
  the blow: shoved the way they were facing goes onto the face, shoved against
  it goes over backwards.
- **Under 7 m/s (25 km/h) they get up** after about eight seconds; at or above
  it they are a casualty and stay down. That threshold is where real
  survivability starts to fall away, and it gives the player feedback about how
  hard they hit somebody. A casualty's pool slot is reused after 60 s, but only
  once the player is more than 42 m away, so nobody watches a body blink out.
- **A shot civilian goes down the same way**, through the same state, via
  `PedestrianSystem.downAt`.

### How it stays batched

The crowd is 270 people in six draw calls because every person is an instance
of one of four `InstancedMesh`es playing a vertex animation texture. A body on
the ground is **the same instance of the same mesh**: the topple is folded into
the 3x3 of the instance matrix that already carried the heading and the build,
as `Ry(heading) * Rx(tilt) * scale(girth, height, girth)`. `tilt` is zero for
everybody upright, which collapses to exactly the yaw-and-scale form the crowd
wrote before.

Verified in the browser with three bodies on the pavement: four visible
pedestrian meshes, `pedestrians-0` to `pedestrians-3`, exactly as with none.

The one compromise: a downed body holds the idle clip, frozen at that person's
own phase offset. The VAT machinery has no slump to play and baking one would
cost a new clip in every character file. It reads clearly as a body on the
ground, and it does not breathe.

### Cost

`crowd.update` over 3,600 frames at 270 people and 141 vehicles, after a
60 s warm-up:

| | mean | median | p95 | max |
| --- | ---: | ---: | ---: | ---: |
| before | 0.107 ms | 0.109 ms | 0.168 ms | 0.739 ms |
| after | **0.101 ms** | 0.108 ms | 0.140 ms | 0.733 ms |

No added cost. The knock-down sweep is one grid walk per player-driven vehicle,
and it is more than paid for by the people who are no longer stuck in the
expensive congested states - `waiting` fell from 57 to 11 in the same run.

In the browser, `stats.updateMs` sits at 0.10 to 0.16 ms with 270 people.

## Wiring another workstream still has to do

Neither of these is required for the features above to work. Both improve them.

### 1. The car should feel the hit (`src/player/Driving.ts`, `src/main.ts`)

```ts
pedestrians.onImpact = (hit) => {
  // `hit.vehicle` is the very object handed to `update` in `ctx.vehicles`, so
  // identity is enough to tell your own car from ambient traffic.
  if (hit.vehicle === crowdCars[playerCarIndex]) {
    driving.reportImpact(hit.speed, hit.dirX, hit.dirZ); // jolt + scrub speed
    player.addHeat(HEAT.vehicleImpact);                  // = 8, already defined
  }
};
```

`PedestrianImpact` carries `{ vehicle, index, x, y, z, speed, dirX, dirZ,
fatal }`. `index` is the position in the array passed to `update`.

Until it is wired, a knock-down still happens and is still visible - it simply
costs the player nothing.

### 2. Traffic should brake for people on a crossing (`src/main.ts`)

```ts
traffic.setObstacles(pedestrians.carriagewayObstacles());
traffic.setCrossingBlocked((id) => pedestrians.crossingBlocked(id));
```

Two lines, once, after both systems exist. `setObstacles` keeps the array by
reference and the crowd rebuilds it in place, so it never needs calling again.

**This is why only the player's vehicle knocks anybody down.** Nothing in the
shipped game makes a driver aware of a pedestrian, and the crowd cannot make up
the difference from its own side. Letting every car hit somebody on those terms
was measured at **210 knock-downs in ten minutes** - a third of the population
run over, none of it the player's doing and none of it avoidable. Once traffic
yields, set `Crowd.trafficStrikes = true` and ambient collisions work exactly
the same way.

### 3. Shot civilians should drop (`src/main.ts`)

```ts
new CrowdTargets(pedestrians.group, {
  removeAt: (x, y, z) => { pedestrians.downAt(x, y, z); },
});
```

`CrowdTargets` documents this hook as missing. `downAt` finds the nearest person
within a metre and puts them down permanently, and returns false if the pool
slot was recycled between the shot and the call.

## Limitations

- **Ambient traffic still passes through the crowd**, exactly as it always has.
  See wiring 2. This is a deliberate hold, not an oversight.
- **A body holds a standing pose lying down.** No slump, no ragdoll. See above.
- **The remaining stalls are corner congestion**, 5 to 25 s at the junctions on
  `harbour-walk` where six links converge on a 1.65 m stub of pavement. Nobody
  is deadlocked - the 30 s bound is asserted in
  `tests/crowdCorners.test.ts` - but a crowd is genuinely slow through a corner
  that narrow. Widening those stubs means changing the station spacing, which
  changes where every corner in the city is.
- **The crossing gate cannot see a turning car's intention.** It knows where
  every vehicle is and how fast, not which way it is about to turn at the
  junction ahead. That is the 20 per cent of collisions described above, and it
  is the traffic layer's to solve.
- **`downAt` matches by position**, like `CrowdTargets` itself. Two people
  within a metre of a bullet and the wrong one may drop.
