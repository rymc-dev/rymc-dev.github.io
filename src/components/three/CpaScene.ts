import * as THREE from 'three';
import { COLORS, addFloor, makeBoat, makeLabel, runStage } from './stage';
import { type Body, type Vec2, calcCpa } from './riskenv';

// Scenario (metres, m/s)
const AGENT_START: Vec2 = [-35, -12];
const OBSTACLE_START: Vec2 = [15, 18];
const AGENT_SPEED = 5.0;
const PLAYBACK = 3.0; // seconds of wall time to replay [0, horizon]
const HORIZON_CAP = 20; // s, how far ahead to replay when there is no future CPA

// Scene layout
const S = 0.08; // metres -> scene units
const LIFT = 0.02;
const AGENT_COLOR = COLORS.cyan;
const OBSTACLE_COLOR = COLORS.magenta;
const MUTED = 0x8a8aa3;

/**
 * riskenv's calc_cpa, made visible. The agent holds course; pointer X sets the
 * obstacle's heading and pointer Y its speed (both snapped, so the parallel
 * special case is reachable). Ghost boats replay both straight-line tracks up
 * to TCPA, where the yellow segment is DCPA.
 */
export function mount(canvas: HTMLCanvasElement): () => void {
  return runStage(canvas, ({ scene, camera, reducedMotion }) => {
    const labels: THREE.Texture[] = [];
    const frame = (aspect: number) => {
      const dist = 8.4 * Math.max(1, 1.75 / aspect);
      camera.position.set(0.2, dist * 0.8, dist * 0.64);
      camera.lookAt(0.2, 0, 0.5);
    };
    frame(camera.aspect);

    scene.add(new THREE.AmbientLight(0x6070ff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(3, 8, 4);
    scene.add(key);
    addFloor(scene, 14);

    const toScene = ([x, y]: Vec2, h = LIFT) => new THREE.Vector3(x * S, h, -y * S);

    const agent: Body = { position: [...AGENT_START], heading: 0, speed: AGENT_SPEED, yawRate: 0, safetyRadius: 4 };
    const obstacle: Body = { position: [...OBSTACLE_START], heading: -1.6, speed: 4.0, yawRate: 0, safetyRadius: 4 };

    // start markers and ghosts
    const make = (color: number) => {
      const start = makeBoat(agent.safetyRadius * 2 * S, color);
      scene.add(start);
      const ghost = makeBoat(agent.safetyRadius * 2 * S, color);
      const gm = ghost.material as THREE.MeshStandardMaterial;
      gm.transparent = true;
      gm.opacity = 0.55;
      scene.add(ghost);
      const trackMat = new THREE.LineDashedMaterial({ color, dashSize: 0.1, gapSize: 0.07, transparent: true, opacity: 0.55 });
      const track = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), trackMat);
      scene.add(track);
      const cpaMarker = new THREE.Mesh(
        new THREE.RingGeometry(0.06, 0.09, 20),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true }),
      );
      cpaMarker.rotation.x = -Math.PI / 2;
      scene.add(cpaMarker);
      return { start, ghost, track, cpaMarker };
    };
    const A = make(AGENT_COLOR);
    const O = make(OBSTACLE_COLOR);

    // the gap between the ghosts, and DCPA at the closest point
    const gapMat = new THREE.LineBasicMaterial({ color: MUTED, transparent: true, opacity: 0.7 });
    const gapLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), gapMat);
    scene.add(gapLine);
    const dcpaMat = new THREE.LineBasicMaterial({ color: COLORS.yellow });
    const dcpaLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), dcpaMat);
    scene.add(dcpaLine);
    const dcpaLabel = makeLabel(320, 56, 0.2);
    scene.add(dcpaLabel.sprite);
    labels.push(dcpaLabel.texture);

    const readout = makeLabel(1000, 210, 0.78);
    readout.sprite.position.set(0.2, 0.3, -3.6);
    scene.add(readout.sprite);
    labels.push(readout.texture);

    // --- pointer: X -> obstacle heading (5° steps), Y -> obstacle speed (0.5 m/s steps) ---
    let lastPointer = -Infinity;
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const u = THREE.MathUtils.clamp((e.clientX - r.left) / r.width, 0, 1);
      const v = THREE.MathUtils.clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      obstacle.heading = THREE.MathUtils.degToRad(Math.round((-180 + u * 360) / 5) * 5);
      obstacle.speed = Math.round(v * 20) / 2;
      lastPointer = performance.now();
    };
    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerdown', onMove);

    const at = (b: Body, tau: number): Vec2 => [
      b.position[0] + b.speed * Math.cos(b.heading) * tau,
      b.position[1] + b.speed * Math.sin(b.heading) * tau,
    ];
    const setLine = (line: THREE.Line, a: THREE.Vector3, b: THREE.Vector3) => {
      line.geometry.setFromPoints([a, b]);
      line.computeLineDistances();
    };

    return {
      update(t) {
        // idle: sweep the obstacle's heading slowly through all four cases' geometry
        if (performance.now() - lastPointer > 4000) {
          obstacle.heading = -1.6 + Math.sin(t * 0.12) * 1.9;
          obstacle.speed = 4.0;
        }
        frame(camera.aspect);

        const [dcpa, tcpa] = calcCpa(agent, obstacle);
        const relV2 =
          (AGENT_SPEED * Math.cos(agent.heading) - obstacle.speed * Math.cos(obstacle.heading)) ** 2 +
          (AGENT_SPEED * Math.sin(agent.heading) - obstacle.speed * Math.sin(obstacle.heading)) ** 2;
        const future = !isNaN(tcpa) && isFinite(tcpa) && relV2 >= 1e-6;
        const parallel = relV2 < 1e-6;
        const horizon = future ? tcpa : HORIZON_CAP;
        const tau = reducedMotion ? horizon : ((t % PLAYBACK) / PLAYBACK) * horizon;

        A.start.position.copy(toScene(agent.position, 0));
        A.start.rotation.y = agent.heading;
        O.start.position.copy(toScene(obstacle.position, 0));
        O.start.rotation.y = obstacle.heading;

        const ga = at(agent, tau);
        const go = at(obstacle, tau);
        A.ghost.position.copy(toScene(ga, 0));
        A.ghost.rotation.y = agent.heading;
        O.ghost.position.copy(toScene(go, 0));
        O.ghost.rotation.y = obstacle.heading;
        setLine(A.track, toScene(agent.position), toScene(at(agent, horizon)));
        setLine(O.track, toScene(obstacle.position), toScene(at(obstacle, horizon)));
        setLine(gapLine, toScene(ga, LIFT * 3), toScene(go, LIFT * 3));

        dcpaLine.visible = A.cpaMarker.visible = O.cpaMarker.visible = dcpaLabel.sprite.visible = future;
        if (future) {
          const ca = toScene(at(agent, tcpa), LIFT * 4);
          const co = toScene(at(obstacle, tcpa), LIFT * 4);
          setLine(dcpaLine, ca, co);
          A.cpaMarker.position.copy(ca);
          O.cpaMarker.position.copy(co);
          dcpaLabel.draw([`DCPA ${dcpa.toFixed(1)} m`], COLORS.yellow, 30);
          dcpaLabel.sprite.position.copy(ca).lerp(co, 0.5).add(new THREE.Vector3(0, 0.3, 0));
        }

        const now = Math.hypot(ga[0] - go[0], ga[1] - go[1]);
        const fmt = (x: number) => (isNaN(x) ? 'NaN' : isFinite(x) ? x.toFixed(2) : 'inf');
        const caseLine: [string, number] = parallel
          ? ['case 1.2  zero relative velocity: DCPA = ‖p_rel‖, TCPA = ‖p_rel‖ / ‖v1‖', COLORS.cyan]
          : future
            ? ['case 2.1  future CPA: TCPA = −(p_rel · v_rel) / ‖v_rel‖²', 0x3bff9d]
            : ['case 2.2  CPA in the past: diverging, no future risk → (NaN, NaN)', MUTED];
        readout.draw(
          [
            caseLine,
            [`obstacle heading ${Math.round(THREE.MathUtils.radToDeg(obstacle.heading))}°  speed ${obstacle.speed.toFixed(1)} m/s   (agent 0°, ${AGENT_SPEED} m/s)`, 0xe6e6f0],
            [`calc_cpa → DCPA ${fmt(dcpa)} m   TCPA ${fmt(tcpa)} s      τ ${tau.toFixed(1)} s   gap ${now.toFixed(1)} m`, COLORS.yellow],
          ],
          0xe6e6f0,
          30,
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
