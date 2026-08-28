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
import { PoliceAudio } from './audio/PoliceAudio';
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
import { AIRCRAFT, AircraftSystem, FLIGHT_CONTROLS, Flying, airQaSection } from './air';
import { RUNWAY, TERMINAL, TERMINAL_FLOOR } from './world/airport/layout';
import { GATE_SEATS, TERMINAL_QUEUES } from './world/airport/plan';
import { buildAirport } from './world/airport';
import { loadAirportModels } from './world/airport/models';
import { TerminalCrowd } from './agents/travellers';
import { insetRect } from './core/mathx';
import { AircraftAudio } from './audio/AircraftAudio';
import { loadVehicleModels } from './traffic/VehicleModels';
import { CollisionWorld } from './player/Collision';
import { FirstPersonController } from './player/FirstPersonController';
import { Driving } from './player/Driving';
import { InteractionSystem } from './player/Interaction';
import { AudioDirector } from './audio/AudioDirector';
import { Dialogue } from './mission/Dialogue';
import { MissionDirector } from './mission/Mission';
import { StandingCharacter } from './agents/StandingCharacter';
import { lockupAnchor, nightclubAnchor } from './world/build/interiorProps';
import { CAST } from './story';
import { DamageFeedback } from './ui/DamageFeedback';
import { Hud } from './ui/Hud';
import { LoadingScreen } from './ui/LoadingScreen';
import { Minimap } from './ui/Minimap';
import { PauseMenu, loadSettings } from './ui/PauseMenu';

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

/**
 * Idle and maximum engine speed per powerplant family, matching
 * `Flying.engineRpm`. Only used to normalise for the audio mixer; see the
 * conversion where `onEngine` is wired.
 */
const RPM_RANGE: Readonly<Record<'piston' | 'turboprop' | 'turbofan', { idle: number; max: number }>> =
  {
    piston: { idle: 700, max: 2700 },
    turboprop: { idle: 1000, max: 1900 },
    turbofan: { idle: 5000, max: 22000 },
  };

/** Mid-field, for "how far from the airport am I" in the aircraft mixer. */
const airfieldMidZ = (RUNWAY.northZ + RUNWAY.southZ) * 0.5;

const DISTRICT_NAMES: Readonly<Record<string, string>> = {
  harbourside: 'Harbourside',
  cannery: 'The Cannery',
  oldQuarter: 'Old Quarter',
  core: 'Meridian Core',
  civic: 'Lantern Park',
  ridge: 'Ridge Terraces',
  airport: 'Meridian Bay Regional',
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

  const loading = new LoadingScreen(import.meta.env.BASE_URL);
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

  loading.setProgress(0.70, 'Grading the airfield');
  await nextFrame();
  /*
   * Everything airside in one call: the platform, the runway and its markings,
   * the taxiway, the apron, the terminal shell and its interior, the tower,
   * the hangars, the fence and the lighting.
   *
   * It runs BEFORE `buildEnvironment` for the same reason the street builders
   * do - `buildTerrain` sinks its quads under whatever hard surface the city
   * has already claimed, and the airfield is a very large hard surface.
   *
   * The airport's ROADS are not here. They are ordinary `Street` records in
   * `plan.streets`, so the loops above have already paved them, and the road
   * network, the pavement graph, the signal heads and the minimap pick them up
   * with no special case at all.
   */
  buildAirport(plan, ground, sink);

  loading.setProgress(0.76, 'Dressing the streets');
  await nextFrame();
  scatterStreetProps(plan, sink);
  buildEnvironment(sink, ground);

  loading.setProgress(0.84, 'Loading generated assets');
  await nextFrame();

  const models = new ModelLibrary();
  /*
   * EVERY BLOCKING DOWNLOAD STARTS HERE, TOGETHER.
   *
   * These five groups are independent - a lamp, a fountain, the vehicle fleet,
   * the street furniture and the airside equipment - and they are all needed
   * before `sink.bake`, because baking is what folds their geometry into the
   * chunk instancing. What is NOT allowed is waiting for one before asking for
   * the next: measured cold against the deployed site, the street props and the
   * airport models were awaited one after the other behind the fleet, and 38
   * GLBs arriving in three sequential batches took **43 seconds** to reach the
   * start button. Individual 400 KB files were spending nine and ten seconds
   * queued, which is a connection-count problem and not a bandwidth one.
   *
   * `loadStreetPropModels` and `loadAirportModels` are therefore STARTED here
   * and awaited below, after the geometry that does not depend on them is
   * built.
   */
  const streetModelsPromise = loadStreetPropModels(import.meta.env.BASE_URL);
  const airportModelsPromise = loadAirportModels(import.meta.env.BASE_URL);
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

  const [streetModels, airportModels] = await Promise.all([streetModelsPromise, airportModelsPromise]);

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
  // The airside equipment takes the same route. Both were requested at the top
  // of this block and are already in flight.
  for (const [key, parts] of streetModels.parts) propGeometry.set(key, parts as PropPart[]);
  for (const [key, parts] of airportModels.parts) propGeometry.set(key, parts as PropPart[]);

  loading.setProgress(0.92, 'Baking the city');
  await nextFrame();

  const { group, chunks } = sink.bake(materials, propGeometry);
  engine.scene.add(group);
  engine.scene.add(airportModels.interior);

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
  /*
   * A car knocked out of its lane is integrated as a free body, and a free
   * body needs walls. Without this it still spins, rolls and settles
   * correctly, but it slides through buildings on the way. The sim's own
   * option is optional precisely so every headless test can run without one.
   */
  traffic.setCollision(collision);

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
    // The same boxes `collision` was built from. The controller indexes the
    // ones that carry a `surface` so a footstep on a terminal floor is decided
    // by that floor rather than by the apron underneath the building.
    colliders: sink.colliders,
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
  /*
   * Every crash in the game goes through one place.
   *
   * The simulation resolves the collision and reports it; the audio layer
   * decides what it sounds like. Keeping the two apart is what lets a struck
   * ambient car, the player ramming a bollard and a blast throwing a van all
   * sound like the same physics rather than three unrelated systems.
   */
  traffic.onImpact = (info) => streetAudio.impact(info);

  const interactions = new InteractionSystem(sink.interactions);
  const minimap = new Minimap(plan);
  const parcelsById = new Map<string, Parcel>(plan.parcels.map((p) => [p.id, p]));

  let quality: QualityLevel = 'high';
  const setQuality = (level: QualityLevel): void => {
    quality = level;
    engine.setQuality(level);
    pedestrians.setQuality(level);
    terminal.setQuality(level);
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
      setGamePaused(false);
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
    onSensitivityChange: (radiansPerPixel) => controller.setSensitivity(radiansPerPixel),
    // Drawn on demand rather than every frame: the world is frozen behind the
    // menu, so the map cannot go out of date while it is open.
    onTabChange: (tab) => {
      if (tab === 'map') drawPauseMap();
    },
    onResume: () => {
      pause.hide();
      setGamePaused(false);
      controller.requestPointerLock();
    },
    onMusicToggle: (enabled) => {
      void audio.setMusicEnabled(enabled);
      hud.setMusicEnabled(enabled);
      pause.setMusicEnabled(enabled);
    },
    onQualityChange: setQuality,
  });

  // The look-speed slider persists itself; the controller has to be told once
  // at start-up or the saved value only takes effect after the menu is opened.
  controller.setSensitivity(loadSettings().sensitivity);

  // The Controls tab lists what the player can actually press, including in
  // the air. Passed in rather than imported by the menu, so the UI layer keeps
  // no dependency on the flight model.
  pause.setControlSections([{ title: 'In the air', hints: FLIGHT_CONTROLS }]);

  /*
   * The Map tab shows the same whole-city picture the `M` overlay does.
   *
   * It cannot borrow the overlay itself: that is a full-screen layer at
   * z-index 30 and the pause menu is at 60, so it would be drawn behind the
   * menu. Instead the minimap draws into a canvas the menu owns, sharing the
   * static layer it rasterised once at start-up - so this costs one blit plus
   * the markers, and only on the frame the tab is opened.
   */
  const pauseMap = document.createElement('canvas');
  pauseMap.className = 'mb-pause__mapcanvas';
  pause.mapPanel.append(pauseMap);
  /*
   * Painted whenever the tab actually HAS a box, not when it is asked for.
   *
   * `onTabChange` fires while the outgoing panel is still the laid-out one, so
   * measuring there returns zero and the canvas is sized to nothing. Waiting a
   * frame is not reliable either: a pane that is not compositing delivers no
   * `requestAnimationFrame` at all, and the timer that backs it up can still
   * beat the layout. A `ResizeObserver` fires exactly when the panel gets its
   * size, which is the event this actually depends on - and it covers the
   * window being resized with the map open for free.
   */
  const mapObserver = new ResizeObserver(() => paintPauseMap());
  mapObserver.observe(pause.mapPanel);
  const drawPauseMap = (): void => paintPauseMap();

  function paintPauseMap(): void {
    if (!pause.visible || pause.tab !== 'map') return;
    const box = pause.mapPanel.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    // Fit the city's own aspect inside whatever the tab gives us.
    const aspect = minimap.mapAspect;
    let cssWidth = box.width;
    let cssHeight = cssWidth / aspect;
    if (cssHeight > box.height) {
      cssHeight = box.height;
      cssWidth = cssHeight * aspect;
    }
    pauseMap.style.width = `${Math.round(cssWidth)}px`;
    pauseMap.style.height = `${Math.round(cssHeight)}px`;
    pauseMap.width = Math.max(1, Math.round(cssWidth * ratio));
    pauseMap.height = Math.max(1, Math.round(cssHeight * ratio));
    minimap.drawInto(pauseMap);
  }

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
  /*
   * DOWNLOADS THE PLAYER CANNOT SEE YET.
   *
   * The gun shop's display weapons, the aircraft on the apron, the terminal's
   * travellers and the city's interior furnishings are all real downloads and
   * none of them is visible from the spawn point - the shop is a walk away,
   * the airfield is 600 m south, and an interior is behind a door. Started
   * during the boot they competed with the geometry the first frame actually
   * needs, and with shader compilation, for the same handful of connections.
   *
   * They are queued here and released on the start click instead, so the
   * player is moving while they stream in. Every one of them already degrades
   * to a procedural stand-in if it has not arrived, which is what makes this
   * safe rather than merely faster.
   */
  const afterStart: (() => void)[] = [];

  afterStart.push(() => void shop.load());

  /*
   * The airfield's aircraft, and the one the player can take.
   *
   * Deliberately NOT a twelfth `VehicleKind`. The traffic simulation is lane
   * discipline on a rail with `settleBody` writing `y` from the terrain every
   * frame, and its own tests cap every vehicle at 7.5 m long and 2.3 m wide -
   * so an aeroplane could not be one of them without either breaking those
   * invariants or never leaving the ground. `src/air` is a separate free-body
   * system that shares only the collision world and the ground sampler.
   */
  const aircraft = new AircraftSystem({
    baseUrl: import.meta.env.BASE_URL,
    groundY: (x: number, z: number) => ground.sample(x, z).y,
  });
  engine.scene.add(aircraft.group);
  afterStart.push(() => void aircraft.load());

  const flying = new Flying({
    aircraft,
    collision,
    camera: engine.camera,
    controller,
    domElement: canvas,
    groundY: (x: number, z: number) => ground.sample(x, z).y,
    // Where a pilot may be put down on foot. The bay is in bounds and is not
    // somewhere to step out onto.
    standable: (x: number, z: number) =>
      ground.isInBounds(x, z) && ground.sample(x, z).surface !== 'water',
  });

  /*
   * The aircraft's own noise, translated at the seam.
   *
   * The two layers deliberately disagree about `rpm` and neither is wrong:
   * the flight model reports a REAL engine speed, because a piston at 2,700
   * and a fan at 22,000 are different machines, while the mixer wants a 0..1
   * fraction so one crossfade curve serves all three families. Converting
   * here - rather than making either side speak the other's units - keeps the
   * flight model free of audio concerns and the mixer free of aerodynamics.
   *
   * The ranges are `Flying.engineRpm`'s own, and are asserted below so a
   * change to either side fails a test rather than quietly desaturating the
   * engine note.
   */
  const airAudio = new AircraftAudio(audio);
  flying.onEngine = (info) => {
    const range = RPM_RANGE[AIRCRAFT[info.type].engine];
    airAudio.engine({
      // One aircraft is flown at a time, so the id is a constant; the mixer
      // uses it only to keep a voice attached to the same machine.
      id: 0,
      x: info.x,
      y: info.y,
      z: info.z,
      rpm: (info.rpm - range.idle) / (range.max - range.idle),
      throttle: info.throttle,
      airspeed: info.airspeed,
      type: info.type,
      onGround: info.onGround,
    });
  };
  flying.onTouchdown = (x, y, z, verticalSpeed) => airAudio.touchdown(x, y, z, verticalSpeed);
  flying.onImpact = (x, y, z, severity) => airAudio.impact(x, y, z, severity);

  /*
   * The travellers inside the terminal.
   *
   * A separate system from the street crowd, and it has to be: the pavement
   * graph is built only from street pavements and crossings, `Crowd.project`
   * hard-clamps every agent into its link corridor, and `tests/pedestrians`
   * asserts over three thousand samples that no walkable link is ever inside a
   * building. The city crowd cannot go indoors by construction.
   *
   * It costs nothing until the player is near the building: `update` returns
   * before it simulates and the group is switched off, so the city pays no
   * draw calls and no CPU for it from downtown.
   */
  const terminal = new TerminalCrowd({
    // The walkable floor, inset past the walls.
    region: insetRect(TERMINAL, 1.6),
    // The city's own collider set. It filters to the boxes that matter.
    obstacles: sink.colliders,
    seats: GATE_SEATS,
    queues: TERMINAL_QUEUES,
    floorY: TERMINAL_FLOOR,
    baseUrl: import.meta.env.BASE_URL,
    quality: 'high',
  });
  engine.scene.add(terminal.group);
  afterStart.push(() => void terminal.load());

  const furnishings = new Furnishings(plan, import.meta.env.BASE_URL);
  engine.scene.add(furnishings.group);
  afterStart.push(() => void furnishings.load());

  // -- law and order ---------------------------------------------------------
  const worldRays = new WorldRayIndex(sink.colliders);
  // `removeAt` is what makes a shot civilian actually fall over instead of
  // walking on with the hit merely recorded. Struck and shot people share one
  // `down` state inside the crowd.
  const civilians = new CrowdTargets(pedestrians.group, {
    removeAt: (x: number, y: number, z: number, dirX?: number, dirZ?: number) => {
      // The direction the round was travelling, so a civilian shot in the back
      // falls forwards and one shot in the chest goes over backwards.
      pedestrians.downAt(x, y, z, undefined, dirX, dirZ);
    },
    // A hit that wounded without killing. The crowd's stagger leaves them
    // UPRIGHT and still targetable - a flinch and a stumble along the round's
    // line - which is what makes a wound read differently from a death. The
    // combat layer withheld this until the crowd had an upright reaction to
    // offer, because the earlier one put a grazed pedestrian flat on the
    // pavement and briefly out of reach.
    staggerAt: (x: number, z: number, dirX: number, dirZ: number) => {
      pedestrians.staggerAt(x, z, undefined, dirX, dirZ);
    },
    // Gunfire is an event the crowd hears, not just something that happens to
    // one person. Raised once per trigger pull and once per detonation, and
    // safe for a round that hit nothing at all.
    alarmAt: (x: number, z: number, radius?: number) => {
      pedestrians.alarmAt(x, z, radius);
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
  /*
   * Police cars sound like police cars.
   *
   * A pursuit unit is an ordinary traffic vehicle the police system has taken
   * control of, so without this layer it was voiced by `StreetAudio` as one
   * more car in the street. This gives it its own engine and a siren that is
   * spatial, Doppler-shifted and attenuates with distance - recognisable from
   * a street away without becoming a sound that follows the player around.
   */
  const policeAudio = new PoliceAudio(audio);
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
    // Recoil belongs to whoever owns the camera angles. The controller writes
    // the camera quaternion ABSOLUTELY every frame from its own pitch and yaw,
    // so a kick applied to the camera afterwards was thrown away on the next
    // frame - and, worse, was applied AFTER the shot had already been cast, so
    // the frame the player saw was rotated relative to the bullet that frame.
    recoil: controller,
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
      // The id is captured because the handle is a live VIEW of a pooled
      // rocket: once that slot is reused for a later shot its `live` flag goes
      // true again, and a motor loop matched only on `live` would never stop.
      rocketFlights.push({ rocket, flight, id: rocket.id });
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
  const rocketFlights: { rocket: RocketHandle; flight: FlightSound; id: number }[] = [];

  // -- the job ---------------------------------------------------------------
  // Sable at the bar in The Vibe, and Teo beside the crate in the Cannery
  // lock-up. Both are one instance of a baked character standing still, the
  // same as the gun shop's clerk.
  const dialogue = new Dialogue(audio);
  hud.element.append(dialogue.element);

  const clubParcel = plan.parcels.find((p) => p.interiorKind === 'nightclub') ?? null;
  const lockupParcel = plan.parcels.find((p) => p.interiorKind === 'workshop') ?? null;
  const missionCast: { character: StandingCharacter; id: string }[] = [];
  for (const [parcel, anchorFor, who] of [
    [clubParcel, nightclubAnchor, CAST.sable],
    [lockupParcel, lockupAnchor, CAST.teo],
  ] as const) {
    if (!parcel || !who.character) continue;
    const anchor = anchorFor(parcel);
    if (!anchor) continue;
    const person = new StandingCharacter();
    person.place(anchor);
    engine.scene.add(person.group);
    missionCast.push({ character: person, id: who.character });
  }

  const mission = new MissionDirector({
    plan,
    player,
    dialogue,
    onObjective: (objective) => {
      hud.setObjective(objective.title, objective.detail);
      // The Mission tab is the same objective, readable while paused - which
      // is when a player who has lost the thread actually goes looking.
      pause.setObjective(objective.title, objective.detail);
    },
    onWaypoint: (waypoint) => minimap.setWaypoint(waypoint),
    onBanner: (title, detail) => hud.setBanner(title, detail),
    onPaid: () => audio.playOneShot('ui-tick'),
    // Taking the box takes it: the lock-up's crate stops being drawn the
    // moment the player lifts it, rather than sitting on the bench for the
    // rest of the game. A no-op if the model never downloaded.
    onCrateTaken: () => {
      if (lockupParcel) furnishings.setPieceVisible(lockupParcel.id, 'cashBox', false);
    },
  });

  /*
   * The death rattle goes on BEFORE the respawn director is built.
   *
   * `RespawnDirector` takes whatever `onDeath` it finds, chains it, and
   * installs its own - so assigning here after it was constructed would
   * silently replace the handler that respawns the player, and being killed
   * would leave them lying in the road for good. Nothing may assign to
   * `player.onDeath` below this line.
   */
  player.onDeath = () => combatAudio.death();

  const respawn = new RespawnDirector({
    player,
    spawn: plan.spawn,
    teleport: (x: number, z: number, heading?: number) => controller.teleport(x, z, heading),
    // EVERY seat the player can be in. A pilot killed in the air was left in
    // the aeroplane, and `CombatSystem` hides the weapon and refuses the
    // trigger for as long as it believes the player is in one - so the gun
    // came back owned, equipped and unusable. `exit(true)` is the forced
    // dismount: `Flying.exit()` refuses in the air, which is right for a
    // living player pressing a key and wrong for a corpse.
    mounts: [
      { occupied: () => driving.driving, exit: () => driving.exit() },
      {
        occupied: () => flying.flying,
        exit: () => {
          flying.exit(true);
        },
      },
    ],
    setPaused: (paused: boolean) => controller.setPaused(paused),
    onBanner: (title: string | null, detail: string) => hud.setBanner(title, detail),
    onBust: () => {
      police.standDown();
      combat.reset();
      combatAudio.reset();
      damageFeedback.reset();
      // Whoever was talking stops, and the job backs up to the point where it
      // will offer that conversation again. Always the two together: cutting
      // the dialogue alone would strand the director in a stage only the
      // dropped callback could leave. See `MissionDirector.interrupt`.
      dialogue.cut();
      mission.interrupt();
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

  interactions.onActivate = ({ point }) => {
    // The mission gets first refusal: the bar and the lock-up crate are
    // ordinary interaction points that mean different things depending on what
    // the player has been asked to do.
    if (mission.activate(point.id)) return;
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

  controller.onFootstep = (step) => {
    // A driver has no feet on the pavement, and neither does a pilot. The
    // controller is paused in both, but its velocity DAMPS to zero rather than
    // snapping there, so it can still cross the footstep threshold for a
    // moment after getting in - which is audible as walking while seated.
    if (driving.driving || flying.flying) return;
    /*
     * The event already carries the AUTHORITATIVE surface and, where the world
     * tagged one, the material of the floor under the sole. Nothing here may
     * re-derive it: the `onRoad` flag this used to sample and pass down was a
     * second guess at something the world already knew, and a dead one - swept
     * over the map, none of the 28,875 carriageway points needed it.
     */
    audio.footstep(step);
  };

  // -- pause / pointer lock --------------------------------------------------

  /**
   * The one place the game stops, and the one place it starts again.
   *
   * `Engine.setPaused` is the whole of it for the simulation: every system in
   * this file is driven from `engine.onUpdate`, so not calling it freezes
   * physics, traffic, the crowd, aircraft, projectiles, mission timers,
   * animation and the audio listener together, and no system needs to know a
   * pause exists. The engine keeps RENDERING, so the world stays on screen
   * behind the menu without advancing, and it holds its simulation clock still
   * - which matters because the traffic signals and pedestrian crossings phase
   * off that clock as an ABSOLUTE time, so handing them wall-clock seconds
   * after a two-minute pause would jump every light in the city on the first
   * resumed frame.
   *
   * The controller is paused as well, because it owns pointer-lock look and
   * would otherwise keep turning the camera from a mouse the menu is using.
   */
  const setGamePaused = (paused: boolean): void => {
    engine.setPaused(paused);
    controller.setPaused(paused);
    audio.setGamePaused(paused);
    hud.setPointerLocked(paused ? false : document.pointerLockElement === canvas);
  };

  const showPause = (): void => {
    if (pause.visible) return;
    pause.show();
    setGamePaused(true);
    if (pause.tab === 'map') drawPauseMap();
  };

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    hud.setPointerLocked(locked);
    // Losing the lock only pauses if the lock was actually in use; an
    // environment that never grants it must stay playable.
    if (!locked && hadPointerLock && !shop.open) showPause();
    if (locked) {
      hadPointerLock = true;
      // Regaining the lock must NOT restart the world on its own. The menu is
      // the only thing that may do that, through its Resume or its close
      // button - otherwise a stray click behind the overlay silently unpauses
      // a game the player is still reading.
      if (!pause.visible) setGamePaused(false);
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
      if (flying.flying) {
        // Refuses in the air and while still rolling; the player stays put
        // and the prompt keeps saying so.
        if (flying.exit()) traffic.setPlayerIsObstacle(true);
        return;
      }
      if (!interactions.focused) {
        const at = controller.state;
        if (driving.tryEnter(at.x, at.z)) return;
        // An aircraft last: a car parked on the apron is the nearer thing and
        // should still win.
        if (flying.tryEnter(at.x, at.z)) traffic.setPlayerIsObstacle(false);
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
    // Before the aircraft system and before anything reads the camera: the
    // flight model poses the camera boom, and the systems that stream around
    // the viewer have to follow the aeroplane, not the body left on the apron.
    flying.update(dt);
    const walkState = controller.state;
    const drive = driving.state;
    const air = flying.state;
    // While driving, the car IS the player as far as the rest of the game is
    // concerned: the camera, the audio listener, the minimap and the systems
    // that stream around the viewer all follow it.
    const state = air.flying
      ? { ...walkState, x: air.x, y: air.y, z: air.z, yaw: air.yaw, speed: air.groundSpeed }
      : drive.driving
        ? {
            ...walkState,
            x: drive.x,
            y: drive.y,
            z: drive.z,
            yaw: drive.yaw,
            speed: Math.abs(drive.speed),
          }
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
      // Where the player is LOOKING, so people are spawned and retired behind
      // them. Without it the crowd falls back to smoothed player drift, which
      // is zero when somebody stands still - exactly when a pop is most
      // visible.
      forwardX: -Math.sin(state.yaw),
      forwardZ: -Math.cos(state.yaw),
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
      // A pilot is no more arrestable on foot than a driver is.
      driving: drive.driving || air.flying,
    });
    combat.update(dt, {
      // Flying counts as driving here. `CombatSystem` uses this flag to put
      // the viewmodel away and refuse the trigger, and both are just as right
      // in a cockpit as behind a wheel - there are no hands free either way.
      driving: drive.driving || air.flying,
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
    dialogue.update(dt);
    mission.update(dt, {
      x: state.x,
      y: state.y,
      z: state.z,
      // Only when actually in an aircraft. The mission's flying stages test
      // for the presence of this, so handing it a resting object on foot
      // would let somebody "land" by standing still on the apron.
      flight: air.flying
        ? { altitude: air.altitudeAgl, speed: air.groundSpeed, onGround: air.onGround }
        : undefined,
    });
    for (const person of missionCast) person.character.update(dt);
    damageFeedback.update(dt, {
      health: player.health / MAX_HEALTH,
      alive: player.alive,
      yaw: state.yaw,
      x: state.x,
      z: state.z,
    });

    aircraft.update(dt, state.x, state.z);
    airAudio.update(dt, {
      x: state.x,
      y: state.y,
      z: state.z,
      indoors: state.indoors,
      inCockpit: air.flying,
      airfieldDistance: Math.hypot(state.x - RUNWAY.centreX, state.z - airfieldMidZ),
    });

    terminal.update(dt, { x: state.x, y: state.y, z: state.z, time: elapsed });
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
      if (entry.rocket.live && entry.rocket.id === entry.id) {
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

    policeAudio.update(dt, {
      x: state.x,
      y: state.y,
      z: state.z,
      indoors: state.indoors,
      // Reused scratch, consumed inside this call and never retained.
      units: police.pursuitAudio,
    });

    // Chunk visibility is cheap but pointless to recompute every frame.
    chunkTimer += dt;
    if (chunkTimer > 0.25) {
      chunkTimer = 0;
      updateChunks(chunks, state.x, state.z, quality, air.flying ? air.altitudeAgl : 0);
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

    // The contextual flight controls: up on boarding, held while the aeroplane
    // is stopped or jammed, faded once it is under way. `Flying` decides,
    // because it is the only thing that knows which of those is true.
    hud.setFlightHints(flying.hintState);

    // One place decides the prompt, so a door and a car can never fight over it.
    if (air.flying) {
      hud.setInteractionPrompt(
        air.onGround && air.groundSpeed < 1.5
          ? 'Press E to get out'
          : `${Math.round(air.airspeed * 1.94384)} kt · ${Math.round(air.altitudeAgl)} m`,
      );
    } else if (drive.driving) {
      hud.setInteractionPrompt('Press E to get out');
    } else if (interactions.focused) {
      // A mission override of '' means "say nothing here right now", which is
      // different from null: null hands the point's own prompt back.
      const override = mission.promptFor(interactions.focused.id);
      hud.setInteractionPrompt(override === null ? interactions.focused.prompt : override || null);
    } else {
      const car = driving.candidateAt(state.x, state.z);
      if (car) {
        hud.setInteractionPrompt(`Press E to drive the ${car.kind}`);
      } else {
        // `Flying` words this one, so the airliner says why it cannot be
        // taken instead of showing nothing at all.
        hud.setInteractionPrompt(flying.promptAt(state.x, state.z));
      }
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

  // The queue above, released now that nothing is racing the first frame.
  for (const start of afterStart) start();

  // The start click is the user gesture that lets us create the AudioContext.
  // Music stays off; only ambience and effects come up here.
  await audio.unlock();
  // Gunfire has to be resident before the first trigger pull, not fetched
  // after it: a shot whose sound arrives 300 ms late reads as no sound at all.
  combatAudio.preload();
  // A line of dialogue that arrives after the subtitle has gone is worse than
  // no line at all, so every recording is decoded before the first one plays.
  dialogue.preload();
  for (const person of missionCast) void person.character.load(person.id);
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
    policeAudio.dispose();
    damageFeedback.dispose();
    dialogue.dispose();
    mapObserver.disconnect();
    mission.dispose();
    for (const person of missionCast) person.character.dispose();
    shop.dispose();
    terminal.dispose();
    airportModels.dispose();
    furnishings.dispose();
    combat.dispose();
    police.dispose();
    flying.dispose();
    aircraft.dispose();
    airAudio.dispose();
    for (const chunk of chunks) chunk.dispose();
  });

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
      /**
       * What the mixer last actually PLAYED, for automated QA.
       *
       * The surface a footstep resolves to is already assertable headless, and
       * has been for two workstreams - and the road still sounded like grass,
       * because the classification and the recording are different questions.
       * This is the only way to answer the second one from a browser: it names
       * the asset file that came out of the speakers, not the family the rule
       * chose, so "walking on a road plays `steps/asphalt-*`" is a measurement
       * rather than an inference.
       */
      get audio(): unknown {
        return audio.debug;
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
      /**
       * Drives real frames outside `requestAnimationFrame`, and says how many
       * of them the world actually advanced through. A backgrounded or
       * non-compositing pane delivers no rAF at all, so this is the only way
       * to measure the simulation from a browser harness - and the returned
       * count is what makes a pause provable rather than merely plausible.
       */
      step(frames = 60, dt = 1 / 60): number {
        let advanced = 0;
        for (let i = 0; i < frames; i += 1) if (engine.stepOnce(dt)) advanced += 1;
        return advanced;
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
          // What the combat layer can actually SEE of the crowd. Without this a
          // shot that hits nobody is indistinguishable from a crowd the shot
          // path cannot reach at all, which is a difference worth one line.
          civilians: {
            live: civilians.liveCount,
            prone: civilians.proneCount,
            tracked: civilians.trackedCount,
          },
          shopOpen: shop.open,
          rockets: combat.rocketsLive,
          // Live effect pools. A blast is supposed to be bounded, and the only
          // way to see that from a browser is to watch these stop climbing.
          fx: combat.effects.stats,
          viewmodelReady: combat.viewmodelReady,
          // Which weapon the viewmodel is actually holding, so a QA pass can
          // tell "still downloading" from "the gun is gone".
          viewmodelWeapon: combat.viewmodelWeapon,
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
        /**
         * Sets a warhead off at a point, with no launcher and no flight.
         *
         * The real `detonate` the rocket calls, so what it does to the cars,
         * the crowd and the effect pools is the shipped behaviour and not a
         * mock. It takes no surface - a rocket that flew there would have
         * carried one - so the scorch falls to the ground under it, which is
         * exactly what an air burst does.
         */
        explode(x: number, y: number, z: number): void {
          combat.detonate(x, y, z);
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
      /**
       * Vehicles near a point, with the fields that say whether one has been
       * hit: where it is, which way it is facing, how bent it is, and whether
       * it is still driving itself. Allocates, so it is for verification only
       * and never for the frame loop.
       */
      vehiclesNear(x: number, z: number, radius = 30): unknown[] {
        const found: unknown[] = [];
        traffic.forEachNear(x, z, radius, (view) => {
          found.push({
            id: view.id,
            kind: view.kind,
            x: view.x,
            y: view.y,
            z: view.z,
            yaw: view.yaw,
            speed: view.speed,
            control: view.control,
            integrity: view.integrity,
            damage: view.damage,
            overturned: view.overturned,
            // `control` still publishes the old three values so the audio and
            // police layers read it unchanged; `state` is what distinguishes a
            // car the player parked from one that is merely driverless.
            state: view.state,
            destroyed: view.destroyed,
            // The damage STAGE, which is the legible form of `damage`:
            // pristine, scuffed, damaged, crippled, wrecked. `destroyed` only
            // says whether the last stage was reached, so without this a QA
            // pass cannot tell a car that took a parking shunt from one that
            // is a crash away from being written off.
            condition: view.condition,
            regions: view.regions,
            handling: view.handling,
          });
        });
        return found;
      },
      /**
       * Every surface mark currently on the world, for automated QA.
       *
       * Where each decal is, which way it faces and how big it is - the only
       * way to check from a browser that a bullet hole is ON the wall that was
       * shot and lying in that wall's plane, rather than floating in front of
       * it or buried behind it. Allocates, so it is for verification only.
       */
      impactMarks(): unknown[] {
        return combat.effects.markReport();
      },
      /** Live crowd state, for automated QA. */
      get crowd(): unknown {
        return pedestrians.stats;
      },
      /**
       * Civilians near a point AS COMBAT SEES THEM, which is not the same list
       * as the crowd's own: this one is harvested from the drawn instance
       * matrices. Allocates, so it is for verification only. The same shape as
       * `vehiclesNear` and for the same reason - aiming at somebody is
       * otherwise guesswork from a harness with no pointer.
       */
      civiliansNear(x: number, z: number, radius = 30): unknown[] {
        const found: unknown[] = [];
        civilians.forEachActor(x, z, radius, (target) => {
          found.push({
            id: target.id,
            x: target.x,
            y: target.y,
            z: target.z,
            radius: target.radius,
            height: target.height,
          });
        });
        return found;
      },
      /**
       * Aircraft and flight, for automated QA.
       *
       * `place(type, x, z, heading?, altitude?)` puts the player in a trimmed
       * cruise at an altitude, so an airborne check does not have to fly a
       * take-off first - the same reason `look` exists for the camera.
       */
      air: airQaSection(aircraft, flying),
      /** Airport terminal population, for automated QA. */
      get travellers(): unknown {
        return terminal.stats;
      },
      /** Whether the world is currently frozen behind a menu. */
      get paused(): boolean {
        return engine.isPaused;
      },
      /**
       * Simulated seconds. Frozen while paused, which is the cheapest way for
       * a test to PROVE the pause rather than eyeballing a screenshot.
       */
      get simulatedTime(): number {
        return engine.simulatedTime;
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
  altitude = 0,
): void {
  // Fog swallows the far side of the city, so chunks past the fade distance can
  // stop submitting draw calls entirely.
  const base = quality === 'low' ? 260 : quality === 'medium' ? 340 : 460;
  /*
   * ALTITUDE HAS TO WIDEN THIS.
   *
   * `distanceTo` is a plan-view distance, which is right for somebody walking
   * down a street with buildings either side of them and wrong the moment they
   * are looking down at the city from a thousand feet: at ground level a chunk
   * 500 m away is behind fog and behind other buildings, and from the air it
   * is the middle of the view. Leaving the range alone made the world switch
   * itself off in a ring around the aircraft.
   *
   * A straight sum rather than anything cleverer: the horizon really does grow
   * about linearly with height at these distances, and the cost is bounded
   * because the whole city is a handful of merged chunks - at 300 m every one
   * of them is drawn, which is the intended answer.
   */
  const visibleRange = base + Math.min(altitude, 400) * 2.6;
  // Shadows are not widened. A shadow map stretched over the whole city is
  // pure blur, and nothing casting one is legible from that height anyway.
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
