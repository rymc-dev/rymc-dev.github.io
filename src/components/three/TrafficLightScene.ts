import * as THREE from 'three';
import { COLORS, addEdges, addFloor, makeLabel, runStage } from './stage';

// Model parameters, matching hybrid_automatons/traffic_lights.py
const DT = 0.01; // the example's delta_time
const SIM_SPEED = 12; // "as fast as possible", capped so it stays readable
const RING_SEGMENTS = 64;
const PANEL_HZ = 15; // text panel redraws per second

type Mode = 'RED' | 'GREEN' | 'YELLOW';
type ConfigKey = 'time_in_red' | 'time_in_green' | 'time_in_yellow';

interface Transition {
  name: string;
  guardName: string;
  from: Mode;
  to: Mode;
  configKey: ConfigKey;
  priority: number;
}

const LAMP_COLOR: Record<Mode, number> = {
  RED: 0xff3b5c,
  YELLOW: COLORS.yellow,
  GREEN: 0x3bff9d,
};
const MUTED = 0x8a8aa3;

/**
 * The traffic-lights hybrid automaton from the hybrid-automaton package. It has
 * no continuous state at all: every guard reads ctx.clock, which the runtime
 * maintains. The panels show that RuntimeContext and each guard's live value.
 * Pointer X sets time_in_green; click switches simulation / real-time clock.
 */
export function mount(canvas: HTMLCanvasElement): () => void {
  return runStage(canvas, ({ scene, camera, reducedMotion }) => {
    const labels: THREE.Texture[] = [];
    const frame = (aspect: number) => {
      // pull back on narrow viewports so the light and the panels both fit
      const dist = 7.2 * Math.max(1, 1.9 / aspect);
      camera.position.set(0, 1.9 + (dist - 7.2) * 0.15, dist);
      camera.lookAt(0, 1.55, 0);
    };
    frame(camera.aspect);

    scene.add(new THREE.AmbientLight(0x6070ff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(3, 6, 4);
    scene.add(key);
    addFloor(scene);

    // --- the automaton ---
    const configuration: Record<ConfigKey, number> = {
      time_in_red: 5.0,
      time_in_green: 8.0,
      time_in_yellow: 3.0,
    };
    const transitions: Transition[] = [
      { name: 'red_to_green', guardName: 'red_to_green_guard', from: 'RED', to: 'GREEN', configKey: 'time_in_red', priority: 1 },
      { name: 'green_to_yellow', guardName: 'green_to_yellow_guard', from: 'GREEN', to: 'YELLOW', configKey: 'time_in_green', priority: 1 },
      { name: 'yellow_to_red', guardName: 'yellow_to_red_guard', from: 'YELLOW', to: 'RED', configKey: 'time_in_yellow', priority: 1 },
    ];

    // the slice of RuntimeContext this automaton touches
    const clock = { elapsedTimeActive: 0, timeElapsedSinceTransition: 0 };
    let mode: Mode = 'RED';
    let transitionsCount = 0;
    let totalSteps = 0;
    let realTime = false;
    let lastPing = -Infinity; // wall-clock seconds, for highlighting the reset

    const guard = (tr: Transition) => clock.timeElapsedSinceTransition >= configuration[tr.configKey];

    // _Runtime._evaluation_step with no flow and no continuous state is just the
    // guard check; the repo's clock is its own asyncio task, here it ticks once per step
    const step = (wallT: number) => {
      const active = transitions.filter((tr) => tr.from === mode && guard(tr));
      if (active.length) {
        mode = active.reduce((a, b) => (b.priority < a.priority ? b : a)).to;
        clock.timeElapsedSinceTransition = 0; // clock.ping_transition()
        transitionsCount++;
        lastPing = wallT;
      }
      totalSteps++;
      clock.elapsedTimeActive += DT; // clock.step_dt()
      clock.timeElapsedSinceTransition += DT;
    };
    let pending = 0;
    const advance = (seconds: number, wallT: number) => {
      pending += seconds;
      while (pending >= DT) {
        step(wallT);
        pending -= DT;
      }
    };

    // --- traffic light ---
    const light = new THREE.Group();
    light.position.set(-2.7, 0, 0);
    scene.add(light);
    const steel = new THREE.MeshStandardMaterial({ color: COLORS.steel, metalness: 0.6, roughness: 0.4 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.6, 8), steel);
    pole.position.y = 0.8;
    addEdges(pole, COLORS.cyan);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.7, 0.4), steel);
    housing.position.y = 2.35;
    addEdges(housing, COLORS.cyan);
    light.add(pole, housing);

    const LAMP_Y: Record<Mode, number> = { RED: 2.88, YELLOW: 2.35, GREEN: 1.82 };
    const lamps = {} as Record<Mode, THREE.MeshStandardMaterial>;
    for (const m of Object.keys(LAMP_Y) as Mode[]) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x111118, emissive: LAMP_COLOR[m], emissiveIntensity: 0.06 });
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.2, 24), mat);
      lamp.position.set(0, LAMP_Y[m], 0.205);
      light.add(lamp);
      lamps[m] = mat;
    }
    const glow = new THREE.PointLight(LAMP_COLOR.RED, 4, 4);
    light.add(glow);

    // dwell-timer ring: time_elapsed_since_transition / time_in_<mode>
    const ringMat = new THREE.MeshBasicMaterial({ color: LAMP_COLOR.RED, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
    const ringGeo = new THREE.RingGeometry(0.25, 0.29, RING_SEGMENTS, 1, Math.PI / 2, Math.PI * 2);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.scale.x = -1; // run clockwise
    light.add(ring);

    // --- panels ---
    const ctxPanel = makeLabel(1024, 500, 2.05);
    ctxPanel.sprite.position.set(1.15, 2.45, 0);
    scene.add(ctxPanel.sprite);
    labels.push(ctxPanel.texture);
    const guardPanel = makeLabel(1024, 290, 1.2);
    guardPanel.sprite.position.set(1.15, 0.62, 0);
    scene.add(guardPanel.sprite);
    labels.push(guardPanel.texture);

    const row = (k: string, v: string, width = 32) => `${k.padEnd(width)}${v}`;
    let nextPanel = 0;
    const drawPanels = (wallT: number) => {
      const fresh = wallT - lastPing < 0.8;
      ctxPanel.draw(
        [
          ['ctx: RuntimeContext', COLORS.cyan],
          [row('discrete_state', mode), LAMP_COLOR[mode]],
          [row('continuous_state', 'None'), MUTED],
          ['configuration', COLORS.cyan],
          ...(Object.keys(configuration) as ConfigKey[]).map(
            (k) => [row(`  ${k}`, `${configuration[k].toFixed(1)} s`), k === 'time_in_green' ? COLORS.yellow : 0xe6e6f0] as [string, number],
          ),
          [`clock  (${realTime ? 'real-time' : 'simulation'} · dt ${DT})`, COLORS.cyan],
          row('  get_elapsed_time_active()', `${clock.elapsedTimeActive.toFixed(2)} s`),
          [
            row('  get_time_elapsed_since_transition()', `${clock.timeElapsedSinceTransition.toFixed(2)} s`, 40),
            fresh ? COLORS.yellow : 0xe6e6f0,
          ],
          row('transitions_count', `${transitionsCount}`),
          row('total_steps', `${totalSteps}`),
        ],
        0xe6e6f0,
        30,
        'left',
      );
      guardPanel.draw(
        [
          [`guards evaluated in ${mode}`, COLORS.cyan],
          ...transitions.flatMap((tr): [string, number][] => {
            if (tr.from !== mode) return [[`${tr.guardName}  (not evaluated)`, MUTED]];
            const v = guard(tr);
            return [
              [tr.guardName, 0xe6e6f0],
              [
                `  ${clock.timeElapsedSinceTransition.toFixed(2)} >= ${tr.configKey} (${configuration[tr.configKey].toFixed(1)})  →  ${v ? 'True' : 'False'}`,
                v ? 0x3bff9d : COLORS.magenta,
              ],
            ];
          }),
        ],
        0xe6e6f0,
        30,
        'left',
      );
    };

    // --- pointer input: X sets time_in_green, click switches clocks ---
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const u = THREE.MathUtils.clamp((e.clientX - r.left) / r.width, 0, 1);
      configuration.time_in_green = Math.round((2 + u * 10) * 2) / 2;
    };
    const onDown = (e: PointerEvent) => {
      onMove(e);
      realTime = !realTime;
    };
    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerdown', onDown);

    // reduced motion: settle partway through a GREEN phase
    if (reducedMotion) advance(configuration.time_in_red + 3, 0);

    return {
      update(t, dt) {
        if (!reducedMotion) advance(dt * (realTime ? 1 : SIM_SPEED), t);
        frame(camera.aspect);

        for (const m of Object.keys(lamps) as Mode[]) lamps[m].emissiveIntensity = m === mode ? 1.6 : 0.06;
        glow.color.setHex(LAMP_COLOR[mode]);
        glow.position.set(0, LAMP_Y[mode], 0.6);

        const tr = transitions.find((x) => x.from === mode)!;
        const k = THREE.MathUtils.clamp(clock.timeElapsedSinceTransition / configuration[tr.configKey], 0, 1);
        ringGeo.setDrawRange(0, Math.ceil(k * RING_SEGMENTS) * 6);
        ringMat.color.setHex(LAMP_COLOR[mode]);
        ring.position.set(0, LAMP_Y[mode], 0.21);

        if (t >= nextPanel || reducedMotion) {
          nextPanel = t + 1 / PANEL_HZ;
          drawPanels(t);
        }
      },
      dispose() {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerdown', onDown);
        labels.forEach((tex) => tex.dispose());
      },
    };
  });
}
