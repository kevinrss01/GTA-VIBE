#!/usr/bin/env node
/**
 * Generates the police, aircraft, airport, impact and replacement footstep
 * sound effects, and re-normalises the whole footstep set on a LOUDNESS basis.
 *
 * LOCAL TOOLING ONLY. This never ships: it takes `ELEVENLABS_API_KEY` from the
 * environment, falling back to the repository's untracked `.env`, writes MP3s
 * into `public/audio/`, and prints the measured properties the audio manifest
 * needs. The key is never written to a file, a log line or an output artefact.
 *
 * Why the REST API rather than the ElevenLabs MCP: the MCP exposes sound
 * effects through `creative_generate_in_flow` with `node_type: 'sfx'`, which
 * builds variation sets on a shared editing canvas and returns node and session
 * ids. That is the wrong shape for twenty-one deterministic single renders that
 * must land at fixed paths with recorded parameters, and the existing manifest
 * was rendered this way, so matching it keeps the provenance uniform. The MCP
 * was checked in this session before falling back; the tool list confirms it
 * has no direct file-returning sound-effect endpoint.
 *
 *   node tools/generate-world-sfx.mjs                # everything missing
 *   node tools/generate-world-sfx.mjs police/siren   # one id, forced
 *   node tools/generate-world-sfx.mjs --probe        # one cheap 3 s loop probe
 *   node tools/generate-world-sfx.mjs --steps        # re-cut/normalise steps
 *   node tools/generate-world-sfx.mjs --steps asphalt-1  # ...only these
 *   node tools/generate-world-sfx.mjs --bands        # step band fingerprints
 *   node tools/generate-world-sfx.mjs --takes 5 steps/stone-1  # best of five
 *
 * Existing files are skipped unless named explicitly, so a rerun costs nothing.
 *
 * ## `--steps`, and why the footsteps are cut before they are levelled
 *
 * The shipped step renders are all 0.680249 s long, and measured per 26 ms
 * window their energy is gone by roughly 0.30 s: everything after that is the
 * model's tail and near-silence. The player controller emits a step every
 * `strideLength / speed` metres-per-second, which is 0.518 s walking and
 * 0.325 s running, so at a run every footstep overlapped the previous one and
 * part of the one before it. Two to three voices summing is +6 to +9.5 dB, and
 * that - not the trim - was why footsteps were too loud.
 *
 * `--steps` cuts every step to STEP_WINDOW seconds around its own transient
 * with a short fade at each end, which removes the overlap at the source, then
 * levels the set by MEAN energy rather than by peak. Peak-normalising
 * transients does not equalise loudness: the shipped set measured a 15.5 dB
 * spread in post-trim mean level, and the grass pair alternated across the
 * widest part of it on every other step.
 */

import { mkdir, writeFile, access, readFile, rename, unlink } from 'node:fs/promises';
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

const NO_BLEED = 'close dry recording, no reverb, no music, no speech, no other sound';
const NO_BLEED_LOOP = 'absolutely even and continuous, no music, no speech, no other sound';

/**
 * Every clip, with the exact parameters it is rendered at.
 *
 * `seconds` is what the request asks for; the model rounds to whole frames, so
 * the shipped duration is measured afterwards rather than assumed.
 */
const CLIPS = [
  // -- footsteps: the grass pair is unusable and is replaced ----------------
  // -- footsteps: the asphalt pair sounded like grass and is replaced -------
  //
  // The 2026-08-27 set classified and levelled correctly but the two ASPHALT
  // renders were the wrong SOUND. Measured in five bands, both sat in the
  // rustle/crunch class rather than the hard-surface class: `asphalt-1` had its
  // 180-800 Hz body 4.2 dB above its 8 kHz air (a rustle has no body; the
  // pavement and concrete renders manage 25-27 dB), and `asphalt-2` peaked in
  // the 0.8-3 kHz band like the gravel pair does. That is why walking on a road
  // still sounded like walking on grass even though the classifier was right.
  //
  // What fixed it in the prompt was naming the DAMPING and excluding the
  // failure modes by name: asphalt is a bound, slightly porous surface, so a
  // shoe on it is a dull blunt low contact with almost no ring and only a trace
  // of grit - not a crunch of loose stones and not a rustle.
  {
    id: 'steps/asphalt-1',
    file: 'steps/asphalt-1.mp3',
    seconds: 0.5,
    influence: 0.85,
    step: true,
    prompt: `one single shoe stepping down onto worn asphalt road, a dull blunt low thud on hard bitumen with a short dry sandy grit texture over it, damped with no ring and no tail, walking pace, recorded loud and very close, no crunch, no loose gravel, no stones, no rustling, ${NO_BLEED}`,
  },
  {
    id: 'steps/asphalt-2',
    file: 'steps/asphalt-2.mp3',
    seconds: 0.5,
    influence: 0.85,
    step: true,
    prompt: `one single boot heel rolling onto dry tarmac and scraping briefly on road dust, a thick low blunt contact with a short gritty rubber drag, dead and damped, walking pace, recorded loud and very close, no crunch, no gravel, no stones, no grass, no rustle, ${NO_BLEED}`,
  },
  {
    id: 'steps/grass-1',
    file: 'steps/grass-1.mp3',
    seconds: 0.5,
    influence: 0.85,
    step: true,
    prompt: `one single footstep pressing down into short dry grass over firm soil, a crisp rustle of grass blades with a dull earth thud underneath it, walking pace, recorded loud and close, ${NO_BLEED}`,
  },
  {
    id: 'steps/grass-2',
    file: 'steps/grass-2.mp3',
    seconds: 0.5,
    influence: 0.85,
    step: true,
    prompt: `one single footstep landing in longer damp grass and soft earth, a muffled swishing rustle with a soft low thump under it, walking pace, recorded loud and close, ${NO_BLEED}`,
  },
  // -- footsteps: cut stone, which used to borrow the pavement pair ---------
  //
  // `plazaStone` and `stoneAshlar` are their own materials in the world and the
  // plaza is its own terrain surface, and all three played a concrete paving
  // slab. Cut stone is denser and brighter than a poured slab: it keeps far
  // more 0.8-3 kHz content, which is why the pavement pair reads as wrong
  // underfoot in the old quarter.
  {
    id: 'steps/stone-1',
    file: 'steps/stone-1.mp3',
    seconds: 0.5,
    influence: 0.85,
    step: true,
    prompt: `one single leather-soled shoe landing on a worn stone flagstone in an old town square, a hard bright stony knock with a short natural click and no grit, walking pace, recorded loud and very close, no crunch, no gravel, no loose stones, no rustling, ${NO_BLEED}`,
  },
  {
    id: 'steps/stone-2',
    file: 'steps/stone-2.mp3',
    seconds: 0.5,
    influence: 0.85,
    step: true,
    prompt: `one single footstep pivoting on a smooth worn limestone slab, a hard bright stone contact with a brief dry sole scuff, dense and solid, walking pace, recorded loud and very close, no crunch, no gravel, no dirt, no rustling, ${NO_BLEED}`,
  },
  // -- footsteps: the airport surfaces --------------------------------------
  {
    id: 'steps/concrete-1',
    file: 'steps/concrete-1.mp3',
    seconds: 0.5,
    influence: 0.85,
    step: true,
    prompt: `one single heavy hard-soled work boot stamping down on a bare poured concrete apron, one loud flat hard slap at full volume with a little grit under the sole, recorded very close with the microphone at the shoe, ${NO_BLEED}`,
  },
  {
    id: 'steps/concrete-2',
    file: 'steps/concrete-2.mp3',
    seconds: 0.5,
    influence: 0.85,
    step: true,
    prompt: `one single boot step scuffing on a bare dusty concrete apron outdoors, a hard flat contact ending in a short gritty scrape, walking pace, recorded loud and close, ${NO_BLEED}`,
  },
  {
    id: 'steps/terminal-1',
    file: 'steps/terminal-1.mp3',
    seconds: 0.5,
    influence: 0.85,
    step: true,
    prompt: 'one single loud sharp footstep on a hard polished tiled floor, a bright flat slap of a leather sole at full volume with a very short tail, recorded extremely close, no music, no speech, no other sound',
  },
  {
    id: 'steps/terminal-2',
    file: 'steps/terminal-2.mp3',
    seconds: 0.5,
    influence: 0.85,
    step: true,
    prompt: 'one single hard leather heel striking a polished marble floor, one loud crisp high click at full volume with a very short tail, recorded extremely close with the microphone right at the shoe, no music, no speech, no other sound',
  },

  // -- police ---------------------------------------------------------------
  {
    id: 'police/siren',
    file: 'police/siren.mp3',
    seconds: 8,
    influence: 0.65,
    loop: true,
    prompt: `seamless looping police car siren, a single electronic siren speaker sweeping up and down in a steady continuous wail cycle at a constant close distance, no engine, no tyres, no traffic, no doppler, no approach and no departure, ${NO_BLEED_LOOP}`,
  },
  {
    id: 'police/engine',
    file: 'police/engine.mp3',
    seconds: 8,
    influence: 0.6,
    loop: true,
    prompt: `seamless looping large V8 police interceptor engine held at high revs under hard acceleration, a hard aggressive exhaust drone with an urgent edge to it, steady pitch with no gear change and no rise or fall, no siren, no tyres, ${NO_BLEED_LOOP}`,
  },

  // -- aircraft -------------------------------------------------------------
  {
    id: 'air/prop-single',
    file: 'air/prop-single.mp3',
    seconds: 8,
    influence: 0.65,
    loop: true,
    prompt: `seamless looping single-engine light aircraft propeller, a small four-cylinder piston aero engine turning a two-blade propeller at steady cruise power, a hard regular blade chop over a rough mechanical engine beat, constant speed with no rise or fall, no wind, no radio, ${NO_BLEED_LOOP}`,
  },
  {
    id: 'air/turboprop',
    file: 'air/turboprop.mp3',
    seconds: 8,
    influence: 0.65,
    loop: true,
    prompt: `seamless looping twin turboprop commuter aircraft engines at steady cruise power, two large multi-blade propellers beating slightly out of phase with a smooth turbine whine behind them, constant speed with no rise or fall, no wind, no radio, ${NO_BLEED_LOOP}`,
  },
  {
    id: 'air/turbofan',
    file: 'air/turbofan.mp3',
    seconds: 8,
    influence: 0.65,
    loop: true,
    prompt: `seamless looping small business jet turbofan engines at steady cruise thrust, a smooth high tonal fan whine over a broad jet efflux roar, no propeller and no blade beat, constant thrust with no spool up or down, no wind, no radio, ${NO_BLEED_LOOP}`,
  },
  {
    id: 'air/airliner',
    file: 'air/airliner.mp3',
    seconds: 8,
    influence: 0.65,
    loop: true,
    prompt: `seamless looping large narrowbody airliner turbofan engines at steady high thrust heard from outside the aircraft, an enormous deep jet roar with a heavy low rumble and a distant fan tone in it, constant thrust with no spool up or down, no wind, no radio, ${NO_BLEED_LOOP}`,
  },
  {
    id: 'air/wind',
    file: 'air/wind.mp3',
    seconds: 10,
    influence: 0.55,
    loop: true,
    prompt: `seamless looping smooth rushing airflow over an aircraft airframe in flight, a broad even wind roar with no gusting and no whistling, no engine, no propeller, no turbine, ${NO_BLEED_LOOP}`,
  },
  {
    id: 'air/runway-roll',
    file: 'air/runway-roll.mp3',
    seconds: 8,
    influence: 0.6,
    loop: true,
    prompt: `seamless looping aircraft main landing gear tyres rolling fast along a concrete runway, a heavy continuous rumble with regular thumps as the wheels cross the expansion joints, no engine, no wind, no brakes, ${NO_BLEED_LOOP}`,
  },
  {
    id: 'air/touchdown',
    file: 'air/touchdown.mp3',
    seconds: 1.2,
    influence: 0.8,
    prompt: `an aircraft main landing gear touching down on a runway, a sharp rubber chirp as the tyres spin up with a puff of smoke and a heavy suspension thump straight after it, one touchdown only, ${NO_BLEED}`,
  },
  {
    id: 'air/brake',
    file: 'air/brake.mp3',
    seconds: 1.8,
    influence: 0.7,
    prompt: `an airliner slowing hard on the runway after landing, heavy wheel brakes grinding and rumbling with a rising roar of reverse thrust over them, decaying away as the aircraft slows, no engine idle, ${NO_BLEED}`,
  },
  {
    id: 'ambience/airport',
    file: 'ambience/airport.mp3',
    seconds: 15,
    influence: 0.45,
    loop: true,
    prompt: `seamless looping airport ambience heard on the apron outside a terminal building, a steady low rumble of distant jet engines idling far across the field, ground power units and air conditioning plant humming nearby, a very distant aircraft taking off at the far end of the runway, faint wind over open concrete, no announcements, no speech, no music, no vehicles close by`,
  },

  // -- vehicle collisions ---------------------------------------------------
  {
    id: 'veh/impact-light',
    file: 'veh/impact-light.mp3',
    seconds: 1.0,
    influence: 0.8,
    prompt: `a car nudging something at walking pace, one dull soft plastic bumper knock with a faint creak of trim afterwards, quiet and unimpressive, no glass, no alarm, ${NO_BLEED}`,
  },
  {
    id: 'veh/impact-heavy',
    file: 'veh/impact-heavy.mp3',
    seconds: 2.0,
    influence: 0.8,
    prompt: `a violent high speed car crash, an enormous crunch of sheet metal folding and tearing with a deep structural boom through it, debris and trim clattering onto the road afterwards, no alarm, ${NO_BLEED}`,
  },

  // -- bullet impacts the combat layer is adding ----------------------------
  {
    id: 'imp/wood',
    file: 'imp/wood.mp3',
    seconds: 0.7,
    influence: 0.8,
    prompt: `a rifle bullet slamming into a thick timber plank at full volume, one loud hard dry woody crack with splinters tearing off and a short hollow ring afterwards, recorded very close, ${NO_BLEED}`,
  },
  {
    id: 'imp/foliage',
    file: 'imp/foliage.mp3',
    seconds: 0.7,
    influence: 0.8,
    prompt: `a bullet tearing through dense leafy foliage, a sharp burst of leaves and thin twigs snapping and shaking, soft and papery with no hard surface hit, ${NO_BLEED}`,
  },
];

/** A single cheap render used to validate the prompt shape and the loop seam. */
const PROBE = {
  id: 'probe/siren',
  file: 'probe/siren.mp3',
  seconds: 3,
  influence: 0.65,
  loop: true,
  prompt: `seamless looping police car siren, a single electronic siren speaker sweeping up and down in a steady continuous wail cycle at a constant close distance, no engine, no tyres, no traffic, no doppler, ${NO_BLEED_LOOP}`,
};

// ---------------------------------------------------------------------------
// Footstep re-cut and loudness normalisation
// ---------------------------------------------------------------------------

/**
 * How much of a footstep is kept.
 *
 * 0.32 s is measured, not chosen: per 26 ms window every shipped step render
 * has fallen at least 25 dB below its own peak by 0.30 s. It is also under the
 * 0.325 s running cadence, so consecutive footsteps no longer sum.
 */
const STEP_WINDOW = 0.32;
/** Fades at the cut points. In at 5 ms to kill the edit click, out at 70 ms. */
const STEP_FADE_IN = 0.005;
const STEP_FADE_OUT = 0.07;
/**
 * Target mean level for the levelled set, in dBFS.
 *
 * -22 dB mean over a 0.32 s window is roughly where the loudest surviving
 * render already sits, so the set is brought together mostly by attenuation
 * rather than by boosting quiet renders and their noise floors with them.
 */
const STEP_TARGET_MEAN_DB = -22;
/** Never let a normalised step come within this much of full scale. */
const STEP_PEAK_CEILING_DB = -1.5;

const STEP_FILES = [
  'pavement-1', 'pavement-2',
  'asphalt-1', 'asphalt-2',
  'boardwalk-1', 'boardwalk-2',
  'gravel-1', 'gravel-2',
  'grass-1', 'grass-2',
  'interior-1', 'interior-2',
  'concrete-1', 'concrete-2',
  'terminal-1', 'terminal-2',
  'stone-1', 'stone-2',
];

/**
 * Finds where the step actually starts, so the cut window is placed on the
 * transient rather than on whatever lead-in the model left in front of it.
 * Returns 0 when the file opens on the hit already, which most of them do.
 */
async function transientStart(path) {
  const { stderr } = await run('ffmpeg', [
    '-i', path,
    '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ]);
  const times = [];
  const levels = [];
  const pattern = /pts_time:([\d.]+)[\s\S]*?RMS_level=(-?[\d.inf]+)/g;
  let match;
  while ((match = pattern.exec(stderr)) !== null) {
    const level = Number(match[2]);
    if (!Number.isFinite(level)) continue;
    times.push(Number(match[1]));
    levels.push(level);
  }
  if (levels.length === 0) return 0;
  const peak = Math.max(...levels);
  // 12 dB under the loudest window is comfortably above the noise floor and
  // below the attack, so the window opens on the rise rather than mid-hit.
  const threshold = peak - 12;
  for (let i = 0; i < levels.length; i += 1) {
    if (levels[i] >= threshold) return Math.max(0, (times[i] ?? 0) - 0.01);
  }
  return 0;
}

/**
 * Five-band fingerprint of one footstep, and why the set needs one.
 *
 * The 2026-08-27 pass levelled the footsteps and fixed the classifier, and the
 * road still sounded like grass - because loudness and classification say
 * nothing about TIMBRE. A footstep on a hard surface is a fast low contact: its
 * 180-800 Hz band stands well above its 8 kHz air, and it does not peak in the
 * 0.8-3 kHz band. A rustle and a crunch do the opposite. Two derived numbers
 * separate them:
 *
 *   body   = mean(180-800 Hz) - mean(8 kHz+)   a hard contact has 12 dB or more
 *   crunch = mean(0.8-3 kHz) - mean(180-800)   a hard contact stays at or below 0
 *
 * Measured with `--bands` and pinned in `src/audio/manifest.ts` as
 * `STEP_BAND_DB`, so `tests/audio.test.ts` fails if a re-render drifts back
 * into the rustle class. The filters are second order rather than steep on
 * purpose: this is a class test, not a crossover, and a gentle slope keeps the
 * number stable against small differences in where the transient lands.
 */
const BANDS = [
  ['lo', 'lowpass=f=180'],
  ['lowMid', 'highpass=f=180,lowpass=f=800'],
  ['mid', 'highpass=f=800,lowpass=f=3000'],
  ['high', 'highpass=f=3000,lowpass=f=8000'],
  ['air', 'highpass=f=8000'],
];

async function bandMean(path, filter) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', path, '-af', `${filter},volumedetect`, '-f', 'null', '-',
  ]);
  const match = /mean_volume: (-?[\d.]+)/.exec(stderr);
  return match ? Number(match[1]) : null;
}

/**
 * Renders a footstep several times and keeps the best take.
 *
 * The generator is stochastic, and a footstep has to satisfy three measured
 * constraints at once that a single take frequently misses:
 *
 *   - it must LEVEL. The set is held inside 4 dB of post-trim mean by
 *     `tests/audio.test.ts`, and the trim is `min(byMean, byPeak)` - so a take
 *     whose peak is already at -0.4 dBFS but whose mean is -27 dB cannot be
 *     brought up to the -22 dB target at all, however good it sounds.
 *   - it must be in the HARD class: body >= 10 dB (see `--bands`).
 *   - it must not be a CRUNCH: crunch <= +2 dB.
 *
 * Re-rolling by hand until three numbers line up is the same work with worse
 * provenance, so the selection lives here and the chosen take's measurements
 * go into the manifest. Cost is linear in the take count and is reported.
 */
const TAKE_TARGET_MEAN_DB = -22;
const TAKE_BODY_DB = 10;
const TAKE_CRUNCH_DB = 2;

async function stepTake(clip, key, index) {
  const path = join(AUDIO_DIR, clip.file);
  const kept = `${path}.take${index}`;
  await generate(clip, key);
  await rename(path, kept);
  return kept;
}

/** Cuts, levels and measures a candidate take in place, without shipping it. */
async function scoreTake(path) {
  const start = await transientStart(path);
  const temp = `${path}.cut`;
  const fadeOutAt = Math.max(0, STEP_WINDOW - STEP_FADE_OUT);
  await run('ffmpeg', [
    '-y', '-ss', start.toFixed(4), '-t', STEP_WINDOW.toFixed(4), '-i', path,
    '-af', `afade=t=in:st=0:d=${STEP_FADE_IN},afade=t=out:st=${fadeOutAt.toFixed(4)}:d=${STEP_FADE_OUT}`,
    '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-f', 'mp3', temp,
  ]);
  const measured = await measure(temp);
  const bands = {};
  for (const [name, filter] of BANDS) bands[name] = await bandMean(temp, filter);
  await unlink(temp);
  const trimDb = Math.min(
    TAKE_TARGET_MEAN_DB - measured.meanDb,
    STEP_PEAK_CEILING_DB - measured.peakDb,
    10,
  );
  const body = bands.lowMid - bands.air;
  const crunch = bands.mid - bands.lowMid;
  // Distance from the three targets, in dB, with no credit for overshooting a
  // constraint that is already satisfied.
  const penalty =
    Math.abs(measured.meanDb + trimDb - TAKE_TARGET_MEAN_DB) +
    Math.max(0, TAKE_BODY_DB - body) +
    Math.max(0, crunch - TAKE_CRUNCH_DB);
  return {
    effectiveMeanDb: Number((measured.meanDb + trimDb).toFixed(1)),
    body: Number(body.toFixed(1)),
    crunch: Number(crunch.toFixed(1)),
    penalty: Number(penalty.toFixed(2)),
  };
}

async function renderTakes(clips, key, takes) {
  let credits = 0;
  for (const clip of clips) {
    if (clip.step !== true) throw new Error(`--takes is for footsteps; ${clip.id} is not one`);
    const scored = [];
    for (let i = 0; i < takes; i += 1) {
      const path = await stepTake(clip, key, i);
      credits += clip.seconds * CREDITS_PER_SECOND;
      const score = await scoreTake(path);
      scored.push({ path, ...score });
      console.error(
        `${clip.id} take ${i}: mean ${score.effectiveMeanDb} dB, body ${score.body} dB, ` +
          `crunch ${score.crunch} dB, penalty ${score.penalty}`,
      );
    }
    scored.sort((a, b) => a.penalty - b.penalty);
    const best = scored[0];
    await rename(best.path, join(AUDIO_DIR, clip.file));
    for (const take of scored.slice(1)) await unlink(take.path);
    console.error(`${clip.id}: kept the take with penalty ${best.penalty}`);
  }
  console.error(`takes cost ${credits.toFixed(2)} credits`);
}

async function measureBands() {
  const out = {};
  for (const name of STEP_FILES) {
    const path = join(AUDIO_DIR, 'steps', `${name}.mp3`);
    if (!(await exists(path))) continue;
    const row = {};
    for (const [key, filter] of BANDS) row[key] = await bandMean(path, filter);
    row.body = Number((row.lowMid - row.air).toFixed(1));
    row.crunch = Number((row.mid - row.lowMid).toFixed(1));
    out[`steps/${name}`] = row;
    console.error(
      `steps/${name}: body ${row.body >= 0 ? '+' : ''}${row.body} dB, ` +
        `crunch ${row.crunch >= 0 ? '+' : ''}${row.crunch} dB`,
    );
  }
  console.log(JSON.stringify(out, null, 2));
}

async function normaliseSteps(only) {
  const report = [];
  // Cutting is DESTRUCTIVE and in place. Re-running it over an already-cut file
  // re-encodes it and re-derives its trim from the re-encode, so a re-render of
  // one pair must not drag the other fourteen through a second generation loss.
  const wanted = only.length > 0 ? STEP_FILES.filter((n) => only.includes(n)) : STEP_FILES;
  if (only.length > 0 && wanted.length !== only.length) {
    throw new Error(`Unknown step: ${only.filter((n) => !STEP_FILES.includes(n)).join(', ')}`);
  }
  for (const name of wanted) {
    const path = join(AUDIO_DIR, 'steps', `${name}.mp3`);
    if (!(await exists(path))) {
      console.error(`skip   steps/${name} (not rendered)`);
      continue;
    }
    const before = await measure(path);
    // ALREADY CUT IS NOT A NO-OP. The cut is destructive and in place, and a
    // second pass re-seeks the transient inside the already-trimmed file, so it
    // walks the window forward and throws away the head of the step - measured
    // once by accident, and the file came back 418 bytes shorter and 1.6 dB
    // louder. Anything at or under the window has been through this already.
    if (before.duration <= STEP_WINDOW + 0.005) {
      console.error(`skip   steps/${name} (already ${before.duration.toFixed(3)}s)`);
      continue;
    }
    const start = await transientStart(path);
    const temp = join(AUDIO_DIR, 'steps', `${name}.cut.mp3`);
    const fadeOutAt = Math.max(0, STEP_WINDOW - STEP_FADE_OUT);
    await run('ffmpeg', [
      '-y', '-ss', start.toFixed(4), '-t', STEP_WINDOW.toFixed(4), '-i', path,
      '-af', `afade=t=in:st=0:d=${STEP_FADE_IN},afade=t=out:st=${fadeOutAt.toFixed(4)}:d=${STEP_FADE_OUT}`,
      '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', temp,
    ]);
    await unlink(path);
    await rename(temp, path);
    const after = await measure(path);

    // Loudness first, then a peak guard: a transient whose mean sits low only
    // because it is short must not be pushed into clipping to hit the target.
    const byMean = STEP_TARGET_MEAN_DB - after.meanDb;
    const byPeak = STEP_PEAK_CEILING_DB - after.peakDb;
    const trimDb = Number(Math.min(byMean, byPeak, 10).toFixed(1));
    report.push({
      id: `steps/${name}`,
      beforeDuration: Number(before.duration.toFixed(6)),
      beforeMeanDb: before.meanDb,
      beforePeakDb: before.peakDb,
      cutFrom: Number(start.toFixed(4)),
      duration: Number(after.duration.toFixed(6)),
      bytes: after.bytes,
      meanDb: after.meanDb,
      peakDb: after.peakDb,
      trimDb,
      effectiveMeanDb: Number((after.meanDb + trimDb).toFixed(1)),
      effectivePeakDb: Number((after.peakDb + trimDb).toFixed(1)),
    });
    console.error(
      `steps/${name}: ${before.duration.toFixed(3)}s -> ${after.duration.toFixed(3)}s, ` +
        `mean ${before.meanDb} -> ${after.meanDb}, trim ${trimDb}`,
    );
  }
  console.log(JSON.stringify({ window: STEP_WINDOW, target: STEP_TARGET_MEAN_DB, steps: report }, null, 2));
}

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
 * point. Anything under about 3 dB is inaudible over a bed.
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
 * Playback trim.
 *
 * Loops are mean-normalised towards -34 dBFS as the rest of the manifest is.
 * One-shots are peak-normalised towards -6 dBFS. Footsteps are the exception
 * and are handled by `--steps`, on a loudness basis; see the note at the top.
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
    credits += clip.seconds * CREDITS_PER_SECOND;
    console.error(
      `${measured.duration.toFixed(3)}s ${measured.bytes}B peak ${measured.peakDb}dB ` +
        `mean ${measured.meanDb}dB${seam === null ? '' : ` seam ${seam}dB`}`,
    );
    report.push({
      id: clip.id,
      path: `/audio/${clip.file}`,
      seconds: clip.seconds,
      influence: clip.influence,
      loop: clip.loop === true,
      prompt: clip.prompt,
      ...measured,
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

  if (args.includes('--bands')) {
    await measureBands();
    return;
  }

  if (args.includes('--steps')) {
    await normaliseSteps(args.filter((a) => !a.startsWith('--')));
    return;
  }

  await loadDotEnv();
  const key = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_LABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set');

  if (args.includes('--probe')) {
    await renderAll([PROBE], key, true);
    return;
  }

  const takesAt = args.indexOf('--takes');
  const takes = takesAt >= 0 ? Number(args[takesAt + 1]) : 0;
  const only = new Set(args.filter((a, i) => !a.startsWith('--') && i !== takesAt + 1));
  const wanted = only.size > 0 ? CLIPS.filter((c) => only.has(c.id)) : CLIPS;
  if (wanted.length === 0) throw new Error(`No clip matches ${[...only].join(', ')}`);
  if (takes > 0) {
    if (!Number.isInteger(takes) || takes < 2) throw new Error('--takes needs an integer of 2 or more');
    await renderTakes(wanted, key, takes);
    return;
  }
  await renderAll(wanted, key, only.size > 0);
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
