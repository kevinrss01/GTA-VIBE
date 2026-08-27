#!/usr/bin/env node
/**
 * Generates the combat sound effects with the ElevenLabs sound-generation API.
 *
 * LOCAL TOOLING ONLY. This never ships: it reads `ELEVENLABS_API_KEY` from the
 * environment (loaded from the untracked `.env`), writes MP3s into
 * `public/audio/`, and prints the measured properties the audio manifest needs.
 * The key is never written to a file, a log line or an output artefact.
 *
 * Why the REST API rather than the ElevenLabs MCP: the MCP's `sfx` node
 * generates onto a shared editing canvas in variation sets, which is the wrong
 * shape for twenty-odd single deterministic renders that have to land at fixed
 * paths with recorded parameters. The whole existing manifest was rendered this
 * way, and matching it keeps the provenance in `src/audio/manifest.ts` uniform.
 *
 *   node tools/generate-combat-sfx.mjs            # everything missing
 *   node tools/generate-combat-sfx.mjs wpn/pistol # one id, forced
 *
 * Existing files are skipped unless named explicitly, so a rerun costs nothing.
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
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

const NO_BLEED =
  'close dry recording, no reverb, no music, no speech, no other sound';

/**
 * Every clip, with the exact parameters it is rendered at.
 *
 * `seconds` is what the request asks for; the model rounds to whole frames, so
 * the shipped duration is measured afterwards rather than assumed.
 */
const CLIPS = [
  // -- weapon fire ---------------------------------------------------------
  {
    id: 'wpn/pistol',
    file: 'wpn/pistol.mp3',
    seconds: 0.9,
    influence: 0.75,
    prompt:
      `a single 9mm semi-automatic pistol gunshot fired outdoors in the open, one sharp percussive crack with a hard transient, the slide cycling with a light metallic clack straight after it, short dry decay, ${NO_BLEED}`,
  },
  {
    id: 'wpn/smg',
    file: 'wpn/smg.mp3',
    seconds: 0.55,
    influence: 0.8,
    prompt:
      `a single loud gunshot fired outdoors from a compact submachine gun, one hard bright percussive crack with a metallic bolt clatter over it and a very short flat decay, one shot only, ${NO_BLEED}`,
  },
  {
    id: 'wpn/shotgun',
    file: 'wpn/shotgun.mp3',
    seconds: 1.3,
    influence: 0.75,
    prompt:
      `a single 12 gauge pump-action shotgun blast fired outdoors, deep heavy boom with a wide low-end thump, followed by the pump sliding back and forward with two solid mechanical clacks, ${NO_BLEED}`,
  },
  {
    id: 'wpn/rifle',
    file: 'wpn/rifle.mp3',
    seconds: 1.0,
    influence: 0.75,
    prompt:
      `a single rifle gunshot from a semi-automatic carbine fired outdoors, a hard high-pressure crack with a supersonic snap and a short bright tail, the bolt cycling with a metallic ring, ${NO_BLEED}`,
  },
  {
    id: 'wpn/launcher',
    file: 'wpn/launcher.mp3',
    seconds: 1.8,
    influence: 0.75,
    prompt:
      `a shoulder-fired rocket launcher firing, a deep hollow whoosh of the rocket motor igniting inside the tube with a heavy pressure thump and a rushing back blast of hot gas behind it, the rocket accelerating away, ${NO_BLEED}`,
  },
  {
    id: 'wpn/explosion',
    file: 'wpn/explosion.mp3',
    seconds: 3.0,
    influence: 0.7,
    prompt:
      `a large high-explosive detonation outdoors in a street, a violent cracking blast with an enormous low-frequency thump, a sharp shockwave front, then a long rolling rumble decaying away and small pieces of debris raining down at the end, no music, no speech, no siren`,
  },
  {
    id: 'wpn/rocket-flight',
    file: 'wpn/rocket-flight.mp3',
    seconds: 2.5,
    influence: 0.7,
    loop: true,
    prompt:
      'seamless looping solid-fuel rocket motor burning in flight, a continuous rushing roar of hot gas with a steady hiss over it, absolutely even with no launch and no impact, no music, no speech',
  },
  {
    id: 'wpn/reload',
    file: 'wpn/reload.mp3',
    seconds: 1.6,
    influence: 0.8,
    prompt:
      `reloading a handgun, the magazine release clicking and the empty magazine dropping out, a fresh magazine pushed in and seated with a solid clack, then the slide released forward with a metallic snap, ${NO_BLEED}`,
  },
  {
    id: 'wpn/draw',
    file: 'wpn/draw.mp3',
    seconds: 0.8,
    influence: 0.8,
    prompt:
      `drawing a handgun out of a leather holster, a short scrape of steel against leather then a hand settling firmly on the grip, ${NO_BLEED}`,
  },
  {
    id: 'wpn/holster',
    file: 'wpn/holster.mp3',
    seconds: 0.8,
    influence: 0.8,
    prompt:
      `putting a handgun away into a leather holster, a muffled scrape of steel sliding into leather ending with a soft strap snap, ${NO_BLEED}`,
  },
  {
    id: 'wpn/dry',
    file: 'wpn/dry.mp3',
    seconds: 0.5,
    influence: 0.85,
    prompt:
      `a loud sharp metallic click recorded close up, the hammer of an empty handgun falling hard on an empty chamber, one crisp dry snap at full volume and nothing else, ${NO_BLEED}`,
  },
  {
    id: 'wpn/shell',
    file: 'wpn/shell.mp3',
    seconds: 1.0,
    influence: 0.8,
    prompt:
      `two or three small brass cartridge cases bouncing and tinkling on a concrete floor and coming to rest, light bright metallic ringing, ${NO_BLEED}`,
  },

  // -- impacts -------------------------------------------------------------
  {
    id: 'imp/concrete',
    file: 'imp/concrete.mp3',
    seconds: 0.7,
    influence: 0.8,
    prompt:
      `a bullet slamming into a concrete wall, a hard dry crack of stone chipping with a puff of dust and a few small fragments falling, ${NO_BLEED}`,
  },
  {
    id: 'imp/metal',
    file: 'imp/metal.mp3',
    seconds: 0.8,
    influence: 0.8,
    prompt:
      `a bullet punching through a car body panel, a sharp bright metallic bang with sheet metal ringing and denting afterwards, ${NO_BLEED}`,
  },
  {
    id: 'imp/flesh',
    file: 'imp/flesh.mp3',
    seconds: 0.6,
    influence: 0.8,
    prompt:
      `a heavy blunt wet impact into a slab of meat, one dull thick thud with a short wet slap, no voice, ${NO_BLEED}`,
  },
  {
    id: 'imp/glass',
    file: 'imp/glass.mp3',
    seconds: 1.1,
    influence: 0.8,
    prompt:
      `a car side window shattering, a bright sharp burst of breaking tempered glass followed by small cubes of glass falling and scattering on the road, ${NO_BLEED}`,
  },
  {
    id: 'imp/ricochet',
    file: 'imp/ricochet.mp3',
    seconds: 0.9,
    influence: 0.8,
    prompt:
      `a bullet ricocheting off stone and whining away into the distance, a short hard tick followed by a descending metallic whistling zing, ${NO_BLEED}`,
  },
  {
    id: 'imp/debris',
    file: 'imp/debris.mp3',
    seconds: 2.2,
    influence: 0.7,
    prompt:
      `broken rubble raining down onto a road after a blast, chunks of concrete and grit clattering and skittering across tarmac and settling, no explosion, ${NO_BLEED}`,
  },

  // -- the player ----------------------------------------------------------
  {
    id: 'plr/hurt',
    file: 'plr/hurt.mp3',
    seconds: 0.8,
    influence: 0.65,
    prompt:
      'a man taking a sudden hard hit to the body and letting out one short involuntary pained grunt through clenched teeth, wordless, no words, no music, close dry recording',
  },
  {
    id: 'plr/death',
    file: 'plr/death.mp3',
    seconds: 1.8,
    influence: 0.6,
    prompt:
      'a man collapsing, one long wordless failing exhale trailing off into silence as the body drops heavily to the ground, wordless, no words, no music, close dry recording',
  },
  {
    id: 'plr/heartbeat',
    file: 'plr/heartbeat.mp3',
    seconds: 2.4,
    influence: 0.7,
    loop: true,
    prompt:
      'seamless looping slow heavy human heartbeat heard from inside the chest, deep muffled double thump repeating at a steady urgent pace, low frequency, no music, no speech, no other sound',
  },
  {
    id: 'plr/tinnitus',
    file: 'plr/tinnitus.mp3',
    seconds: 2.5,
    influence: 0.7,
    loop: true,
    prompt:
      'seamless looping steady high-pitched ringing tone of ear damage after a nearby explosion, a single continuous thin sine-like whine with a faint hollow pressure underneath, absolutely even, no music, no speech, no other sound',
  },
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Peak level and duration of a rendered file, via ffmpeg/ffprobe. */
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
 * Playback trim, derived the same way the rest of the manifest was: one-shots
 * are peak-normalised towards -6 dBFS and loops mean-normalised towards
 * -34 dBFS, with boosts capped at +10 dB so a quiet render cannot drag its own
 * noise floor up with it.
 */
function trimFor(clip, measured) {
  const target = clip.loop ? -34 : -6;
  const level = clip.loop ? measured.meanDb : measured.peakDb;
  if (!Number.isFinite(level)) return 0;
  return Number(Math.min(10, target - level).toFixed(1));
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

async function main() {
  const key = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_LABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set');

  const only = new Set(process.argv.slice(2));
  const wanted = only.size > 0 ? CLIPS.filter((c) => only.has(c.id)) : CLIPS;
  if (wanted.length === 0) throw new Error(`No clip matches ${[...only].join(', ')}`);

  const report = [];
  let credits = 0;
  for (const clip of wanted) {
    const path = join(AUDIO_DIR, clip.file);
    if (only.size === 0 && (await exists(path))) {
      console.error(`skip   ${clip.id} (exists)`);
      continue;
    }
    process.stderr.write(`render ${clip.id} ... `);
    await generate(clip, key);
    const measured = await measure(path);
    credits += clip.seconds * CREDITS_PER_SECOND;
    console.error(
      `${measured.duration.toFixed(3)}s ${measured.bytes}B peak ${measured.peakDb}dB mean ${measured.meanDb}dB`,
    );
    report.push({
      id: clip.id,
      path: `/audio/${clip.file}`,
      seconds: clip.seconds,
      influence: clip.influence,
      loop: clip.loop === true,
      prompt: clip.prompt,
      ...measured,
      trimDb: trimFor(clip, measured),
      credits: Number((clip.seconds * CREDITS_PER_SECOND).toFixed(4)),
    });
  }
  console.log(JSON.stringify({ model: MODEL, outputFormat: OUTPUT_FORMAT, credits: Number(credits.toFixed(2)), clips: report }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
