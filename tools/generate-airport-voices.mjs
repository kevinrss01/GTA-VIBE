#!/usr/bin/env node
/**
 * Generates Sable's dialogue for the airport leg of "Last Call".
 *
 * LOCAL TOOLING ONLY. Reads `ELEVENLABS_API_KEY` from the environment, falling
 * back to the repository's untracked `.env`, and writes MP3s into
 * `public/audio/voice/`. The key never reaches a file, a log line or an output
 * artefact.
 *
 *   node tools/generate-airport-voices.mjs                    # everything missing
 *   node tools/generate-airport-voices.mjs sable-charter-1    # one line, forced
 *
 * Existing files are skipped unless named explicitly, so a rerun is free.
 *
 * VOICE. Sable keeps the voice she was cast with in `generate-mission-voices.mjs`
 * - Lily, from the account's own library - because these lines are the same
 * person finishing the same conversation, and a second voice for the second
 * half of a job reads as a fault. Not a clone of a real person.
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
  sable: { voiceId: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily - Velvety Actress' },
  teo: { voiceId: 'N2lVS1w4EtoT3dr4eOWO', name: 'Callum - Husky Trickster' },
};

/**
 * Voice settings, per speaker.
 *
 * `stability` low enough that a line is delivered rather than read, and
 * `similarity_boost` high so two lines from the same person sound like the
 * same person. Sable is steadier than Teo on purpose: she is in charge of the
 * room and he is not.
 */
const SETTINGS = {
  sable: { stability: 0.42, similarity_boost: 0.85, style: 0.25, use_speaker_boost: true },
  teo: { stability: 0.3, similarity_boost: 0.85, style: 0.45, use_speaker_boost: true },
};

const LINES = [
  {
    id: 'sable-charter-1',
    speaker: 'sable',
    text: "Don't put that in your pocket yet. Teo made his call, and whoever he called owns half the men who would come looking for this box tonight.",
  },
  {
    id: 'sable-charter-2',
    speaker: 'sable',
    text: "So it does not stay in Meridian Bay. There is an aircraft on stand four out at the regional field, fuelled, and in my name.",
  },
  {
    id: 'sable-charter-2b',
    speaker: 'sable',
    text: "Walk in through the terminal like a passenger, take her up, and carry that box out over the bay.",
  },
  {
    id: 'sable-charter-3',
    speaker: 'sable',
    text: "Then bring my aircraft home and put it back on the runway. I am insured for the money. I am not insured for the plane.",
  },
  {
    id: 'sable-handoff-1',
    speaker: 'sable',
    text: "That is the hand-off. It is out of your hands and out of this city. Now turn her round, line up on the field, and land it like you want to walk away.",
  },
  {
    id: 'sable-landed-1',
    speaker: 'sable',
    text: "Wheels down, and still in one piece. You will do, Marlo. Come back when you want the next one.",
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

/**
 * Reads the repository's untracked `.env` into `process.env`.
 *
 * An already-exported value always wins, and nothing here prints one.
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

async function speak(line, key) {
  const voice = CAST[line.speaker];
  if (!voice) throw new Error(`${line.id}: no voice for ${line.speaker}`);
  const response = await fetch(
    `${API}/${voice.voiceId}?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: line.text,
        model_id: MODEL,
        voice_settings: SETTINGS[line.speaker],
      }),
    },
  );
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
      settings: SETTINGS[line.speaker],
      ...measured,
      // Dialogue is peak-normalised towards -6 dBFS like every other one-shot
      // in the manifest, so a line sits in the mix at the level a footstep or
      // a gunshot does.
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
  process.exit(1);
});
