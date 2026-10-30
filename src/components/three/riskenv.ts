/**
 * A TypeScript port of the riskenv Python package (rymc-dev/riskenv v1.0.0),
 * function for function, so the Three.js demos run the real algorithm.
 * Planar only, like the package: positions are [x, y] in metres.
 */
export type Vec2 = [number, number];

export interface Body {
  position: Vec2;
  heading: number; // rad, from +x
  speed: number; // m/s
  yawRate: number; // rad/s
  safetyRadius: number; // m
}

export interface ObstacleWithMetrics {
  obstacle: Body;
  tcpa: number;
  dcpa: number;
}

const velocity = (b: Body): Vec2 => [b.speed * Math.cos(b.heading), b.speed * Math.sin(b.heading)];

/** risk_assessment.calc_cpa: returns [dcpa, tcpa], either may be NaN. */
export function calcCpa(agent: Body, obstacle: Body): [number, number] {
  const [v1x, v1y] = velocity(agent);
  const [v2x, v2y] = velocity(obstacle);
  const px = agent.position[0] - obstacle.position[0];
  const py = agent.position[1] - obstacle.position[1];
  const vx = v1x - v2x;
  const vy = v1y - v2y;
  const vRelNormSq = vx * vx + vy * vy;
  if (vRelNormSq < 1e-6) {
    if (Math.abs(px) < 1e-8 && Math.abs(py) < 1e-8) return [NaN, Infinity];
    const distance = Math.hypot(px, py);
    const speed = Math.hypot(v1x, v1y);
    return [distance, speed > 0 ? distance / speed : Infinity];
  }
  const tcpa = -(px * vx + py * vy) / vRelNormSq;
  if (!(tcpa > 0)) return [NaN, NaN];
  return [Math.hypot(px + tcpa * vx, py + tcpa * vy), tcpa];
}

/** position_prediction.predict_position: constant yaw-rate dead reckoning. */
export function predictPosition(b: Body, dt: number): Vec2 {
  const yaw = b.heading + b.yawRate * dt;
  return [b.position[0] + b.speed * Math.cos(yaw) * dt, b.position[1] + b.speed * Math.sin(yaw) * dt];
}

const gap = (a: Body, b: Body) =>
  Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1]) - (a.safetyRadius + b.safetyRadius);

/** indices_of_interest.calc_I1: obstacles within dsf of the agent (net of safety radii). */
export const calcI1 = (agent: Body, metrics: ObstacleWithMetrics[], dsf: number) =>
  metrics.filter((o) => gap(agent, o.obstacle) <= dsf);

/** indices_of_interest.calc_I2: members of I1 with another obstacle within dsf. */
export const calcI2 = (I1: ObstacleWithMetrics[], metrics: ObstacleWithMetrics[], dsf: number) =>
  I1.filter((o) => metrics.some((other) => other !== o && gap(o.obstacle, other.obstacle) <= dsf));

/** indices_of_interest.calc_I3: DCPA within dsf and TCPA within the time of interest. */
export const calcI3 = (metrics: ObstacleWithMetrics[], dsf: number, timeOfInterest: number) =>
  metrics.filter((o) => !isNaN(o.dcpa) && !isNaN(o.tcpa) && o.dcpa <= dsf && o.tcpa <= timeOfInterest);

/** collision_geometry._circle_vertices */
export function circleVertices([cx, cy]: Vec2, radius: number, numPoints = 10): Vec2[] {
  return Array.from({ length: numPoints }, (_, i) => {
    const t = (2 * Math.PI * i) / numPoints;
    return [cx + radius * Math.cos(t), cy + radius * Math.sin(t)] as Vec2;
  });
}

/** 2-D convex hull (Andrew's monotone chain), counter-clockwise like scipy's ConvexHull. */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** collision_geometry.gen_uIoI_convhull: hull of current and predicted-CPA safety circles. */
export function genUIoIConvhull(uIoI: ObstacleWithMetrics[]): Vec2[] {
  const vertices: Vec2[] = [];
  for (const o of uIoI) {
    vertices.push(...circleVertices(o.obstacle.position, o.obstacle.safetyRadius));
    if (!isNaN(o.tcpa) && o.tcpa > 0 && isFinite(o.tcpa)) {
      vertices.push(...circleVertices(predictPosition(o.obstacle, o.tcpa), o.obstacle.safetyRadius));
    }
  }
  return vertices.length ? convexHull(vertices) : [];
}

export interface UnsafeSet {
  metrics: ObstacleWithMetrics[];
  I1: ObstacleWithMetrics[];
  I2: ObstacleWithMetrics[];
  I3: ObstacleWithMetrics[];
  uIoI: ObstacleWithMetrics[];
  hull: Vec2[];
}

/** unsafe_set.create_unsafe_set, also returning the intermediate sets for display. */
export function createUnsafeSet(agent: Body, obstacles: Body[], dsf: number, timeOfInterest = 15.0): UnsafeSet {
  const metrics = obstacles.map((obstacle) => {
    const [dcpa, tcpa] = calcCpa(agent, obstacle);
    return { obstacle, dcpa, tcpa };
  });
  const I1 = calcI1(agent, metrics, dsf);
  const I2 = calcI2(I1, metrics, dsf);
  const I3 = calcI3(metrics, dsf, timeOfInterest);
  const uIoI = [...new Set([...I1, ...I2, ...I3])];
  return { metrics, I1, I2, I3, uIoI, hull: uIoI.length ? genUIoIConvhull(uIoI) : [] };
}
