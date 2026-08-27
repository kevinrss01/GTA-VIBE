# AGENTS.md

## Scope and source of truth

This repository is an iterative Three.js web product. Its exact product scope,
features, interactions, visual direction, and user journeys are intentionally
not defined in this file. The user will define them incrementally.

- Treat the current user request and accepted repository state as the product
  specification for each implementation.
- Do not infer requirements from the repository name, earlier ideas, provider
  test artifacts, or assumptions about a particular application or product.
- Do not invent a roadmap, feature set, world structure, characters, controls,
  screens, or architecture for work the user has not requested.
- Ask only when an unresolved choice would materially change the result. Make
  small, reversible assumptions when they do not alter product direction.
- Build the smallest complete increment that satisfies the current request and
  leaves the repository easy to extend.
- Quality, correctness, polish, and maintainability are more important than
  implementation speed. Take the time needed to inspect, refine, test, and
  verify each requested increment; do not accept a visibly inferior shortcut
  merely because it is faster.
- Use the best-fit provider when it can materially improve the result. In
  particular, actively consider Tripo for relevant 3D asset work and do not
  hesitate to use it instead of a lower-quality placeholder or improvised model.
- Quality is also more important than minimizing provider cost, but test cheaply
  before high-quality generation. Ask before a large batch, expensive retry
  loop, or open-ended paid operation.

## Repository state and technology foundation

This workspace may begin without an application scaffold. Provider verification
files are connectivity evidence, not production assets or product requirements.
Inspect the repository before every change and follow the stack actually present.

Unless the user or existing repository establishes something else, use these
defaults when scaffolding becomes part of an explicit request:

- TypeScript in strict mode.
- Three.js for 3D rendering.
- Vite for local development and production builds.
- `@dimforge/rapier3d-compat` only when physics is required.
- Vitest for deterministic unit and integration tests.
- Browser-level testing for user-visible behavior.
- TesterArmy for repeatable user-journey and visual QA.
- npm unless a different lockfile already establishes another package manager.

Do not claim that a command exists until it is defined by the repository. Once
the relevant tooling exists, keep discoverable scripts for development, build,
type checking, linting, tests, and browser tests.

## Required skill routing

Before using a skill, read its complete `SKILL.md` and every reference it marks
as required. Say which skill is being used and why. Project-local skills live at
`.agents/skills/<skill-name>/SKILL.md`; Claude-compatible copies may also exist
under `.claude/skills/`.

### ElevenLabs skills

These three skills are mandatory whenever their domain is involved:

- `text-to-speech`: speech, dialogue, narration, or any generated voice.
- `music`: music, themes, beds, stingers, or jingles.
- `sound-effects`: non-speech audio, ambience, Foley, impacts, UI audio, loops,
  or other effects.

### Three.js skills

Choose the smallest relevant set; use more than one for cross-cutting work:

- `threejs-fundamentals`: scenes, render loops, transforms, cameras, and core
  Three.js behavior.
- `threejs-geometry`: procedural geometry, buffers, meshes, instancing, and
  geometry optimization.
- `threejs-materials`: PBR materials, transparency, blending, and material
  performance.
- `threejs-textures`: loading, color spaces, UVs, compression, environment maps,
  and texture quality.
- `threejs-lighting`: lighting, shadows, image-based lighting, and performance.
- `threejs-loaders`: GLB/GLTF/FBX loading, progress, caching, and recovery.
- `threejs-animation`: skeletal animation, `AnimationMixer`, blending, state
  machines, and procedural motion.
- `threejs-interaction`: input, raycasting, selection, camera controls, and
  interaction behavior.
- `threejs-postprocessing`: tone mapping, anti-aliasing, bloom, depth effects,
  and screen-space polish.
- `threejs-shaders`: custom GLSL/WebGPU shaders and GPU effects.
- `threejs-3d-generator`: Tripo-backed generation, texturing, rigging,
  animation, conversion, and runtime-ready 3D asset pipelines.

### QA skill

- Read `testerarmy-cli` before using `ta`, interpreting a TesterArmy result, or
  creating or changing durable TesterArmy coverage.
- Use the current [TesterArmy agent documentation](https://docs.tester.army/llms.txt)
  instead of guessing CLI syntax.

## MCP and provider access

MCP, the Model Context Protocol, lets the coding client expose provider tools to
the agent through a configured server. An MCP tool is an integration boundary,
not evidence that every operation will succeed or that an output is usable.

An ElevenLabs MCP server named `elevenlabs` is configured for this environment.
It can expose speech, voice discovery, sound effects, music, transcription,
voice processing, conversational-agent, and related ElevenLabs operations.

A Tripo MCP server named `tripo` is configured in this repository's `.mcp.json`.
It runs `tripo mcp` through `.agents/bin/tripo-mcp.sh`, which loads
`TRIPO_API_KEY` from the untracked `.env` so the key never enters a config file.
It exposes `tripo_make`, `tripo_task_get`, `tripo_task_wait`, `tripo_balance`,
and `tripo_history`. `tripo_make` is a paid generating operation and is not
pre-approved; the read-only Tripo tools are. The MCP surface is narrower than
the CLI, so use `tripo` CLI commands directly for texturing, rigging,
retargeting, mesh ops, stylization, conversion, and batch manifests.

For MCP work:

1. Read the matching project skill first.
2. Discover the tools available in the current session; never assume a server
   loaded successfully because it worked in an earlier session.
3. Prefer the MCP tool when it supports the requested operation. Use the
   skill's documented official SDK or API fallback when it does not.
4. Keep generated files inside the repository's intended asset or temporary
   output directory.
5. Validate the returned artifact itself. A successful tool response is not
   proof of correct content, format, duration, quality, or runtime behavior.
6. Never place secrets in prompts, tool arguments that will be persisted,
   screenshots, committed metadata, or final reports.

A client restart or new session may be required after MCP configuration changes.
If the server is unavailable, report the exact boundary and continue with an
authorized documented fallback when possible.

## ElevenLabs workflow

1. Read `text-to-speech`, `music`, or `sound-effects`, as applicable.
2. Prefer the ElevenLabs MCP when available; otherwise follow the skill's
   official SDK flow with `ELEVENLABS_API_KEY`.
3. For speech, inspect the account voice library before selecting a voice. Do
   not assume an example voice is accessible.
4. Generate a short, low-cost sample and inspect or listen to it before a full
   batch.
5. Validate file type, duration, sample rate, clipping, silence, loop seams, and
   behavior in the actual product context.
6. Preserve prompt/settings, model, voice where applicable, creation date,
   provenance, and final path in an asset manifest. Never record the key.

Use `music_v2` only while it remains the model required by the current skill or
official documentation. Generated music, lyrics, voices, and effects must respect
applicable rights; do not copy a known work or impersonate a person without the
necessary permission.

The canonical variable is `ELEVENLABS_API_KEY`. An older local environment may
use `ELEVEN_LABS_API_KEY`; map it privately for local tooling when necessary,
but use the canonical name in new code and `.env.example`.

## OpenAI image workflow

Use the official OpenAI Images API and model identifier `gpt-image-2` for image
generation or editing when an image is the best input to the requested work.

- Read the current
  [OpenAI image documentation](https://developers.openai.com/api/docs/guides/image-generation)
  before implementing or changing API calls.
- Use `OPENAI_API_KEY` only in local tooling or trusted server code.
- Never expose the key through `VITE_*`, a browser bundle, browser requests,
  logs, screenshots, or committed files.
- Use inexpensive settings for connectivity and composition probes, then higher
  quality for approved final candidates when the improvement is material.
- Preserve prompt, model, settings, source references, creation date,
  provenance, and final path. Never record the key.
- Inspect every output before integration. Validate dimensions, color space,
  seams, alpha, compression, UV suitability, and physical plausibility as
  relevant to its intended use.
- Use an appropriate vision-capable model or visual inspection for criticism;
  do not treat an image generator as an evaluator.

The canonical variable is `OPENAI_API_KEY`. An older local environment may use
`OPEN_AI_API_KEY`; map or migrate it privately without printing its value.

## Tripo 3D workflow

Use Tripo CLI with `TRIPO_API_KEY` when generated 3D assets are appropriate to
the current request. For every requested 3D asset or substantial 3D visual,
explicitly evaluate whether Tripo would materially improve realism, detail, or
production quality. When it would, prefer using Tripo over rushing a crude
placeholder solely to save time.

1. Read `.agents/skills/threejs-3d-generator/SKILL.md` and all references it
   requires for the operation.
2. Check the current
   [Tripo API introduction](https://developers.tripo3d.ai/en/docs/introduction)
   and [Tripo CLI documentation](https://developers.tripo3d.ai/en/docs/cli)
   when uncertain.
3. Run `tripo docs --llm` or the relevant `tripo docs --topic ...` page instead
   of inventing flags or parameters.
4. Run `tripo doctor --json --no-open` before paid generation and record only
   safe status or balance metadata.
5. Generate a low-cost candidate first unless the user explicitly approves a
   higher-cost operation.
6. Prefer a blocking CLI command for simple jobs so the CLI polls and downloads
   the final result. Do not stop after obtaining only a task ID.
7. Inspect the preview, then validate file type, bounds, scale, pivot,
   polygon/vertex counts, meshes, materials, textures, skeleton, and animation
   clips before integration.
8. Download expiring provider outputs promptly and preserve non-secret task
   metadata and prompts for reproducibility.

For humanoids, a T-pose or A-pose may be appropriate as a rigging source, but
it is not a finished runtime state. Inspect limb separation and symmetry,
pre-check and rig the model, validate the skeleton, retarget the required clips,
and confirm a valid default animation before showing it in the product. Follow
the generator skill's current retry and root-motion guidance.

Keep source artifacts separate from optimized runtime assets. Use GLB/GLTF and
`GLTFLoader` by default; use another format only when the current workflow
requires it.

## Engineering boundaries

- Inspect the current structure before adding directories or abstractions. Do
  not impose a speculative application architecture.
- Keep rendering, state, input, audio, assets, providers, and UI behind clear
  module boundaries when those concerns exist.
- Keep OpenAI, ElevenLabs, and Tripo calls in local/offline tooling or trusted
  server code, never shipped browser code.
- Centralize asset loading, caching, progress, cancellation, fallback, and error
  reporting when the application needs those capabilities.
- Dispose Three.js geometries, materials, textures, render targets, listeners,
  workers, and audio nodes when their owner unloads.
- Use consistent world units, scale, axes, pivots, color spaces, and asset naming.
- Keep deterministic logic testable without WebGL or a live provider.
- Avoid per-frame allocation, synchronous network work, repeated resource
  creation, and unbounded queries in render or simulation loops.
- Record non-obvious technical decisions and performance tradeoffs close to the
  implementation.

## Visual quality and performance

Define a measurable budget for each rendering change rather than assuming one
global target fits every iteration.

- Profile before and after meaningful changes in a production build.
- Record relevant evidence such as FPS, frame time, draw calls, triangles,
  loading time, bundle size, and memory pressure where available.
- Use LODs, culling, instancing, pooling, compression, and streaming when
  measurement shows they are appropriate.
- Prefer GLB with PBR materials. Evaluate KTX2/Basis, Meshopt, or Draco based on
  measured download, decode, memory, and quality tradeoffs.
- Treat shadows, post-processing, reflections, particles, and high-density
  geometry as explicit budgets.
- Provide useful development diagnostics when the current work needs them, but
  do not turn a debugging overlay into an unrequested product feature.
- Visual quality is incomplete if frame pacing, loading, input responsiveness,
  or fallback behavior becomes unacceptable.

## Environment and secrets

Copy `.env.example` to `.env` for local development. `.env` must remain
untracked and owner-readable only. Never reveal secret values in output,
terminal logs, screenshots, test steps, URLs, client code, or reports.

Private variables:

- `ELEVENLABS_API_KEY`
- `OPENAI_API_KEY`
- `TRIPO_API_KEY`
- `TESTERARMY_API_KEY` only when saved TesterArmy authentication is unavailable

Optional non-secret QA configuration:

- `TESTERARMY_PROJECT_ID`
- `TESTERARMY_SMOKE_TEST_ID`
- `APP_URL`

Do not prefix secrets with `VITE_`; Vite exposes those values to browser code.

## Implementation workflow

For every implementation:

1. Read the nearest `AGENTS.md`, the current source, `package.json`, lockfile,
   tests, and relevant documentation before changing anything.
2. Convert only the current user request into observable acceptance criteria.
   Do not add implied product features.
3. Read the relevant skills and current primary provider/framework docs.
4. Implement the smallest complete increment and preserve unrelated user work.
5. Add or update deterministic tests for changed logic and failure paths.
6. Run focused checks first, then the repository's typecheck, lint, test, and
   production build commands.
7. Start a production-like local build and verify the exact requested journey
   in a real browser when user-visible behavior changed.
8. Run the applicable TesterArmy gate below.
9. Inspect screenshots, console output, network failures, test details, and
   performance evidence. Fix defects and rerun the failed layers.
10. Report the change, checks, artifacts, provider credits spent, and remaining
    limitations precisely.

A successful provider response, generated file, compilation, queued test, or
authentication status is never sufficient proof by itself.

## Testing foundation

Use the actual scripts in `package.json`. Once present, the usual local gate is:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Apply tests in layers proportional to the change:

- Unit tests for deterministic logic and edge cases.
- Integration tests for module and asset boundaries.
- Browser tests for the exact user-visible behavior requested.
- Visual inspection for rendered, generated, image, and audio outputs.
- Performance measurement for changes that affect rendering, loading,
  simulation, assets, or bundle size.

For browser-visible work, verify at minimum:

- The requested path loads without an uncaught console error.
- Required requests and assets succeed, or show an intentional fallback.
- The exact requested behavior and its relevant failure/loading state work.
- The result remains correct after relevant resize, reload, or lifecycle events.
- There is no obvious regression in responsiveness or frame pacing.

Do not write tests for speculative product behavior. Each test should map to a
current requirement, an established invariant, or a reproduced regression.

## Mandatory TesterArmy gate

Read `.agents/skills/testerarmy-cli/SKILL.md` before every TesterArmy operation.
TesterArmy must run after every user-visible implementation once a runnable web
application exists.

Maintain one durable baseline smoke test for behavior that is already part of
the accepted product. Update it only when accepted behavior changes. Add focused
coverage for the current request without inventing future journeys.

Discover and reuse exact identifiers:

```bash
ta status --json
ta projects list --json
ta tests list --project "$TESTERARMY_PROJECT_ID" --json
ta tests get "$TESTERARMY_SMOKE_TEST_ID" --json
```

Run the saved smoke test locally against the real local URL:

```bash
ta tests run "$TESTERARMY_SMOKE_TEST_ID" \
  --local \
  --url "${APP_URL:-http://127.0.0.1:4173}" \
  --browser chrome \
  --json
```

Inspect the returned run with `ta runs get <runId> --json`. Read the actual
result, first failed step, transcript, screenshots, and telemetry. `ta status`,
a queued run, or a created test does not prove a pass. Classify product defects
separately from quota, entitlement, fixture, assertion, and infrastructure
failures. Preserve a valid saved test instead of weakening it to hide a defect.

For a release candidate, run the appropriate saved remote smoke/regression test
or group with `--wait --json` against the intended environment and inspect the
finished run.

If the repository has no runnable UI, browser and TesterArmy gates are not yet
applicable. Validate the files that changed and state this narrowly; never fake
a browser pass. When the first runnable UI is explicitly implemented, create or
locate the durable TesterArmy project and baseline test, store its non-secret
identifiers, and execute it.

## Code style

- Use strict TypeScript and explicit domain types. Avoid `any`; isolate
  unavoidable third-party gaps.
- Prefer small modules with clear ownership and lifecycle.
- Name modules by their actual current responsibility, not a speculative future
  role.
- Keep provider and deterministic logic testable without a browser renderer.
- Document non-obvious math, coordinate conventions, asset assumptions, and
  performance tradeoffs.
- Avoid premature abstraction and duplicated lifecycle or loading logic.
- Use comments for reasons, constraints, and invariants, not obvious narration.

## Definition of done

An implementation is complete only when:

- The exact requested behavior works through the real user-facing path.
- Relevant loading, error, empty, and cleanup behavior is handled.
- Focused tests, applicable repository checks, and the production build pass.
- There are no new relevant browser console errors or failed required requests.
- Generated visual, audio, or 3D assets were inspected in their actual context,
  and reproducibility metadata was recorded.
- Performance and loading impact were measured in proportion to the change.
- The durable TesterArmy baseline and focused coverage passed when applicable.
- The final report includes concrete evidence, costs, artifact paths or run IDs,
  and honest limitations.

## Primary documentation

- [AGENTS.md format](https://agents.md/)
- [Three.js documentation](https://threejs.org/docs/)
- [Tripo API introduction](https://developers.tripo3d.ai/en/docs/introduction)
- [Tripo CLI](https://developers.tripo3d.ai/en/docs/cli)
- [ElevenLabs API documentation](https://elevenlabs.io/docs)
- [ElevenLabs MCP server](https://github.com/elevenlabs/elevenlabs-mcp)
- [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation)
- [TesterArmy agent documentation](https://docs.tester.army/llms.txt)

When a skill and current official documentation disagree about a public API,
prefer the current official documentation for the API fact and retain the skill
for repository-specific workflow. Record the discrepancy instead of guessing.
