#!/usr/bin/env node
/**
 * Generates GTA Vibe's loading-screen key art with the OpenAI Images API.
 *
 * LOCAL TOOLING ONLY. Takes `OPENAI_API_KEY` from the environment, falling
 * back to the repository's untracked `.env`, and writes a JPEG into
 * `public/art/`. The key never reaches a file, a log line, a browser bundle or
 * an output artefact, and it is never prefixed `VITE_`.
 *
 *   node tools/generate-key-art.mjs           # only if the file is missing
 *   node tools/generate-key-art.mjs --force   # regenerate
 *
 * WHY A BACKDROP AND NOT A WORDMARK. The title is real DOM text on the loading
 * screen - selectable, scalable, and readable by a screen reader - and baking
 * it into a picture would throw all three away. What the picture is for is the
 * thing text cannot do: say what kind of city this is before the city has
 * finished loading.
 */

import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const API = 'https://api.openai.com/v1/images/generations';
const MODEL = 'gpt-image-2';
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'public', 'art', 'key-art.jpg');

/**
 * 1536x1024 rather than a square: it is a full-bleed backdrop behind a centred
 * panel on a landscape screen, and a square would be cropped to a letterbox.
 */
const SIZE = '1536x1024';

const PROMPT = [
  'Wide cinematic key art for an original open-world crime video game set in an invented coastal city.',
  'Looking west along a harbour promenade at dusk: a container port with gantry cranes on the left,',
  'a strip of low pastel waterfront buildings with lit shopfronts on the right, palm trees along the kerb,',
  'wet asphalt reflecting magenta and warm amber neon, a small downtown skyline of pale towers in the',
  'far distance across the water, and a low bank of cloud catching the last orange light.',
  'Empty street, no people, no vehicles in the foreground, no text, no logos, no lettering, no signage text,',
  'no user interface. Painterly, slightly stylised, low-contrast in the shadows so a title can sit over it.',
].join(' ');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Reads the untracked `.env`. An exported value always wins; nothing prints. */
async function loadDotEnv() {
  let text;
  try {
    text = await readFile(join(ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (process.env[name] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

async function main() {
  await loadDotEnv();
  const key = process.env.OPENAI_API_KEY ?? process.env.OPEN_AI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');

  const force = process.argv.includes('--force');
  if (!force && (await exists(OUT))) {
    console.error('skip (exists). Pass --force to regenerate.');
    return;
  }

  process.stderr.write(`render key art at ${SIZE} ... `);
  const response = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: PROMPT,
      size: SIZE,
      quality: 'high',
      output_format: 'jpeg',
      // The loading screen paints its own dark ground behind this, and a
      // transparent key art would show it through the sky.
      background: 'opaque',
      n: 1,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status} ${detail.slice(0, 400)}`);
  }
  const body = await response.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`no image in the response: ${JSON.stringify(body).slice(0, 300)}`);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, Buffer.from(b64, 'base64'));

  let measured = {};
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=width,height:format=size',
      '-of', 'json', OUT,
    ]);
    const info = JSON.parse(stdout);
    measured = {
      width: info.streams?.[0]?.width,
      height: info.streams?.[0]?.height,
      bytes: Number(info.format?.size ?? 0),
    };
  } catch {
    /* measurement is advisory */
  }
  console.error('done');
  console.log(
    JSON.stringify(
      { model: MODEL, size: SIZE, path: '/art/key-art.jpg', prompt: PROMPT, ...measured },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
