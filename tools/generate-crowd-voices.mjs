#!/usr/bin/env node
/**
 * Generates the voices of the street: police challenges and crowd chatter.
 *
 * LOCAL TOOLING ONLY. Reads `ELEVENLABS_API_KEY` from the environment, falling
 * back to the repository's untracked `.env`, and writes MP3s into
 * `public/audio/voice/`. The key never reaches a file, a log line or an output
 * artefact.
 *
 *   node tools/generate-crowd-voices.mjs                 # everything missing
 *   node tools/generate-crowd-voices.mjs pol-stop-1      # one line, forced
 *
 * Existing files are skipped unless named explicitly, so a rerun is free.
 *
 * SHAPE OF THE CAST. Two things are being voiced here and they want opposite
 * treatments:
 *
 *   POLICE are an instruction shouted at the player. They have to cut through
 *   a siren, an engine and whatever the player is doing, so they are short,
 *   hard-consonant lines delivered with low `stability` (a shout, not a read)
 *   and are given only three speakers, because a pursuit that arrives in eight
 *   different voices reads as a crowd rather than as the police.
 *
 *   PEDESTRIANS are overheard, not addressed. They are half-sentences from the
 *   middle of a conversation that the player will only ever catch a few metres
 *   of, and they get SEVEN speakers, because the whole point is that the city
 *   is full of different people. Higher `stability` than the police: this is
 *   ordinary talk, and an emotional read of "the rent is going up again" is
 *   worse than a flat one.
 *
 * VOICES are chosen from the account's own library (658 voices at the time of
 * writing; `GET /v1/voices`), never assumed. `Lily` and `Callum` are
 * deliberately absent: they are Sable and Teo, and the crowd must not sound
 * like the mission cast. None is a clone of a real person.
 */

import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const API = 'https://api.elevenlabs.io/v1/text-to-speech';
const MODEL = 'eleven_multilingual_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';
const ROOT = new URL('..', import.meta.url).pathname;
const AUDIO_DIR = join(ROOT, 'public', 'audio', 'voice');

/** Who speaks, and which library voice they speak with. */
const CAST = {
  officerM: { voiceId: 'pNInz6obpgDQGcFmaJgB', name: 'Adam - Dominant, Firm' },
  officerF: { voiceId: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda - Knowledgable, Professional' },
  dispatch: { voiceId: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel - Steady Broadcaster' },
  civicA: { voiceId: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger - Laid-Back, Casual, Resonant' },
  civicB: { voiceId: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica - Playful, Bright, Warm' },
  civicC: { voiceId: 'iP95p4xoKVk53GoZ742B', name: 'Chris - Charming, Down-to-Earth' },
  civicD: { voiceId: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura - Enthusiast, Quirky Attitude' },
  civicE: { voiceId: 'bIHbv24MWmeRgasZH58o', name: 'Will - Relaxed Optimist' },
  civicF: { voiceId: 'pqHfZKP75CvOlQylNhV4', name: 'Bill - Wise, Mature, Balanced' },
  civicG: { voiceId: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah - Mature, Reassuring, Confident' },
};

/**
 * Voice settings, per speaker.
 *
 * `stability` is the dial that matters. Low is a delivery with range in it,
 * high is an even read - so the police sit low (they are shouting an order
 * across a street) and ordinary conversation sits high (it is talk, not
 * performance). `similarity_boost` is high everywhere so two lines from the
 * same speaker are recognisably the same person, which is the only thing
 * holding a pursuit or a conversation together across separate files.
 */
const POLICE_SETTINGS = {
  stability: 0.3,
  similarity_boost: 0.85,
  style: 0.55,
  use_speaker_boost: true,
};
const RADIO_SETTINGS = {
  stability: 0.55,
  similarity_boost: 0.85,
  style: 0.2,
  use_speaker_boost: true,
};
const CIVIC_SETTINGS = {
  stability: 0.55,
  similarity_boost: 0.8,
  style: 0.3,
  use_speaker_boost: true,
};
const ALARM_SETTINGS = {
  stability: 0.25,
  similarity_boost: 0.8,
  style: 0.6,
  use_speaker_boost: true,
};

const SETTINGS = {
  officerM: POLICE_SETTINGS,
  officerF: POLICE_SETTINGS,
  dispatch: RADIO_SETTINGS,
  civicA: CIVIC_SETTINGS,
  civicB: CIVIC_SETTINGS,
  civicC: CIVIC_SETTINGS,
  civicD: CIVIC_SETTINGS,
  civicE: CIVIC_SETTINGS,
  civicF: CIVIC_SETTINGS,
  civicG: CIVIC_SETTINGS,
};

const LINES = [
  // -- Police: the challenge, shouted from a unit that has closed on foot ----
  { id: 'pol-stop-1', speaker: 'officerM', text: 'Meridian Bay Police! Stop right there!' },
  { id: 'pol-stop-2', speaker: 'officerF', text: 'Police! Stop moving!' },
  { id: 'pol-stop-3', speaker: 'officerM', text: 'Stop! Hands where I can see them!' },
  { id: 'pol-halt-1', speaker: 'officerF', text: "That's far enough. Down on the ground." },
  { id: 'pol-halt-2', speaker: 'officerM', text: 'Last warning. On the ground, now!' },
  { id: 'pol-halt-3', speaker: 'officerF', text: "Don't make this worse. Stay where you are." },
  // -- Police: at a vehicle --------------------------------------------------
  { id: 'pol-pullover-1', speaker: 'officerM', text: 'Pull the vehicle over. Now.' },
  { id: 'pol-pullover-2', speaker: 'officerF', text: 'Stop the car and step out of it.' },
  // -- Police: radio traffic between units -----------------------------------
  { id: 'pol-radio-1', speaker: 'dispatch', text: 'All units, suspect on foot, Harbourside.' },
  { id: 'pol-radio-2', speaker: 'dispatch', text: 'Converge on Dock Street. Move in.' },
  { id: 'pol-radio-3', speaker: 'dispatch', text: 'Be advised, the suspect is armed.' },
  { id: 'pol-lost-1', speaker: 'officerM', text: "We've lost visual. Sweep the block." },
  { id: 'pol-lost-2', speaker: 'officerF', text: 'Anyone got eyes on him? Check the alley.' },

  // -- Pedestrians: half a conversation, overheard in passing ----------------
  {
    id: 'chat-a-1',
    speaker: 'civicA',
    text: "Have you seen what they're charging for a coffee down on Harbour Walk?",
  },
  { id: 'chat-a-2', speaker: 'civicA', text: "It's the boats. It's always the boats with him." },
  { id: 'chat-b-1', speaker: 'civicB', text: 'So then she says the rent is going up. Again.' },
  {
    id: 'chat-b-2',
    speaker: 'civicB',
    text: "Tell him I'm not covering another night shift. I mean it.",
  },
  {
    id: 'chat-c-1',
    speaker: 'civicC',
    text: "I heard they're finally fixing the lights on Cannery Row.",
  },
  { id: 'chat-c-2', speaker: 'civicC', text: 'No, no, listen. You have to try the fish place.' },
  { id: 'chat-d-1', speaker: 'civicD', text: 'My brother swears he saw the whole thing.' },
  { id: 'chat-d-2', speaker: 'civicD', text: "That's what I said. That is exactly what I said." },
  { id: 'chat-e-1', speaker: 'civicE', text: "Half the town's out at the airfield today." },
  { id: 'chat-e-2', speaker: 'civicE', text: "Right, I'd better get back. See you Thursday." },
  { id: 'chat-f-1', speaker: 'civicF', text: "Weather's turning. You can smell it off the water." },
  { id: 'chat-f-2', speaker: 'civicF', text: 'Forty years I have walked this street. Forty.' },
  { id: 'chat-g-1', speaker: 'civicG', text: 'You are joking. Tell me you are joking.' },
  { id: 'chat-g-2', speaker: 'civicG', text: "Anyway, that's what I heard. Make of it what you will." },

  // -- Pedestrians: reacting to the player -----------------------------------
  { id: 'react-shove-1', speaker: 'civicA', text: 'Hey! Watch where you are going!' },
  { id: 'react-shove-2', speaker: 'civicD', text: 'What is wrong with you?' },
  { id: 'react-gun-1', speaker: 'civicB', text: 'Gun! He has got a gun!' },
  { id: 'react-gun-2', speaker: 'civicC', text: 'Somebody call the police!' },
  { id: 'react-gun-3', speaker: 'civicG', text: 'Get down! Everybody get down!' },
];

const ALARM_IDS = new Set(['react-gun-1', 'react-gun-2', 'react-gun-3']);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads `.env` without printing anything from it.
 *
 * Deliberately not `dotenv`: this tool has no dependencies of its own and the
 * file is three lines of `KEY=value`.
 */
async function loadDotEnv() {
  let text;
  try {
    text = await readFile(join(ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (process.env[name]) continue;
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

/** Measured properties of a rendered file, for the audio manifest. */
async function measure(path) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=sample_rate,channels',
    '-of', 'json', path,
  ]);
  const info = JSON.parse(stdout);
  const stream = info.streams?.[0] ?? {};
  let peak = null;
  let mean = null;
  try {
    const { stderr } = await run('ffmpeg', ['-i', path, '-af', 'volumedetect', '-f', 'null', '-']);
    peak = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1] ?? NaN);
    mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1] ?? NaN);
  } catch {
    /* advisory only */
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

function settingsFor(line) {
  return ALARM_IDS.has(line.id) ? ALARM_SETTINGS : SETTINGS[line.speaker];
}

async function speak(line, key) {
  const voice = CAST[line.speaker];
  if (!voice) throw new Error(`${line.id}: no voice for ${line.speaker}`);
  const response = await fetch(`${API}/${voice.voiceId}?output_format=${OUTPUT_FORMAT}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: line.text,
      model_id: MODEL,
      voice_settings: settingsFor(line),
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${line.id}: HTTP ${response.status} ${detail.slice(0, 300)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const path = join(AUDIO_DIR, `${line.id}.mp3`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function main() {
  await loadDotEnv();
  const key = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_LABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set');

  const only = new Set(process.argv.slice(2));
  const wanted = only.size > 0 ? LINES.filter((l) => only.has(l.id)) : LINES;
  if (wanted.length === 0) throw new Error(`No line matches ${[...only].join(', ')}`);

  const report = [];
  let characters = 0;
  for (const line of wanted) {
    const path = join(AUDIO_DIR, `${line.id}.mp3`);
    if (only.size === 0 && (await exists(path))) {
      console.error(`skip   ${line.id} (exists)`);
      continue;
    }
    process.stderr.write(`speak  ${line.id} (${line.text.length} chars) ... `);
    await speak(line, key);
    const measured = await measure(path);
    characters += line.text.length;
    console.error(
      `${measured.duration.toFixed(3)}s ${measured.bytes}B peak ${measured.peakDb}dB mean ${measured.meanDb}dB`,
    );
    report.push({
      id: line.id,
      speaker: line.speaker,
      voiceId: CAST[line.speaker].voiceId,
      voiceName: CAST[line.speaker].name,
      path: `/audio/voice/${line.id}.mp3`,
      text: line.text,
      characters: line.text.length,
      settings: settingsFor(line),
      ...measured,
      // Peak-normalised towards -6 dBFS like every other one-shot in the
      // manifest, so a shout sits in the mix where a gunshot does.
      trimDb: Number.isFinite(measured.peakDb)
        ? Number(Math.min(10, -6 - measured.peakDb).toFixed(1))
        : 0,
    });
  }
  console.log(
    JSON.stringify({ model: MODEL, outputFormat: OUTPUT_FORMAT, characters, lines: report }, null, 2),
  );
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});
