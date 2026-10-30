import * as THREE from 'three';

export const COLORS = {
  bg: 0x0a0a12,
  cyan: 0x00f0ff,
  magenta: 0xff2bd6,
  yellow: 0xf5ff3b,
  steel: 0x1a1a2a,
};

export interface Stage {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  reducedMotion: boolean;
}

export interface SceneHooks {
  /** Called every frame while the canvas is on screen. `t` and `dt` are in seconds. */
  update?(t: number, dt: number): void;
  dispose?(): void;
}

/**
 * Boilerplate shared by every scene: renderer, camera, resizing, pausing when
 * off-screen, and reduced-motion handling. Returns a cleanup function.
 */
export function runStage(canvas: HTMLCanvasElement, setup: (stage: Stage) => SceneHooks): () => void {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(COLORS.bg, 8, 22);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const hooks = setup({ canvas, renderer, scene, camera, reducedMotion });

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const clock = new THREE.Clock();
  let t = 0;
  const frame = () => {
    // clamp dt so the scene doesn't jump after a tab switch
    const dt = Math.min(clock.getDelta(), 0.05);
    t += dt;
    hooks.update?.(t, dt);
    renderer.render(scene, camera);
  };

  let visible = false;
  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (reducedMotion) return;
    if (visible) {
      clock.getDelta();
      renderer.setAnimationLoop(frame);
    } else {
      renderer.setAnimationLoop(null);
    }
  });
  io.observe(canvas);

  // reduced motion: draw one settled frame, then only re-render on demand
  if (reducedMotion) {
    hooks.update?.(0, 1);
    renderer.render(scene, camera);
  }

  return () => {
    io.disconnect();
    ro.disconnect();
    renderer.setAnimationLoop(null);
    hooks.dispose?.();
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    renderer.dispose();
  };
}

/** Neon wireframe edges for a mesh, added as a child so they follow it. */
export function addEdges(mesh: THREE.Mesh, color: number = COLORS.cyan, threshold = 20): THREE.LineSegments {
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry, threshold),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
  );
  mesh.add(edges);
  return edges;
}

/** Floor grid that fades into the fog. */
export function addFloor(scene: THREE.Scene, size = 20): void {
  const grid = new THREE.GridHelper(size, size * 2, COLORS.magenta, COLORS.cyan);
  const mat = grid.material as THREE.LineBasicMaterial;
  mat.transparent = true;
  mat.opacity = 0.18;
  scene.add(grid);
}

/** Text on a canvas texture, drawn as a camera-facing sprite. */
export function makeLabel(width: number, height: number, scale: number) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false }),
  );
  sprite.scale.set((width / height) * scale, scale, 1);
  let last = '';
  const draw = (lines: string[], color: number, size = 34) => {
    const key = lines.join('\n') + color;
    if (key === last) return;
    last = key;
    ctx.clearRect(0, 0, width, height);
    ctx.font = `${size}px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lh = size * 1.25;
    lines.forEach((l, i) => ctx.fillText(l, width / 2, height / 2 + (i - (lines.length - 1) / 2) * lh));
    texture.needsUpdate = true;
  };
  return { sprite, texture, draw };
}
