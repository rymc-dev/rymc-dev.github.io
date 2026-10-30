import * as THREE from 'three';
import { COLORS, addEdges, addFloor, makeLabel, runStage } from './stage';

// Model parameters, matching hybrid_automatons/thermostat.py
const TOO_COLD = 18.0;
const TOO_HOT = 22.0;
const DRIFT_RATE = 0.5;
const DT = 0.01; // the example's delta_time
const T0 = 20.0;
// with hysteresis on, heating and cooling both run on to this set point
const SET_POINT = 20.0;

// Scene layout
const STRIP_SECONDS = 10;
const STRIP_N = STRIP_SECONDS / DT; // one texel per step, so every switch is visible
const TRACE_RATE = 30;
const TRACE_N = STRIP_SECONDS * TRACE_RATE;
const T_MIN = 10;
const T_MAX = 30;
const OCCUPANCY_WINDOW = 0.5; // seconds
const CHATTER_RATE = 5; // switches per second that count as chattering

type Mode = 'HEATING' | 'IDLE' | 'COOLING';

interface Transition {
  name: string;
  from: Mode;
  to: Mode;
  guard: (temp: number) => boolean;
  priority: number;
}

const MODE_COLOR: Record<Mode, number> = {
  HEATING: COLORS.magenta,
  IDLE: 0x3bff9d,
  COOLING: COLORS.cyan,
};

/**
 * The thermostat hybrid automaton from the hybrid-automaton package. Its exit
 * guards sit on the same thresholds as its entry guards, so whenever ambient
 * is outside 18-22 °C it chatters between modes every step or two. Click to
 * add hysteresis.
 *
 * Mode changes run at up to ~80 Hz, so nothing here flashes per switch (that
 * would be a photosensitivity hazard). Nodes and edges glow by time-averaged
 * occupancy and switch rate instead, and the chattering shows up as stripes
 * in the scrolling mode timeline.
 */
export function mount(canvas: HTMLCanvasElement): () => void {
  return runStage(canvas, ({ scene, camera, reducedMotion }) => {
    const labels: THREE.Texture[] = [];
    const frame = (aspect: number) => {
      // pull back on narrow viewports so the room and the graph both fit
      const dist = 7.6 * Math.max(1, 1.8 / aspect);
      camera.position.set(0, 2.1 + (dist - 7.6) * 0.15, dist);
      camera.lookAt(0, 1.6, 0);
    };
    frame(camera.aspect);

    scene.add(new THREE.AmbientLight(0x6070ff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(3, 6, 4);
    scene.add(key);
    addFloor(scene);

    // --- the automaton ---
    let ambient = 12;
    let hysteresis = false;
    const transitions: Transition[] = [
      { name: 'idle_to_heating', from: 'IDLE', to: 'HEATING', guard: (T) => T < TOO_COLD, priority: 1 },
      { name: 'idle_to_cooling', from: 'IDLE', to: 'COOLING', guard: (T) => T > TOO_HOT, priority: 1 },
      // temp_comfortable in the repo; the hysteresis variant runs on to the set point
      {
        name: 'heating_to_idle',
        from: 'HEATING',
        to: 'IDLE',
        guard: (T) => T >= (hysteresis ? SET_POINT : TOO_COLD) && T <= TOO_HOT,
        priority: 1,
      },
      {
        name: 'cooling_to_idle',
        from: 'COOLING',
        to: 'IDLE',
        guard: (T) => T <= (hysteresis ? SET_POINT : TOO_HOT) && T >= TOO_COLD,
        priority: 1,
      },
    ];
    const flows: Record<Mode, (T: number) => number> = {
      HEATING: () => 2.0,
      COOLING: () => -1.5,
      IDLE: (T) => DRIFT_RATE * (ambient - T),
    };

    let mode: Mode = 'IDLE';
    let temp = T0;
    let simT = 0;
    let nextSample = 0;
    const switchTimes: number[] = [];
    const recentModes: Mode[] = []; // last OCCUPANCY_WINDOW of steps
    const edgeHits = transitions.map(() => [] as number[]);

    // --- room ---
    const room = new THREE.Group();
    room.position.set(-2.3, 0, 0);
    scene.add(room);
    const roomFill = new THREE.MeshStandardMaterial({
      color: COLORS.steel,
      transparent: true,
      opacity: 0.35,
      emissive: COLORS.cyan,
      emissiveIntensity: 0.15,
      depthWrite: false,
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.5, 1.4), roomFill);
    box.position.y = 0.75;
    const boxEdges = addEdges(box, COLORS.cyan);
    room.add(box);

    const unit = (x: number, color: number) => {
      const mat = new THREE.MeshStandardMaterial({ color: COLORS.steel, emissive: color, emissiveIntensity: 0.05 });
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.7, 0.5), mat);
      m.position.set(x, 0.6, 0);
      addEdges(m, color);
      room.add(m);
      return mat;
    };
    const heaterMat = unit(-0.84, COLORS.magenta);
    const acMat = unit(0.84, COLORS.cyan);

    // --- mode graph ---
    const graph = new THREE.Group();
    graph.position.set(2.1, 0.9, 0);
    scene.add(graph);
    const NODE_POS: Record<Mode, THREE.Vector3> = {
      HEATING: new THREE.Vector3(-1.1, 0, 0),
      IDLE: new THREE.Vector3(0, 0.7, 0),
      COOLING: new THREE.Vector3(1.1, 0, 0),
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
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.08, 8), mat);
      mesh.rotation.x = Math.PI / 2; // face the camera
      addEdges(mesh, MODE_COLOR[m]);
      mesh.position.copy(NODE_POS[m]);
      graph.add(mesh);
      nodes[m] = { mat, mesh };

      const label = makeLabel(256, 56, 0.17);
      label.draw([m], MODE_COLOR[m], 30);
      label.sprite.position.copy(NODE_POS[m]).add(new THREE.Vector3(0, m === 'IDLE' ? 0.38 : -0.38, 0));
      graph.add(label.sprite);
      labels.push(label.texture);
    }
    const edges = transitions.map((tr) => {
      const a = NODE_POS[tr.from];
      const b = NODE_POS[tr.to];
      const dir = b.clone().sub(a);
      const bend = new THREE.Vector3(dir.y, -dir.x, 0).setLength(0.14);
      const curve = new THREE.QuadraticBezierCurve3(a, a.clone().lerp(b, 0.5).add(bend), b);
      const mat = new THREE.LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.3 });
      graph.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)), mat));
      return { mat, glow: 0 };
    });

    // --- T(t) trace and mode timeline on the back wall ---
    const W = 7.4;
    const H = 1.3;
    const wall = new THREE.Group();
    wall.position.set(-W / 2, 2.7, -2.6);
    scene.add(wall);
    const ty = (T: number) => ((THREE.MathUtils.clamp(T, T_MIN, T_MAX) - T_MIN) / (T_MAX - T_MIN)) * H;
    const hline = (T: number, color: number, opacity: number) => {
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(W, 0, 0)]), mat);
      line.position.y = ty(T);
      wall.add(line);
      return { mat, line };
    };
    hline(T_MIN, COLORS.cyan, 0.3);
    hline(TOO_COLD, COLORS.yellow, 0.45);
    hline(TOO_HOT, COLORS.yellow, 0.45);
    const setPoint = hline(SET_POINT, COLORS.yellow, 0);
    const ambientLine = hline(ambient, COLORS.cyan, 0.25);

    const wallLabel = (text: string, x0: number, y0: number, color: number = COLORS.cyan) => {
      const l = makeLabel(320, 48, 0.13);
      l.draw([text], color, 28);
      l.sprite.position.set(x0, y0, 0);
      wall.add(l.sprite);
      labels.push(l.texture);
    };
    wallLabel('T(t) [°C]', 0.35, H + 0.14);
    wallLabel('18', -0.18, ty(TOO_COLD), COLORS.yellow);
    wallLabel('22', -0.18, ty(TOO_HOT), COLORS.yellow);
    wallLabel('mode', -0.3, -0.2);

    const trace: number[] = [];
    const tracePos = new Float32Array(TRACE_N * 3);
    const traceGeo = new THREE.BufferGeometry();
    traceGeo.setAttribute('position', new THREE.BufferAttribute(tracePos, 3));
    traceGeo.setDrawRange(0, 0);
    wall.add(new THREE.Line(traceGeo, new THREE.LineBasicMaterial({ color: 0xffffff })));

    // one texel per automaton step; NearestFilter keeps every switch a hard edge
    const stripData = new Uint8Array(STRIP_N * 4);
    const stripTex = new THREE.DataTexture(stripData, STRIP_N, 1);
    stripTex.magFilter = THREE.NearestFilter;
    stripTex.minFilter = THREE.NearestFilter;
    stripTex.colorSpace = THREE.SRGBColorSpace;
    labels.push(stripTex);
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(W, 0.16),
      new THREE.MeshBasicMaterial({ map: stripTex, transparent: true, fog: false }),
    );
    strip.position.set(W / 2, -0.2, 0);
    wall.add(strip);
    const MODE_RGB = Object.fromEntries(
      (Object.keys(MODE_COLOR) as Mode[]).map((m) => [m, new THREE.Color(MODE_COLOR[m])]),
    ) as Record<Mode, THREE.Color>;
    let stripHead = 0;
    let stripFill = 0;
    const stripModes: Mode[] = [];

    // --- readout ---
    const readout = makeLabel(640, 160, 0.58);
    readout.sprite.position.set(0, 1.85, 0.6);
    scene.add(readout.sprite);
    labels.push(readout.texture);

    // --- runtime: same order as _Runtime._evaluation_step ---
    const step = () => {
      temp += DT * flows[mode](temp);
      const i = transitions.findIndex((tr) => tr.from === mode && tr.guard(temp));
      if (i >= 0) {
        mode = transitions[i].to;
        switchTimes.push(simT);
        edgeHits[i].push(simT);
      }
      simT += DT;

      recentModes.push(mode);
      if (recentModes.length > OCCUPANCY_WINDOW / DT) recentModes.shift();
      stripModes[stripHead] = mode;
      stripHead = (stripHead + 1) % STRIP_N;
      stripFill = Math.min(stripFill + 1, STRIP_N);

      if (simT >= nextSample) {
        nextSample += 1 / TRACE_RATE;
        trace.push(temp);
        if (trace.length > TRACE_N) trace.shift();
      }
    };
    const advance = (seconds: number) => {
      const end = simT + seconds;
      while (simT < end) step();
      while (switchTimes.length && switchTimes[0] < simT - 1) switchTimes.shift();
      for (const hits of edgeHits) while (hits.length && hits[0] < simT - 1) hits.shift();
    };

    const drawWall = () => {
      const n = trace.length;
      for (let i = 0; i < n; i++) {
        tracePos[i * 3] = ((TRACE_N - n + i) / (TRACE_N - 1)) * W;
        tracePos[i * 3 + 1] = ty(trace[i]);
      }
      traceGeo.setDrawRange(0, n);
      traceGeo.attributes.position.needsUpdate = true;

      // oldest step on the left, newest on the right
      for (let k = 0; k < STRIP_N; k++) {
        const o = k * 4;
        const age = STRIP_N - 1 - k;
        if (age >= stripFill) {
          stripData[o + 3] = 0;
          continue;
        }
        const c = MODE_RGB[stripModes[(stripHead - 1 - age + STRIP_N * 2) % STRIP_N]];
        stripData[o] = c.r * 255;
        stripData[o + 1] = c.g * 255;
        stripData[o + 2] = c.b * 255;
        stripData[o + 3] = 230;
      }
      stripTex.needsUpdate = true;
      ambientLine.line.position.y = ty(ambient);
    };

    // --- pointer input: X sets ambient, click toggles hysteresis ---
    let lastPointer = -Infinity;
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const u = THREE.MathUtils.clamp((e.clientX - r.left) / r.width, 0, 1);
      ambient = Math.round(T_MIN + u * (T_MAX - T_MIN));
      lastPointer = performance.now();
    };
    const onDown = (e: PointerEvent) => {
      onMove(e);
      hysteresis = !hysteresis;
    };
    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerdown', onDown);

    // reduced motion: pre-roll a full strip of chattering for the settled frame
    if (reducedMotion) advance(STRIP_SECONDS);

    return {
      update(t, dt) {
        if (!reducedMotion) {
          // when idle, sweep ambient slowly through cold, comfortable and hot
          if (performance.now() - lastPointer > 4000) ambient = Math.round(20 + Math.sin(t * 0.15) * 9);
          advance(dt);
        }
        frame(camera.aspect);

        const occ = { HEATING: 0, IDLE: 0, COOLING: 0 };
        for (const m of recentModes) occ[m]++;
        const total = Math.max(recentModes.length, 1);
        for (const m of Object.keys(nodes) as Mode[]) {
          const share = occ[m] / total;
          nodes[m].mat.emissiveIntensity = 0.05 + share * 0.85;
          nodes[m].mesh.scale.setScalar(1 + share * 0.15);
        }
        heaterMat.emissiveIntensity = 0.05 + (occ.HEATING / total) * 1.2;
        acMat.emissiveIntensity = 0.05 + (occ.COOLING / total) * 1.2;

        // edge brightness follows its switch rate, eased so it never strobes
        edges.forEach((e, i) => {
          const target = Math.min(edgeHits[i].length / 10, 1);
          e.glow += (target - e.glow) * (1 - Math.exp(-dt * 3));
          e.mat.color.setHex(e.glow > 0.05 ? COLORS.yellow : COLORS.cyan);
          e.mat.opacity = 0.3 + e.glow * 0.7;
        });

        // room tint: cool cyan to warm magenta
        const warmth = THREE.MathUtils.clamp((temp - 15) / 10, 0, 1);
        roomFill.emissive.setHex(COLORS.cyan).lerp(new THREE.Color(COLORS.magenta), warmth);
        (boxEdges.material as THREE.LineBasicMaterial).color.copy(roomFill.emissive);

        setPoint.mat.opacity = hysteresis ? 0.45 : 0;
        drawWall();

        const rate = switchTimes.length;
        const chattering = rate >= CHATTER_RATE;
        readout.draw(
          [
            `T ${temp.toFixed(2)} °C   ambient ${ambient} °C`,
            `${rate} switches/s   hysteresis ${hysteresis ? 'ON' : 'OFF'} (click)${chattering ? '   CHATTERING' : ''}`,
          ],
          chattering ? COLORS.magenta : 0x3bff9d,
          28,
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
