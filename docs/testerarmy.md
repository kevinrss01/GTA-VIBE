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
