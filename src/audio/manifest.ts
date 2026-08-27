/**
 * The audio asset manifest for Meridian Bay.
 *
 * This module is the single source of truth for every sound the game ships:
 * where the file lives, what it measured as on disk, how loud it needs to be
 * trimmed to sit correctly in the mix, and exactly how it was generated. The
 * reproducibility metadata is the record `AGENTS.md` requires for generated
 * assets, so it is kept next to the runtime data rather than only in docs.
 *
 * Everything here is plain data with no Web Audio or Three.js dependency, so
 * both the audio engine and the tests can read it without a browser.
 *
 * `trimDb` is not a mixing preference: it is derived from the measured level of
 * each rendered file (`ffmpeg -af volumedetect`). Generated one-shots came back
 * with peaks spread across roughly 22 dB, so they are peak-normalised towards
 * -6 dBFS, and the ambience beds are mean-normalised towards -34 dBFS so no bed
 * jumps in level as the player crosses a district boundary. Boosts are capped at
 * +10 dB so a quiet clip cannot drag its own noise floor up with it.
 */

import type { DistrictId } from '../world/CityPlan';
import type { SurfaceId } from '../world/CityGround';

export type AudioAssetKind = 'ambience' | 'step' | 'sfx' | 'music' | 'voice' | 'vehicle';

export type AmbienceBedId =
  | 'ambience/harbour'
  | 'ambience/street'
  | 'ambience/old-quarter'
  | 'ambience/park'
  | 'ambience/cannery'
  | 'ambience/ridge'
  | 'ambience/interior';

export type StepAssetId =
  | 'steps/pavement-1'
  | 'steps/pavement-2'
  | 'steps/asphalt-1'
  | 'steps/asphalt-2'
  | 'steps/boardwalk-1'
  | 'steps/boardwalk-2'
  | 'steps/gravel-1'
  | 'steps/gravel-2'
  | 'steps/grass-1'
  | 'steps/grass-2'
  | 'steps/interior-1'
  | 'steps/interior-2';

/** One-shots the game triggers by name. */
export type OneShotId = 'door-open' | 'door-close' | 'ui-tick';

export type SfxAssetId = 'sfx/door-open' | 'sfx/door-close' | 'sfx/ui-tick';

export type MusicAssetId = 'music/meridian-theme';

export type VoiceAssetId = 'voice/harbour-pa-01';

/**
 * The moving city.
 *
 * The three engine loops are the interesting ones. `engine-idle` is almost all
 * low rumble (86 per cent of its energy below 200 Hz) and `engine-load` is
 * mid-dominant (72 per cent between 200 Hz and 1.5 kHz) - that measured
 * difference is what `engineCurve.ts` crossfades between, and it is why
 * accelerating, cruising and lifting off do not all sound like one tape being
 * sped up. `engine-far` carries tyre roll rather than exhaust, because a car
 * heard from across the street is mostly rubber on asphalt and because
 * mid-band content is what an HRTF panner can actually place.
 */
export type VehicleAssetId =
  | 'veh/engine-idle'
  | 'veh/engine-load'
  | 'veh/engine-far'
  | 'veh/tyre-scrub'
  | 'veh/door-open'
  | 'veh/door-close'
  | 'veh/impact';

/**
 * The distant traffic layer. Deliberately not an `AmbienceBedId`: like the sea,
 * it sums on top of whichever land bed is playing at a level taken from the
 * world (here, how much traffic is actually moving nearby) rather than
 * replacing one, so it must never be picked up by `applyAmbience`.
 */
export type StreetLayerId = 'ambience/traffic-hum';

export type AudioAssetId =
  | AmbienceBedId
  | StepAssetId
  | SfxAssetId
  | MusicAssetId
  | VoiceAssetId
  | VehicleAssetId
  | StreetLayerId;

/** Provenance for a generated asset. Never contains a key or a signed URL. */
export interface AudioGeneration {
  readonly provider: 'elevenlabs';
  /** Model id, or `null` for an asset generated before this manifest existed. */
  readonly modelId: string | null;
  /** Exact prompt text, or `null` when it was not recorded at generation time. */
  readonly prompt: string | null;
  /** ISO-8601 date the file was generated. */
  readonly date: string;
  /** Credits actually charged, or `null` when not recorded. */
  readonly credits: number | null;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
}

export interface AudioAsset {
  readonly id: AudioAssetId;
  /** Site-absolute path. The director prefixes it with its `basePath`. */
  readonly path: string;
  readonly kind: AudioAssetKind;
  /** Duration in seconds, measured with ffprobe on the shipped file. */
  readonly duration: number;
  readonly loop: boolean;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bytes: number;
  /** Playback trim in dB, derived from the measured level of the file. */
  readonly trimDb: number;
  readonly generation: AudioGeneration;
  /**
   * Set when the shipped file is not byte-identical to the provider's output,
   * describing exactly what was done so the result stays reproducible. Omitted
   * for assets that ship exactly as generated.
   */
  readonly postProcess?: string;
}

const SFX_MODEL = 'eleven_text_to_sound_v2';
const MUSIC_MODEL = 'eleven_music_v2';
const GENERATED_ON = '2026-08-17';

const LOOP_PARAMS = { duration_seconds: 15, prompt_influence: 0.4, loop: true } as const;
const STEP_PARAMS = { duration_seconds: 0.7, prompt_influence: 0.75, loop: false } as const;

function sfxGeneration(
  prompt: string,
  credits: number,
  parameters: Readonly<Record<string, string | number | boolean>>,
): AudioGeneration {
  return { provider: 'elevenlabs', modelId: SFX_MODEL, prompt, date: GENERATED_ON, credits, parameters };
}

// ---------------------------------------------------------------------------
// Ambience beds
// ---------------------------------------------------------------------------

const AMBIENCE: readonly AudioAsset[] = [
  {
    id: 'ambience/harbour',
    path: '/audio/ambience/harbour.mp3',
    kind: 'ambience',
    duration: 15.0,
    loop: true,
    sampleRate: 44100,
    channels: 2,
    bytes: 258042,
    trimDb: 0.6,
    generation: sfxGeneration(
      'Seamless looping harbour ambience: small waves lapping against a stone seawall, distant seagulls calling, boat rigging and halyards tapping lightly against metal masts, one very distant boat engine far out in the bay. Steady even background texture, no music, no speech, no sirens.',
      50,
      LOOP_PARAMS,
    ),
  },
  {
    id: 'ambience/street',
    path: '/audio/ambience/street.mp3',
    kind: 'ambience',
    duration: 15.0,
    loop: true,
    sampleRate: 44100,
    channels: 2,
    bytes: 258042,
    trimDb: 0.1,
    generation: sfxGeneration(
      'Seamless looping general city street room tone: distant traffic hum several blocks away, air-conditioning condenser units humming on nearby walls, faint far-off construction work, an occasional distant door closing. Even, unobtrusive background texture, no music, no speech, no sirens, no car horns close by.',
      50,
      LOOP_PARAMS,
    ),
  },
  {
    id: 'ambience/old-quarter',
    path: '/audio/ambience/old-quarter.mp3',
    kind: 'ambience',
    duration: 15.0,
    loop: true,
    sampleRate: 44100,
    channels: 2,
    bytes: 258042,
    trimDb: 1.5,
    generation: sfxGeneration(
      'Seamless looping ambience of a narrow reverberant old-town street between tall stone buildings: pigeons cooing and fluttering, a faint indistinct radio muffled behind a closed window, distant crockery clinking in a kitchen, footsteps echoing far away down the alley. Reverberant and calm, no music, no clear speech, no sirens.',
      50,
      LOOP_PARAMS,
    ),
  },
  {
    id: 'ambience/park',
    path: '/audio/ambience/park.mp3',
    kind: 'ambience',
    duration: 15.0,
    loop: true,
    sampleRate: 44100,
    channels: 2,
    bytes: 258042,
    trimDb: 2.4,
    generation: sfxGeneration(
      'Seamless looping city park ambience: leaves and branches moving in a light wind, several small songbirds chirping in the trees, a stone water fountain splashing gently a short distance away. Peaceful and continuous, no music, no speech, no traffic, no sirens.',
      50,
      LOOP_PARAMS,
    ),
  },
  {
    id: 'ambience/cannery',
    path: '/audio/ambience/cannery.mp3',
    kind: 'ambience',
    duration: 15.0,
    loop: true,
    sampleRate: 44100,
    channels: 2,
    bytes: 258042,
    trimDb: -10.3,
    generation: sfxGeneration(
      'Seamless looping industrial yard ambience: a low steady electric motor hum, corrugated metal sheeting creaking and ticking as it flexes, an occasional distant metallic clank from across the yard, wind whistling through a chain-link fence. Sparse, low and continuous, no music, no speech, no sirens, no alarms.',
      50,
      LOOP_PARAMS,
    ),
  },
  {
    id: 'ambience/ridge',
    path: '/audio/ambience/ridge.mp3',
    kind: 'ambience',
    duration: 15.0,
    loop: true,
    sampleRate: 44100,
    channels: 2,
    bytes: 258042,
    trimDb: -2.5,
    generation: sfxGeneration(
      'Seamless looping ambience high on an exposed hillside above a city: steady gusting wind over open grassy ground, overhead power lines and wires humming and singing in the wind, the faint distant murmur of the city far below. Airy and wide, no music, no speech, no sirens.',
      50,
      LOOP_PARAMS,
    ),
  },
  {
    id: 'ambience/interior',
    path: '/audio/ambience/interior.mp3',
    kind: 'ambience',
    duration: 15.0,
    loop: true,
    sampleRate: 44100,
    channels: 2,
    bytes: 258042,
    trimDb: 8.3,
    generation: sfxGeneration(
      'Seamless looping quiet indoor room tone: the muffled dull rumble of the city heard through closed windows and thick walls, a faint refrigerator compressor humming in the corner, very low broadband air. Extremely calm and enclosed, no music, no speech, no sirens.',
      50,
      LOOP_PARAMS,
    ),
  },
];

// ---------------------------------------------------------------------------
// Footsteps
// ---------------------------------------------------------------------------

interface StepSpec {
  readonly id: StepAssetId;
  readonly file: string;
  readonly prompt: string;
  readonly trimDb: number;
}

const STEP_SPECS: readonly StepSpec[] = [
  {
    id: 'steps/pavement-1',
    file: 'pavement-1',
    prompt:
      'one single footstep on a dry concrete paving slab, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: -5.7,
  },
  {
    id: 'steps/pavement-2',
    file: 'pavement-2',
    prompt:
      'one single footstep landing heel first on a dry concrete paving slab, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: -5.6,
  },
  {
    id: 'steps/asphalt-1',
    file: 'asphalt-1',
    prompt:
      'one single footstep on worn asphalt road surface, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: 2.6,
  },
  {
    id: 'steps/asphalt-2',
    file: 'asphalt-2',
    prompt:
      'one single scuffing footstep on worn gritty asphalt road surface, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: -6.0,
  },
  {
    id: 'steps/boardwalk-1',
    file: 'boardwalk-1',
    prompt:
      'one single footstep on hollow wooden decking boards, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: 4.0,
  },
  {
    id: 'steps/boardwalk-2',
    file: 'boardwalk-2',
    prompt:
      'one single footstep on a creaking hollow wooden boardwalk plank, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: -3.4,
  },
  {
    id: 'steps/gravel-1',
    file: 'gravel-1',
    prompt:
      'one single footstep crunching on loose gravel, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: -6.0,
  },
  {
    id: 'steps/gravel-2',
    file: 'gravel-2',
    prompt:
      'one single footstep shifting on loose gravel and small stones, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: 2.8,
  },
  {
    id: 'steps/grass-1',
    file: 'grass-1',
    prompt:
      'one single footstep on soft grass and soil, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: 10.0,
  },
  {
    id: 'steps/grass-2',
    file: 'grass-2',
    prompt:
      'one single muffled footstep pressing into damp grass and soft earth, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: 10.0,
  },
  {
    id: 'steps/interior-1',
    file: 'interior-1',
    prompt:
      'one single footstep on a hard indoor tiled floor, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: 5.1,
  },
  {
    id: 'steps/interior-2',
    file: 'interior-2',
    prompt:
      'one single hard-soled footstep tapping on a smooth indoor ceramic tile floor, walking pace, close dry recording, no reverb, no music, no other sound',
    trimDb: -3.2,
  },
];

/**
 * Every footstep came back at 0.680249 s: the model rounds a 0.7 s request down
 * to a whole number of frames, so the value is recorded as measured, not as
 * requested.
 */
const STEP_DURATION = 0.680249;

const STEPS: readonly AudioAsset[] = STEP_SPECS.map((spec) => ({
  id: spec.id,
  path: `/audio/steps/${spec.file}.mp3`,
  kind: 'step' as const,
  duration: STEP_DURATION,
  loop: false,
  sampleRate: 44100,
  channels: 2,
  bytes: 29000,
  trimDb: spec.trimDb,
  generation: sfxGeneration(spec.prompt, 2.3333, STEP_PARAMS),
}));

// ---------------------------------------------------------------------------
// Interaction, UI, music and voice
// ---------------------------------------------------------------------------

const SFX: readonly AudioAsset[] = [
  {
    id: 'sfx/door-open',
    path: '/audio/sfx/door-open.mp3',
    kind: 'sfx',
    duration: 1.2,
    loop: false,
    sampleRate: 44100,
    channels: 2,
    bytes: 36942,
    trimDb: 0.1,
    generation: sfxGeneration(
      'a wooden door latch turning and the door swinging open on its hinges, close dry interior recording, no music, no speech, no other sound',
      4,
      { duration_seconds: 1.2, prompt_influence: 0.75, loop: false },
    ),
  },
  {
    id: 'sfx/door-close',
    path: '/audio/sfx/door-close.mp3',
    kind: 'sfx',
    duration: 1.2,
    loop: false,
    sampleRate: 44100,
    channels: 2,
    bytes: 36942,
    trimDb: -5.2,
    generation: sfxGeneration(
      'a wooden door swinging closed and the latch clicking shut, close dry interior recording, no music, no speech, no other sound',
      4,
      { duration_seconds: 1.2, prompt_influence: 0.75, loop: false },
    ),
  },
  {
    id: 'sfx/ui-tick',
    path: '/audio/sfx/ui-tick.mp3',
    kind: 'sfx',
    duration: 0.48,
    loop: false,
    sampleRate: 44100,
    channels: 2,
    bytes: 25657,
    trimDb: -1.5,
    generation: sfxGeneration(
      'a very soft short neutral interface tick, a single restrained dry click, quiet and understated, not a musical chime, no reverb, no music, no other sound',
      1.6667,
      { duration_seconds: 0.5, prompt_influence: 0.75, loop: false },
    ),
  },
];

// ---------------------------------------------------------------------------
// Vehicles and the street
// ---------------------------------------------------------------------------

const VEHICLE_GENERATED_ON = '2026-08-27';

/** Sound-effect credits are charged per second of generated audio. */
const CREDITS_PER_SECOND = 10 / 3;

function vehicleGeneration(
  prompt: string,
  seconds: number,
  promptInfluence: number,
  loop: boolean,
): AudioGeneration {
  return {
    provider: 'elevenlabs',
    modelId: SFX_MODEL,
    prompt,
    date: VEHICLE_GENERATED_ON,
    credits: Number((seconds * CREDITS_PER_SECOND).toFixed(4)),
    parameters: {
      duration_seconds: seconds,
      prompt_influence: promptInfluence,
      loop,
      output_format: 'mp3_44100_128',
    },
  };
}

const VEHICLE: readonly AudioAsset[] = [
  {
    id: 'veh/engine-idle',
    path: '/audio/veh/engine-idle.mp3',
    kind: 'vehicle',
    duration: 7.0,
    loop: true,
    sampleRate: 44100,
    channels: 2,
    bytes: 112893,
    // Peak-normalised towards -6 dBFS from a measured -5.8 dBFS peak, so the
    // two engine layers can be crossfaded without a level step between them.
    trimDb: -0.2,
    generation: vehicleGeneration(
      'seamless looping close recording of a small four-cylinder petrol car engine idling at rest, steady low mechanical rumble with a regular firing pulse and faint valvetrain ticking, engine held at constant idle, no revving, no exhaust blips, no music, no speech, no wind, no traffic',
      7,
      0.6,
      true,
    ),
  },
  {
    id: 'veh/engine-load',
    path: '/audio/veh/engine-load.mp3',
    kind: 'vehicle',
    duration: 7.0,
    loop: true,
    sampleRate: 44100,
    channels: 2,
    bytes: 112893,
    trimDb: -3.9,
    generation: vehicleGeneration(
      'seamless looping recording of a four-cylinder petrol car engine held at a constant mid-range engine speed under load, continuous even drone with audible intake induction and a hard edge to the exhaust note, absolutely steady pitch with no rise or fall, no gear changes, no tyre noise, no music, no speech',
      7,
      0.6,
      true,
    ),
  },
  {
    id: 'veh/engine-far',
    path: '/audio/veh/engine-far.mp3',
    kind: 'vehicle',
    duration: 8.0,
    loop: true,
    sampleRate: 44100,
    channels: 2,
    bytes: 129193,
    trimDb: -3.6,
    generation: vehicleGeneration(
      'seamless looping continuous tyre roll noise of car tyres running on a dry asphalt road at steady speed, a broad steady rubber-on-tarmac hiss with a muffled engine drone underneath it, heard from across the street, absolutely even with no pass-by and no doppler, no horn, no braking, no music, no speech',
      8,
      0.7,
      true,
    ),
  },
  {
    id: 'veh/tyre-scrub',
    path: '/audio/veh/tyre-scrub.mp3',
    kind: 'vehicle',
    duration: 1.6,
    loop: false,
    sampleRate: 44100,
    channels: 2,
    bytes: 26793,
    trimDb: -6.0,
    generation: vehicleGeneration(
      'a car braking hard on dry asphalt, rubber tyres scrubbing and chirping against the road surface with brake pad squeal, ending as the car stops, close dry recording, no engine, no music, no speech',
      1.6,
      0.75,
      false,
    ),
  },
  {
    id: 'veh/door-open',
    path: '/audio/veh/car-door-open.mp3',
    kind: 'vehicle',
    // 0.98 s, not the 1.2 s generated: see postProcess.
    duration: 0.98,
    loop: false,
    sampleRate: 44100,
    channels: 2,
    bytes: 16762,
    trimDb: -5.6,
    generation: vehicleGeneration(
      'a car door handle being pulled and the metal car door swinging open on its hinge with a soft rubber seal release, close dry recording outdoors, no engine, no music, no speech, no other sound',
      1.2,
      0.75,
      false,
    ),
    postProcess:
      'The generation opened with 0.30 s of near-silence, which reads as lag between pressing E ' +
      'and the door. The lead-in is cut: ffmpeg -ss 0.22 -i raw.mp3 -c:a libmp3lame -b:a 128k ' +
      '-ar 44100 car-door-open.mp3',
  },
  {
    id: 'veh/door-close',
    path: '/audio/veh/car-door-close.mp3',
    kind: 'vehicle',
    duration: 1.0,
    loop: false,
    sampleRate: 44100,
    channels: 2,
    bytes: 17180,
    trimDb: -5.7,
    generation: vehicleGeneration(
      'a car door swung shut with a solid damped metallic thunk and the latch clicking home, close dry recording outdoors, no engine, no music, no speech, no other sound',
      1.0,
      0.8,
      false,
    ),
  },
  {
    id: 'veh/impact',
    path: '/audio/veh/impact.mp3',
    kind: 'vehicle',
    duration: 1.36,
    loop: false,
    sampleRate: 44100,
    channels: 2,
    bytes: 23031,
    trimDb: -6.0,
    generation: vehicleGeneration(
      'a slow speed car collision, a dull heavy metallic crunch of a car bumper hitting a solid obstacle, sheet metal deforming with a short rattle afterwards, no glass smashing, no alarm, no music, no speech',
      1.4,
      0.75,
      false,
    ),
  },
];

export const TRAFFIC_HUM: StreetLayerId = 'ambience/traffic-hum';

const STREET_LAYER: AudioAsset = {
  id: TRAFFIC_HUM,
  path: '/audio/ambience/traffic-hum.mp3',
  kind: 'ambience',
  duration: 12.0,
  loop: true,
  sampleRate: 44100,
  channels: 2,
  bytes: 193141,
  // Mean-normalised towards -34 dBFS like the other beds, from a measured
  // -32.9 dBFS mean. It is then driven well below unity at runtime, because it
  // sums on top of a land bed rather than replacing one.
  trimDb: -1.1,
  generation: vehicleGeneration(
    'seamless looping distant city traffic hum heard from a few blocks away, a continuous soft wash of many cars rolling on asphalt with an occasional very faint far-off engine, no individual vehicle close by, no horns, no sirens, no music, no speech',
    12,
    0.5,
    true,
  ),
};

export const MUSIC_ASSET_ID: MusicAssetId = 'music/meridian-theme';

const MUSIC: AudioAsset = {
  id: MUSIC_ASSET_ID,
  path: '/audio/music/meridian-theme.mp3',
  kind: 'music',
  // 35 s, not the 45 s generated: the model ended the track with a fade-out to
  // near-silence, which would have dropped the mix out at every loop point. The
  // shipped file is a crossfade loop cut from the musical body. See postProcess.
  duration: 35.0,
  loop: true,
  sampleRate: 48000,
  channels: 2,
  bytes: 841581,
  trimDb: 0,
  generation: {
    provider: 'elevenlabs',
    modelId: MUSIC_MODEL,
    prompt:
      'An original, unhurried instrumental exploration theme for an open-world coastal city at golden hour. Warm analogue synthesiser pad as a bed, muted nylon-string guitar playing a simple melancholy but hopeful motif, soft upright bass, brushed percussion kept low and steady. Even dynamics throughout with no big climax and no dramatic build, designed to loop seamlessly as background music. Gentle, reflective, spacious. Fully instrumental, no vocals, no singing, no spoken word.',
    date: GENERATED_ON,
    credits: 675,
    parameters: { duration_seconds: 45, instrumental: true, lyrics_type: 'instrumental' },
  },
  postProcess:
    'Crossfade loop built from the 45 s generation, whose last ~6 s fade to silence. ' +
    'Body 0-39 s, 4 s triangular crossfade of 35-39 s over 0-4 s, then 4-35 s appended: ' +
    'ffmpeg -ss 35 -t 4 -i raw.mp3 -ss 0 -t 4 -i raw.mp3 -ss 4 -t 31 -i raw.mp3 ' +
    '-filter_complex "[0:a][1:a]acrossfade=d=4:c1=tri:c2=tri[x];[x][2:a]concat=n=2:v=0:a=1[out]" ' +
    '-map "[out]" -c:a libmp3lame -b:a 192k -ar 48000 meridian-theme.mp3',
};

export const HARBOUR_PA_ASSET_ID: VoiceAssetId = 'voice/harbour-pa-01';

const VOICE: AudioAsset = {
  id: HARBOUR_PA_ASSET_ID,
  path: '/audio/voice/harbour-pa-01.mp3',
  kind: 'voice',
  duration: 6.501587,
  loop: false,
  sampleRate: 44100,
  channels: 1,
  bytes: 121787,
  trimDb: -4.1,
  generation: {
    provider: 'elevenlabs',
    // Generated in an earlier session, before this manifest existed. The model,
    // voice and prompt were not recorded at the time and are deliberately left
    // null rather than guessed; the measured file properties above are real.
    modelId: null,
    prompt: null,
    date: GENERATED_ON,
    credits: null,
    parameters: {},
  },
};

/** Every asset the game ships, in load order. */
export const AUDIO_ASSETS: readonly AudioAsset[] = [
  ...AMBIENCE,
  ...STEPS,
  ...SFX,
  ...VEHICLE,
  STREET_LAYER,
  MUSIC,
  VOICE,
];

const BY_ID: ReadonlyMap<AudioAssetId, AudioAsset> = new Map(
  AUDIO_ASSETS.map((asset) => [asset.id, asset]),
);

export function getAudioAsset(id: AudioAssetId): AudioAsset {
  const asset = BY_ID.get(id);
  if (!asset) throw new Error(`Unknown audio asset: ${id}`);
  return asset;
}

/**
 * Assets fetched eagerly once the context is unlocked. Music is deliberately
 * absent: it must not be fetched or decoded until the player enables it.
 */
export const PRELOAD_ASSET_IDS: readonly AudioAssetId[] = AUDIO_ASSETS.filter(
  (asset) => asset.kind !== 'music',
).map((asset) => asset.id);

// ---------------------------------------------------------------------------
// Mappings the director drives itself from
// ---------------------------------------------------------------------------

/**
 * Two variants per surface so the runtime can alternate and avoid a metronome.
 *
 * `plaza` and `sand` reuse a neighbouring surface rather than carrying their own
 * recordings: paving slabs read correctly for a paved plaza, and loose gravel is
 * the closest match for dry sand. `water` is mapped for completeness only — the
 * player controller stops them before they can wade — and takes the gravel pair
 * as the nearest wet-crunch.
 */
export const STEP_SURFACES: Readonly<Record<SurfaceId, readonly [StepAssetId, StepAssetId]>> = {
  asphalt: ['steps/asphalt-1', 'steps/asphalt-2'],
  pavement: ['steps/pavement-1', 'steps/pavement-2'],
  boardwalk: ['steps/boardwalk-1', 'steps/boardwalk-2'],
  plaza: ['steps/pavement-1', 'steps/pavement-2'],
  grass: ['steps/grass-1', 'steps/grass-2'],
  sand: ['steps/gravel-1', 'steps/gravel-2'],
  gravel: ['steps/gravel-1', 'steps/gravel-2'],
  water: ['steps/gravel-1', 'steps/gravel-2'],
  interior: ['steps/interior-1', 'steps/interior-2'],
};

/**
 * The sea layer.
 *
 * Deliberately not a member of `DISTRICT_AMBIENCE` or `SURFACE_AMBIENCE`: this
 * loop is the bay itself, so its level comes from the listener's distance to
 * the waterline (`seaAudibility.ts`) and it sums on top of whichever land bed
 * is playing rather than replacing it. Standing on the quay you hear both, and
 * a street two districts inland hears neither the water nor a gap where the
 * city bed should have been.
 */
export const SEA_BED: AmbienceBedId = 'ambience/harbour';

/**
 * The land bed each district falls back to.
 *
 * `harbourside` takes the neutral street bed rather than the sea: the sea is no
 * longer a district bed, and the harbour blocks still have traffic and plant
 * noise behind them. This entry does double duty, because the frame loop has no
 * block under the player on any street corridor and falls back to `harbourside`
 * there, so it is also the bed heard on the open carriageway everywhere in the
 * city - which is exactly what the street bed is for.
 */
export const DISTRICT_AMBIENCE: Readonly<Record<DistrictId, AmbienceBedId>> = {
  harbourside: 'ambience/street',
  cannery: 'ambience/cannery',
  oldQuarter: 'ambience/old-quarter',
  core: 'ambience/street',
  civic: 'ambience/street',
  ridge: 'ambience/ridge',
};

/**
 * Surfaces that override their district's land bed. Standing on grass means a
 * park whichever district it sits in.
 *
 * The shoreline surfaces - sand, boardwalk and water - used to override to the
 * harbour bed, which is how the sea came to follow the player: every corridor
 * in the city resolves to the `harbourside` district, so the promenade override
 * was never the only thing selecting it. They are gone because the sea is a
 * distance-driven layer now, and every point where those surfaces exist is
 * inside `SEA_FULL_DISTANCE` of the water anyway - the beach by construction
 * (`x < shorelineX(z) + 9`), and the boardwalk within 14.4-57.9 m - so the sea
 * is already at or near full level on all of them.
 */
export const SURFACE_AMBIENCE: Partial<Readonly<Record<SurfaceId, AmbienceBedId>>> = {
  grass: 'ambience/park',
};

export const INTERIOR_BED: AmbienceBedId = 'ambience/interior';

/** One-shot ids the game triggers, mapped onto their assets. */
export const ONE_SHOTS: Readonly<Record<OneShotId, SfxAssetId>> = {
  'door-open': 'sfx/door-open',
  'door-close': 'sfx/door-close',
  'ui-tick': 'sfx/ui-tick',
};

/**
 * The vehicle set, named so the street layer never spells an id out.
 *
 * `doorOpen`/`doorClose` here are the CAR doors. The building doors in
 * `ONE_SHOTS` are a wooden latch and a hinge, which is the wrong sound
 * entirely for getting into a car.
 */
export const VEHICLE_SOUNDS = {
  engineIdle: 'veh/engine-idle',
  engineLoad: 'veh/engine-load',
  engineFar: 'veh/engine-far',
  tyreScrub: 'veh/tyre-scrub',
  doorOpen: 'veh/door-open',
  doorClose: 'veh/door-close',
  impact: 'veh/impact',
} as const satisfies Readonly<Record<string, VehicleAssetId>>;
