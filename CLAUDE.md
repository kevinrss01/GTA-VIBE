# Claude project instructions

Read [`AGENTS.md`](./AGENTS.md) completely before planning or changing this
repository. It is the authoritative project contract. Explicit user
instructions override it; a closer nested `AGENTS.md` overrides it for files in
that subtree.

The product is defined incrementally by the user. Do not infer or invent its
features, roadmap, interactions, or architecture from the repository name or
earlier ideas. Implement only the smallest complete increment requested.

## Required routing

- Read `.agents/skills/text-to-speech/SKILL.md` before generating speech with
  ElevenLabs.
- Read `.agents/skills/music/SKILL.md` before generating music with ElevenLabs.
- Read `.agents/skills/sound-effects/SKILL.md` before generating sound effects
  with ElevenLabs.
- Select and read the relevant `threejs-*` skill before Three.js work.
- Read `.agents/skills/threejs-3d-generator/SKILL.md` and its required
  references before using Tripo.
- Read `.agents/skills/testerarmy-cli/SKILL.md` before TesterArmy work, and run
  the durable accepted-product smoke test after user-visible implementations
  once the app is runnable.

## Provider and execution rules

- The configured `elevenlabs` MCP server is the preferred ElevenLabs tool path
  when available in the current session.
- Use `gpt-image-2` through trusted OpenAI tooling when image generation or
  editing is appropriate to the current request.
- Use Tripo CLI for requested generated 3D assets and validate the downloaded
  artifact, not only the provider task response.
- Keep all provider keys out of client code, logs, screenshots, prompts,
  committed files, and reports.
- Inspect the repository first, define acceptance criteria from the current
  request, implement narrowly, run repository checks and a production build,
  verify the exact browser journey, run TesterArmy when applicable, and inspect
  the finished evidence before reporting completion.

[TesterArmy documentation](https://docs.tester.army/llms.txt)
