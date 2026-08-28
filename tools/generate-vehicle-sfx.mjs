#!/usr/bin/env node
/**
 * Generates the per-class vehicle engine voices and the driving Foley around
 * them: tyre roll, an automatic upshift, and a light brake squeal.
 *
 * LOCAL TOOLING ONLY. This never ships: it takes `ELEVENLABS_API_KEY` from the
 * environment, falling back to the repository's untracked `.env`, writes MP3s
 * into `public/audio/`, and prints the measured properties the audio manifest
 * needs. The key is never written to a file, a log line or an output artefact.
 *
 * Why the REST API rather than an ElevenLabs MCP: the tool list was checked in
 * this session. There is no `elevenlabs` MCP server configured here - the only
 * MCP server in `.mcp.json` is `tripo` - and the ElevenCreative server that IS
 * reachable exposes sound effects only through `creative_generate_in_flow` with
 * `node_type: 'sfx'`, which builds variation sets on a shared editing canvas
 * and returns node and session ids rather than a file at a fixed path. That is
 * the wrong shape for deterministic single renders, and it is the same boundary
 * `tools/generate-world-sfx.mjs` recorded when the airfield set was made.
 *
 *   node tools/generate-vehicle-sfx.mjs                      # everything missing
 *   node tools/generate-vehicle-sfx.mjs veh/engine-v8-idle   # one id, forced
 *   node tools/generate-vehicle-sfx.mjs --probe              # one cheap 4 s loop
 *
 * Existing files are skipped unless named explicitly, so a rerun costs nothing.
 *
 * ## Why five engine classes and two layers each
 *
 * `src/audio/engineCurve.ts` crossfades a DARK idle layer against a BRIGHT
 * on-load layer as the revs rise, because pitching one recording across a whole
 * rev range thins out at the top and turns to mud at the bottom. That shape is
 * kept; what is added is that the pair is chosen by vehicle class, so a box
 * truck and a sports coupe are two different engines rather than one engine at
 * two playback rates. The shipped `veh/engine-idle` / `veh/engine-load` pair
 * stays exactly as it is and becomes the mid-size saloon voice.
 *
 * Every engine layer is rendered as a LOOP, at a steady state, with no
 * acceleration in it. A render that sweeps its own revs fights the playback
 * rate the curve applies and is heard as two engines beating against each
 * other; the sweep has to come from the runtime, not from the file.
 */

import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const API = 'https://api.elevenlabs.io/v1/sound-generation';
const MODEL = 'eleven_text_to_sound_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';
const ROOT = new URL('..', import.meta.url).pathname;
const AUDIO_DIR = join(ROOT, 'public', 'audio');

/** Sound-effect credits are charged per second of generated audio. */
const CREDITS_PER_SECOND = 10 / 3;

/** Every engine render must be steady state, or it fights the rev curve. */
const STEADY =
  'perfectly steady and even with no acceleration and no revving up or down, ' +
  'continuous mechanical texture, close exterior recording, ' +
  'no music, no speech, no tyres, no wind, no other sound';

const ENGINE_SECONDS = 6;
const ENGINE_INFLUENCE = 0.6;

function engine(id, prompt) {
  return {
    id: `veh/${id}`,
    file: `veh/${id}.mp3`,
    seconds: ENGINE_SECONDS,
    influence: ENGINE_INFLUENCE,
    loop: true,
    prompt: `${prompt}, ${STEADY}`,
  };
}

/**
 * The clips, with the exact parameters they are rendered at.
 *
 * `seconds` is what the request asks for; the model rounds to whole frames, so
 * the shipped duration is measured afterwards rather than assumed.
 */
const CLIPS = [
  // -- small petrol four, the hatchback ------------------------------------
  engine(
    'engine-small-idle',
    'a small 1.2 litre four cylinder petrol car engine ticking over at idle, ' +
      'light rattly four cylinder pulses and a thin exhaust note',
  ),
  // The first render of this one came back 78 per cent above 1.5 kHz and 1.8
  // per cent below 200 Hz: an induction hiss with no engine under it at all.
  // The rewrite names the exhaust, the firing pulses and the four-cylinder
  // thrum, and rules the whistle out explicitly.
  engine(
    'engine-small-load',
    'a small four cylinder petrol car engine held at mid revs under load, ' +
      'a hard buzzy exhaust drone with clearly audible four cylinder firing pulses ' +
      'and a low engine thrum underneath, recorded behind the car, ' +
      'no hiss, no whistle, no turbo whine, no wind noise',
  ),
  // -- high revving sports coupe -------------------------------------------
  // The first render was 82 per cent below 200 Hz and 0.2 per cent above
  // 1.5 kHz: a low drone rather than a lumpy cam, and indistinguishable from
  // the truck at idle. The rewrite asks for the valvetrain and the rasp.
  engine(
    'engine-sport-idle',
    'a sports car engine idling with a hard uneven lumpy racing cam, ' +
      'an offbeat burble with a sharp metallic rasp on every pulse ' +
      'and audible valvetrain ticking over it, bright and hard edged, ' +
      'not a smooth low drone, no rumble bed, no wind noise',
  ),
  engine(
    'engine-sport-load',
    'a high revving sports car engine held wide open at high revs, ' +
      'hard bright ripping exhaust howl with mechanical intake roar',
  ),
  // -- light commercial diesel, the van and the pickup ----------------------
  engine(
    'engine-diesel-idle',
    'a diesel delivery van engine idling cold, ' +
      'loud clattery diesel knock and a slow uneven low rumble',
  ),
  engine(
    'engine-diesel-load',
    'a diesel delivery van engine pulling hard at mid revs under load, ' +
      'gruff clattering diesel roar with turbo whistle over it',
  ),
  // -- heavy truck ----------------------------------------------------------
  engine(
    'engine-truck-idle',
    'a large heavy goods truck diesel engine idling, ' +
      'very deep slow heavy rumble with a hard metallic diesel knock',
  ),
  engine(
    'engine-truck-load',
    'a large heavy goods truck diesel engine labouring under full load at low revs, ' +
      'enormous deep bellowing diesel roar with a loud turbo whine',
  ),
  // -- police interceptor V8 ------------------------------------------------
  engine(
    'engine-v8-idle',
    'a large american V8 police interceptor engine idling, ' +
      'deep loping V8 burble with a heavy offbeat thump',
  ),
  engine(
    'engine-v8-load',
    'a large american V8 police interceptor engine accelerating hard and held at high revs, ' +
      'huge muscular V8 roar with a hard bark in it',
  ),
  // -- Foley ----------------------------------------------------------------
  {
    id: 'veh/tyre-roll',
    file: 'veh/tyre-roll.mp3',
    seconds: 6,
    influence: 0.6,
    loop: true,
    prompt:
      'seamless looping tyre roar of car tyres rolling fast over coarse dry asphalt, ' +
      'a steady broadband rushing hiss with a low rumble under it, ' +
      'recorded from just above the wheel arch, ' +
      'absolutely even and continuous, no engine, no music, no speech, no wind gusts, no other sound',
  },
  {
    id: 'veh/gear-shift',
    file: 'veh/gear-shift.mp3',
    seconds: 0.7,
    influence: 0.8,
    loop: false,
    prompt:
      'one single automatic gearbox upshift inside a car, a soft mechanical clunk with a brief ' +
      'drop in engine tone, close dry recording, no music, no speech, no other sound',
  },
  {
    id: 'veh/brake-squeal',
    file: 'veh/brake-squeal.mp3',
    seconds: 1.2,
    influence: 0.8,
    loop: false,
    prompt:
      'one single light brake disc squeal as a car slows to a stop, a short high metallic ' +
      'ringing whine from the brake pads that fades out, no tyre skid, no engine, ' +
      'close dry recording, no music, no speech, no other sound',
  },
];

/** One cheap render, used to check the model and the prompt shape before a batch. */
const PROBE = {
  id: 'veh/_probe',
  file: 'veh/_probe.mp3',
  seconds: 4,
  influence: ENGINE_INFLUENCE,
  loop: true,
  prompt: `a large heavy goods truck diesel engine idling, very deep slow heavy rumble with a hard metallic diesel knock, ${STEADY}`,
};

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Peak level, mean level and duration of a rendered file, via ffmpeg/ffprobe. */
async function measure(path) {
  const { stdout: probe } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=sample_rate,channels',
    '-of', 'json', path,
  ]);
  const info = JSON.parse(probe);
  const stream = info.streams?.[0] ?? {};
  let peak = null;
  let mean = null;
  try {
    const { stderr } = await run('ffmpeg', ['-i', path, '-af', 'volumedetect', '-f', 'null', '-']);
    peak = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1] ?? NaN);
    mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1] ?? NaN);
  } catch {
    /* measurement is advisory; a missing ffmpeg must not lose the render */
  }
  return {
    duration: Number(info.format?.duration ?? 0),
    bytes: Number(info.format?.size ?? 0),
    sampleRate: Number(stream.sample_rate ?? 0),
    channels: Number(stream.channels ?? 0),
    peakDb: peak,
    meanDb: mean,
  };
}

/**
 * How far a looping render's ends differ, in dB.
 *
 * A loop is judged by its seam, not by its middle: this compares the mean level
 * of the first and last 150 ms, which is what a listener hears jump at the wrap
 * point. Anything under about 3 dB is inaudible under an engine.
 */
async function seamDelta(path, duration) {
  if (!(duration > 0.4)) return null;
  const window = 0.15;
  const head = await windowMean(path, 0, window);
  const tail = await windowMean(path, Math.max(0, duration - window), window);
  if (!Number.isFinite(head) || !Number.isFinite(tail)) return null;
  return Number(Math.abs(head - tail).toFixed(2));
}

async function windowMean(path, start, length) {
  try {
    const { stderr } = await run('ffmpeg', [
      '-ss', String(start), '-t', String(length), '-i', path,
      '-af', 'volumedetect', '-f', 'null', '-',
    ]);
    return Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1] ?? NaN);
  } catch {
    return NaN;
  }
}

/**
 * Leading and trailing silence, in seconds.
 *
 * An engine LOOP with silence at either end drops out once per wrap, which is
 * far more obvious than a level step; a one-shot with a long lead-in fires
 * late. Reported so the manifest can record it and a bad render can be caught
 * before it ships rather than heard in the game.
 */
async function edgeSilence(path) {
  try {
    const { stderr } = await run('ffmpeg', [
      '-i', path,
      '-af', 'silencedetect=noise=-50dB:d=0.05',
      '-f', 'null', '-',
    ]);
    const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    const duration = (await measure(path)).duration;
    const lead = starts.length > 0 && starts[0] <= 0.001 ? (ends[0] ?? 0) : 0;
    const lastStart = starts.length > 0 ? starts[starts.length - 1] : null;
    const trail =
      lastStart !== null && ends.length < starts.length ? Math.max(0, duration - lastStart) : 0;
    return { leadSilence: Number(lead.toFixed(3)), trailSilence: Number(trail.toFixed(3)) };
  } catch {
    return { leadSilence: null, trailSilence: null };
  }
}

/**
 * Playback trim.
 *
 * Engine layers are levelled by LOUDNESS onto the shipped saloon pair, which is
 * the reference voice: `veh/engine-idle` measures -21.0 dBFS mean and carries a
 * -0.2 dB trim, so every idle layer is brought to -21.2 dBFS mean, and
 * `veh/engine-load` measures -14.3 dBFS mean at -3.9 dB, so every load layer is
 * brought to -18.2 dBFS mean. Peak-normalising them instead - which is what the
 * rest of the manifest does for one-shots - put the coupe's idle 4.8 dB over the
 * saloon's purely because the render happened to be hotter, and the class
 * difference is supposed to come from `engineCurve.ts`, not from render luck.
 * The same lesson the footstep set already learned, applied to loops.
 *
 * A -1.5 dBFS peak guard sits under all of it so a hard transient is never
 * pushed into clipping to hit a loudness target, and the +10 dB boost cap stops
 * a quiet render dragging its own noise floor up with it.
 */
const IDLE_TARGET_MEAN_DB = -21.2;
const LOAD_TARGET_MEAN_DB = -18.2;
/** The tyre bed sits under the engine it plays with. */
const TYRE_TARGET_MEAN_DB = -24;
const LOOP_PEAK_CEILING_DB = -1.5;

function trimFor(clip, measured) {
  if (!clip.loop) {
    if (!Number.isFinite(measured.peakDb)) return 0;
    return Number(Math.min(10, -6 - measured.peakDb).toFixed(1));
  }
  if (!Number.isFinite(measured.meanDb) || !Number.isFinite(measured.peakDb)) return 0;
  const target = clip.id.endsWith('-idle')
    ? IDLE_TARGET_MEAN_DB
    : clip.id.endsWith('-load')
      ? LOAD_TARGET_MEAN_DB
      : TYRE_TARGET_MEAN_DB;
  const byMean = target - measured.meanDb;
  const byPeak = LOOP_PEAK_CEILING_DB - measured.peakDb;
  return Number(Math.min(byMean, byPeak, 10).toFixed(1));
}

async function generate(clip, key) {
  const body = {
    text: clip.prompt,
    model_id: MODEL,
    duration_seconds: clip.seconds,
    prompt_influence: clip.influence,
    loop: clip.loop === true,
  };
  const response = await fetch(`${API}?output_format=${OUTPUT_FORMAT}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${clip.id}: HTTP ${response.status} ${detail.slice(0, 300)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const path = join(AUDIO_DIR, clip.file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

/**
 * Reads the repository's untracked `.env` into `process.env`.
 *
 * `AGENTS.md` puts every key in that file and nowhere else, so a tool whose
 * documented invocation is a bare `node tools/...` has to load it or the
 * documented invocation does not work. An already-exported value always wins,
 * and nothing here ever prints a value.
 */
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

async function renderAll(clips, key, forced) {
  const report = [];
  let credits = 0;
  for (const clip of clips) {
    const path = join(AUDIO_DIR, clip.file);
    if (!forced && (await exists(path))) {
      console.error(`skip   ${clip.id} (exists)`);
      continue;
    }
    process.stderr.write(`render ${clip.id} ... `);
    await generate(clip, key);
    const measured = await measure(path);
    const seam = clip.loop ? await seamDelta(path, measured.duration) : null;
    const silence = await edgeSilence(path);
    credits += clip.seconds * CREDITS_PER_SECOND;
    console.error(
      `${measured.duration.toFixed(3)}s ${measured.bytes}B ${measured.sampleRate}Hz ` +
        `${measured.channels}ch peak ${measured.peakDb}dB mean ${measured.meanDb}dB` +
        `${seam === null ? '' : ` seam ${seam}dB`} lead ${silence.leadSilence}s tail ${silence.trailSilence}s`,
    );
    report.push({
      id: clip.id,
      path: `/audio/${clip.file}`,
      seconds: clip.seconds,
      influence: clip.influence,
      loop: clip.loop === true,
      prompt: clip.prompt,
      ...measured,
      ...silence,
      seamDeltaDb: seam,
      trimDb: trimFor(clip, measured),
      credits: Number((clip.seconds * CREDITS_PER_SECOND).toFixed(4)),
    });
  }
  console.log(
    JSON.stringify(
      { model: MODEL, outputFormat: OUTPUT_FORMAT, credits: Number(credits.toFixed(2)), clips: report },
      null,
      2,
    ),
  );
}

async function main() {
  const args = process.argv.slice(2);

  await loadDotEnv();
  const key = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_LABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set');

  if (args.includes('--probe')) {
    await renderAll([PROBE], key, true);
    return;
  }

  const only = new Set(args);
  const wanted = only.size > 0 ? CLIPS.filter((c) => only.has(c.id)) : CLIPS;
  if (wanted.length === 0) throw new Error(`No clip matches ${[...only].join(', ')}`);
  await renderAll(wanted, key, only.size > 0);
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
