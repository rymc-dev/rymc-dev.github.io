import * as THREE from 'three';
import { COLORS, addEdges, addFloor, makeBoat, makeLabel, runStage } from './stage';
import { type Vec2, createUnsafeSet } from './riskenv';
import {
  type ColavContext,
  type Maneuver,
  type Mode,
  type Ship,
  EDGES,
  classifyUnsafeSetObstacles,
  clipSegment,
  createContext,
  guards,
  step,
} from './colav';

// Pipeline parameters, matching colav-automaton's scripts/generate_unsafe_set.py
const DSF = 40.0;
const TIME_OF_INTEREST = 20.0;
const SAFETY_RADIUS = 15.0;
const DT = 0.1; // the example's delta_time
const TIME_SCALE = 6;
const END_PAUSE = 3.5; // seconds to show SUCCESS / FAILURE before the next scenario

interface Scenario {
  name: string;
  goal: Vec2;
  ships: Ship[];
}

const ship = (tag: string, position: Vec2, headingDeg: number, speed: number): Ship => ({
  tag,
  position,
  heading: (headingDeg * Math.PI) / 180,
  speed,
  yawRate: 0,
  safetyRadius: 15,
});

const SCENARIOS: Scenario[] = [
  { name: 'Head-on (Rule 14)', goal: [200, 0], ships: [ship('cargo', [150, 2], 180, 2.5)] },
  { name: 'Crossing, give way (Rule 15)', goal: [200, 0], ships: [ship('cargo', [110, -70], 90, 2.0)] },
  { name: 'Crossing from port, fishing vessel (Rules 17 + 18)', goal: [200, 0], ships: [ship('fishing boat', [110, 70], -90, 2.0)] },
  {
    name: 'Stress test: generate_unsafe_set.py',
    goal: [200, 0],
    ships: [ship('cargo', [100, 0.5], 180, 3.0), ship('fishing boat', [70, -35], 90, 1.5), ship('super tanker', [160, 60], -90, 2.5)],
  },
];

// Scene layout
const S = 0.03; // metres -> scene units
const CX = 100; // world x at the scene origin
const FIELD: [Vec2, Vec2] = [
  [-20, -95],
  [220, 95],
];
const LIFT = 0.02;
const GREEN = 0x3bff9d;
const MUTED = 0x5a5a7a;
const MODE_COLOR: Record<Mode, number> = { Transit: COLORS.cyan, Fallback: COLORS.magenta, Waypoint_Reached: GREEN };

function ring(color: number, opacity: number, width = 0.05) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(1 - width, 1, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/**
 * colav-automaton's full pipeline, closed loop: ships -> riskenv unsafe region
 * -> COLREGs maneuver_bias -> ColavAutomaton step, every tick. Click to skip
 * to the next scenario.
 */
export function mount(canvas: HTMLCanvasElement): () => void {
  return runStage(canvas, ({ scene, camera, reducedMotion }) => {
    const labels: THREE.Texture[] = [];
    const frame = (aspect: number) => {
      const dist = 9.6 * Math.max(1, 1.9 / aspect);
      camera.position.set(0.7, dist * 0.84, dist * 0.56);
      camera.lookAt(0.7, 0, 0.45);
    };
    frame(camera.aspect);

    scene.add(new THREE.AmbientLight(0x6070ff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(3, 8, 4);
    scene.add(key);
    addFloor(scene, 16);

    const toScene = ([x, y]: Vec2, h = LIFT) => new THREE.Vector3((x - CX) * S, h, -y * S);
    const line = (color: number, opacity = 1) =>
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
      );

    const [[fx0, fy0], [fx1, fy1]] = FIELD;
    scene.add(
      new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(
          ([[fx0, fy0], [fx1, fy0], [fx1, fy1], [fx0, fy1]] as Vec2[]).map((p) => toScene(p)),
        ),
        new THREE.LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.3 }),
      ),
    );

    // --- agent ---
    const agentMesh = makeBoat(SAFETY_RADIUS * 1.2 * S, COLORS.cyan);
    scene.add(agentMesh);
    const agentRing = ring(COLORS.cyan, 0.8);
    agentRing.scale.setScalar(SAFETY_RADIUS * S);
    scene.add(agentRing);
    const TRAIL_N = 600;
    const trailPos = new Float32Array(TRAIL_N * 3);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    scene.add(new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.45 })));
    let trailN = 0;

    // --- waypoints and line of sight ---
    const marker = (color: number, size: number) => {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(size), new THREE.MeshBasicMaterial({ color, wireframe: true }));
      scene.add(m);
      return m;
    };
    const goalMarker = marker(GREEN, 0.12);
    const virtualMarker = marker(COLORS.yellow, 0.1);
    const los = line(COLORS.cyan, 0.7);
    scene.add(los);
    const midMarker = ring(COLORS.yellow, 0.95, 0.35);
    midMarker.scale.setScalar(0.09);
    scene.add(midMarker);
    const entryMarker = ring(COLORS.cyan, 0.95, 0.35);
    entryMarker.scale.setScalar(0.06);
    scene.add(entryMarker);
    const midLabel = makeLabel(320, 48, 0.15);
    scene.add(midLabel.sprite);
    labels.push(midLabel.texture);

    // --- unsafe region ---
    const hullFillMat = new THREE.MeshBasicMaterial({
      color: COLORS.magenta,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const hullFill = new THREE.Mesh(new THREE.BufferGeometry(), hullFillMat);
    scene.add(hullFill);
    const hullLine = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.magenta }));
    scene.add(hullLine);
    const drawHull = (hull: Vec2[]) => {
      hullFill.geometry.dispose();
      hullLine.geometry.dispose();
      hullFill.visible = hullLine.visible = hull.length >= 3;
      if (!hullFill.visible) return;
      const geo = new THREE.ShapeGeometry(new THREE.Shape(hull.map(([x, y]) => new THREE.Vector2((x - CX) * S, y * S))));
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, LIFT * 0.5, 0);
      hullFill.geometry = geo;
      hullLine.geometry = new THREE.BufferGeometry().setFromPoints(hull.map((p) => toScene(p, LIFT * 1.5)));
    };

    // --- ships (rebuilt per scenario) ---
    let shipViews: { body: Ship; mesh: THREE.Mesh; safety: THREE.Mesh; tag: ReturnType<typeof makeLabel> }[] = [];
    const clearShips = () => {
      for (const v of shipViews) {
        scene.remove(v.mesh, v.safety, v.tag.sprite);
        v.mesh.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          (m.material as THREE.Material)?.dispose();
        });
        v.safety.geometry.dispose();
        (v.safety.material as THREE.Material).dispose();
        v.tag.texture.dispose();
        (v.tag.sprite.material as THREE.Material).dispose();
      }
      shipViews = [];
    };

    // --- mode graph (billboarded, to the right of the field) ---
    const graph = new THREE.Group();
    graph.position.set(4.9, 0.9, -0.6);
    scene.add(graph);
    const NODE_POS: Record<Mode, THREE.Vector3> = {
      Transit: new THREE.Vector3(0, 0.75, 0),
      Fallback: new THREE.Vector3(-0.75, -0.55, 0),
      Waypoint_Reached: new THREE.Vector3(0.75, -0.55, 0),
    };
    const nodes = {} as Record<Mode, { mat: THREE.MeshStandardMaterial; mesh: THREE.Mesh }>;
    for (const m of Object.keys(NODE_POS) as Mode[]) {
      const mat = new THREE.MeshStandardMaterial({ color: COLORS.steel, metalness: 0.6, roughness: 0.4, emissive: MODE_COLOR[m], emissiveIntensity: 0.05 });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.07, 8), mat);
      mesh.rotation.x = Math.PI / 2;
      addEdges(mesh, MODE_COLOR[m]);
      mesh.position.copy(NODE_POS[m]);
      graph.add(mesh);
      nodes[m] = { mat, mesh };
      const l = makeLabel(400, 52, 0.15);
      l.draw([m], MODE_COLOR[m], 30);
      l.sprite.position.copy(NODE_POS[m]).add(new THREE.Vector3(0, m === 'Transit' ? 0.32 : -0.32, 0));
      graph.add(l.sprite);
      labels.push(l.texture);
    }
    const edgeViews = EDGES.map((e) => {
      let curve: THREE.Curve<THREE.Vector3>;
      if (e.from === e.to) {
        // e3 self-loop above Transit
        const c = NODE_POS[e.from];
        curve = new THREE.CubicBezierCurve3(
          c.clone().add(new THREE.Vector3(-0.12, 0.15, 0)),
          c.clone().add(new THREE.Vector3(-0.55, 0.65, 0)),
          c.clone().add(new THREE.Vector3(0.55, 0.65, 0)),
          c.clone().add(new THREE.Vector3(0.12, 0.15, 0)),
        );
      } else {
        const a = NODE_POS[e.from];
        const b = NODE_POS[e.to];
        const dir = b.clone().sub(a);
        const bend = new THREE.Vector3(dir.y, -dir.x, 0).setLength(0.14);
        curve = new THREE.QuadraticBezierCurve3(a, a.clone().lerp(b, 0.5).add(bend), b);
      }
      const mat = new THREE.LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.3 });
      graph.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(28)), mat));
      const l = makeLabel(96, 48, 0.12);
      l.draw([e.name], MUTED, 30);
      l.sprite.position.copy(curve.getPoint(0.5)).add(new THREE.Vector3(0, e.from === e.to ? 0.08 : 0, 0.01));
      graph.add(l.sprite);
      labels.push(l.texture);
      return { mat, hits: [] as number[], glow: 0 };
    });

    // --- readout ---
    const readout = makeLabel(1100, 230, 0.82);
    readout.sprite.position.set(0.7, 0.25, (fy1 * -S) - 0.75);
    scene.add(readout.sprite);
    labels.push(readout.texture);

    // --- simulation state ---
    let scenarioIndex = -1;
    let ships: Ship[] = [];
    let ctx: ColavContext;
    let maneuver: Maneuver;
    let simT = 0;
    let pending = 0;
    let endedAt = -1;

    const tick = () => {
      for (const s of ships) {
        s.position[0] += s.speed * Math.cos(s.heading) * DT;
        s.position[1] += s.speed * Math.sin(s.heading) * DT;
      }
      // the live-deployment pattern: refresh both auxiliary states every step
      const agent = { position: [ctx.x[0], ctx.x[1]] as Vec2, heading: ctx.x[2], speed: ctx.x[3], yawRate: 0, safetyRadius: SAFETY_RADIUS };
      ctx.unsafeRegion = createUnsafeSet(agent, ships, DSF, TIME_OF_INTEREST).hull;
      maneuver = classifyUnsafeSetObstacles(agent, ships, DSF, TIME_OF_INTEREST);
      ctx.maneuverBias = { side: maneuver.side, urgency: maneuver.urgency };
      const fired = step(ctx, DT);
      simT += DT;
      if (fired) edgeViews[EDGES.indexOf(fired)].hits.push(simT);
      if (trailN < TRAIL_N && Math.round(simT / DT) % 3 === 0) {
        const p = toScene([ctx.x[0], ctx.x[1]], LIFT);
        trailPos.set([p.x, p.y, p.z], trailN * 3);
        trailN++;
      }
    };

    const loadScenario = (i: number) => {
      scenarioIndex = i % SCENARIOS.length;
      const sc = SCENARIOS[scenarioIndex];
      clearShips();
      ships = sc.ships.map((s) => ({ ...s, position: [...s.position] as Vec2 }));
      ctx = createContext([0, 0, 0, 2, 0], sc.goal, { agent_safety_radius: SAFETY_RADIUS });
      simT = 0;
      pending = 0;
      endedAt = -1;
      trailN = 0;
      edgeViews.forEach((e) => (e.hits = []));
      shipViews = ships.map((body) => {
        const mesh = makeBoat(body.safetyRadius * 1.2 * S, MUTED);
        const safety = ring(MUTED, 0.7);
        safety.scale.setScalar(body.safetyRadius * S);
        const tag = makeLabel(320, 52, 0.15);
        scene.add(mesh, safety, tag.sprite);
        return { body, mesh, safety, tag };
      });
      tick(); // populate the auxiliary states before the first draw
    };
    loadScenario(0);

    const onDown = () => loadScenario(scenarioIndex + 1);
    canvas.addEventListener('pointerdown', onDown);

    // reduced motion: settle mid-way through the first reroute
    if (reducedMotion) {
      for (let i = 0; i < 300; i++) tick();
    }

    return {
      update(t, dt) {
        if (!reducedMotion) {
          if (ctx.status === 'ACTIVE') {
            pending += dt * TIME_SCALE;
            while (pending >= DT && ctx.status === 'ACTIVE') {
              tick();
              pending -= DT;
            }
            if (ctx.status !== 'ACTIVE') endedAt = t;
          } else if (t - endedAt > END_PAUSE) {
            loadScenario(scenarioIndex + 1);
          }
        }
        frame(camera.aspect);
        graph.quaternion.copy(camera.quaternion);

        const agentPos: Vec2 = [ctx.x[0], ctx.x[1]];
        agentMesh.position.copy(toScene(agentPos, 0));
        agentMesh.rotation.y = ctx.x[2];
        agentRing.position.copy(toScene(agentPos));
        const touching = !guards.safe_conditions_guard(ctx);
        (agentRing.material as THREE.MeshBasicMaterial).color.setHex(touching ? COLORS.magenta : COLORS.cyan);
        trailGeo.setDrawRange(0, trailN);
        trailGeo.attributes.position.needsUpdate = true;

        const goal = ctx.waypoints[0];
        const current = ctx.waypoints[ctx.waypoints.length - 1];
        goalMarker.position.copy(toScene(goal, 0.15));
        goalMarker.rotation.y = t;
        virtualMarker.visible = ctx.waypoints.length > 1;
        virtualMarker.position.copy(toScene(current, 0.15));
        virtualMarker.rotation.y = -t * 1.5;

        // LOS to the current waypoint, the overlap midpoint the guard measures, and the entry point
        const blocked = guards.los_clear_to_waypoint_guard(ctx);
        los.geometry.setFromPoints([toScene(agentPos, LIFT * 3), toScene(current, LIFT * 3)]);
        (los.material as THREE.LineBasicMaterial).color.setHex(blocked ? COLORS.magenta : COLORS.cyan);
        const clip = ctx.unsafeRegion.length >= 3 ? clipSegment(agentPos, current, ctx.unsafeRegion) : null;
        midMarker.visible = entryMarker.visible = midLabel.sprite.visible = !!clip;
        if (clip) {
          const at = (k: number): Vec2 => [agentPos[0] + (current[0] - agentPos[0]) * k, agentPos[1] + (current[1] - agentPos[1]) * k];
          const mid = at((clip[0] + clip[1]) / 2);
          midMarker.position.copy(toScene(mid, LIFT * 4));
          entryMarker.position.copy(toScene(at(clip[0]), LIFT * 4));
          const d = Math.hypot(mid[0] - agentPos[0], mid[1] - agentPos[1]);
          const th = ctx.config.los_distance_threshold;
          midLabel.draw([`${d.toFixed(0)} m ${d <= th ? '≤' : '>'} ${th}`], COLORS.yellow, 30);
          midLabel.sprite.position.copy(toScene(mid, 0.25));
        }

        drawHull(ctx.unsafeRegion);

        const agentBody = { position: agentPos, heading: ctx.x[2], speed: ctx.x[3], yawRate: 0, safetyRadius: SAFETY_RADIUS };
        const inRegion = new Set(
          createUnsafeSet(agentBody, ships, DSF, TIME_OF_INTEREST).uIoI.map((m) => m.obstacle),
        );
        for (const v of shipViews) {
          const active = inRegion.has(v.body);
          const color = active ? COLORS.magenta : MUTED;
          v.mesh.position.copy(toScene(v.body.position, 0));
          v.mesh.rotation.y = v.body.heading;
          (v.mesh.material as THREE.MeshStandardMaterial).emissive.setHex(color);
          (v.mesh.children[0] as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>).material.color.setHex(color);
          v.safety.position.copy(toScene(v.body.position));
          (v.safety.material as THREE.MeshBasicMaterial).color.setHex(color);
          v.tag.draw([v.body.tag], active ? COLORS.magenta : 0x8a8aa3, 30);
          v.tag.sprite.position.copy(toScene(v.body.position, 0.3)).add(new THREE.Vector3(0, 0, -v.body.safetyRadius * S - 0.12));
        }

        // mode graph: occupancy glow, and edge glow eased by recent firing rate (e3 can refire at 10 Hz)
        for (const m of Object.keys(nodes) as Mode[]) {
          const on = m === ctx.mode;
          nodes[m].mat.emissiveIntensity = on ? 0.75 : 0.05;
          nodes[m].mesh.scale.setScalar(on ? 1.15 : 1);
        }
        edgeViews.forEach((e) => {
          while (e.hits.length && e.hits[0] < simT - 2) e.hits.shift();
          const target = Math.min(e.hits.length / 2, 1);
          e.glow += (target - e.glow) * (1 - Math.exp(-dt * 3));
          e.mat.color.setHex(e.glow > 0.05 ? COLORS.yellow : COLORS.cyan);
          e.mat.opacity = 0.3 + e.glow * 0.7;
        });

        const sc = SCENARIOS[scenarioIndex];
        const statusColor = ctx.status === 'SUCCESS' ? GREEN : ctx.status === 'FAILURE' ? COLORS.magenta : 0xe6e6f0;
        const statusText =
          ctx.status === 'ACTIVE'
            ? `${ctx.mode}${ctx.mode === 'Fallback' ? ` (${ctx.timeSinceTransition.toFixed(0)} / ${ctx.config.fallback_timeout} s)` : ''}`
            : ctx.status === 'SUCCESS'
              ? 'SUCCESS: goal reached'
              : 'FAILURE: fallback_timeout exceeded';
        readout.draw(
          [
            [`${scenarioIndex + 1}/${SCENARIOS.length}  ${sc.name}   (click: next)`, COLORS.cyan],
            [`t ${simT.toFixed(0).padStart(3)} s   ${statusText}   last ${ctx.lastTransition || '—'}`, statusColor],
            [
              `maneuver_bias: ${maneuver.side} ${maneuver.urgency.toFixed(2)}  ${maneuver.encounter.replaceAll('_', ' ')}`,
              maneuver.encounter === 'none' ? 0x8a8aa3 : COLORS.yellow,
            ],
            [maneuver.reason.length > 62 ? maneuver.reason.slice(0, 61) + '…' : maneuver.reason, 0x8a8aa3],
          ],
          0xe6e6f0,
          30,
        );
      },
      dispose() {
        canvas.removeEventListener('pointerdown', onDown);
        clearShips();
        hullFill.geometry.dispose();
        hullLine.geometry.dispose();
        labels.forEach((tex) => tex.dispose());
      },
    };
  });
}
