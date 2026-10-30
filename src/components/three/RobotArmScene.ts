import * as THREE from 'three';
import { COLORS, addEdges, addFloor, runStage } from './stage';

// Link lengths (scene units)
const BASE_H = 0.45;
const L1 = 1.4; // shoulder -> elbow
const L2 = 1.2; // elbow -> wrist
const WRIST = 0.35;

/**
 * Low-poly 6-DOF-style arm that tracks the pointer using analytic 2-link IK
 * (base yaw + shoulder/elbow pitch). Drifts on a Lissajous path when idle.
 */
export function mount(canvas: HTMLCanvasElement): () => void {
  return runStage(canvas, ({ scene, camera, reducedMotion }) => {
    camera.position.set(3.1, 2.5, 4.0);
    camera.lookAt(0, 1.0, 0.5);

    scene.add(new THREE.AmbientLight(0x6070ff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(3, 6, 4);
    scene.add(key);
    const rim = new THREE.PointLight(COLORS.magenta, 6, 10);
    rim.position.set(-3, 2, -2);
    scene.add(rim);
    addFloor(scene);

    const body = new THREE.MeshStandardMaterial({
      color: COLORS.steel,
      metalness: 0.6,
      roughness: 0.4,
      emissive: COLORS.cyan,
      emissiveIntensity: 0.04,
    });
    const jointMat = new THREE.MeshStandardMaterial({
      color: COLORS.magenta,
      emissive: COLORS.magenta,
      emissiveIntensity: 0.8,
    });

    const part = (geo: THREE.BufferGeometry, mat = body, edge: number = COLORS.cyan) => {
      const m = new THREE.Mesh(geo, mat);
      addEdges(m, edge);
      return m;
    };
    const joint = (r: number) => {
      const j = new THREE.Mesh(new THREE.CylinderGeometry(r, r, r * 1.6, 16), jointMat);
      j.rotation.z = Math.PI / 2; // axis along X, the pitch axis
      return j;
    };
    // a link whose length runs along +Y from its parent's origin
    const link = (len: number, w: number) => {
      const m = part(new THREE.BoxGeometry(w, len, w * 0.8));
      m.position.y = len / 2;
      return m;
    };

    // --- kinematic chain ---
    const pedestal = part(new THREE.CylinderGeometry(0.7, 0.85, 0.2, 8));
    pedestal.position.y = 0.1;
    scene.add(pedestal);

    const yaw = new THREE.Group(); // J1: base rotation
    yaw.position.y = 0.2;
    scene.add(yaw);
    const turret = part(new THREE.CylinderGeometry(0.45, 0.55, BASE_H, 8));
    turret.position.y = BASE_H / 2;
    yaw.add(turret);

    const shoulder = new THREE.Group(); // J2
    shoulder.position.y = BASE_H;
    shoulder.add(joint(0.22), link(L1, 0.26));
    yaw.add(shoulder);

    const elbow = new THREE.Group(); // J3
    elbow.position.y = L1;
    elbow.add(joint(0.18), link(L2, 0.2));
    shoulder.add(elbow);

    const wrist = new THREE.Group(); // J5
    wrist.position.y = L2;
    wrist.add(joint(0.13));
    const flange = part(new THREE.CylinderGeometry(0.1, 0.12, WRIST, 8));
    flange.position.y = WRIST / 2;
    wrist.add(flange);
    elbow.add(wrist);

    const tool = new THREE.Group(); // J6 roll + gripper
    tool.position.y = WRIST;
    wrist.add(tool);
    const palm = part(new THREE.BoxGeometry(0.34, 0.06, 0.14));
    tool.add(palm);
    const fingers = [-1, 1].map((side) => {
      const f = part(new THREE.BoxGeometry(0.05, 0.22, 0.1), body, COLORS.yellow);
      f.position.set(side * 0.12, 0.14, 0);
      tool.add(f);
      return f;
    });

    // target marker
    const target = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.08),
      new THREE.MeshBasicMaterial({ color: COLORS.yellow, wireframe: true }),
    );
    scene.add(target);
    const goal = new THREE.Vector3(1.2, 1.0, 1.4);
    target.position.copy(goal);

    // --- pointer input ---
    const pointer = new THREE.Vector2();
    let lastPointer = -Infinity;
    const onPointer = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.set(
        THREE.MathUtils.clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1.5, 1.5),
        THREE.MathUtils.clamp(-(((e.clientY - r.top) / r.height) * 2 - 1), -1.5, 1.5),
      );
      lastPointer = performance.now();
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    const solveIK = (p: THREE.Vector3) => {
      const phi = Math.atan2(p.x, p.z);
      const r = Math.hypot(p.x, p.z);
      const h = p.y - (0.2 + BASE_H);
      const d = THREE.MathUtils.clamp(Math.hypot(r, h), 0.4, L1 + L2 - 1e-3);
      const alpha = Math.atan2(r, h); // target direction, measured from vertical
      const beta = Math.acos((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d));
      const gamma = Math.acos((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2));
      const q2 = alpha - beta; // elbow-up solution
      const q3 = Math.PI - gamma;
      yaw.rotation.y = phi;
      shoulder.rotation.x = q2;
      elbow.rotation.x = q3;
      // keep the gripper angled down toward the work surface
      wrist.rotation.x = 2.3 - (q2 + q3);
    };

    const tmp = new THREE.Vector3();
    return {
      update(t, dt) {
        const idle = performance.now() - lastPointer > 2500;
        if (idle) {
          tmp.set(Math.sin(t * 0.5) * 1.6, 0.9 + Math.sin(t * 0.8) * 0.5, 1.3 + Math.cos(t * 0.35) * 0.4);
        } else {
          tmp.set(pointer.x * 2.0, 1.1 + pointer.y * 0.9, 1.4);
        }
        // critically-damped-ish smoothing toward the goal
        goal.lerp(tmp, reducedMotion ? 1 : 1 - Math.exp(-dt * 4));
        target.position.copy(goal);
        target.rotation.y += dt * 2;
        solveIK(goal);

        tool.rotation.y = Math.sin(t * 0.6) * 0.8;
        const open = 0.12 + (Math.sin(t * 2) * 0.5 + 0.5) * 0.06;
        fingers[0].position.x = -open;
        fingers[1].position.x = open;
        jointMat.emissiveIntensity = 0.6 + Math.sin(t * 3) * 0.25;
      },
      dispose() {
        window.removeEventListener('pointermove', onPointer);
      },
    };
  });
}
