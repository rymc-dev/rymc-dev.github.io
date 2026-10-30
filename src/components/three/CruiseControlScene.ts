import * as THREE from 'three';
import { COLORS, addEdges, addFloor, makeLabel, runStage } from './stage';

// Model parameters, matching hybrid_automatons/cruise_control.py
const TARGET_SPEED = 30.0;
const SAFE_DISTANCE = 50.0;
const DANGER_CLOSE = 20.0;
const DT = 0.01; // the example's delta_time
// the example starts at distance 0, which drops straight into EMERGENCY_BRAKE
const X0: X = [5.0, 80.0];
const TIME_SCALE = 2; // simulated seconds per real second

// Scene layout
const S = 0.05; // metres of gap -> scene units
const EGO_X = -3.6;
const CAR_L = 0.9;
const PHASE_SECONDS = 60;
const PHASE_RATE = 10; // samples per simulated second
const PHASE_N = PHASE_SECONDS * PHASE_RATE;
const GAP_MAX = 250;

type Mode = 'ACCELERATE' | 'CRUISE' | 'BRAKE' | 'EMERGENCY_BRAKE';
type X = [v: number, dist: number];

interface Transition {
  name: string;
  from: Mode;
  to: Mode;
  guard: (x: X) => boolean;
  priority: number;
}

const GREEN = 0x3bff9d;
const MODE_COLOR: Record<Mode, number> = {
  ACCELERATE: COLORS.cyan,
  CRUISE: GREEN,
  BRAKE: COLORS.yellow,
  EMERGENCY_BRAKE: COLORS.magenta,
};

/**
 * The cruise-control hybrid automaton from the hybrid-automaton package: four
 * modes, nine prioritised transitions and a 2-D state x = [v, dist] to a lead
 * car. Pointer X sets the lead car's speed. Shows the road, the mode graph and
 * the (dist, v) phase portrait.
 */
export function mount(canvas: HTMLCanvasElement): () => void {
  return runStage(canvas, ({ scene, camera, reducedMotion }) => {
    const labels: THREE.Texture[] = [];
    const frame = (aspect: number) => {
      // pull back on narrow viewports so the road and the panels both fit
      const dist = 8.2 * Math.max(1, 1.9 / aspect);
      camera.position.set(1.2, 3.0 + (dist - 8.2) * 0.2, dist);
      camera.lookAt(1.2, 1.3, -0.8);
    };
    frame(camera.aspect);

    scene.add(new THREE.AmbientLight(0x6070ff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(3, 6, 4);
    scene.add(key);
    const rim = new THREE.PointLight(COLORS.magenta, 6, 10);
    rim.position.set(-3, 2, -2);
    scene.add(rim);
    addFloor(scene, 24);

    // --- the automaton ---
    let carAheadSpeed = 20.0;
    const reachedTargetSpeed = ([v]: X) => Math.abs(v - TARGET_SPEED) < 0.5;
    const belowTargetSpeed = ([v, d]: X) => v < TARGET_SPEED - 1.0 && d > SAFE_DISTANCE;
    const tooClose = ([, d]: X) => d < SAFE_DISTANCE;
    const dangerouslyClose = ([, d]: X) => d < DANGER_CLOSE;
    const safeDistanceRestored = ([, d]: X) => d > SAFE_DISTANCE + 10.0;

    const transitions: Transition[] = [
      { name: 'reach_cruise', from: 'ACCELERATE', to: 'CRUISE', guard: reachedTargetSpeed, priority: 1 },
      { name: 'acc_to_brake', from: 'ACCELERATE', to: 'BRAKE', guard: tooClose, priority: 2 },
      { name: 'acc_to_emergency', from: 'ACCELERATE', to: 'EMERGENCY_BRAKE', guard: dangerouslyClose, priority: 3 },
      { name: 'cruise_to_brake', from: 'CRUISE', to: 'BRAKE', guard: tooClose, priority: 1 },
      { name: 'cruise_to_emergency', from: 'CRUISE', to: 'EMERGENCY_BRAKE', guard: dangerouslyClose, priority: 2 },
      { name: 'cruise_to_acc', from: 'CRUISE', to: 'ACCELERATE', guard: belowTargetSpeed, priority: 3 },
      { name: 'brake_to_emergency', from: 'BRAKE', to: 'EMERGENCY_BRAKE', guard: dangerouslyClose, priority: 1 },
      { name: 'brake_to_cruise', from: 'BRAKE', to: 'CRUISE', guard: safeDistanceRestored, priority: 2 },
      { name: 'emergency_to_brake', from: 'EMERGENCY_BRAKE', to: 'BRAKE', guard: safeDistanceRestored, priority: 1 },
    ];
    const closing = (v: number) => -(v - carAheadSpeed);
    const flows: Record<Mode, (x: X) => X> = {
      ACCELERATE: ([v]) => [v < TARGET_SPEED ? 2.0 : 0.0, closing(v)],
      CRUISE: ([v]) => [0.0, closing(v)],
      BRAKE: ([v]) => [v > 0 ? -1.5 : 0.0, closing(v)],
      EMERGENCY_BRAKE: ([v]) => [v > 0 ? -5.0 : 0.0, closing(v)],
    };

    let mode: Mode = 'ACCELERATE';
    let x: X = [...X0];
    let simT = 0;
    let travelled = 0;
    let nextSample = 0;
    let lastFired: Transition | null = null;
    let competing = 0;

    // --- road ---
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 1.6),
      new THREE.MeshStandardMaterial({ color: COLORS.steel, metalness: 0.3, roughness: 0.8 }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(1, 0.005, 0);
    scene.add(road);
    for (const z of [-0.8, 0.8]) {
      const edge = new THREE.Mesh(
        new THREE.BoxGeometry(26, 0.02, 0.03),
        new THREE.MeshBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.6 }),
      );
      edge.position.set(1, 0.02, z);
      scene.add(edge);
    }
    const DASH_GAP = 1.0;
    const dashes = new THREE.Group();
    scene.add(dashes);
    for (let i = 0; i < 28; i++) {
      const d = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.02, 0.05),
        new THREE.MeshBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.35 }),
      );
      d.position.set(-12 + i * DASH_GAP, 0.02, 0);
      dashes.add(d);
    }

    // danger and safe-distance zones, measured from the ego car's front bumper
    const zone = (from: number, to: number, color: number) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry((to - from) * S, 1.5),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(EGO_X + CAR_L / 2 + ((from + to) / 2) * S, 0.012, 0);
      scene.add(m);
      return m.material;
    };
    const dangerZone = zone(0, DANGER_CLOSE, COLORS.magenta);
    const safeZone = zone(DANGER_CLOSE, SAFE_DISTANCE, COLORS.yellow);

    // --- cars ---
    const car = (edge: number) => {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({
        color: COLORS.steel,
        metalness: 0.6,
        roughness: 0.4,
        emissive: edge,
        emissiveIntensity: 0.05,
      });
      const body = new THREE.Mesh(new THREE.BoxGeometry(CAR_L, 0.22, 0.5), mat);
      body.position.y = 0.2;
      addEdges(body, edge);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(CAR_L * 0.5, 0.16, 0.42), mat);
      cabin.position.set(-0.05, 0.39, 0);
      addEdges(cabin, edge);
      g.add(body, cabin);
      const wheels: THREE.Mesh[] = [];
      for (const [wx, wz] of [
        [-0.3, -0.26],
        [-0.3, 0.26],
        [0.3, -0.26],
        [0.3, 0.26],
      ]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 10), mat);
        w.rotation.x = Math.PI / 2;
        w.position.set(wx, 0.09, wz);
        addEdges(w, edge);
        g.add(w);
        wheels.push(w);
      }
      scene.add(g);
      return { g, mat, wheels };
    };
    const ego = car(COLORS.cyan);
    ego.g.position.x = EGO_X;
    const lead = car(COLORS.magenta);

    // mode beacon on the ego car's roof
    const beaconMat = new THREE.MeshBasicMaterial({ color: COLORS.cyan });
    const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), beaconMat);
    beacon.position.set(-0.05, 0.6, 0);
    ego.g.add(beacon);

    // --- mode graph (back right) ---
    const graph = new THREE.Group();
    graph.position.set(3.4, 2.3, -2.6);
    scene.add(graph);
    const NODE_POS: Record<Mode, THREE.Vector3> = {
      ACCELERATE: new THREE.Vector3(-1.1, 0, 0),
      CRUISE: new THREE.Vector3(0, 0.85, 0),
      BRAKE: new THREE.Vector3(1.1, 0, 0),
      EMERGENCY_BRAKE: new THREE.Vector3(0, -0.85, 0),
    };
    const nodes = {} as Record<Mode, { mat: THREE.MeshStandardMaterial; mesh: THREE.Mesh }>;
    for (const m of Object.keys(NODE_POS) as Mode[]) {
      const mat = new THREE.MeshStandardMaterial({
        color: COLORS.steel,
        metalness: 0.6,
        roughness: 0.4,
        emissive: MODE_COLOR[m],
        emissiveIntensity: 0.05,
      });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.07, 8), mat);
      mesh.rotation.x = Math.PI / 2; // face the camera
      addEdges(mesh, MODE_COLOR[m]);
      mesh.position.copy(NODE_POS[m]);
      graph.add(mesh);
      nodes[m] = { mat, mesh };

      const label = makeLabel(320, 56, 0.16);
      label.draw([m === 'EMERGENCY_BRAKE' ? 'EMERGENCY' : m], MODE_COLOR[m], 30);
      const below = m !== 'CRUISE';
      label.sprite.position.copy(NODE_POS[m]).add(new THREE.Vector3(0, below ? -0.33 : 0.33, 0));
      graph.add(label.sprite);
      labels.push(label.texture);
    }

    // curved edges; bending to the right of travel keeps paired edges apart
    const edges = transitions.map((tr) => {
      const a = NODE_POS[tr.from];
      const b = NODE_POS[tr.to];
      const dir = b.clone().sub(a);
      const bend = new THREE.Vector3(dir.y, -dir.x, 0).setLength(0.16);
      const curve = new THREE.QuadraticBezierCurve3(a, a.clone().lerp(b, 0.5).add(bend), b);
      const mat = new THREE.LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.3 });
      graph.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)), mat));
      const pulse = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.05),
        new THREE.MeshBasicMaterial({ color: COLORS.yellow, transparent: true, opacity: 0 }),
      );
      graph.add(pulse);
      return { curve, mat, pulse, age: Infinity };
    });

    // --- (dist, v) phase portrait (back left) ---
    const PW = 3.6;
    const PH = 1.9;
    const phase = new THREE.Group();
    phase.position.set(-3.9, 1.25, -2.6);
    scene.add(phase);
    const px = (d: number) => (THREE.MathUtils.clamp(d, 0, GAP_MAX) / GAP_MAX) * PW;
    const py = (v: number) => (THREE.MathUtils.clamp(v, 0, 32) / 32) * PH;
    const lineMat = (color: number, opacity: number) =>
      new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const seg = (pts: [number, number][], mat: THREE.LineBasicMaterial) =>
      phase.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(([a, b]) => new THREE.Vector3(a, b, 0))), mat));
    seg(
      [
        [0, PH],
        [0, 0],
        [PW, 0],
      ],
      lineMat(COLORS.cyan, 0.3),
    );
    seg(
      [
        [px(DANGER_CLOSE), 0],
        [px(DANGER_CLOSE), PH],
      ],
      lineMat(COLORS.magenta, 0.35),
    );
    seg(
      [
        [px(SAFE_DISTANCE), 0],
        [px(SAFE_DISTANCE), PH],
      ],
      lineMat(COLORS.yellow, 0.35),
    );
    seg(
      [
        [0, py(TARGET_SPEED)],
        [PW, py(TARGET_SPEED)],
      ],
      lineMat(GREEN, 0.25),
    );
    const axisLabel = (text: string, x0: number, y0: number) => {
      const l = makeLabel(256, 48, 0.14);
      l.draw([text], COLORS.cyan, 28);
      l.sprite.position.set(x0, y0, 0);
      phase.add(l.sprite);
      labels.push(l.texture);
    };
    axisLabel('v [m/s]', 0.15, PH + 0.15);
    axisLabel('gap [m]', PW - 0.2, -0.15);

    const samples: { v: number; d: number; mode: Mode }[] = [];
    const phasePos = new Float32Array(PHASE_N * 3);
    const phaseCol = new Float32Array(PHASE_N * 3);
    const phaseGeo = new THREE.BufferGeometry();
    phaseGeo.setAttribute('position', new THREE.BufferAttribute(phasePos, 3));
    phaseGeo.setAttribute('color', new THREE.BufferAttribute(phaseCol, 3));
    phaseGeo.setDrawRange(0, 0);
    phase.add(new THREE.Line(phaseGeo, new THREE.LineBasicMaterial({ vertexColors: true })));
    const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.05), new THREE.MeshBasicMaterial({ color: COLORS.yellow }));
    phase.add(head);
    const col = new THREE.Color();

    const drawPhase = () => {
      const n = samples.length;
      for (let i = 0; i < n; i++) {
        const s = samples[i];
        phasePos[i * 3] = px(s.d);
        phasePos[i * 3 + 1] = py(s.v);
        col.setHex(MODE_COLOR[s.mode]).multiplyScalar(0.25 + 0.75 * (i / n)); // older samples fade
        phaseCol.set([col.r, col.g, col.b], i * 3);
      }
      phaseGeo.setDrawRange(0, n);
      phaseGeo.attributes.position.needsUpdate = true;
      phaseGeo.attributes.color.needsUpdate = true;
      head.position.set(px(x[1]), py(x[0]), 0.01);
    };

    // --- readout ---
    const readout = makeLabel(640, 160, 0.6);
    readout.sprite.position.set(EGO_X + 0.9, 1.25, 0.4);
    scene.add(readout.sprite);
    labels.push(readout.texture);

    // --- runtime: same order as _Runtime._evaluation_step ---
    const step = () => {
      const [dv, dd] = flows[mode](x);
      x = [x[0] + DT * dv, x[1] + DT * dd];
      travelled += DT * x[0];
      const active = transitions.filter((tr) => tr.from === mode && tr.guard(x));
      if (active.length) {
        const tr = active.reduce((a, b) => (b.priority < a.priority ? b : a));
        mode = tr.to;
        lastFired = tr;
        competing = active.length;
        edges[transitions.indexOf(tr)].age = 0;
      }
      simT += DT;
      if (simT >= nextSample) {
        nextSample += 1 / PHASE_RATE;
        samples.push({ v: x[0], d: x[1], mode });
        if (samples.length > PHASE_N) samples.shift();
      }
    };
    const advance = (seconds: number) => {
      const end = simT + seconds;
      while (simT < end) step();
    };

    // --- pointer input: X sets the lead car's speed ---
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const u = THREE.MathUtils.clamp((e.clientX - r.left) / r.width, 0, 1);
      carAheadSpeed = Math.round(5 + u * 25);
    };
    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerdown', onMove);

    // reduced motion: pre-roll one full limit cycle so the frame tells the story
    if (reducedMotion) advance(40);

    return {
      update(t, dt) {
        if (!reducedMotion) advance(dt * TIME_SCALE);
        frame(camera.aspect);

        lead.g.position.x = EGO_X + CAR_L + x[1] * S;
        lead.g.visible = lead.g.position.x < 14;
        dashes.position.x = -((travelled * S) % DASH_GAP);
        const spin = x[0] * S * dt * TIME_SCALE * 11; // wheel radius 0.09
        ego.wheels.forEach((w) => (w.rotation.y -= spin));
        lead.wheels.forEach((w) => (w.rotation.y -= carAheadSpeed * S * dt * TIME_SCALE * 11));

        beaconMat.color.setHex(MODE_COLOR[mode]);
        ego.mat.emissive.setHex(MODE_COLOR[mode]);
        ego.mat.emissiveIntensity = 0.15 + (mode === 'EMERGENCY_BRAKE' ? 0.35 * (Math.sin(t * 18) > 0 ? 1 : 0) : 0);
        dangerZone.opacity = x[1] < DANGER_CLOSE ? 0.35 : 0.12;
        safeZone.opacity = x[1] < SAFE_DISTANCE ? 0.25 : 0.1;

        for (const m of Object.keys(nodes) as Mode[]) {
          const on = m === mode;
          nodes[m].mat.emissiveIntensity = on ? 0.7 + Math.sin(t * 5) * 0.2 : 0.05;
          nodes[m].mesh.scale.setScalar(on ? 1.15 : 1);
        }
        for (const e of edges) {
          e.age += dt;
          const flash = Math.max(1 - e.age / 0.9, 0);
          e.mat.color.setHex(flash > 0 ? COLORS.yellow : COLORS.cyan);
          e.mat.opacity = 0.3 + flash * 0.7;
          (e.pulse.material as THREE.MeshBasicMaterial).opacity = flash;
          e.pulse.position.copy(e.curve.getPoint(Math.min(e.age / 0.4, 1)));
        }

        drawPhase();
        const fired = lastFired
          ? `${lastFired.name} (p${lastFired.priority}${competing > 1 ? `, beat ${competing - 1}` : ''})`
          : '—';
        readout.draw(
          [
            `${mode}  v ${x[0].toFixed(1).padStart(4)} m/s  gap ${x[1].toFixed(0).padStart(3)} m`,
            `lead ${carAheadSpeed} m/s   last: ${fired}`,
          ],
          MODE_COLOR[mode],
          28,
        );
      },
      dispose() {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerdown', onMove);
        labels.forEach((tex) => tex.dispose());
      },
    };
  });
}
