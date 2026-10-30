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
  'bouncing-ball-automaton': {
    title: 'Hybrid Automaton: Bouncing Ball',
    description:
      'The classic hybrid system, run by a port of the hybrid-automaton runtime. Guards, resets and priorities drive the mode graph live. Move to change restitution, click to drop.',
    tags: ['hybrid-systems', 'control'],
    load: () => import('./BouncingBallScene'),
  },
  'cruise-control-automaton': {
    title: 'Hybrid Automaton: Cruise Control',
    description:
      'Four modes, nine prioritised transitions and a (gap, speed) phase portrait. Move across the scene to set the lead car\'s speed and push it into emergency braking.',
    tags: ['hybrid-systems', 'control'],
    load: () => import('./CruiseControlScene'),
  },
  'thermostat-chattering': {
    title: 'Hybrid Automaton: Thermostat Chattering',
    description:
      'A thermostat whose exit guards sit on its entry thresholds, so it switches modes about 80 times a second. Move to set the ambient temperature; click to add hysteresis.',
    tags: ['hybrid-systems', 'control'],
    load: () => import('./ThermostatScene'),
  },
  'traffic-light-context': {
    title: 'Hybrid Automaton: RuntimeContext Inspector',
    description:
      'A traffic light with no continuous state at all: every guard reads the runtime clock. Watch the live RuntimeContext and guard values; move to set time_in_green, click to switch clocks.',
    tags: ['hybrid-systems', 'runtime'],
    load: () => import('./TrafficLightScene'),
  },
};
