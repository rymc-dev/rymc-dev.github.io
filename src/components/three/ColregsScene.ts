import * as THREE from 'three';
import { COLORS, addFloor, makeBoat, makeLabel, runStage } from './stage';
import { type Body, type Vec2, calcCpa } from './riskenv';
import {
  ABAFT_BEAM_LIMIT,
  HEAD_ON_BEARING_LIMIT,
  type Ship,
  classifyEncounter,
  determineManeuver,
  normalizeVesselType,
  relativeBearing,
} from './colav';

const SECTOR_RADIUS = 120; // m
const S = 0.025; // metres -> scene units
const LIFT = 0.02;
const GREEN = 0x3bff9d;
const MUTED = 0x8a8aa3;

type Course = 'toward' | 'same';
const SETUPS: { course: Course; tag: string }[] = [
  { course: 'toward', tag: 'cargo' },
  { course: 'toward', tag: 'fishing boat' },
  { course: 'same', tag: 'cargo' },
  { course: 'same', tag: 'fishing boat' },
];

/**
 * colav_automaton.classification, made visible: the agent's COLREGs sectors,
 * a second ship placed by the pointer, and classify_encounter /
 * determine_maneuver evaluated live. Click cycles the ship's course and type.
 */
export function mount(canvas: HTMLCanvasElement): () => void {
  return runStage(canvas, ({ scene, camera, reducedMotion }) => {
    const labels: THREE.Texture[] = [];
    const frame = (aspect: number) => {
      const dist = 8.4 * Math.max(1, 1.7 / aspect);
      camera.position.set(0, dist * 0.82, dist * 0.6);
      camera.lookAt(0, 0, 0.55);
    };
    frame(camera.aspect);

    scene.add(new THREE.AmbientLight(0x6070ff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(3, 8, 4);
    scene.add(key);
    addFloor(scene, 14);

    const toScene = ([x, y]: Vec2, h = LIFT) => new THREE.Vector3(x * S, h, -y * S);

    const agent: Body = { position: [0, 0], heading: 0, speed: 2.0, yawRate: 0, safetyRadius: 15 };

    // --- agent's COLREGs sectors (bearing relative to heading; + = port) ---
    const sector = (from: number, to: number, color: number, text: string) => {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(SECTOR_RADIUS * S, 48, from, to - from), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.005;
      scene.add(mesh);
      const edgeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 });
      for (const a of [from, to]) {
        scene.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([toScene([0, 0]), toScene([Math.cos(a) * SECTOR_RADIUS, Math.sin(a) * SECTOR_RADIUS])]),
            edgeMat,
          ),
        );
      }
      const l = makeLabel(360, 52, 0.17);
      l.draw([text], color, 30);
      const mid = (from + to) / 2;
      l.sprite.position.copy(toScene([Math.cos(mid) * SECTOR_RADIUS * 0.82, Math.sin(mid) * SECTOR_RADIUS * 0.82], 0.15));
      scene.add(l.sprite);
      labels.push(l.texture);
      return mat;
    };
    const sectors = {
      head_on: sector(-HEAD_ON_BEARING_LIMIT, HEAD_ON_BEARING_LIMIT, COLORS.yellow, 'head-on ±15°'),
      starboard: sector(-ABAFT_BEAM_LIMIT, -HEAD_ON_BEARING_LIMIT, COLORS.magenta, 'starboard bow'),
      port: sector(HEAD_ON_BEARING_LIMIT, ABAFT_BEAM_LIMIT, COLORS.cyan, 'port bow'),
      astern: sector(ABAFT_BEAM_LIMIT, 2 * Math.PI - ABAFT_BEAM_LIMIT, MUTED, 'abaft the beam'),
    };

    const agentMesh = makeBoat(agent.safetyRadius * 2 * S, COLORS.cyan);
    scene.add(agentMesh);
    const intended = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: GREEN, dashSize: 0.1, gapSize: 0.07 }),
    );
    scene.add(intended);
    const intendedLabel = makeLabel(320, 52, 0.16);
    scene.add(intendedLabel.sprite);
    labels.push(intendedLabel.texture);

    // --- the other ship ---
    const other: Ship = { tag: 'cargo', position: [70, -40], heading: Math.PI / 2, speed: 3.0, yawRate: 0, safetyRadius: 15 };
    const otherMesh = makeBoat(other.safetyRadius * 2 * S, COLORS.magenta);
    scene.add(otherMesh);
    const otherHeading = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: COLORS.magenta, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0.7 }),
    );
    scene.add(otherHeading);
    const otherLabel = makeLabel(320, 52, 0.16);
    scene.add(otherLabel.sprite);
    labels.push(otherLabel.texture);

    const readout = makeLabel(1100, 230, 0.8);
    readout.sprite.position.set(0, 0.25, -SECTOR_RADIUS * S - 0.75);
    scene.add(readout.sprite);
    labels.push(readout.texture);

    // --- pointer: place the ship; click cycles course and vessel type ---
    let setup = 0;
    let lastPointer = -Infinity;
    const raycaster = new THREE.Raycaster();
    const water = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    const ndc = new THREE.Vector2();
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (!raycaster.ray.intersectPlane(water, hit)) return;
      const p: Vec2 = [hit.x / S, -hit.z / S];
      const d = Math.hypot(p[0], p[1]);
      const k = d > SECTOR_RADIUS ? SECTOR_RADIUS / d : d < 25 ? 25 / Math.max(d, 1e-6) : 1;
      other.position = [p[0] * k, p[1] * k];
      lastPointer = performance.now();
    };
    const onDown = (e: PointerEvent) => {
      onMove(e);
      setup = (setup + 1) % SETUPS.length;
    };
    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerdown', onDown);

    const deg = (r: number) => `${Math.round((r * 180) / Math.PI)}°`.padStart(5);

    return {
      update(t) {
        frame(camera.aspect);
        // idle: orbit the agent, switching course each lap
        let course = SETUPS[setup].course;
        const tag = SETUPS[setup].tag;
        if (performance.now() - lastPointer > 4000) {
          const a = reducedMotion ? -0.6 : -t * 0.3;
          other.position = [Math.cos(a) * 75, Math.sin(a) * 75];
          const lap = Math.floor((t * 0.3) / (2 * Math.PI));
          course = lap % 2 === 0 ? 'toward' : 'same';
        }
        other.tag = tag;
        if (course === 'toward') {
          other.heading = Math.atan2(-other.position[1], -other.position[0]);
          other.speed = 3.0;
        } else {
          other.heading = agent.heading;
          other.speed = 1.5;
        }

        const [dcpa, tcpa] = calcCpa(agent, other);
        const m = determineManeuver(agent, { obstacle: other, dcpa, tcpa });
        const encounter = classifyEncounter(agent, other);
        const b2o = relativeBearing(agent.position, agent.heading, other.position);
        const b2a = relativeBearing(other.position, other.heading, agent.position);
        const hd = Math.atan2(Math.sin(other.heading - agent.heading), Math.cos(other.heading - agent.heading));

        agentMesh.position.copy(toScene(agent.position, 0));
        agentMesh.rotation.y = agent.heading;
        otherMesh.position.copy(toScene(other.position, 0));
        otherMesh.rotation.y = other.heading;
        otherHeading.geometry.setFromPoints([
          toScene(other.position, LIFT * 2),
          toScene([other.position[0] + Math.cos(other.heading) * 40, other.position[1] + Math.sin(other.heading) * 40], LIFT * 2),
        ]);
        otherHeading.computeLineDistances();
        otherLabel.draw([`${other.tag} (${normalizeVesselType(other.tag).replaceAll('_', ' ')})`], COLORS.magenta, 28);
        otherLabel.sprite.position.copy(toScene(other.position, 0.35)).add(new THREE.Vector3(0, 0, -0.45));

        // give way: alter to the maneuver's side; stand on: hold course
        const turn = m.giveWay ? (m.side === 'starboard' ? -0.6 : 0.6) : 0;
        const tip: Vec2 = [Math.cos(turn) * 55, Math.sin(turn) * 55];
        intended.geometry.setFromPoints([toScene([0, 0], LIFT * 2), toScene(tip, LIFT * 2)]);
        intended.computeLineDistances();
        intendedLabel.draw([m.giveWay ? `give way → ${m.side}` : 'stand on'], GREEN, 28);
        intendedLabel.sprite.position.copy(toScene(tip, 0.3));

        // highlight the sector the ship is in
        const inSector = Math.abs(b2o) <= HEAD_ON_BEARING_LIMIT ? 'head_on' : Math.abs(b2o) >= ABAFT_BEAM_LIMIT ? 'astern' : b2o < 0 ? 'starboard' : 'port';
        for (const [k, mat] of Object.entries(sectors)) mat.opacity = k === inSector ? 0.22 : 0.06;

        readout.draw(
          [
            [`${encounter.replaceAll('_', ' ').toUpperCase()}   ${m.giveWay ? 'GIVE WAY' : 'STAND ON'}   side ${m.side}   urgency ${m.urgency.toFixed(2)}`, m.giveWay ? COLORS.yellow : GREEN],
            [m.reason.length > 64 ? m.reason.slice(0, 63) + '…' : m.reason, 0xe6e6f0],
            [`bearing to ship ${deg(b2o)}  bearing to us ${deg(b2a)}  heading diff ${deg(hd)}`, MUTED],
            [`course: ${course === 'toward' ? 'toward us' : 'same as ours'}   type: ${other.tag}   (move: place · click: next)`, COLORS.cyan],
          ],
          0xe6e6f0,
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
