/**
 * Registry of Three.js scenes. Each module exports `mount(canvas) => cleanup`.
 * Modules are dynamically imported, so Three.js only loads on pages that use a scene.
 *
 * To add a scene: create `MyScene.ts` exporting `mount`, then add an entry here.
 * It will show up on /lab and can be embedded anywhere with <SceneCanvas scene="my-scene" />.
 */
export interface SceneModule {
  mount(canvas: HTMLCanvasElement): () => void;
}

export interface SceneEntry {
  title: string;
  description: string;
  tags: string[];
  load: () => Promise<SceneModule>;
}

export const scenes: Record<string, SceneEntry> = {
  'robot-arm': {
    title: 'Robot Arm IK',
    description: 'A low-poly manipulator tracking your cursor with analytic two-link inverse kinematics.',
    tags: ['kinematics', 'manipulation'],
    load: () => import('./RobotArmScene'),
  },
  'lidar-scan': {
    title: 'LiDAR Sweep',
    description: 'A 16-beam spinning LiDAR driving through a room, building a fading point cloud.',
    tags: ['perception', 'sensors'],
    load: () => import('./LidarScene'),
  },
};
