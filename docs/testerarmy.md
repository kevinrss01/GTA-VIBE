# TesterArmy coverage

The durable identifiers `AGENTS.md` asks to be stored, so a later session finds
this coverage instead of inventing new one-off prompts. **None of these is a
secret** — they are dashboard object ids, useless without the account's own
API key, which lives in `~/.config/testerarmy/config.json` and appears nowhere
in this repository.

| What | Id |
| --- | --- |
| Project — *GTA Vibe — Meridian Bay* | `e039ea49-386b-40a3-865d-b4c79a6c1b23` |
| Group — *Smoke* | `81fc41b7-a23a-413a-84e7-f71b943da402` |
| **Baseline** — *Meridian Bay smoke: the city is alive and you can move through it* | `3c3c8951-73f9-451c-9d3d-b8edfdc4efa5` |
| *Last Call — the first mission briefs, points and can be started* | `b9317604-a3e9-4029-ab94-74a6967961e2` |

The project URL is the GitHub repository, because the dashboard requires a
public HTTP(S) URL and this game has no deployment. Runs are therefore **local**
against a production preview on this machine.

## Running it

```bash
npm run build && npm run preview   # serves dist/ on http://localhost:4183
```

```bash
ta tests run --group 81fc41b7-a23a-413a-84e7-f71b943da402 --project e039ea49-386b-40a3-865d-b4c79a6c1b23 --local --url http://localhost:4183 --browser chrome --headed --json
```

**`--headed` is not optional.** A local run defaults to headless Chrome, which
cannot create a WebGL context, so the game correctly refuses to start and every
step fails on *"Meridian Bay needs WebGL, and this browser cannot provide it."*
That is the game reporting an unsupported browser, not a defect — but it costs
a whole run to find out. `--headed` gives Chrome a real GPU context and the
city loads.

Two more things the CLI will not tell you: **the dashboard rejects an em dash**
in a project or test name (it goes into a request header, and the CLI throws
`Cannot convert argument to a ByteString`), and the local runner writes a full
transcript to `.testerarmy/<timestamp>/result.json` — read that rather than the
`--json` summary, which reports only counts.

Then read the finished run, not the queue acknowledgement:

```bash
ta runs get <runId> --json
```

## The baseline is the accepted product, and only that

`3c3c...` covers what the game already promises and has promised for several
workstreams: it boots into daylight with music off, the player can walk, the
streets carry people and traffic, a parked car can be driven, and a building can
be entered. **Update it only when accepted behaviour changes** — not to make a
red run go green.

`b931...` is focused coverage for the story workstream and asserts the things
that workstream actually added: the title, the opening objective, the club
interior, Sable behind the bar, and the briefing moving the objective on to the
Cannery. It deliberately stops after the briefing; the drive, the pickup and the
payout are covered by `tests/mission.test.ts`, which plays the whole job in
milliseconds and does not depend on an agent successfully driving a car across
two districts.

## What the runs established, and where they stopped

Run against the production preview, headed:

| Test | Steps passed | Where it stopped |
| --- | --- | --- |
| Baseline smoke | 7 of 8 | Per-step tool-call budget, walking to a car |
| Last Call | 4 of 5 | Per-step tool-call budget, walking to the club |

Both reached their assertions and both ran out of budget on **traversal**, not on
anything the game did. The passing steps are worth having: daylight, cash,
`Music: Off`, walking, cars on the road, *"Multiple pedestrians are visible
walking on the pavements"*, the `GTA Vibe` title and tab title, and the opening
objective card with its exact copy. The runner also confirmed it had seen
*"Press E to drive the van"* and pressed E before the budget ran out.

The steps were then split so each traversal has its own budget — one short move
per step, and the key press that follows it in a step of its own. That is the
skill's own "one clear job per step" rule, not a weakened assertion: every
assertion is unchanged.

**These runs drive a separate Chrome.** They compete with the dev server for the
machine and are slow — the two-test group took thirteen minutes. Detailed
verification of a change is faster and more precise through the in-app browser,
driving the game directly and reading the real numbers out of it; TesterArmy is
for the durable regression pass, not for checking a change you just made.

## Project memories

Four memories are saved on the project, because the default assumptions of a web
QA agent are wrong here in ways that produce false failures:

- **It is a 3D game in a single canvas, not a page.** There is no DOM to assert
  against; judge it from the screenshot.
- **Controls.** Click to capture the mouse, WASD or arrows, `E` interacts,
  `Escape` opens the pause menu.
- **Reading the HUD.** Where the objective card, the prompt, the cash, the
  stars, the minimap markers and the subtitles are.
- **Traffic is real but is not always in front of you at spawn.** The city
  simulates ~95 vehicles, but the spawn point on Harbour Walk can have no road
  in shot. An earlier run reported "no cars visible" without leaving the spawn
  pavement; that was a false negative — the same build was measured drawing
  93–98 vehicles. The baseline now tells the agent to walk out to a road and
  look along it *before* judging, which is the action the assertion always
  needed rather than a weaker assertion.


## The airport upgrade journey

A second project holds the coverage for the airport, aircraft, pause, audio and
combat work, because that is the project `AGENTS.md` was pointed at for it:

| What | Id |
| --- | --- |
| Project — *Youtube videos GTA - TOOLS* | `c152f076-e9b6-4708-a104-cdcd1c06b5cc` |
| *GTA Vibe - airport upgrade journey* | `73153284-b197-425e-9dc9-2a668e226044` |

**A test may hold at most 30 steps.** The dashboard rejects 31 with
`ValidationError: A test cannot have more than 30 steps`, which is a tighter
limit than the CLI skill's own "maximum 50". The journey is ordered so that
everything which needs no travel comes first — the pause menu, the map, the
controls, resuming, the car collision, the police reaction, aiming, the rocket
— and the long drive south to the airport is last. That ordering is deliberate:
this runner has twice exhausted its per-step tool-call budget on traversal, so
anything behind a drive is the first thing to be lost.

Five project memories were added first, for the same reason the other project
has four: the defaults of a web QA agent are wrong for a game in a canvas, and
without them the run produces false negatives rather than findings.

### What the run found

Run once, headed, against a production preview on `http://localhost:4183`.
Nine steps completed; eight passed.

It confirmed the game boots into daylight with the HUD and `Music: Off`, that
Escape opens a pause menu with all eight tabs and no clipping, that the Map tab
draws Meridian Bay with **Meridian Bay Regional to the south of the city**, and
that the Controls tab is selectable.

Then it failed step 8, and it was right to:

> *"Although the Controls tab is selected, the Map panel remains visible in the
> foreground, obscuring the controls text."*

**A real defect, and a new one.** Tab panels are hidden with the `hidden`
attribute, which the user-agent stylesheet turns into `display: none` at the
lowest specificity there is. The rule added to give the Map tab its full height
set `display: flex` on it **by class** — which beats the UA sheet — so the map
was drawn on top of whichever tab the player had actually chosen. It is fixed
by scoping both rules with `:not([hidden])`, verified in the browser, and
pinned by a jsdom test that asserts exactly one panel is ever showing and that
it is the selected one.

The run was not repeated. That is the instruction, and the finding did not need
a second run to act on.

## The airport repair pass

| What | Id |
| --- | --- |
| Project — *Youtube videos GTA - TOOLS* | `c152f076-e9b6-4708-a104-cdcd1c06b5cc` |
| *GTA Vibe - airport repair pass* | `8a5bf3d6-0945-4a35-997d-797f1a0e48be` |

```bash
ta tests run 8a5bf3d6-0945-4a35-997d-797f1a0e48be \
  --local --url http://localhost:4183 --browser chrome --headed --json
```

**A run has a budget, and it is smaller than a long journey.** The first version
of this test had 23 steps and covered boot, HUD, ramming a car, the drive south,
the crowd, the terminal floor, the fit-out and boarding an aircraft. It returned
`FAILED` with **`5/23 steps passed, 0 failed`** and **zero issues**: every step it
reached passed, and it simply ran out of agent budget part-way into step 6. That
is an infrastructure boundary, not a product defect, and it cost the one run this
workstream was allowed.

The skill says three to ten meaningful steps. Take it literally: a browser agent
driving 600 m through traffic, walking into a building and crossing to an apron
spends a great many tool calls inside a single "step".

It is now 13 steps and **ordered so the checks that need no travel come first** —
the abandoned-car check happens near the spawn point, before the long drive, so
a run that exhausts its budget on the way south still returns signal on one of
the headline repairs.

## Run of 2026-08-31 — the detail, avatars and voice workstream

`3c3c8951` run alone against a production preview on `http://localhost:4183`,
headed Chrome. **Six steps passed, none failed, and the run then stopped on the
runner's own repetition guard** — `Repeated "ui_press:" 6 times in a row` while
the agent was walking towards a parked car. `issues: []`.

| step | result |
| --- | --- |
| Open the game and click through the gate | passed |
| Street in daylight, blue sky, cash top right, Music: Off | passed |
| Capture the mouse and walk forward | passed |
| The view moved / the street name changed | passed |
| Walk out to the nearest wide road and face along it | passed |
| At least one car is on the road | passed |
| *(find a parked car and drive it)* | runner stopped |

**That is an agent-budget failure, not a product defect**, and it is the same
place this test has stopped before: the run recorded on 2026-08-28 managed 5 of
23 steps for the same reason. The local runner spends its action budget walking
the city, and Meridian Bay is a big place to walk across with arrow keys.

Two things worth recording for the next person:

- **Run the tests one at a time, not the group.** A `--group` run starts both
  tests against one headed Chrome; the mission test got 19 seconds and one step
  before the two interfered. Run alone, the smoke test got six.
- The step that matters most for this workstream — *"the view is a street in
  daylight with a blue sky"* — passed, which is the first time it has been
  asserted against a sky that is actually drawn. See section 3 of
  `docs/art-direction.md`.
