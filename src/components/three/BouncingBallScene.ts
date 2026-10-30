import * as THREE from 'three';
import { COLORS, addEdges, addFloor, makeLabel, runStage } from './stage';

// Model parameters, matching hybrid_automatons/bouncing_ball.py
const GRAVITY = -9.81;
const DT = 0.001; // the example's delta_time
const Y0 = 5.0;
const REST_DELAY = 1.5; // seconds spent RESTING before the ball is dropped again

// Scene layout
const H_SCALE = 0.5; // metres of height -> scene units
const BALL_R = 0.22;
const BALL_X = -1.4;
const TRACE_SECONDS = 10;
const TRACE_RATE = 60; // samples per simulated second
const TRACE_N = TRACE_SECONDS * TRACE_RATE;

type Mode = 'FLYING' | 'GROUND' | 'RESTING';
type X = [y: number, v: number];

interface Transition {
  name: string;
  from: Mode;
  to: Mode;
  guard: (x: X) => boolean;
  reset?: (x: X) => X;
  priority: number;
  label: string;
}

const MODE_COLOR: Record<Mode, number> = {
  FLYING: COLORS.cyan,
  GROUND: COLORS.yellow,
  RESTING: COLORS.magenta,
};

/**
 * The bouncing-ball hybrid automaton from the hybrid-automaton package, ported
 * step for step with Euler integration at the example's delta_time. Shows the
 * ball, the live mode graph, and y(t).
 */
export function mount(canvas: HTMLCanvasElement): () => void {
  return runStage(canvas, ({ scene, camera, reducedMotion }) => {
    const labels: THREE.Texture[] = [];
    const frame = (aspect: number) => {
      // pull back on narrow viewports so the ball and the graph both fit
      const dist = 7.2 * Math.max(1, 1.7 / aspect);
      camera.position.set(0.4, 2.0 + (dist - 7.2) * 0.15, dist);
      camera.lookAt(0.4, 1.5, 0);
    };
    frame(camera.aspect);

    scene.add(new THREE.AmbientLight(0x6070ff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(3, 6, 4);
    scene.add(key);
    const rim = new THREE.PointLight(COLORS.magenta, 6, 10);
    rim.position.set(-3, 2, -2);
    scene.add(rim);
    addFloor(scene);

    // --- the automaton ---
    let restitution = 0.8;
    const transitions: Transition[] = [
      {
        name: 'hit_ground',
        from: 'FLYING',
        to: 'GROUND',
        guard: ([y, v]) => y <= 0 && v < 0,
        reset: ([, v]) => [0, -v * restitution],
        priority: 1,
        label: 'y ≤ 0 ∧ v < 0',
      },
      {
        name: 'bounce_up',
        from: 'GROUND',
        to: 'FLYING',
        guard: ([, v]) => Math.abs(v) > 0.1,
        priority: 2,
        label: '|v| > 0.1',
      },
      {
        name: 'come_to_rest',
        from: 'GROUND',
        to: 'RESTING',
        guard: ([, v]) => Math.abs(v) <= 0.1,
        reset: () => [0, 0],
        priority: 1,
        label: '|v| ≤ 0.1',
      },
    ];
    const flows: Record<Mode, (x: X) => X> = {
      FLYING: ([, v]) => [v, GRAVITY],
      GROUND: () => [0, 0],
      RESTING: () => [0, 0],
    };

    let mode: Mode = 'FLYING';
    let x: X = [Y0, 0];
    let simT = 0;
    let restedAt = 0;
    let bounces = 0;
    let nextSample = 0;

    // --- ball ---
    const ballMat = new THREE.MeshStandardMaterial({
      color: COLORS.steel,
      metalness: 0.6,
      roughness: 0.4,
      emissive: COLORS.cyan,
      emissiveIntensity: 0.25,
    });
    const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(BALL_R, 1), ballMat);
    const ballEdges = addEdges(ball, COLORS.cyan, 1);
    ball.position.x = BALL_X;
    scene.add(ball);

    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.65, 0.06, 8),
      new THREE.MeshStandardMaterial({ color: COLORS.steel, metalness: 0.6, roughness: 0.4 }),
    );
    addEdges(pad, COLORS.magenta);
    pad.position.set(BALL_X, 0.03, 0);
    scene.add(pad);

    // impact ring, re-triggered on every bounce_reset
    const ringMat = new THREE.MeshBasicMaterial({
      color: COLORS.yellow,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(BALL_X, 0.07, 0);
    scene.add(ring);
    let ringAge = Infinity;

    // --- mode graph ---
    const graph = new THREE.Group();
    graph.position.set(2.3, 0, 0);
    scene.add(graph);
    const NODE_POS: Record<Mode, THREE.Vector3> = {
      FLYING: new THREE.Vector3(0, 2.55, 0),
      GROUND: new THREE.Vector3(-0.75, 0.9, 0),
      RESTING: new THREE.Vector3(0.9, 0.9, 0),
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
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.08, 8), mat);
      mesh.rotation.x = Math.PI / 2; // face the camera
      addEdges(mesh, MODE_COLOR[m]);
      mesh.position.copy(NODE_POS[m]);
      graph.add(mesh);
      nodes[m] = { mat, mesh };

      const label = makeLabel(256, 64, 0.22);
      label.draw([m], MODE_COLOR[m]);
      label.sprite.position.copy(NODE_POS[m]).add(new THREE.Vector3(0, m === 'FLYING' ? 0.42 : -0.42, 0));
      graph.add(label.sprite);
      labels.push(label.texture);
    }

    // curved edge per transition, with a pulse that runs along it when it fires
    const BEND: Record<string, THREE.Vector3> = {
      hit_ground: new THREE.Vector3(-0.85, 0.15, 0),
      bounce_up: new THREE.Vector3(0.45, -0.1, 0),
      come_to_rest: new THREE.Vector3(0, -0.55, 0),
    };
    const edges = transitions.map((tr) => {
      const a = NODE_POS[tr.from];
      const b = NODE_POS[tr.to];
      const mid = a.clone().lerp(b, 0.5).add(BEND[tr.name]);
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const mat = new THREE.LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.35 });
      graph.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(32)), mat));

      const pulse = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.06),
        new THREE.MeshBasicMaterial({ color: COLORS.yellow, transparent: true, opacity: 0 }),
      );
      graph.add(pulse);

      const label = makeLabel(320, 56, 0.15);
      label.draw([tr.label], COLORS.cyan, 30);
      label.sprite.position.copy(curve.getPoint(0.5)).add(BEND[tr.name].clone().setLength(0.22));
      graph.add(label.sprite);
      labels.push(label.texture);

      return { curve, mat, pulse, age: Infinity };
    });

    // --- y(t) trace on the back wall ---
    const TRACE_W = 7.2;
    const TRACE_H = Y0 * 1.2 * 0.3;
    const trace = new THREE.Group();
    trace.position.set(0.4 - TRACE_W / 2, 0.15, -2.6);
    scene.add(trace);
    const axisMat = new THREE.LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.3 });
    trace.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, TRACE_H, 0),
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(TRACE_W, 0, 0),
        ]),
        axisMat,
      ),
    );
    const traceLabel = makeLabel(256, 48, 0.16);
    traceLabel.draw(['y(t)'], COLORS.cyan, 30);
    traceLabel.sprite.position.set(0.3, TRACE_H + 0.15, 0);
    trace.add(traceLabel.sprite);
    labels.push(traceLabel.texture);

    const samples: { y: number; mode: Mode }[] = [];
    const tracePos = new Float32Array(TRACE_N * 3);
    const traceCol = new Float32Array(TRACE_N * 3);
    const traceGeo = new THREE.BufferGeometry();
    traceGeo.setAttribute('position', new THREE.BufferAttribute(tracePos, 3));
    traceGeo.setAttribute('color', new THREE.BufferAttribute(traceCol, 3));
    traceGeo.setDrawRange(0, 0);
    trace.add(new THREE.Line(traceGeo, new THREE.LineBasicMaterial({ vertexColors: true })));
    const col = new THREE.Color();

    const drawTrace = () => {
      const n = samples.length;
      for (let i = 0; i < n; i++) {
        const s = samples[i];
        tracePos[i * 3] = ((TRACE_N - n + i) / (TRACE_N - 1)) * TRACE_W;
        tracePos[i * 3 + 1] = (s.y / (Y0 * 1.2)) * TRACE_H;
        col.setHex(MODE_COLOR[s.mode]);
        traceCol.set([col.r, col.g, col.b], i * 3);
      }
      traceGeo.setDrawRange(0, n);
      traceGeo.attributes.position.needsUpdate = true;
      traceGeo.attributes.color.needsUpdate = true;
    };

    // --- readout ---
    const readout = makeLabel(512, 160, 0.55);
    readout.sprite.position.set(BALL_X, 3.75, 0);
    scene.add(readout.sprite);
    labels.push(readout.texture);

    // --- runtime: one step of the automaton ---
    const fire = (tr: Transition) => {
      if (tr.reset) x = tr.reset(x);
      mode = tr.to;
      const edge = edges[transitions.indexOf(tr)];
      edge.age = 0;
      if (tr.name === 'hit_ground') {
        bounces++;
        ringAge = 0;
      }
      if (tr.name === 'come_to_rest') restedAt = simT;
    };

    // same order as _Runtime._evaluation_step: integrate the flow, then fire the
    // lowest-priority-value active transition (RESTING is final, so the real run
    // terminates there; here we just drop the ball again)
    const step = () => {
      const [dy, dv] = flows[mode](x);
      x = [x[0] + DT * dy, x[1] + DT * dv];
      const active = transitions.filter((tr) => tr.from === mode && tr.guard(x));
      if (active.length) fire(active.reduce((a, b) => (b.priority < a.priority ? b : a)));
      simT += DT;
      if (simT >= nextSample) {
        nextSample += 1 / TRACE_RATE;
        samples.push({ y: Math.max(x[0], 0), mode });
        if (samples.length > TRACE_N) samples.shift();
      }
    };

    const drop = (height: number) => {
      mode = 'FLYING';
      x = [height, 0];
      bounces = 0;
    };

    const advance = (seconds: number) => {
      const end = simT + seconds;
      while (simT < end) {
        step();
        if (mode === 'RESTING' && simT - restedAt > REST_DELAY) drop(Y0);
      }
    };

    // --- pointer input: X sets restitution, click drops from pointer height ---
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const u = THREE.MathUtils.clamp((e.clientX - r.left) / r.width, 0, 1);
      restitution = 0.5 + u * 0.45;
    };
    const onDown = (e: PointerEvent) => {
      onMove(e);
      const r = canvas.getBoundingClientRect();
      const v = THREE.MathUtils.clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      drop(1.5 + v * 4.5);
    };
    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerdown', onDown);

    // reduced motion: pre-roll so the single settled frame shows a full trace
    if (reducedMotion) advance(TRACE_SECONDS);

    return {
      update(t, dt) {
        if (!reducedMotion) advance(dt);
        frame(camera.aspect);

        ball.position.y = BALL_R + Math.max(x[0], 0) * H_SCALE;
        // squash a little on contact
        const squash = mode === 'FLYING' ? 1 : 0.85;
        ball.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
        ball.rotation.y += dt * 0.8;
        ballMat.emissive.setHex(MODE_COLOR[mode]);
        (ballEdges.material as THREE.LineBasicMaterial).color.setHex(MODE_COLOR[mode]);

        ringAge += dt;
        const k = Math.min(ringAge / 0.5, 1);
        ring.scale.setScalar(0.25 + k * 0.6);
        ringMat.opacity = (1 - k) * 0.8;

        for (const m of Object.keys(nodes) as Mode[]) {
          const on = m === mode;
          nodes[m].mat.emissiveIntensity = on ? 0.7 + Math.sin(t * 5) * 0.2 : 0.05;
          nodes[m].mesh.scale.setScalar(on ? 1.12 : 1);
        }
        for (const e of edges) {
          e.age += dt;
          const flash = Math.max(1 - e.age / 0.6, 0);
          e.mat.color.setHex(flash > 0 ? COLORS.yellow : COLORS.cyan);
          e.mat.opacity = 0.35 + flash * 0.65;
          const pm = e.pulse.material as THREE.MeshBasicMaterial;
          pm.opacity = flash;
          e.pulse.position.copy(e.curve.getPoint(Math.min(e.age / 0.35, 1)));
        }

        drawTrace();
        readout.draw(
          [
            `mode ${mode}`,
            `y ${x[0].toFixed(2).padStart(5)} m  v ${x[1].toFixed(2).padStart(6)} m/s`,
            `e ${restitution.toFixed(2)}  bounces ${bounces}`,
          ],
          MODE_COLOR[mode],
          30,
        );
      },
      dispose() {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerdown', onDown);
        labels.forEach((tex) => tex.dispose());
      },
    };
  });
}
