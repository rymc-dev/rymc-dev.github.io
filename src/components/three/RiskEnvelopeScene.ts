import * as THREE from 'three';
import { COLORS, addFloor, makeBoat, makeLabel, runStage } from './stage';
import { type Body, type Vec2, createUnsafeSet, predictPosition } from './riskenv';

// Scenario (metres, m/s); the agent and obstacles live on a 140 x 90 m patch of water
const ARENA: Vec2 = [70, 45]; // half extents
const DSF = 10.0;
const TIMES_OF_INTEREST = [5, 15, 30];
const AGENT_SPEED = 6.0;
const AGENT_TURN = 0.7; // max yaw rate, rad/s
const TIME_SCALE = 1.5;

// Scene layout
const S = 0.075; // metres -> scene units
const LIFT = 0.02;

const I1_COLOR = COLORS.yellow;
const I3_COLOR = COLORS.magenta;
const IDLE_COLOR = 0x4a4a6a;

/** A flat ring on the water, unit radius, scaled per use. */
function ring(color: number, opacity: number, width = 0.04) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(1 - width, 1, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/**
 * The riskenv Risk Envelope, recomputed every frame with a port of
 * create_unsafe_set. The agent steers toward the pointer; obstacles follow
 * constant-yaw-rate paths. Rings show I1 / I3 membership, ghosts show each
 * obstacle's predicted position at TCPA, and the filled polygon is the hull.
 */
export function mount(canvas: HTMLCanvasElement): () => void {
  return runStage(canvas, ({ scene, camera, reducedMotion }) => {
    const labels: THREE.Texture[] = [];
    const frame = (aspect: number) => {
      // pull back on narrow viewports so the whole arena fits
      const dist = 9.5 * Math.max(1, 1.75 / aspect);
      camera.position.set(0, dist * 0.82, dist * 0.62);
      camera.lookAt(0, 0, 0.6);
    };
    frame(camera.aspect);

    scene.add(new THREE.AmbientLight(0x6070ff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(3, 8, 4);
    scene.add(key);
    addFloor(scene, 14);

    const toScene = ([x, y]: Vec2, h = LIFT) => new THREE.Vector3(x * S, h, -y * S);

    // arena boundary
    const [ax, ay] = ARENA;
    scene.add(
      new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(
          ([[-ax, -ay], [ax, -ay], [ax, ay], [-ax, ay]] as Vec2[]).map((p) => toScene(p)),
        ),
        new THREE.LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.35 }),
      ),
    );

    // --- bodies ---
    const agent: Body = { position: [-45, -20], heading: 0.3, speed: AGENT_SPEED, yawRate: 0, safetyRadius: 5 };
    const obstacles: Body[] = [
      { position: [10, 25], heading: -1.9, speed: 3.0, yawRate: 0.0, safetyRadius: 6 },
      { position: [35, -10], heading: 2.6, speed: 4.0, yawRate: 0.04, safetyRadius: 5 },
      { position: [-10, -30], heading: 0.9, speed: 2.5, yawRate: -0.05, safetyRadius: 4 },
      { position: [50, 30], heading: -2.8, speed: 3.5, yawRate: 0.0, safetyRadius: 7 },
      { position: [-30, 30], heading: -0.6, speed: 2.0, yawRate: 0.08, safetyRadius: 4 },
      { position: [20, -35], heading: 2.0, speed: 3.0, yawRate: -0.03, safetyRadius: 5 },
    ];

    const agentMesh = makeBoat(agent.safetyRadius * 2 * S, COLORS.cyan);
    scene.add(agentMesh);
    const agentRing = ring(COLORS.cyan, 0.8);
    agentRing.scale.setScalar(agent.safetyRadius * S);
    scene.add(agentRing);
    // I1 reach: an obstacle is in I1 once its safety circle crosses this ring
    const dsfRing = ring(COLORS.cyan, 0.3, 0.015);
    dsfRing.scale.setScalar((agent.safetyRadius + DSF) * S);
    scene.add(dsfRing);

    const obs = obstacles.map((o) => {
      const mesh = makeBoat(o.safetyRadius * 2 * S, IDLE_COLOR);
      scene.add(mesh);
      const safety = ring(IDLE_COLOR, 0.7);
      safety.scale.setScalar(o.safetyRadius * S);
      scene.add(safety);
      const ghost = ring(I3_COLOR, 0.5, 0.03);
      ghost.scale.setScalar(o.safetyRadius * S);
      scene.add(ghost);
      const pathMat = new THREE.LineDashedMaterial({ color: I3_COLOR, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0.6 });
      const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), pathMat);
      scene.add(path);
      const tag = makeLabel(192, 48, 0.16);
      scene.add(tag.sprite);
      labels.push(tag.texture);
      return { body: o, mesh, safety, ghost, path, tag };
    });

    // I2 links: pairs of obstacles within dsf of each other
    const linkMat = new THREE.LineBasicMaterial({ color: I1_COLOR, transparent: true, opacity: 0.7 });
    const linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(obstacles.length * obstacles.length * 6), 3));
    scene.add(new THREE.LineSegments(linkGeo, linkMat));

    // --- the Risk Envelope ---
    const hullFillMat = new THREE.MeshBasicMaterial({
      color: COLORS.magenta,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const hullFill = new THREE.Mesh(new THREE.BufferGeometry(), hullFillMat);
    scene.add(hullFill);
    const hullLineMat = new THREE.LineBasicMaterial({ color: COLORS.magenta });
    const hullLine = new THREE.LineLoop(new THREE.BufferGeometry(), hullLineMat);
    scene.add(hullLine);

    const drawHull = (hull: Vec2[]) => {
      hullFill.geometry.dispose();
      hullLine.geometry.dispose();
      if (hull.length < 3) {
        hullFill.visible = hullLine.visible = false;
        return;
      }
      hullFill.visible = hullLine.visible = true;
      const shape = new THREE.Shape(hull.map(([x, y]) => new THREE.Vector2(x * S, y * S)));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2); // shape y -> scene -z
      geo.translate(0, LIFT * 0.5, 0);
      hullFill.geometry = geo;
      hullLine.geometry = new THREE.BufferGeometry().setFromPoints(hull.map((p) => toScene(p, LIFT * 1.5)));
    };

    // --- readout ---
    const readout = makeLabel(900, 170, 0.62);
    readout.sprite.position.set(0, 0.25, -ay * S - 0.7);
    scene.add(readout.sprite);
    labels.push(readout.texture);

    // --- world update ---
    let toiIndex = 1;
    let target: Vec2 | null = null;
    let lastPointer = -Infinity;
    const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

    const moveBody = (b: Body, dt: number) => {
      b.heading += b.yawRate * dt;
      b.position[0] += b.speed * Math.cos(b.heading) * dt;
      b.position[1] += b.speed * Math.sin(b.heading) * dt;
      // reflect off the arena edge (the prediction doesn't know about walls)
      for (const k of [0, 1] as const) {
        const lim = ARENA[k] - b.safetyRadius;
        if (Math.abs(b.position[k]) > lim) {
          b.position[k] = Math.sign(b.position[k]) * lim;
          b.heading = k === 0 ? Math.PI - b.heading : -b.heading;
        }
      }
    };

    const steerAgent = (t: number, dt: number) => {
      // idle: loop around the arena; otherwise head for the pointer
      const goal: Vec2 =
        target && performance.now() - lastPointer < 4000 ? target : [Math.cos(t * 0.09) * 50, Math.sin(t * 0.18) * 28];
      const want = Math.atan2(goal[1] - agent.position[1], goal[0] - agent.position[0]);
      const err = wrapAngle(want - agent.heading);
      agent.yawRate = THREE.MathUtils.clamp(err * 1.5, -AGENT_TURN, AGENT_TURN);
      moveBody(agent, dt);
    };

    // --- pointer: steer on the water plane; click cycles time_of_interest ---
    const raycaster = new THREE.Raycaster();
    const water = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    const ndc = new THREE.Vector2();
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (!raycaster.ray.intersectPlane(water, hit)) return;
      target = [
        THREE.MathUtils.clamp(hit.x / S, -ax + 5, ax - 5),
        THREE.MathUtils.clamp(-hit.z / S, -ay + 5, ay - 5),
      ];
      lastPointer = performance.now();
    };
    const onDown = (e: PointerEvent) => {
      onMove(e);
      toiIndex = (toiIndex + 1) % TIMES_OF_INTEREST.length;
    };
    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerdown', onDown);

    let computeMs = 0;
    const linkPos = linkGeo.attributes.position as THREE.BufferAttribute;

    // reduced motion: settle into an interesting moment
    if (reducedMotion) {
      for (let i = 0; i < 600; i++) {
        steerAgent(i * 0.05, 0.05);
        obstacles.forEach((o) => moveBody(o, 0.05));
      }
    }

    return {
      update(t, dt) {
        const sdt = reducedMotion ? 0 : dt * TIME_SCALE;
        if (sdt > 0) {
          steerAgent(t, sdt);
          obstacles.forEach((o) => moveBody(o, sdt));
        }
        frame(camera.aspect);

        const toi = TIMES_OF_INTEREST[toiIndex];
        const t0 = performance.now();
        const result = createUnsafeSet(agent, obstacles, DSF, toi);
        computeMs += (performance.now() - t0 - computeMs) * 0.05; // smoothed

        agentMesh.position.copy(toScene(agent.position, 0));
        agentMesh.rotation.y = agent.heading;
        agentRing.position.copy(toScene(agent.position));
        dsfRing.position.copy(toScene(agent.position));

        let links = 0;
        result.metrics.forEach((m, i) => {
          const o = obs[i];
          const inI1 = result.I1.includes(m);
          const inI2 = result.I2.includes(m);
          const inI3 = result.I3.includes(m);
          const color = inI3 ? I3_COLOR : inI1 ? I1_COLOR : IDLE_COLOR;

          o.mesh.position.copy(toScene(m.obstacle.position, 0));
          o.mesh.rotation.y = m.obstacle.heading;
          (o.mesh.material as THREE.MeshStandardMaterial).emissive.setHex(color);
          (o.mesh.children[0] as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>).material.color.setHex(color);
          o.safety.position.copy(toScene(m.obstacle.position));
          (o.safety.material as THREE.MeshBasicMaterial).color.setHex(color);

          // the predicted CPA circle is only part of the hull for members of uIoI
          const inUnion = result.uIoI.includes(m);
          const showGhost = inUnion && !isNaN(m.tcpa) && isFinite(m.tcpa) && m.tcpa > 0;
          o.ghost.visible = o.path.visible = showGhost;
          if (showGhost) {
            const future = predictPosition(m.obstacle, m.tcpa);
            o.ghost.position.copy(toScene(future));
            o.path.geometry.setFromPoints([toScene(m.obstacle.position), toScene(future)]);
            o.path.computeLineDistances();
          }

          const sets = [inI1 && 'I1', inI2 && 'I2', inI3 && 'I3'].filter(Boolean).join(' ');
          o.tag.draw([sets], color, 30);
          o.tag.sprite.visible = sets.length > 0;
          o.tag.sprite.position.copy(toScene(m.obstacle.position, 0.25)).add(new THREE.Vector3(0, 0, -m.obstacle.safetyRadius * S - 0.1));

          if (inI2) {
            for (const other of result.metrics) {
              if (other === m) continue;
              const d =
                Math.hypot(m.obstacle.position[0] - other.obstacle.position[0], m.obstacle.position[1] - other.obstacle.position[1]) -
                (m.obstacle.safetyRadius + other.obstacle.safetyRadius);
              if (d > DSF) continue;
              const a = toScene(m.obstacle.position, LIFT * 2);
              const b = toScene(other.obstacle.position, LIFT * 2);
              linkPos.setXYZ(links * 2, a.x, a.y, a.z);
              linkPos.setXYZ(links * 2 + 1, b.x, b.y, b.z);
              links++;
            }
          }
        });
        linkGeo.setDrawRange(0, links * 2);
        linkPos.needsUpdate = true;

        drawHull(result.hull);

        readout.draw(
          [
            [`|I1| ${result.I1.length}   |I2| ${result.I2.length}   |I3| ${result.I3.length}   →  uIoI ${result.uIoI.length}   hull ${result.hull.length} vertices`, 0xe6e6f0],
            [`dsf ${DSF} m   time_of_interest ${toi} s (click)   create_unsafe_set ${(computeMs * 1000).toFixed(0)} µs`, COLORS.cyan],
          ],
          0xe6e6f0,
          30,
        );
      },
      dispose() {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerdown', onDown);
        hullFill.geometry.dispose();
        hullLine.geometry.dispose();
        labels.forEach((tex) => tex.dispose());
      },
    };
  });
}
