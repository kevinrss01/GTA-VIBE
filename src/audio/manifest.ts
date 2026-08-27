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

export type AudioAssetKind =
  | 'ambience'
  | 'step'
  | 'sfx'
  | 'music'
  | 'voice'
  | 'vehicle'
  | 'weapon'
  | 'impact'
  | 'body'
  | 'dialogue';

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
 * Firing a weapon, and being on the receiving end of one.
 *
 * Three families, kept apart because they are mixed and triggered differently.
 * `wpn/*` is the gun in the player's own hands or an officer's, played dry and
 * close; `imp/*` is what the round arrives at, played positionally at the point
 * of impact; `plr/*` is the player's own body, played flat with no panning at
 * all because it is not somewhere in the world, it is you.
 *
 * `wpn/smg` is the ONE clip in the manifest that is not a generation of its
 * own. Four separate renders of a submachine-gun shot all came back between
 * -39 and -49 dBFS peak with a noise floor only 24 dB below that, so bringing
 * one up to a usable level would have brought an audible hiss up with it under
 * a weapon that fires thirteen times a second. The shipped file is the pistol
 * render - the same 9 mm cartridge, and an excellent one at 0.1 dBFS peak with
 * a -74.8 dB floor - resampled up and cut short, which is both what a shorter
 * barrel and a lighter bolt actually sound like and what every game does for a
 * calibre it shares. See its `postProcess` for the exact command.
 */
export type WeaponAssetId =
  | 'wpn/pistol'
  | 'wpn/smg'
  | 'wpn/shotgun'
  | 'wpn/rifle'
  | 'wpn/launcher'
  | 'wpn/explosion'
  | 'wpn/rocket-flight'
  | 'wpn/reload'
  | 'wpn/draw'
  | 'wpn/holster'
  | 'wpn/dry'
  | 'wpn/shell';

export type ImpactAssetId =
  | 'imp/concrete'
  | 'imp/metal'
  | 'imp/flesh'
  | 'imp/glass'
  | 'imp/ricochet'
  | 'imp/debris';

export type BodyAssetId = 'plr/hurt' | 'plr/death' | 'plr/heartbeat' | 'plr/tinnitus';

/**
 * Spoken dialogue.
 *
 * The only text-to-speech in the game, and the only assets with a script: the
 * words are in `src/mission/script.ts`, the recordings are here, and
 * `tools/generate-mission-voices.mjs` is the runnable form of both. Every line
 * is written for this game about invented people; none is an impersonation of
 * anybody, and the two voices are stock library voices rather than clones.
 */
export type DialogueAssetId =
  | 'dlg/sable-brief-1'
  | 'dlg/sable-brief-2'
  | 'dlg/sable-brief-3'
  | 'dlg/teo-handover-1'
  | 'dlg/teo-handover-2'
  | 'dlg/sable-paid-1'
  | 'dlg/sable-paid-2';

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
  | WeaponAssetId
  | ImpactAssetId
  | BodyAssetId
  | DialogueAssetId
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

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

const COMBAT_GENERATED_ON = '2026-08-27';

interface CombatSpec {
  readonly id: WeaponAssetId | ImpactAssetId | BodyAssetId;
  readonly file: string;
  readonly kind: 'weapon' | 'impact' | 'body';
  readonly duration: number;
  readonly bytes: number;
  readonly trimDb: number;
  readonly seconds: number;
  readonly influence: number;
  readonly loop?: boolean;
  readonly prompt: string;
  readonly postProcess?: string;
}

/**
 * Rendered by `tools/generate-combat-sfx.mjs`, which is also where the prompts
 * live in runnable form. `duration`, `bytes` and the level behind `trimDb` are
 * ffprobe/volumedetect measurements of the shipped files, not the request.
 */
const COMBAT_SPECS: readonly CombatSpec[] = [
  {
    id: 'wpn/pistol', file: 'wpn/pistol.mp3', kind: 'weapon',
    duration: 0.88, bytes: 15090, trimDb: -6.0, seconds: 0.9, influence: 0.75,
    prompt:
      'a single 9mm semi-automatic pistol gunshot fired outdoors in the open, one sharp percussive crack with a hard transient, the slide cycling with a light metallic clack straight after it, short dry decay, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'wpn/smg', file: 'wpn/smg.mp3', kind: 'weapon',
    duration: 0.55, bytes: 10075, trimDb: -5.3, seconds: 0.9, influence: 0.75,
    prompt:
      'derived from the pistol render; see postProcess. The four submachine-gun generations are recorded in tools/generate-combat-sfx.mjs and were all rejected on level.',
    postProcess:
      'Resampled up 18 per cent and cut to 0.55 s from the pistol render, which ' +
      'shortens and brightens it the way a shorter barrel and lighter bolt do: ' +
      'ffmpeg -i wpn/pistol.mp3 -af "asetrate=44100*1.18,aresample=44100,volume=-1dB" ' +
      '-t 0.55 -c:a libmp3lame -b:a 128k -ar 44100 wpn/smg.mp3',
  },
  {
    id: 'wpn/shotgun', file: 'wpn/shotgun.mp3', kind: 'weapon',
    duration: 1.28, bytes: 21359, trimDb: -6.0, seconds: 1.3, influence: 0.75,
    prompt:
      'a single 12 gauge pump-action shotgun blast fired outdoors, deep heavy boom with a wide low-end thump, followed by the pump sliding back and forward with two solid mechanical clacks, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'wpn/rifle', file: 'wpn/rifle.mp3', kind: 'weapon',
    duration: 1.0, bytes: 17180, trimDb: -2.3, seconds: 1.0, influence: 0.75,
    prompt:
      'a single rifle gunshot from a semi-automatic carbine fired outdoors, a hard high-pressure crack with a supersonic snap and a short bright tail, the bolt cycling with a metallic ring, close dry recording, no reverb, no music, no speech, no other sound',
    postProcess:
      'Rendered at -18.7 dBFS peak, which needs more than the +10 dB the trim is ' +
      'allowed to apply. Peak-normalised offline instead: ' +
      'ffmpeg -i raw.mp3 -af "volume=15.7dB" -c:a libmp3lame -b:a 128k -ar 44100 wpn/rifle.mp3',
  },
  {
    id: 'wpn/launcher', file: 'wpn/launcher.mp3', kind: 'weapon',
    duration: 1.76, bytes: 29301, trimDb: -6.0, seconds: 1.8, influence: 0.75,
    prompt:
      'a shoulder-fired rocket launcher firing, a deep hollow whoosh of the rocket motor igniting inside the tube with a heavy pressure thump and a rushing back blast of hot gas behind it, the rocket accelerating away, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'wpn/explosion', file: 'wpn/explosion.mp3', kind: 'weapon',
    duration: 3.0, bytes: 48945, trimDb: -6.0, seconds: 3.0, influence: 0.7,
    prompt:
      'a large high-explosive detonation outdoors in a street, a violent cracking blast with an enormous low-frequency thump, a sharp shockwave front, then a long rolling rumble decaying away and small pieces of debris raining down at the end, no music, no speech, no siren',
  },
  {
    id: 'wpn/rocket-flight', file: 'wpn/rocket-flight.mp3', kind: 'weapon',
    duration: 2.61, bytes: 42675, trimDb: -28.8, seconds: 2.5, influence: 0.7, loop: true,
    prompt:
      'seamless looping solid-fuel rocket motor burning in flight, a continuous rushing roar of hot gas with a steady hiss over it, absolutely even with no launch and no impact, no music, no speech',
  },
  {
    id: 'wpn/reload', file: 'wpn/reload.mp3', kind: 'weapon',
    duration: 1.6, bytes: 26793, trimDb: -6.0, seconds: 1.6, influence: 0.8,
    prompt:
      'reloading a handgun, the magazine release clicking and the empty magazine dropping out, a fresh magazine pushed in and seated with a solid clack, then the slide released forward with a metallic snap, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'wpn/draw', file: 'wpn/draw.mp3', kind: 'weapon',
    duration: 0.8, bytes: 13836, trimDb: -3.5, seconds: 0.8, influence: 0.8,
    prompt:
      'drawing a handgun out of a leather holster, a short scrape of steel against leather then a hand settling firmly on the grip, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'wpn/holster', file: 'wpn/holster.mp3', kind: 'weapon',
    duration: 0.8, bytes: 13836, trimDb: 3.9, seconds: 0.8, influence: 0.8,
    prompt:
      'putting a handgun away into a leather holster, a muffled scrape of steel sliding into leather ending with a soft strap snap, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'wpn/dry', file: 'wpn/dry.mp3', kind: 'weapon',
    duration: 0.48, bytes: 8821, trimDb: -0.8, seconds: 0.5, influence: 0.85,
    prompt:
      'a loud sharp metallic click recorded close up, the hammer of an empty handgun falling hard on an empty chamber, one crisp dry snap at full volume and nothing else, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'wpn/shell', file: 'wpn/shell.mp3', kind: 'weapon',
    duration: 1.0, bytes: 17180, trimDb: -1.9, seconds: 1.0, influence: 0.8,
    prompt:
      'two or three small brass cartridge cases bouncing and tinkling on a concrete floor and coming to rest, light bright metallic ringing, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'imp/concrete', file: 'imp/concrete.mp3', kind: 'impact',
    duration: 0.680249, bytes: 12164, trimDb: -6.0, seconds: 0.7, influence: 0.8,
    prompt:
      'a bullet slamming into a concrete wall, a hard dry crack of stone chipping with a puff of dust and a few small fragments falling, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'imp/metal', file: 'imp/metal.mp3', kind: 'impact',
    duration: 0.8, bytes: 13836, trimDb: 1.6, seconds: 0.8, influence: 0.8,
    prompt:
      'a bullet punching through a car body panel, a sharp bright metallic bang with sheet metal ringing and denting afterwards, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'imp/flesh', file: 'imp/flesh.mp3', kind: 'impact',
    duration: 0.6, bytes: 10493, trimDb: -2.4, seconds: 0.6, influence: 0.8,
    prompt:
      'a heavy blunt wet impact into a slab of meat, one dull thick thud with a short wet slap, no voice, close dry recording, no reverb, no music, no speech, no other sound',
    postProcess:
      'Rendered at -16.3 dBFS peak, past the trim cap. Peak-normalised offline: ' +
      'ffmpeg -i raw.mp3 -af "volume=13.3dB" -c:a libmp3lame -b:a 128k -ar 44100 imp/flesh.mp3',
  },
  {
    id: 'imp/glass', file: 'imp/glass.mp3', kind: 'impact',
    duration: 1.08, bytes: 18434, trimDb: -6.0, seconds: 1.1, influence: 0.8,
    prompt:
      'a car side window shattering, a bright sharp burst of breaking tempered glass followed by small cubes of glass falling and scattering on the road, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'imp/ricochet', file: 'imp/ricochet.mp3', kind: 'impact',
    duration: 0.88, bytes: 15090, trimDb: -4.6, seconds: 0.9, influence: 0.8,
    prompt:
      'a bullet ricocheting off stone and whining away into the distance, a short hard tick followed by a descending metallic whistling zing, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'imp/debris', file: 'imp/debris.mp3', kind: 'impact',
    duration: 2.2, bytes: 36406, trimDb: -0.1, seconds: 2.2, influence: 0.7,
    prompt:
      'broken rubble raining down onto a road after a blast, chunks of concrete and grit clattering and skittering across tarmac and settling, no explosion, close dry recording, no reverb, no music, no speech, no other sound',
  },
  {
    id: 'plr/hurt', file: 'plr/hurt.mp3', kind: 'body',
    duration: 0.8, bytes: 13836, trimDb: -5.9, seconds: 0.8, influence: 0.65,
    prompt:
      'a man taking a sudden hard hit to the body and letting out one short involuntary pained grunt through clenched teeth, wordless, no words, no music, close dry recording',
  },
  {
    id: 'plr/death', file: 'plr/death.mp3', kind: 'body',
    duration: 1.76, bytes: 29301, trimDb: -5.8, seconds: 1.8, influence: 0.6,
    prompt:
      'a man collapsing, one long wordless failing exhale trailing off into silence as the body drops heavily to the ground, wordless, no words, no music, close dry recording',
  },
  {
    id: 'plr/heartbeat', file: 'plr/heartbeat.mp3', kind: 'body',
    duration: 2.55, bytes: 41839, trimDb: -14.3, seconds: 2.4, influence: 0.7, loop: true,
    prompt:
      'seamless looping slow heavy human heartbeat heard from inside the chest, deep muffled double thump repeating at a steady urgent pace, low frequency, no music, no speech, no other sound',
  },
  {
    id: 'plr/tinnitus', file: 'plr/tinnitus.mp3', kind: 'body',
    duration: 2.61, bytes: 42675, trimDb: -20.6, seconds: 2.5, influence: 0.7, loop: true,
    prompt:
      'seamless looping steady high-pitched ringing tone of ear damage after a nearby explosion, a single continuous thin sine-like whine with a faint hollow pressure underneath, absolutely even, no music, no speech, no other sound',
  },
];

const COMBAT: readonly AudioAsset[] = COMBAT_SPECS.map((spec) => ({
  id: spec.id,
  path: `/audio/${spec.file}`,
  kind: spec.kind,
  duration: spec.duration,
  loop: spec.loop === true,
  sampleRate: 44100,
  channels: 2,
  bytes: spec.bytes,
  trimDb: spec.trimDb,
  generation: {
    provider: 'elevenlabs' as const,
    modelId: SFX_MODEL,
    prompt: spec.prompt,
    date: COMBAT_GENERATED_ON,
    credits: Number((spec.seconds * CREDITS_PER_SECOND).toFixed(4)),
    parameters: {
      duration_seconds: spec.seconds,
      prompt_influence: spec.influence,
      loop: spec.loop === true,
      output_format: 'mp3_44100_128',
    },
  },
  ...(spec.postProcess ? { postProcess: spec.postProcess } : {}),
}));

/** What each weapon sounds like when it goes off. */
export const WEAPON_SOUNDS = {
  pistol: 'wpn/pistol',
  smg: 'wpn/smg',
  shotgun: 'wpn/shotgun',
  rifle: 'wpn/rifle',
  launcher: 'wpn/launcher',
} as const satisfies Readonly<Record<string, WeaponAssetId>>;

/** Handling the weapon, rather than firing it. */
export const HANDLING_SOUNDS = {
  reload: 'wpn/reload',
  draw: 'wpn/draw',
  holster: 'wpn/holster',
  dry: 'wpn/dry',
  shell: 'wpn/shell',
} as const satisfies Readonly<Record<string, WeaponAssetId>>;

/** What the round arrives at. Keyed by `CombatFx`'s own impact kinds. */
export const IMPACT_SOUNDS = {
  world: 'imp/concrete',
  ground: 'imp/concrete',
  metal: 'imp/metal',
  glass: 'imp/glass',
  body: 'imp/flesh',
  ricochet: 'imp/ricochet',
  debris: 'imp/debris',
} as const satisfies Readonly<Record<string, ImpactAssetId>>;

/** The player's own body. Never panned: it is not out there, it is you. */
export const BODY_SOUNDS = {
  hurt: 'plr/hurt',
  death: 'plr/death',
  heartbeat: 'plr/heartbeat',
  tinnitus: 'plr/tinnitus',
} as const satisfies Readonly<Record<string, BodyAssetId>>;

export const EXPLOSION_SOUND: WeaponAssetId = 'wpn/explosion';
export const ROCKET_FLIGHT_SOUND: WeaponAssetId = 'wpn/rocket-flight';

// ---------------------------------------------------------------------------
// Dialogue
// ---------------------------------------------------------------------------

const DIALOGUE_MODEL = 'eleven_multilingual_v2';
const DIALOGUE_GENERATED_ON = '2026-08-27';

/**
 * Two library voices, chosen from the account's own 658 rather than assumed.
 *
 * Sable is steady because she owns the room; Teo is not because he does not.
 * Neither is a clone of a real person, and no line impersonates anybody: the
 * whole cast is invented for this game.
 */
const DIALOGUE_VOICES = {
  sable: { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily - Velvety Actress' },
  teo: { id: 'N2lVS1w4EtoT3dr4eOWO', name: 'Callum - Husky Trickster' },
} as const;

interface DialogueSpec {
  readonly id: DialogueAssetId;
  readonly file: string;
  readonly speaker: keyof typeof DIALOGUE_VOICES;
  readonly duration: number;
  readonly bytes: number;
  readonly trimDb: number;
  readonly text: string;
}

const DIALOGUE_SPECS: readonly DialogueSpec[] = [
  { id: 'dlg/sable-brief-1', file: 'sable-brief-1.mp3', speaker: 'sable', duration: 5.201, bytes: 84471, trimDb: 1.6, text: "So you're the one who came back. Good. I need somebody nobody in this city has bought yet." },
  { id: 'dlg/sable-brief-2', file: 'sable-brief-2.mp3', speaker: 'sable', duration: 9.845, bytes: 158450, trimDb: 0.9, text: 'Two nights ago a box of my money went into a lock-up down in the Cannery, and it has not come out. Teo is sitting on it, and Teo is frightened of his own shadow.' },
  { id: 'dlg/sable-brief-3', file: 'sable-brief-3.mp3', speaker: 'sable', duration: 4.598, bytes: 74440, trimDb: -1.4, text: "Bring it to me. Don't open it, don't count it, and don't stop for anybody." },
  { id: 'dlg/teo-handover-1', file: 'teo-handover-1.mp3', speaker: 'teo', duration: 6.594, bytes: 106623, trimDb: -1.5, text: "You're Sable's? Take it. Take it, please, I don't want it in here another night." },
  { id: 'dlg/teo-handover-2', file: 'teo-handover-2.mp3', speaker: 'teo', duration: 5.341, bytes: 86561, trimDb: -4.2, text: "Listen. I might have mentioned it to a man in a bar. I'm sorry. Drive fast." },
  { id: 'dlg/sable-paid-1', file: 'sable-paid-1.mp3', speaker: 'sable', duration: 3.901, bytes: 63573, trimDb: 1.6, text: "You made it. And it's still heavy. That's the part most people get wrong." },
  { id: 'dlg/sable-paid-2', file: 'sable-paid-2.mp3', speaker: 'sable', duration: 3.065, bytes: 50199, trimDb: -3.1, text: 'Seven and a half. Come back when you want the next one.' },
];

const DIALOGUE: readonly AudioAsset[] = DIALOGUE_SPECS.map((spec) => ({
  id: spec.id,
  path: `/audio/voice/${spec.file}`,
  kind: 'dialogue' as const,
  duration: spec.duration,
  loop: false,
  sampleRate: 44100,
  channels: 1,
  bytes: spec.bytes,
  trimDb: spec.trimDb,
  generation: {
    provider: 'elevenlabs' as const,
    modelId: DIALOGUE_MODEL,
    prompt: spec.text,
    date: DIALOGUE_GENERATED_ON,
    // Text-to-speech is charged per character of the line, not per second.
    credits: spec.text.length,
    parameters: {
      voice_id: DIALOGUE_VOICES[spec.speaker].id,
      voice_name: DIALOGUE_VOICES[spec.speaker].name,
      output_format: 'mp3_44100_128',
    },
  },
}));

/** The spoken line for a script beat, with the words it says. */
export const DIALOGUE_LINES: Readonly<Record<DialogueAssetId, { speaker: string; text: string; duration: number }>> =
  Object.fromEntries(
    DIALOGUE_SPECS.map((spec) => [spec.id, { speaker: spec.speaker, text: spec.text, duration: spec.duration }]),
  ) as Readonly<Record<DialogueAssetId, { speaker: string; text: string; duration: number }>>;

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
  ...COMBAT,
  ...DIALOGUE,
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
