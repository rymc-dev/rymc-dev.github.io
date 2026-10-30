/**
 * A TypeScript port of colav-automaton v1.0.6 (rymc-dev/colav-automaton):
 * the ColavAutomaton's guards, resets, invariants and flows, plus the COLREGs
 * classification module. Built on the riskenv port. Shapely calls are
 * replaced with exact convex-polygon geometry, which holds because the unsafe
 * region is always riskenv's convex hull.
 */
import {
  type Body,
  type ObstacleWithMetrics,
  type Vec2,
  calcCpa,
  calcI1,
  calcI2,
  calcI3,
} from './riskenv';

// ---------------------------------------------------------------------------
// convex-polygon geometry (polygons are CCW, as riskenv's hull returns them)
// ---------------------------------------------------------------------------

const EPS = 1e-9;
const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function pointInConvex(p: Vec2, poly: Vec2[], strict = false): boolean {
  for (let i = 0; i < poly.length; i++) {
    const c = cross(poly[i], poly[(i + 1) % poly.length], p);
    if (strict ? c <= EPS : c < -EPS) return false;
  }
  return true;
}

/** Cyrus-Beck: the parameter range [tE, tL] of segment a->b inside the polygon, or null. */
export function clipSegment(a: Vec2, b: Vec2, poly: Vec2[]): [number, number] | null {
  let tE = 0;
  let tL = 1;
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    // inward normal of a CCW edge
    const n: Vec2 = [-(q[1] - p[1]), q[0] - p[0]];
    const num = n[0] * (a[0] - p[0]) + n[1] * (a[1] - p[1]);
    const den = n[0] * d[0] + n[1] * d[1];
    if (Math.abs(den) < EPS) {
      if (num < -EPS) return null; // parallel and outside
      continue;
    }
    const t = -num / den;
    if (den > 0) tE = Math.max(tE, t);
    else tL = Math.min(tL, t);
    if (tE > tL + EPS) return null;
  }
  return [tE, tL];
}

function distPointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** shapely Point(c).buffer(r).intersects(Polygon(poly)) */
export function circleIntersectsPolygon(c: Vec2, r: number, poly: Vec2[]): boolean {
  if (poly.length < 3) return false;
  if (pointInConvex(c, poly)) return true;
  return poly.some((p, i) => distPointSegment(c, p, poly[(i + 1) % poly.length]) <= r);
}

/** shapely polygon.exterior.crosses(LineString([agent, vertex])) for a convex polygon. */
function rayCrossesExterior(agent: Vec2, vertex: Vec2, poly: Vec2[]): boolean {
  if (pointInConvex(agent, poly)) return false; // from inside, it only touches at the vertex
  const clip = clipSegment(agent, vertex, poly);
  if (!clip || clip[1] - clip[0] < 1e-7) return false;
  return pointInConvex(lerp2(agent, vertex, (clip[0] + clip[1]) / 2), poly, true);
}

const wrapAngle = (a: number) => {
  const m = (a + Math.PI) % (2 * Math.PI);
  return (m < 0 ? m + 2 * Math.PI : m) - Math.PI;
};

// ---------------------------------------------------------------------------
// classification (colav_automaton.classification)
// ---------------------------------------------------------------------------

export type Encounter = 'head_on' | 'crossing_give_way' | 'crossing_stand_on' | 'overtaking' | 'overtaken' | 'none';
export type Side = 'port' | 'starboard';

export interface Ship extends Body {
  tag: string;
}

export interface Maneuver {
  side: Side;
  giveWay: boolean;
  urgency: number;
  reason: string;
  encounter: Encounter;
}

export const VESSEL_TYPE_PRIORITY: Record<string, number> = {
  power_driven: 0,
  sailing: 1,
  fishing: 2,
  constrained_by_draft: 3,
  restricted_maneuverability: 4,
  not_under_command: 5,
};

const VESSEL_TYPE_KEYWORDS: [string, string][] = [
  ['not under command', 'not_under_command'],
  ['nuc', 'not_under_command'],
  ['restricted', 'restricted_maneuverability'],
  ['dredg', 'restricted_maneuverability'],
  ['constrained', 'constrained_by_draft'],
  ['tanker', 'constrained_by_draft'],
  ['fishing', 'fishing'],
  ['trawler', 'fishing'],
  ['sail', 'sailing'],
  ['hydrofoil', 'power_driven'],
  ['motor', 'power_driven'],
  ['tug', 'power_driven'],
  ['cargo', 'power_driven'],
];

export function normalizeVesselType(rawTag: string): string {
  const tag = (rawTag || '').trim().toLowerCase();
  return VESSEL_TYPE_KEYWORDS.find(([k]) => tag.includes(k))?.[1] ?? 'power_driven';
}

const rad = (deg: number) => (deg * Math.PI) / 180;
export const HEAD_ON_BEARING_LIMIT = rad(15.0);
const HEAD_ON_HEADING_SLACK = rad(30.0);
export const ABAFT_BEAM_LIMIT = rad(112.5);
const SAME_DIRECTION_LIMIT = rad(67.5);

/** Negative = to starboard, positive = to port. */
export const relativeBearing = (from: Vec2, fromHeading: number, to: Vec2) =>
  wrapAngle(Math.atan2(to[1] - from[1], to[0] - from[0]) - fromHeading);

export function classifyEncounter(agent: Body, obstacle: Body): Encounter {
  if (Math.hypot(agent.position[0] - obstacle.position[0], agent.position[1] - obstacle.position[1]) < 1e-6) return 'none';
  const bearingToObstacle = relativeBearing(agent.position, agent.heading, obstacle.position);
  const bearingToAgent = relativeBearing(obstacle.position, obstacle.heading, agent.position);
  const headingDiff = wrapAngle(obstacle.heading - agent.heading);
  const reciprocal = Math.abs(Math.abs(headingDiff) - Math.PI) < HEAD_ON_HEADING_SLACK;
  const sameDirection = Math.abs(headingDiff) < SAME_DIRECTION_LIMIT;

  if (Math.abs(bearingToObstacle) <= HEAD_ON_BEARING_LIMIT && Math.abs(bearingToAgent) <= HEAD_ON_BEARING_LIMIT && reciprocal) {
    return 'head_on';
  }
  if (sameDirection && Math.abs(bearingToAgent) > ABAFT_BEAM_LIMIT) return 'overtaking';
  if (sameDirection && Math.abs(bearingToObstacle) > ABAFT_BEAM_LIMIT) return 'overtaken';
  if (Math.abs(bearingToObstacle) < ABAFT_BEAM_LIMIT) return bearingToObstacle < 0 ? 'crossing_give_way' : 'crossing_stand_on';
  return 'none';
}

const ENCOUNTER_DEFAULTS: Record<Encounter, [Side, boolean, number, string]> = {
  head_on: ['starboard', true, 0.9, 'Rule 14 head-on: alter course to starboard'],
  crossing_give_way: ['starboard', true, 0.8, 'Rule 15 crossing, obstacle to starboard: give way'],
  crossing_stand_on: ['starboard', false, 0.15, 'Rule 17 crossing, obstacle to port: stand on'],
  overtaking: ['starboard', true, 0.5, 'Rule 13 overtaking: give way, pass to starboard'],
  overtaken: ['starboard', false, 0.1, 'Rule 13 being overtaken: stand on'],
  none: ['starboard', false, 0.0, 'No COLREGs-significant encounter'],
};

export function determineManeuver(agent: Body, m: ObstacleWithMetrics & { obstacle: Ship }): Maneuver {
  const encounter = classifyEncounter(agent, m.obstacle);
  let [side, giveWay, urgency, reason] = ENCOUNTER_DEFAULTS[encounter];
  const vesselType = normalizeVesselType(m.obstacle.tag);
  if ((VESSEL_TYPE_PRIORITY[vesselType] ?? 0) > VESSEL_TYPE_PRIORITY.power_driven) {
    if (!giveWay) {
      giveWay = true;
      urgency = Math.max(urgency, 0.5);
    } else {
      urgency = Math.min(1.0, urgency + 0.2);
    }
    reason += `; Rule 18: '${vesselType}' outranks power-driven`;
  }
  if (!isNaN(m.dcpa) && !isNaN(m.tcpa) && m.tcpa >= 0) {
    const combined = Math.max(agent.safetyRadius + m.obstacle.safetyRadius, 1e-6);
    urgency = Math.min(1.0, urgency + 0.3 * Math.max(0, Math.min(1, 1 - m.dcpa / combined)));
  }
  return { side, giveWay, urgency: Math.round(urgency * 1000) / 1000, reason, encounter };
}

export function aggregateManeuvers(maneuvers: Maneuver[]): Maneuver {
  if (!maneuvers.length) {
    return { side: 'starboard', giveWay: false, urgency: 0, reason: 'No obstacles to classify', encounter: 'none' };
  }
  // highest urgency wins, starboard breaks ties
  return maneuvers.reduce((best, m) =>
    m.urgency > best.urgency || (m.urgency === best.urgency && m.side === 'starboard' && best.side !== 'starboard') ? m : best,
  );
}

/** classify_unsafe_set_obstacles: classify only riskenv's union of interest, then aggregate. */
export function classifyUnsafeSetObstacles(agent: Body, ships: Ship[], dsf: number, timeOfInterest = 15.0): Maneuver {
  const metrics = ships.map((obstacle) => {
    const [dcpa, tcpa] = calcCpa(agent, obstacle);
    return { obstacle, dcpa, tcpa };
  });
  const I1 = calcI1(agent, metrics, dsf);
  const I2 = calcI2(I1, metrics, dsf);
  const I3 = calcI3(metrics, dsf, timeOfInterest);
  const uIoI = [...new Set([...I1, ...I2, ...I3])];
  return aggregateManeuvers(uIoI.map((m) => determineManeuver(agent, m as ObstacleWithMetrics & { obstacle: Ship })));
}

// ---------------------------------------------------------------------------
// the automaton (colav_automaton.automaton.ColavAutomaton)
// ---------------------------------------------------------------------------

export type Mode = 'Transit' | 'Fallback' | 'Waypoint_Reached';
export type Status = 'ACTIVE' | 'SUCCESS' | 'FAILURE';

export interface ColavConfig {
  k_theta: number;
  k_v: number;
  constant_velocity: number;
  agent_safety_radius: number;
  acceptance_radius: number;
  los_distance_threshold: number;
  lateral_offset_distance: number;
  fallback_timeout: number;
}

export const DEFAULT_CONFIG: ColavConfig = {
  k_theta: 1.0,
  k_v: 1.0,
  constant_velocity: 2.0,
  agent_safety_radius: 30.0,
  acceptance_radius: 5,
  los_distance_threshold: 60.0,
  lateral_offset_distance: 50.0,
  fallback_timeout: 30.0,
};

export interface ColavContext {
  x: [px: number, py: number, theta: number, v: number, yawRate: number];
  waypoints: Vec2[]; // aux buffer: [goal, virtual?]; latest() is the last entry
  unsafeRegion: Vec2[];
  maneuverBias: { side: Side; urgency: number } | null;
  config: ColavConfig;
  mode: Mode;
  status: Status;
  timeSinceTransition: number;
  transitionsCount: number;
  lastTransition: string;
  lastSide: Side | null; // side picked by the most recent e3 reroute
}

const latest = (ctx: ColavContext) => ctx.waypoints[ctx.waypoints.length - 1];
const pos = (ctx: ColavContext): Vec2 => [ctx.x[0], ctx.x[1]];

// --- guards ---

/** Where the LOS hits the unsafe region (midpoint of the overlap), or null. */
export function losIntersection(ctx: ColavContext): Vec2 | null {
  if (ctx.unsafeRegion.length < 3) return null;
  const clip = clipSegment(pos(ctx), latest(ctx), ctx.unsafeRegion);
  if (!clip) return null;
  return lerp2(pos(ctx), latest(ctx), (clip[0] + clip[1]) / 2);
}

export const guards = {
  los_clear_to_waypoint_guard(ctx: ColavContext) {
    const hit = losIntersection(ctx);
    if (!hit) return false;
    return Math.hypot(hit[0] - ctx.x[0], hit[1] - ctx.x[1]) <= ctx.config.los_distance_threshold;
  },
  unsafe_conditions_guard: (ctx: ColavContext) => circleIntersectsPolygon(pos(ctx), ctx.config.agent_safety_radius, ctx.unsafeRegion),
  safe_conditions_guard: (ctx: ColavContext) => !circleIntersectsPolygon(pos(ctx), ctx.config.agent_safety_radius, ctx.unsafeRegion),
  virtual_waypoints_guard: (ctx: ColavContext) => ctx.waypoints.length > 1,
  waypoint_reached_guard(ctx: ColavContext) {
    const wp = latest(ctx);
    return ctx.config.acceptance_radius >= Math.hypot(ctx.x[0] - wp[0], ctx.x[1] - wp[1]);
  },
};

// --- resets ---

const ANGLE_COST_WEIGHT = 50.0;
const DISTANCE_COST_WEIGHT = 1.0;

function visibleSideVertices(ctx: ColavContext) {
  const [xx, yy, heading] = ctx.x;
  const visible = ctx.unsafeRegion.filter((v) => !rayCrossesExterior([xx, yy], v, ctx.unsafeRegion));
  if (!visible.length) throw new Error("No visible vertices from agent's position to unsafe set.");
  const withAngle = visible.map((v) => [v[0], v[1], wrapAngle(Math.atan2(v[1] - yy, v[0] - xx) - heading)] as const);
  // first occurrence of min / max, like numpy argmin / argmax
  const right = withAngle.reduce((a, b) => (b[2] < a[2] ? b : a));
  const left = withAngle.reduce((a, b) => (b[2] > a[2] ? b : a));
  return { right, left };
}

const navigationCost = (angle: number, vx: number, vy: number, xx: number, yy: number) =>
  ANGLE_COST_WEIGHT * Math.abs(angle) + DISTANCE_COST_WEIGHT * Math.hypot(vx - xx, vy - yy);

export function generateNewVirtualWaypoint(ctx: ColavContext) {
  const [xx, yy] = ctx.x;
  const { right, left } = visibleSideVertices(ctx);
  const defaultSide: Side =
    navigationCost(right[2], right[0], right[1], xx, yy) <= navigationCost(left[2], left[0], left[1], xx, yy) ? 'starboard' : 'port';
  const bias = ctx.maneuverBias;
  const side = bias ? bias.side : defaultSide;
  const urgency = bias ? bias.urgency : 0;
  const [cx, cy] = side === 'starboard' ? right : left;

  const goal = latest(ctx);
  const gx = goal[0] - xx;
  const gy = goal[1] - yy;
  const norm = Math.hypot(gx, gy);
  if (norm === 0) throw new Error('Agent position coincides with the current waypoint');
  const fwd: Vec2 = [gx / norm, gy / norm];
  const rightPerp: Vec2 = [fwd[1], -fwd[0]];
  const perp = side === 'starboard' ? rightPerp : ([-rightPerp[0], -rightPerp[1]] as Vec2);
  const offset = ctx.config.lateral_offset_distance * (1 + urgency);

  // replace a queued virtual waypoint in place rather than stacking another
  if (ctx.waypoints.length > 1) ctx.waypoints.pop();
  ctx.waypoints.push([cx + perp[0] * offset, cy + perp[1] * offset]);
  ctx.lastSide = side;
}

export function popVirtualWaypoint(ctx: ColavContext) {
  if (ctx.waypoints.length <= 1) throw new Error('Cannot pop last waypoint');
  ctx.waypoints.pop();
}

// --- flows ---

function flow(ctx: ColavContext): number[] {
  const [px, py, theta, v] = ctx.x;
  const c = ctx.config;
  if (ctx.mode === 'Transit') {
    // flow_los_heading
    const [xw, yw] = latest(ctx);
    const eTheta = wrapAngle(Math.atan2(yw - py, xw - px) - theta);
    return [v * Math.cos(theta), v * Math.sin(theta), c.k_theta * eTheta, c.k_v * (c.constant_velocity - v), 0];
  }
  if (ctx.mode === 'Fallback') {
    // hold_position_dynamics: brake to a stop on the current heading
    return [v * Math.cos(theta), v * Math.sin(theta), 0, c.k_v * (0 - v), 0];
  }
  // constant_heading_dynamics
  return [v * Math.cos(theta), v * Math.sin(theta), 0, c.k_v * (c.constant_velocity - v), 0];
}

export interface Edge {
  name: string;
  from: Mode;
  to: Mode;
  guard: (ctx: ColavContext) => boolean;
  reset?: (ctx: ColavContext) => void;
  priority: number;
}

export const EDGES: Edge[] = [
  { name: 'e1', from: 'Transit', to: 'Waypoint_Reached', guard: guards.waypoint_reached_guard, priority: 0 },
  { name: 'e2', from: 'Transit', to: 'Fallback', guard: guards.unsafe_conditions_guard, priority: 2 },
  { name: 'e3', from: 'Transit', to: 'Transit', guard: guards.los_clear_to_waypoint_guard, reset: generateNewVirtualWaypoint, priority: 1 },
  { name: 'e4', from: 'Fallback', to: 'Transit', guard: guards.safe_conditions_guard, priority: 0 },
  { name: 'e5', from: 'Waypoint_Reached', to: 'Transit', guard: guards.virtual_waypoints_guard, reset: popVirtualWaypoint, priority: 0 },
];

export function createContext(x0: ColavContext['x'], goal: Vec2, config: Partial<ColavConfig> = {}): ColavContext {
  return {
    x: [...x0],
    waypoints: [[...goal]],
    unsafeRegion: [],
    maneuverBias: null,
    config: { ...DEFAULT_CONFIG, ...config },
    mode: 'Transit',
    status: 'ACTIVE',
    timeSinceTransition: 0,
    transitionsCount: 0,
    lastTransition: '',
    lastSide: null,
  };
}

/** One _Runtime._evaluation_step: integrate, fire the min-priority active edge, else check invariants. */
export function step(ctx: ColavContext, dt: number): Edge | null {
  if (ctx.status !== 'ACTIVE') return null;
  const xdot = flow(ctx);
  ctx.x = ctx.x.map((xi, i) => xi + dt * xdot[i]) as ColavContext['x'];
  ctx.timeSinceTransition += dt;

  const active = EDGES.filter((e) => e.from === ctx.mode && e.guard(ctx));
  if (active.length) {
    const edge = active.reduce((a, b) => (b.priority < a.priority ? b : a));
    try {
      edge.reset?.(ctx);
    } catch {
      ctx.status = 'FAILURE'; // the runtime's TRANSITION_ERROR
      return null;
    }
    ctx.mode = edge.to;
    ctx.timeSinceTransition = 0;
    ctx.transitionsCount++;
    ctx.lastTransition = edge.name;
    return edge;
  }
  // invariants: Fallback may idle up to fallback_timeout; Waypoint_Reached is final
  if (ctx.mode === 'Fallback' && ctx.timeSinceTransition >= ctx.config.fallback_timeout) ctx.status = 'FAILURE';
  if (ctx.mode === 'Waypoint_Reached') ctx.status = 'SUCCESS';
  return null;
}
