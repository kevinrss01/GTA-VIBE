/**
 * Meridian Bay - entry point.
 *
 * Builds the whole city once at start-up, then runs a single frame loop that
 * updates the controller, the lighting, the audio and the UI. The build is
 * synchronous but yields between phases so the loading screen can actually
 * paint; a build that blocks the main thread for several seconds looks like a
 * hang no matter how fast it really is.
 */

import { Vector3 } from 'three';

import { Engine } from './core/Engine';
import { MaterialLibrary } from './render/materials';
import { Lighting, type QualityLevel } from './render/Lighting';
import { Sky } from './render/Sky';
import { getCityPlan, type Parcel } from './world/CityPlan';
import { CityGround } from './world/CityGround';
import { buildEnvironment } from './world/Environment';
import { ModelLibrary } from './world/ModelLibrary';
import { WorldSink, type PropPart, type WorldChunk } from './world/WorldBuilder';
import { ALL_PROP_KEYS, type PropKey } from './world/build/types';
import { buildBuilding } from './world/build/BuildingFactory';
import { buildInterior } from './world/build/InteriorBuilder';
import { createPropGeometry } from './world/build/PropLibrary';
import { scatterStreetProps } from './world/build/PropScatter';
import { buildBlockGround, buildIntersections, buildStreet } from './world/build/StreetBuilder';
import { buildRoadNetwork } from './city/RoadNetwork';
import { PedestrianSystem } from './agents/PedestrianSystem';
import { TrafficSystem } from './traffic/TrafficSystem';
import { SignalHeads } from './city/SignalHeads';
import { StreetAudio } from './audio/StreetAudio';
import { CombatAudio, type FlightSound } from './audio/CombatAudio';
import { HEAT, MAX_HEALTH, PlayerState, WEAPONS, type WeaponId } from './player/PlayerState';
import { GunShop } from './shop/GunShop';
import { Furnishings } from './world/furnishings/Furnishings';
import { loadStreetPropModels } from './world/furnishings/StreetProps';
import { CombatSystem } from './combat/CombatSystem';
import { CrowdTargets } from './combat/CrowdTargets';
import { WorldRayIndex } from './combat/rays';
import { RespawnDirector } from './combat/Respawn';
import { defaultViewmodels } from './combat/WeaponViewmodel';
import type { RocketHandle } from './combat/Projectiles';
import { PoliceSystem } from './police/PoliceSystem';
import { loadVehicleModels } from './traffic/VehicleModels';
import { CollisionWorld } from './player/Collision';
import { FirstPersonController } from './player/FirstPersonController';
import { Driving } from './player/Driving';
import { InteractionSystem } from './player/Interaction';
import { AudioDirector } from './audio/AudioDirector';
import { DamageFeedback } from './ui/DamageFeedback';
import { Hud } from './ui/Hud';
import { LoadingScreen } from './ui/LoadingScreen';
import { Minimap } from './ui/Minimap';
import { PauseMenu } from './ui/PauseMenu';

/**
 * Yields to the browser so the loading screen can repaint between phases.
 *
 * A plain `requestAnimationFrame` is not enough: a backgrounded or throttled
 * tab may deliver frames once a second or not at all, and the whole build then
 * appears to hang on the first phase. Racing a timer guarantees progress while
 * still giving the compositor a chance to paint when the tab is visible.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 32);
  });
}

const DISTRICT_NAMES: Readonly<Record<string, string>> = {
  harbourside: 'Harbourside',
  cannery: 'The Cannery',
  oldQuarter: 'Old Quarter',
  core: 'Meridian Core',
  civic: 'Lantern Park',
  ridge: 'Ridge Terraces',
};

/**
 * Confirms the browser can actually give us a 3D context before we build a
 * city for it. Without this check a machine with WebGL disabled gets a
 * minified TypeError from deep inside the renderer, which tells the player
 * nothing and looks like the game is broken rather than unsupported.
 */
function detectWebgl(canvas: HTMLCanvasElement): string | null {
  try {
    const gl =
      canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) ??
      canvas.getContext('webgl');
    if (!gl) return 'This browser could not create a WebGL context.';
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'WebGL is unavailable.';
  }
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('viewport canvas is missing');

  const webglProblem = detectWebgl(canvas);
  if (webglProblem) {
    showFatal(
      `Meridian Bay needs WebGL, and this browser cannot provide it. ${webglProblem}`,
      'Try a browser with hardware acceleration enabled.',
    );
    return;
  }

  const loading = new LoadingScreen();
  document.body.appendChild(loading.element);

  loading.setProgress(0.04, 'Planning Meridian Bay');
  await nextFrame();

  const plan = getCityPlan();
  const ground = new CityGround(plan);

  const engine = new Engine(canvas);
  const materials = new MaterialLibrary();
  const sky = new Sky();
  engine.scene.add(sky.mesh);
  engine.scene.environment = sky.createEnvironment(engine.renderer);
  // The held weapon is drawn in its own pass with its own scene, so it needs
  // to be handed the same sky to reflect.
  engine.setOverlayEnvironment(engine.scene.environment);

  const lighting = new Lighting();
  lighting.addTo(engine.scene);

  const sink = new WorldSink();

  loading.setProgress(0.14, 'Laying out the streets');
  await nextFrame();
  for (const street of plan.streets) buildStreet(street, plan, sink);
  buildIntersections(plan, sink);
  for (const block of plan.blocks) buildBlockGround(block, plan, sink);

  loading.setProgress(0.4, 'Raising the buildings');
  await nextFrame();
  for (const parcel of plan.parcels) buildBuilding(parcel, sink);

  loading.setProgress(0.62, 'Fitting out the interiors');
  await nextFrame();
  for (const parcel of plan.parcels) {
    if (parcel.enterable) buildInterior(parcel, sink);
  }

  loading.setProgress(0.72, 'Dressing the streets');
  await nextFrame();
  scatterStreetProps(plan, sink);
  buildEnvironment(sink, ground);

  loading.setProgress(0.84, 'Loading generated assets');
  await nextFrame();

  const models = new ModelLibrary();
  // The generated street lamp is normalised to 1 unit tall with a centre pivot;
  // ModelLibrary rescales it to a real 4.2 m and moves the origin to its base.
  // Loaded together, not one after the other: they are independent, and
  // serialising them made the slower of the two set the whole loading time.
  const [lamp, fountain, vehicleModels] = await Promise.all([
    models.load('streetLamp', {
      url: `${import.meta.env.BASE_URL}models/street-lamp/model.glb`,
      targetHeight: 4.2,
      timeoutMs: 15000,
    }),
    models.load('fountain', {
      url: `${import.meta.env.BASE_URL}models/fountain/model.glb`,
      targetHeight: 2.1,
      timeoutMs: 15000,
    }),
    // The fleet: ten generated bodies and one generated wheel, fitted to the
    // simulation's own chassis sizes. Null falls the renderer back to the
    // authored shells rather than emptying the streets.
    loadVehicleModels({ baseUrl: import.meta.env.BASE_URL, timeoutMs: 20000 }),
  ]);

  const propGeometry = new Map<PropKey, PropPart[]>();
  for (const key of ALL_PROP_KEYS) {
    const parts = createPropGeometry(key);
    if (parts.length > 0) propGeometry.set(key, parts as PropPart[]);
  }
  if (lamp) {
    propGeometry.set('streetLamp', [
      { key: 'metalDark', geometry: lamp.geometry, material: lamp.material },
    ]);
  }

  // Generated street furniture overrides its authored massing, by exactly the
  // same trick as the lamp above: everything has a procedural version, and
  // whatever downloads replaces it BEFORE the city is baked. Props therefore
  // keep their per-chunk instancing, distance culling and shadows, and a
  // failed download degrades to the authored shape rather than to nothing.
  const streetModels = await loadStreetPropModels(import.meta.env.BASE_URL);
  for (const [key, parts] of streetModels.parts) propGeometry.set(key, parts as PropPart[]);

  loading.setProgress(0.92, 'Baking the city');
  await nextFrame();

  const { group, chunks } = sink.bake(materials, propGeometry);
  engine.scene.add(group);

  // The fountain is a single landmark rather than an instanced prop, so it is
  // placed directly once its real size is known.
  if (fountain) {
    const landmark = plan.landmarks.find((l) => l.kind === 'fountain');
    if (landmark) {
      const { Mesh } = await import('three');
      const mesh = new Mesh(fountain.geometry, fountain.material);
      const y = ground.sample(landmark.x, landmark.z).y;
      mesh.position.set(landmark.x, y, landmark.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      engine.scene.add(mesh);
      sink.collider({
        minX: landmark.x - fountain.size.x / 2,
        maxX: landmark.x + fountain.size.x / 2,
        minZ: landmark.z - fountain.size.z / 2,
        maxZ: landmark.z + fountain.size.z / 2,
        bottom: y,
        top: y + fountain.size.y,
        solid: true,
      });
    }
  }

  const collision = new CollisionWorld(sink.colliders);
  lighting.setLightRequests(sink.lights);

  loading.setProgress(0.94, 'Waking the city');
  await nextFrame();

  // The movement graph every moving thing shares: lanes for vehicles,
  // pavements and crossings for people, one signal clock for both. Built once
  // from the plan so a car stopping at a red and a pedestrian stepping off the
  // kerb are agreeing about the same junction.
  const network = buildRoadNetwork(plan);

  // The signal heads read the SAME clock and the SAME `signalFor` the traffic
  // simulation obeys, so the lights and the cars can never disagree.
  const signals = new SignalHeads({
    network,
    materials,
    heightAt: (x: number, z: number) => ground.heightAt(x, z),
  });
  engine.scene.add(signals.group);

  const pedestrians = new PedestrianSystem({
    plan,
    ground,
    network,
    quality: 'high',
    // Reuse the colliders the world already emitted rather than making the
    // system re-run a whole prop-scatter pass to rediscover the same furniture.
    obstacles: sink.colliders,
  });
  engine.scene.add(pedestrians.group);

  const traffic = new TrafficSystem({
    plan,
    ground,
    network,
    quality: 'high',
    models: vehicleModels,
  });
  engine.scene.add(traffic.group);

  /**
   * Vehicles as the crowd wants to see them.
   *
   * `VehicleView` carries a scalar `speed` and a yaw; the crowd steers on a
   * velocity vector. Deriving it here rather than inside the crowd keeps the
   * two systems structurally independent, and the array is reused every frame
   * because this runs at 120 Hz beside 270 pedestrians.
   */
  interface CrowdCar {
    x: number;
    z: number;
    vx: number;
    vz: number;
    halfLength: number;
    halfWidth: number;
  }
  const crowdCars: CrowdCar[] = [];
  const syncCrowdCars = (): CrowdCar[] => {
    const views = traffic.vehicles;
    while (crowdCars.length < views.length) {
      crowdCars.push({ x: 0, z: 0, vx: 0, vz: 0, halfLength: 2.2, halfWidth: 0.9 });
    }
    crowdCars.length = views.length;
    for (let i = 0; i < views.length; i += 1) {
      const v = views[i];
      const o = crowdCars[i];
      if (!v || !o) continue;
      o.x = v.x;
      o.z = v.z;
      // Forward is (-sin yaw, 0, -cos yaw), the same convention the camera uses.
      o.vx = -Math.sin(v.yaw) * v.speed;
      o.vz = -Math.cos(v.yaw) * v.speed;
      o.halfLength = v.halfLength;
      o.halfWidth = v.halfWidth;
    }
    return crowdCars;
  };

  const controller = new FirstPersonController({
    ground,
    collision,
    camera: engine.camera,
    domElement: canvas,
    spawn: plan.spawn,
  });

  const driving = new Driving({
    traffic,
    ground,
    collision,
    camera: engine.camera,
    controller,
    domElement: canvas,
  });

  // Running somebody over: the car feels it, and it counts against the player.
  // Only the player's vehicle strikes anyone - ambient drivers cannot see
  // pedestrians, so letting them strike was measured at 210 knock-downs in ten
  // minutes that the player neither caused nor could avoid.
  pedestrians.onImpact = (hit) => {
    driving.reportImpact(hit.speed, hit.dirX, hit.dirZ);
    player.addHeat(HEAT.vehicleImpact);
  };

  // Traffic brakes for people who are actually on a crossing. The array is
  // read live, so this is handed over once and the crowd keeps mutating it.
  traffic.setObstacles(pedestrians.carriagewayObstacles());
  traffic.setCrossingBlocked((id: string) => pedestrians.crossingBlocked(id));

  const audio = new AudioDirector();
  const streetAudio = new StreetAudio({
    host: audio,
    surfaceAt: (x: number, z: number) => ground.sample(x, z).surface,
  });
  const interactions = new InteractionSystem(sink.interactions);
  const minimap = new Minimap(plan);
  const parcelsById = new Map<string, Parcel>(plan.parcels.map((p) => [p.id, p]));

  let quality: QualityLevel = 'high';
  const setQuality = (level: QualityLevel): void => {
    quality = level;
    engine.setQuality(level);
    pedestrians.setQuality(level);
    traffic.setQuality(level);
    lighting.applyQuality(level);
    lighting.setLightRequests(sink.lights);
  };

  const hud = new Hud({
    onMusicToggle: (enabled) => {
      void audio.setMusicEnabled(enabled);
      hud.setMusicEnabled(enabled);
      pause.setMusicEnabled(enabled);
      audio.playOneShot('ui-tick');
    },
    onResume: () => {
      pause.hide();
      controller.requestPointerLock();
    },
    onQualityChange: setQuality,
  });

  const pause = new PauseMenu({
    volumes: {
      master: audio.getVolume('master'),
      music: audio.getVolume('music'),
      effects: audio.getVolume('effects'),
      ambience: audio.getVolume('ambience'),
    },
    onVolumeChange: (channel, value) => audio.setVolume(channel, value),
    onResume: () => {
      pause.hide();
      controller.setPaused(false);
      controller.requestPointerLock();
    },
    onMusicToggle: (enabled) => {
      void audio.setMusicEnabled(enabled);
      hud.setMusicEnabled(enabled);
      pause.setMusicEnabled(enabled);
    },
    onQualityChange: setQuality,
  });

  document.body.appendChild(hud.element);
  document.body.appendChild(minimap.element);
  document.body.appendChild(pause.element);

  // -- the player's own condition -------------------------------------------
  // One source of truth for money, health, weapons and heat. The shop spends
  // it, combat spends ammunition from it, and the police read the heat.
  const player = new PlayerState();

  const shop = new GunShop({
    plan,
    player,
    baseUrl: import.meta.env.BASE_URL,
    onSound: () => audio.playOneShot('ui-tick'),
  });
  engine.scene.add(shop.group);
  document.body.appendChild(shop.element);
  shop.onOpenChange = (open: boolean) => {
    controller.setPaused(open);
    if (open) document.exitPointerLock();
    else controller.requestPointerLock();
  };
  void shop.load();

  const furnishings = new Furnishings(plan, import.meta.env.BASE_URL);
  engine.scene.add(furnishings.group);
  void furnishings.load();

  // -- law and order ---------------------------------------------------------
  const worldRays = new WorldRayIndex(sink.colliders);
  // `removeAt` is what makes a shot civilian actually fall over instead of
  // walking on with the hit merely recorded. Struck and shot people share one
  // `down` state inside the crowd.
  const civilians = new CrowdTargets(pedestrians.group, {
    removeAt: (x: number, y: number, z: number) => {
      pedestrians.downAt(x, y, z);
    },
  });

  const police = new PoliceSystem({
    player,
    traffic,
    network,
    collision,
    world: worldRays,
    heightAt: (x: number, z: number) => ground.heightAt(x, z),
    quality: 'high',
    seed: plan.seed,
    onArrest: () => respawn.bust('busted'),
    onOfficerShot: (x: number, y: number, z: number) => combatAudio.shotAt('pistol', x, y, z),
  });
  engine.scene.add(police.group);

  // Gunfire, impacts, blasts and the sound of being hit. A third layer on the
  // director's own buses, like `StreetAudio`, so the volume sliders reach it.
  const combatAudio = new CombatAudio(audio);
  const damageFeedback = new DamageFeedback();
  hud.element.append(damageFeedback.element);

  const combat = new CombatSystem({
    player,
    camera: engine.camera,
    domElement: canvas,
    world: worldRays,
    heightAt: (x: number, z: number) => ground.heightAt(x, z),
    civilians,
    vehicles: traffic,
    law: police,
    hud,
    seed: plan.seed,
    viewmodels: defaultViewmodels(import.meta.env.BASE_URL),
    rocketUrl: `${import.meta.env.BASE_URL}models/weapons/rocket.glb`,
    onShot: (weapon) => combatAudio.shot(weapon),
    onImpact: (kind, x, y, z) => combatAudio.impact(kind, x, y, z),
    onHandling: (kind) => combatAudio.handling(kind),
    onExplosion: (x, y, z, radius, distance) => {
      combatAudio.explosion(x, y, z, distance);
      // Everything inside the blast gets thrown about, and the camera with it.
      pedestrians.blastAt(x, z, radius);
      controller.shake(Math.max(0, 1 - distance / (radius * 3.5)));
    },
    onRocket: (rocket) => {
      const flight = combatAudio.flight(rocket.x, rocket.y, rocket.z);
      rocketFlights.push({ rocket, flight });
    },
    onSlotDenied: (weapon, reason) => {
      hud.flash(
        reason === 'unowned'
          ? `${WEAPONS[weapon].name} — buy it at the gun store`
          : `${WEAPONS[weapon].name} — out of ammunition`,
      );
    },
  });
  engine.scene.add(combat.group);
  // The held weapon is drawn in its own pass against a cleared depth buffer,
  // which is the only way a barrel can be at a shop counter without going
  // through it. See `Engine.renderFrame`.
  const heldWeapon = combat.overlay;
  if (heldWeapon) engine.overlayScene.add(heldWeapon);
  police.setEffects(combat.effects);

  /** Live rocket motors, so each one's loop can follow it and then stop. */
  const rocketFlights: { rocket: RocketHandle; flight: FlightSound }[] = [];

  const respawn = new RespawnDirector({
    player,
    spawn: plan.spawn,
    teleport: (x: number, z: number, heading?: number) => controller.teleport(x, z, heading),
    isDriving: () => driving.driving,
    exitVehicle: () => driving.exit(),
    setPaused: (paused: boolean) => controller.setPaused(paused),
    onBanner: (title: string | null, detail: string) => hud.setBanner(title, detail),
    onBust: () => {
      police.standDown();
      combat.reset();
      combatAudio.reset();
      damageFeedback.reset();
    },
  });

  // The HUD follows the player's condition rather than polling it.
  player.onChange = () => {
    hud.setMoney(player.money);
    shop.refresh();
  };
  hud.setMoney(player.money);

  // Being shot: a grunt, a red flash, and an arc pointing at whoever did it.
  player.onDamage = (amount, sourceX, sourceZ) => {
    combatAudio.hurt();
    damageFeedback.hit(amount / MAX_HEALTH, sourceX, sourceZ);
  };
  player.onDeath = () => combatAudio.death();

  interactions.onActivate = ({ point }) => {
    // The counter is an interaction point like any other; the shop claims it.
    if (shop.tryOpen(point)) return;
    if (point.kind !== 'door' || !point.target) return;
    audio.playOneShot('door-open');
    const parcel = point.parcelId ? parcelsById.get(point.parcelId) : undefined;
    if (parcel) {
      controller.placeOnFloor(point.target.x, point.target.z, point.target.y, point.target.heading);
    } else {
      controller.teleport(point.target.x, point.target.z, point.target.heading);
    }
    window.setTimeout(() => audio.playOneShot('door-close'), 420);
  };

  // A driver has no feet on the pavement. The controller is paused while
  // driving, but its velocity DAMPS to zero rather than snapping there, so it
  // can still cross the footstep threshold for a moment after getting in -
  // which is audible as walking while sitting in a car.
  controller.onFootstep = (surface, running) => {
    if (driving.driving) return;
    audio.footstep(surface, running);
  };

  // -- pause / pointer lock --------------------------------------------------

  const showPause = (): void => {
    pause.show();
    controller.setPaused(true);
    hud.setPointerLocked(false);
  };

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    hud.setPointerLocked(locked);
    // Losing the lock only pauses if the lock was actually in use; an
    // environment that never grants it must stay playable.
    if (!locked && hadPointerLock && !shop.open) showPause();
    if (locked) {
      hadPointerLock = true;
      controller.setPaused(false);
    }
  });

  let hadPointerLock = false;

  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas && !pause.visible) controller.requestPointerLock();
  });

  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyE' && !event.repeat) {
      // Order matters: get out of a car first, then a focused door (the
      // interaction system handles that itself), then get into a car.
      if (driving.driving) {
        // StreetAudio plays the CAR door from the transition itself; the
        // wooden building-door one-shot here would double it with the wrong sound.
        driving.exit();
        return;
      }
      if (!interactions.focused) {
        const at = controller.state;
        driving.tryEnter(at.x, at.z);
      }
      return;
    }
    if (event.code === 'KeyM') {
      minimap.setExpanded(!minimap.expanded);
      audio.playOneShot('ui-tick');
    } else if (event.code === 'F3' || event.code === 'Backquote') {
      // macOS binds F3 to Mission Control, so the key never reaches the page.
      // Backquote needs no Fn modifier and is free on every layout we target.
      event.preventDefault();
      statsVisible = !statsVisible;
      hud.setStatsVisible(statsVisible);
    } else if (event.code === 'Escape') {
      // The shop closes itself on Escape; the pause menu must not also open
      // behind it, or leaving the counter drops the player into a paused game.
      if (!shop.open) showPause();
    }
  });

  let statsVisible = false;

  // -- frame loop ------------------------------------------------------------

  const listenerForward = new Vector3();
  let statsTimer = 0;
  let chunkTimer = 0;

  engine.onUpdate = (dt, elapsed) => {
    materials.update(elapsed);
    controller.update(dt);
    driving.update(dt);
    const walkState = controller.state;
    const drive = driving.state;
    // While driving, the car IS the player as far as the rest of the game is
    // concerned: the camera, the audio listener, the minimap and the systems
    // that stream around the viewer all follow it.
    const state = drive.driving
      ? { ...walkState, x: drive.x, y: drive.y, z: drive.z, yaw: drive.yaw, speed: Math.abs(drive.speed) }
      : walkState;

    // One clock for signals, crossings and gaits: `elapsed` is what
    // `signalFor`/`walkSignal` read, so people and traffic never disagree
    // about who has right of way. Traffic moves FIRST so the crowd steers
    // against where the cars are this frame, not where they were last.
    traffic.update(dt, { x: state.x, z: state.z, time: elapsed });
    pedestrians.update(dt, {
      x: state.x,
      y: state.y,
      z: state.z,
      time: elapsed,
      vehicles: syncCrowdCars(),
    });

    // Signals share `elapsed` with the traffic simulation - see above.
    signals.update(elapsed);

    // Law and order run AFTER the crowd is written (combat reads targets out
    // of its instance buffers) and after the camera is posed (recoil sits on
    // top of it). `police.update` owns the call to `player.coolOff`.
    listenerForward.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    police.update(dt, {
      time: elapsed,
      playerX: state.x,
      playerY: state.y,
      playerZ: state.z,
      playerSpeed: state.speed,
      forwardX: listenerForward.x,
      forwardZ: listenerForward.z,
      driving: drive.driving,
    });
    combat.update(dt, {
      driving: drive.driving,
      playerX: state.x,
      playerY: state.y,
      playerZ: state.z,
      playerSpeed: state.speed,
    });
    respawn.update(dt);
    // Health comes back once the player has been left alone. See PlayerState.
    player.regenerate(dt);
    hud.setWanted(player.wanted);
    hud.setHealth(player.health, MAX_HEALTH);
    hud.tick(dt);
    damageFeedback.update(dt, {
      health: player.health / MAX_HEALTH,
      alive: player.alive,
      yaw: state.yaw,
      x: state.x,
      z: state.z,
    });

    shop.update(dt, { x: state.x, z: state.z });
    furnishings.update(state.x, state.z);

    sky.follow(state.x, state.y, state.z);
    lighting.update(state.x, state.y + 1.6, state.z);
    interactions.update(state.x, state.y, state.z, state.yaw);
    minimap.update(state.x, state.z, state.yaw);

    listenerForward.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    audio.update(dt, {
      x: state.x,
      y: state.y,
      z: state.z,
      forwardX: listenerForward.x,
      forwardZ: listenerForward.z,
      // Never default this: `blockAt` is null on every street, so a fixed
      // fallback reported one district for most of the map.
      district: ground.districtAt(state.x, state.z),
      surface: state.surface,
      indoors: state.indoors,
      speed: state.speed,
    });

    // Rocket motors travel with their rockets, and stop when they arrive. The
    // list is walked backwards so a finished flight can be spliced out of it.
    for (let i = rocketFlights.length - 1; i >= 0; i -= 1) {
      const entry = rocketFlights[i];
      if (!entry) continue;
      if (entry.rocket.live) {
        entry.flight.moveTo(entry.rocket.x, entry.rocket.y, entry.rocket.z);
      } else {
        entry.flight.stop();
        rocketFlights.splice(i, 1);
      }
    }

    combatAudio.update(dt, {
      health: player.health,
      maxHealth: MAX_HEALTH,
      alive: player.alive,
    });

    // Engine note, tyres, doors, impacts and crowd footsteps. Routed through
    // the same buses as everything else, so the volume sliders still govern it.
    streetAudio.update(dt, {
      x: state.x,
      y: state.y,
      z: state.z,
      indoors: state.indoors,
      driving: drive.driving,
      driveSpeed: drive.speed,
      vehicles: traffic.vehicles,
      crowd: pedestrians.group,
    });

    // Chunk visibility is cheap but pointless to recompute every frame.
    chunkTimer += dt;
    if (chunkTimer > 0.25) {
      chunkTimer = 0;
      updateChunks(chunks, state.x, state.z, quality);
    }

    statsTimer += dt;
    if (statsVisible && statsTimer > 0.25) {
      statsTimer = 0;
      const stats = engine.getStats();
      hud.setStats({
        fps: stats.fps,
        p95Ms: stats.p95Ms,
        worstMs: stats.worstMs,
        hitches: stats.hitches,
        updateMs: stats.updateMs,
        renderMs: stats.renderMs,
        bufferWidth: stats.bufferWidth,
        bufferHeight: stats.bufferHeight,
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
        memoryMB: stats.memoryMB,
      });
    }

    // One place decides the prompt, so a door and a car can never fight over it.
    if (drive.driving) {
      hud.setInteractionPrompt('Press E to get out');
    } else if (interactions.focused) {
      hud.setInteractionPrompt(interactions.focused.prompt);
    } else {
      const car = driving.candidateAt(state.x, state.z);
      hud.setInteractionPrompt(car ? `Press E to drive the ${car.kind}` : null);
    }

    const street = nearestStreetName(plan, state.x, state.z);
    hud.setLocation(DISTRICT_NAMES[ground.districtAt(state.x, state.z)] ?? 'Meridian Bay', street);
  };

  // -- start -----------------------------------------------------------------

  // Compile every shader while the loading screen is still up.
  //
  // Three.js compiles a material's program the first time it actually renders,
  // and this scene needs 16 of them. Measured: the first frame after the
  // loading screen took 202.9 ms and produced all 16, while every later frame
  // from every other vantage took 2-5 ms and produced none. That is a fifth of
  // a second of frozen screen at the exact moment the player takes control.
  //
  // Compiling here moves the stall behind the progress bar, where a pause is
  // expected. It changes nothing about what is drawn.
  loading.setProgress(0.97, 'Compiling shaders');
  await nextFrame();
  try {
    // Guarded: `compileAsync` resolves via KHR_parallel_shader_compile, and a
    // driver that never reports readiness would otherwise hang the boot.
    await Promise.race([
      engine.renderer.compileAsync(engine.scene, engine.camera),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
  } catch {
    // A failed pre-compile costs a stutter, not a broken game: the programs
    // are built lazily on first render exactly as they were before.
  }

  // `compileAsync` walks the scene's own materials, which leaves the shadow
  // pass out: the depth variants are only built when the shadow map is first
  // drawn. Two warm-up frames behind the loading screen force those as well -
  // measured, this is the difference between 12 of 14 programs ready and all
  // of them. The frames land under the loading overlay, so nothing is seen.
  engine.renderer.render(engine.scene, engine.camera);
  await nextFrame();
  engine.renderer.render(engine.scene, engine.camera);

  loading.setProgress(1, 'Ready');
  await loading.awaitStart();
  loading.hide();

  // The start click is the user gesture that lets us create the AudioContext.
  // Music stays off; only ambience and effects come up here.
  await audio.unlock();
  // Gunfire has to be resident before the first trigger pull, not fetched
  // after it: a shot whose sound arrives 300 ms late reads as no sound at all.
  combatAudio.preload();
  hud.setMusicEnabled(audio.musicEnabled);
  pause.setMusicEnabled(audio.musicEnabled);

  engine.start();
  controller.requestPointerLock();

  window.addEventListener('beforeunload', () => {
    engine.dispose();
    controller.dispose();
    interactions.dispose();
    audio.dispose();
    minimap.dispose();
    hud.dispose();
    pause.dispose();
    materials.dispose();
    sky.dispose();
    lighting.dispose();
    models.dispose();
    driving.dispose();
    pedestrians.dispose();
    traffic.dispose();
    signals.dispose();
    streetAudio.dispose();
    combatAudio.dispose();
    damageFeedback.dispose();
    shop.dispose();
    furnishings.dispose();
    combat.dispose();
    police.dispose();
    for (const chunk of chunks) chunk.dispose();
  });

  // TEMPORARY performance-investigation hook. Remove before finishing.
  (window as unknown as Record<string, unknown>).__dev = {
    scene: engine.scene,
    renderer: engine.renderer,
    camera: engine.camera,
    lighting,
    chunks,
  };

  // Expose a small read-only handle so automated QA can assert on real state
  // instead of scraping pixels, and can drive the camera to a known vantage
  // point without depending on synthetic key events being delivered.
  Object.defineProperty(window, '__meridian', {
    value: {
      /** Places the player and points the camera. Returns the resulting state. */
      look(x: number, z: number, yaw: number, pitch = 0): unknown {
        controller.teleport(x, z, yaw);
        controller.setPitch(pitch);
        controller.update(1 / 60);
        return controller.state;
      },
      setQuality(level: QualityLevel): void {
        setQuality(level);
      },
      /**
       * Renders a burst of frames back to back, forcing a GPU sync after each
       * one, and reports the real per-frame cost. Unlike a rAF benchmark this
       * still works in a throttled or backgrounded tab, which is the only way
       * to get a truthful number out of an automated browser.
       */
      renderBenchmark(frames = 90, width?: number, height?: number): unknown {
        // A backgrounded tab lays the canvas out at a couple of pixels, which
        // would measure submission cost only. Forcing a real size makes the
        // number comparable to what a player actually sees.
        const restore = [engine.renderer.domElement.width, engine.renderer.domElement.height];
        if (width && height) engine.renderer.setSize(width, height, false);
        const gl = engine.renderer.getContext();
        const pixel = new Uint8Array(4);
        const sync = (): void => {
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        };
        // Warm the pipeline so shader compilation is not counted.
        for (let i = 0; i < 6; i += 1) {
          engine.renderer.render(engine.scene, engine.camera);
        }
        sync();

        const samples: number[] = [];
        for (let i = 0; i < frames; i += 1) {
          const t0 = performance.now();
          engine.renderer.info.reset();
          engine.renderer.render(engine.scene, engine.camera);
          sync();
          samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        const at = (q: number): number => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] ?? 0;
        const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
        const info = engine.renderer.info;
        const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
        const measured = [engine.renderer.domElement.width, engine.renderer.domElement.height];
        if (width && height) engine.resize();
        void restore;
        return {
          frames,
          renderedAt: measured,
          meanMs: Number(mean.toFixed(2)),
          medianMs: Number(at(0.5).toFixed(2)),
          p95Ms: Number(at(0.95).toFixed(2)),
          worstMs: Number(at(1).toFixed(2)),
          impliedFps: Number((1000 / mean).toFixed(1)),
          drawCalls: info.render.calls,
          triangles: info.render.triangles,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          pixelRatio: engine.getStats().pixelRatio,

          memoryMB: perf.memory ? Number((perf.memory.usedJSHeapSize / 1048576).toFixed(1)) : null,
        };
      },
      /** Every door the player can use, for automated QA and for the map. */
      get doors(): unknown[] {
        return sink.interactions
          .filter((point) => point.kind === 'door')
          .map((point) => ({
            id: point.id,
            parcelId: point.parcelId ?? null,
            x: point.x,
            y: point.y,
            z: point.z,
            prompt: point.prompt,
            target: point.target ?? null,
          }));
      },
      /** Lists scene meshes matching a name fragment, for automated QA. */
      probe(fragment: string): unknown[] {
        const out: unknown[] = [];
        engine.scene.traverse((child) => {
          if (!child.name.includes(fragment)) return;
          const mesh = child as unknown as {
            isMesh?: boolean;
            visible: boolean;
            geometry?: { boundingBox?: { min: Vector3; max: Vector3 } | null };
            material?: { name?: string };
            parent?: { visible: boolean; name: string } | null;
          };
          out.push({
            name: child.name,
            isMesh: mesh.isMesh === true,
            visible: child.visible,
            parentVisible: mesh.parent?.visible ?? null,
            parentName: mesh.parent?.name ?? null,
            material: mesh.material?.name ?? null,
            box: mesh.geometry?.boundingBox
              ? {
                  min: mesh.geometry.boundingBox.min.toArray(),
                  max: mesh.geometry.boundingBox.max.toArray(),
                }
              : null,
          });
        });
        return out;
      },
      /** Measures real frame pacing over a window, ignoring the first frames. */
      benchmark(seconds = 4): Promise<unknown> {
        return new Promise((resolve) => {
          const samples: number[] = [];
          let last = performance.now();
          let warmup = 12;
          const started = last;
          const step = (): void => {
            const now = performance.now();
            const dt = now - last;
            last = now;
            if (warmup > 0) warmup -= 1;
            else samples.push(dt);
            if (now - started < seconds * 1000) requestAnimationFrame(step);
            else {
              const sorted = [...samples].sort((a, b) => a - b);
              const at = (q: number): number => sorted[Math.floor(sorted.length * q)] ?? 0;
              const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
              const stats = engine.getStats();
              resolve({
                frames: samples.length,
                meanFps: 1000 / mean,
                medianMs: at(0.5),
                p95Ms: at(0.95),
                worstMs: sorted[sorted.length - 1] ?? 0,
                drawCalls: stats.drawCalls,
                triangles: stats.triangles,
                pixelRatio: stats.pixelRatio,
                memoryMB: stats.memoryMB,
              });
            }
          };
          requestAnimationFrame(step);
        });
      },
      get position() {
        const s = controller.state;
        return { x: s.x, y: s.y, z: s.z, yaw: s.yaw, surface: s.surface, indoors: s.indoors };
      },
      get stats() {
        return engine.getStats();
      },
      get musicEnabled() {
        return audio.musicEnabled;
      },
      get circuitLength() {
        return plan.circuitLength;
      },
      /**
       * Drives N real frames at a fixed delta, for automated QA.
       *
       * The browser pane used for verification stops compositing between tool
       * calls, which stops `requestAnimationFrame` and makes the whole game
       * look frozen. This runs the same update path the loop runs.
       */
      step(frames = 60, dt = 1 / 60): void {
        for (let i = 0; i < frames; i += 1) engine.stepOnce(dt);
      },
      /** Money, health, weapons and wanted level, for automated QA. */
      get player(): unknown {
        return player.snapshot();
      },
      /** Combat and law-enforcement state, for automated QA. */
      get law(): unknown {
        return {
          combat: combat.stats,
          police: police.stats,
          shopOpen: shop.open,
          rockets: combat.rocketsLive,
          viewmodelReady: combat.viewmodelReady,
          officerPoses: police.officerPoses,
        };
      },
      /**
       * Levers that put the game into a state worth looking at, for automated
       * QA and for verifying a change by hand.
       *
       * Deliberately a separate object with a name that says what it is: these
       * write to the same `PlayerState` the shop and the police read, so
       * anything reached through here is the real system and not a mock. It is
       * the only way to check a weapon, a wanted level or an explosion without
       * playing the twenty minutes it would take to earn one.
       */
      qa: {
        /** Puts a weapon and its ammunition in the player's hands. */
        give(id: WeaponId, rounds = 90): void {
          player.earn(WEAPONS[id].price);
          player.buyWeapon(id);
          while (player.ammo(id) < rounds) {
            player.earn(WEAPONS[id].ammoPrice);
            if (!player.buyAmmo(id)) break;
          }
          player.equip(id);
        },
        /** One deliberate trigger pull. Returns whether a round left. */
        fire(): boolean {
          return combat.fireOnce();
        },
        /** Damages the player from a direction, as an officer's round does. */
        hurt(amount = 20, sourceX?: number, sourceZ?: number): void {
          player.hurt(amount, sourceX, sourceZ);
        },
        /** Adds heat, which is what the star rating is a threshold over. */
        heat(amount = 200): void {
          player.addHeat(amount);
        },
        teleport(x: number, z: number, heading?: number): void {
          controller.teleport(x, z, heading);
        },
      },
      /** Player driving state, for automated QA. */
      get driving(): unknown {
        return driving.state;
      },
      /** Nearest drivable car to the player, for automated QA. */
      nearestCar(): unknown {
        const at = controller.state;
        return driving.candidateAt(at.x, at.z);
      },
      /** Live traffic state, for automated QA. */
      get traffic(): unknown {
        return traffic.stats;
      },
      /** Live crowd state, for automated QA. */
      get crowd(): unknown {
        return pedestrians.stats;
      },
      get counts() {
        return {
          parcels: plan.parcels.length,
          streets: plan.streets.length,
          colliders: sink.colliders.length,
          instances: sink.stats.instances,
          triangles: sink.stats.triangles,
          chunks: chunks.length,
        };
      },
    },
    writable: false,
  });
}

function updateChunks(
  chunks: readonly WorldChunk[],
  x: number,
  z: number,
  quality: QualityLevel,
): void {
  // Fog swallows the far side of the city, so chunks past the fade distance can
  // stop submitting draw calls entirely.
  const visibleRange = quality === 'low' ? 260 : quality === 'medium' ? 340 : 460;
  const shadowRange = quality === 'low' ? 0 : 110;
  for (const chunk of chunks) {
    const distance = chunk.distanceTo(x, z);
    chunk.setVisible(distance < visibleRange);
    chunk.setShadowsEnabled(distance < shadowRange);
  }

}

function nearestStreetName(
  plan: ReturnType<typeof getCityPlan>,
  x: number,
  z: number,
): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const street of plan.streets) {
    const along = street.axis === 'x' ? z : x;
    if (along < street.from || along > street.to) continue;
    const across = street.axis === 'x' ? x : z;
    const distance = Math.abs(across - street.position);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = street.name;
    }
  }
  return bestDistance < 22 ? best : null;
}

/** Replaces the screen with a readable failure message. */
function showFatal(message: string, hint?: string): void {
  document.querySelector('.mb-loading')?.remove();
  const panel = document.createElement('div');
  panel.setAttribute('role', 'alert');
  panel.className = 'mb-fatal';
  panel.style.cssText =
    'position:fixed;inset:0;z-index:200;display:grid;align-content:center;justify-items:center;gap:12px;' +
    'background:#0b0d10;color:#d8cfc2;font:15px/1.7 ui-sans-serif,system-ui,sans-serif;padding:40px;text-align:center';
  const title = document.createElement('p');
  title.style.cssText = 'margin:0;max-width:46ch';
  title.textContent = message;
  panel.appendChild(title);
  if (hint) {
    const sub = document.createElement('p');
    sub.style.cssText = 'margin:0;opacity:0.6;font-size:13px';
    sub.textContent = hint;
    panel.appendChild(sub);
  }
  document.body.appendChild(panel);
}

void boot().catch((error: unknown) => {
  // A build failure must say so on screen rather than leaving a black canvas.
  const message = error instanceof Error ? error.message : String(error);
  showFatal(`Meridian Bay could not start: ${message}`);
  // eslint-disable-next-line no-console
  console.error('[meridian] boot failed', error);
});
