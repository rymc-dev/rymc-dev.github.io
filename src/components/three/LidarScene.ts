import * as THREE from 'three';
import { COLORS, addEdges, addFloor, runStage } from './stage';

const LAYERS = 16; // vertical beams, like a VLP-16
const FOV_V = THREE.MathUtils.degToRad(30);
const STEP = THREE.MathUtils.degToRad(0.6);
const RPM = 60;
const MAX_POINTS = 24000;
const DECAY = 2.5; // seconds a return stays visible
const RANGE = 12;

type Box = { min: THREE.Vector3; max: THREE.Vector3 };

/** Ray vs axis-aligned box (slab method). Returns hit distance or Infinity. */
function rayBox(o: THREE.Vector3, d: THREE.Vector3, b: Box, inside: boolean): number {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const k of ['x', 'y', 'z'] as const) {
    const inv = 1 / d[k];
    let t0 = (b.min[k] - o[k]) * inv;
    let t1 = (b.max[k] - o[k]) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
  }
  if (tmax < Math.max(tmin, 0)) return Infinity;
  return inside ? tmax : tmin > 0 ? tmin : Infinity;
}

/**
 * A spinning multi-beam LiDAR driving through a room, accumulating a fading
 * point cloud. Ray casting is done analytically against box obstacles.
 */
export function mount(canvas: HTMLCanvasElement): () => void {
  return runStage(canvas, ({ scene, camera, reducedMotion }) => {
    camera.position.set(0, 9, 10);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    addFloor(scene);

    const room: Box = { min: new THREE.Vector3(-7, 0, -5), max: new THREE.Vector3(7, 3, 5) };
    const obstacles: Box[] = [
      [-4, -2, 1.2, 1.2, 1.5],
      [3.5, 2, 1.6, 0.8, 1.0],
      [0, -3.2, 3, 0.6, 0.9],
      [-2, 3, 0.5, 0.5, 2.2],
      [4.5, -2.5, 0.8, 1.6, 1.8],
      [-5.5, 3, 1, 1, 0.7],
    ].map(([x, z, w, dpt, h]) => ({
      min: new THREE.Vector3(x - w / 2, 0, z - dpt / 2),
      max: new THREE.Vector3(x + w / 2, h, z + dpt / 2),
    }));

    // faint wireframes so the scene reads before the cloud fills in
    const ghost = new THREE.MeshBasicMaterial({ visible: false });
    for (const b of [room, ...obstacles]) {
      const size = b.max.clone().sub(b.min);
      const m = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), ghost);
      m.position.copy(b.min).addScaledVector(size, 0.5);
      const e = addEdges(m, b === room ? COLORS.magenta : COLORS.cyan);
      (e.material as THREE.LineBasicMaterial).opacity = 0.12;
      scene.add(m);
    }

    // sensor puck
    const puck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, 0.2, 16),
      new THREE.MeshBasicMaterial({ color: COLORS.yellow }),
    );
    scene.add(puck);

    // point cloud ring buffer
    const pos = new Float32Array(MAX_POINTS * 3);
    const col = new Float32Array(MAX_POINTS * 3);
    const born = new Float32Array(MAX_POINTS).fill(-1e9);
    const hue = new Float32Array(MAX_POINTS);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const cloud = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.06,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    scene.add(cloud);

    const cA = new THREE.Color(COLORS.cyan);
    const cB = new THREE.Color(COLORS.magenta);
    const c = new THREE.Color();
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let head = 0;
    let angle = 0;

    const cast = (t: number, az: number) => {
      for (let l = 0; l < LAYERS; l++) {
        const el = -FOV_V / 2 + (FOV_V * l) / (LAYERS - 1);
        dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
        let hit = rayBox(origin, dir, room, true);
        if (dir.y < 0) hit = Math.min(hit, -origin.y / dir.y); // floor
        for (const b of obstacles) hit = Math.min(hit, rayBox(origin, dir, b, false));
        if (hit > RANGE) continue;
        const i = head;
        head = (head + 1) % MAX_POINTS;
        pos[i * 3] = origin.x + dir.x * hit;
        pos[i * 3 + 1] = origin.y + dir.y * hit;
        pos[i * 3 + 2] = origin.z + dir.z * hit;
        hue[i] = pos[i * 3 + 1] / 3;
        born[i] = t;
      }
    };

    return {
      update(t, dt) {
        // drive a slow figure-eight
        const s = t * 0.25;
        origin.set(Math.sin(s) * 4, 0.8, Math.sin(s * 2) * 2.2);
        puck.position.copy(origin);

        if (reducedMotion) {
          // one full sweep from a fixed spot
          for (let a = 0; a < Math.PI * 2; a += STEP) cast(0, a);
          t = 0;
        } else {
          const next = angle + ((RPM / 60) * Math.PI * 2) * dt;
          for (; angle < next; angle += STEP) cast(t, angle);
          angle %= Math.PI * 2;
        }

        for (let i = 0; i < MAX_POINTS; i++) {
          const k = Math.max(0, 1 - (t - born[i]) / DECAY);
          c.copy(cA).lerp(cB, hue[i]).multiplyScalar(k);
          col[i * 3] = c.r;
          col[i * 3 + 1] = c.g;
          col[i * 3 + 2] = c.b;
        }
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
      },
    };
  });
}
