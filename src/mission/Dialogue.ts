/**
 * People talking: the recording, the subtitle, and the timing between them.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const dialogue = new Dialogue(audio);        // audio: AudioBusHost
 *   hud.element.append(dialogue.element);
 *   dialogue.say(CONVERSATIONS.briefing, () => mission.advance());
 *   dialogue.update(dt);                          // once a frame
 *   dialogue.dispose();
 *
 * ============================================================================
 *
 * SUBTITLES ARE NOT OPTIONAL HERE. The whole conversation happens over engine
 * noise, a police siren and whatever the player is driving into, and there is
 * no way to replay a line. Every beat is on screen for as long as it is
 * audible, which also means the mission still reads correctly with the sound
 * off - including for a player who has muted the tab, and for the automated
 * QA that can read the DOM but cannot hear.
 *
 * IT IS DRIVEN BY dt, NEVER BY A CLOCK. The audio layer reports nothing back,
 * so a beat advances on the duration recorded in the manifest plus its hold.
 * That makes the whole conversation deterministic and steppable by a fixed-step
 * harness, which is the only way it can be tested at all.
 */

import type { AudioBusHost } from '../audio/AudioDirector';
import { DIALOGUE_LINES, getAudioAsset, type DialogueAssetId } from '../audio/manifest';
import type { Beat } from './script';

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Who is speaking, by the name the subtitle shows. */
const SPEAKER_NAMES: Readonly<Record<string, string>> = {
  sable: 'SABLE',
  teo: 'TEO',
};

export class Dialogue {
  /** Put this in the HUD. It takes no pointer events. */
  readonly element: HTMLElement;

  private readonly host: AudioBusHost;
  private readonly nameEl: HTMLElement;
  private readonly textEl: HTMLElement;

  private queue: readonly Beat[] = [];
  private at = 0;
  private left = 0;
  private done: (() => void) | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private disposed = false;

  constructor(host: AudioBusHost) {
    this.host = host;
    this.element = document.createElement('div');
    this.element.className = 'mb-dialogue';
    this.element.setAttribute('role', 'status');
    this.element.setAttribute('aria-live', 'polite');

    this.nameEl = document.createElement('p');
    this.nameEl.className = 'mb-dialogue__name';
    this.textEl = document.createElement('p');
    this.textEl.className = 'mb-dialogue__text';
    this.element.append(this.nameEl, this.textEl);
  }

  /** True while somebody is mid-sentence. */
  get speaking(): boolean {
    return this.at < this.queue.length;
  }

  /** The line currently on screen, or an empty string. For automated QA. */
  get subtitle(): string {
    return this.textEl.textContent ?? '';
  }

  /** Asks the director to decode every line, so none arrives late. */
  preload(): void {
    for (const id of Object.keys(DIALOGUE_LINES) as DialogueAssetId[]) {
      this.host.requestAsset(id);
    }
  }

  /**
   * Plays a conversation. Replaces anything already running, because the
   * player walking away mid-sentence and coming back must not stack two
   * voices on top of each other.
   */
  say(beats: readonly Beat[], onFinished?: () => void): void {
    if (this.disposed) return;
    this.stopAudio();
    this.queue = beats;
    this.at = 0;
    this.left = 0;
    this.done = onFinished ?? null;
    this.begin();
  }

  /**
   * Cuts the conversation off NOW and lets it count as finished.
   *
   * This is what happens when the player is killed or arrested mid-sentence:
   * the voice and the subtitle stop, because Sable talking a corpse through a
   * job while the BUSTED banner is up is nonsense - but the callback still
   * runs, so the mission advances exactly as far as it would have.
   *
   * SKIPPING FORWARD RATHER THAN ABANDONING IS DELIBERATE. Dropping the
   * callback would leave the director parked in a conversational stage
   * (`briefing`, `handover`, `payout`) that only that callback can leave,
   * which is a softlock: the box would be in the player's hands with no way
   * to be asked for it. The player loses the recording, which they were in no
   * position to hear, and nothing else.
   */
  skip(): void {
    this.stopAudio();
    this.queue = [];
    this.at = 0;
    this.show(null);
    const finished = this.done;
    this.done = null;
    finished?.();
  }

  update(dt: number): void {
    if (this.disposed || !this.speaking) return;
    this.left -= dt;
    if (this.left > 0) return;
    this.at += 1;
    if (this.at < this.queue.length) {
      this.begin();
      return;
    }
    this.show(null);
    const finished = this.done;
    this.done = null;
    finished?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAudio();
    this.element.remove();
  }

  // -- internals ------------------------------------------------------------

  private begin(): void {
    const beat = this.queue[this.at];
    if (!beat) return;
    const line = DIALOGUE_LINES[beat.line];
    this.show(beat.line);
    this.left = line.duration + beat.hold;
    this.play(beat.line);
  }

  private show(id: DialogueAssetId | null): void {
    if (!id) {
      this.nameEl.textContent = '';
      this.textEl.textContent = '';
      this.element.classList.remove('is-visible');
      return;
    }
    const line = DIALOGUE_LINES[id];
    this.nameEl.textContent = SPEAKER_NAMES[line.speaker] ?? line.speaker.toUpperCase();
    this.textEl.textContent = line.text;
    this.element.classList.add('is-visible');
  }

  /**
   * One line, through the effects bus and deliberately NOT panned.
   *
   * A conversation is between the player and somebody an arm's length away;
   * running it through an HRTF panner at that distance smears it, and the one
   * thing a line of dialogue has to be is intelligible.
   */
  private play(id: DialogueAssetId): void {
    const ctx = this.host.context;
    const bus = this.host.effectsBus;
    if (!ctx || !bus) return;
    const buffer = this.host.bufferFor(id);
    if (!buffer) {
      this.host.requestAsset(id);
      return;
    }
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(getAudioAsset(id).trimDb);
    gain.connect(bus);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = (): void => {
      if (this.source === source) {
        this.source = null;
        this.gain = null;
      }
      source.disconnect();
      gain.disconnect();
    };
    this.source = source;
    this.gain = gain;
    source.start();
  }

  private stopAudio(): void {
    const source = this.source;
    const gain = this.gain;
    this.source = null;
    this.gain = null;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* already ended */
    }
    source.disconnect();
    gain?.disconnect();
  }
}
