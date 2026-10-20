/**
 * The Fairmind mark that floats over the head of a sub-agent spawned from a Fairmind plugin (src/scene/fairmind.ts
 * isFairmindAgent): a small teal disc with the brand's head-profile mark (traced from the FairMind Studio favicon), drawn
 * from primitives, never a texture, in the house style of every other part a robot wears. Its geometry and its
 * materials are shared by every robot that can show it (attachFairmindBadge, through the scene's own Geometries and
 * Materials) — one disc geometry, one mark geometry, one material each — so that it costs two draw calls on a robot
 * that has it and none on one that does not: a session's robot never does (a session carries no agent type at all,
 * isFairmindAgent(null) is always false), and neither does a sub-agent from anywhere else.
 *
 * Attached directly to a robot's top-level group (robot.ts RobotObject.group), not to its neck: a badge that rode the
 * head would tip with it in a leisure pose's lean (robot.ts POSES) and nod with its doze and breathe loops
 * (robot.ts animateRobot) — the badge should not. It turns in place to face the camera's azimuth every frame
 * (orientFairmindBadge, floor-scene.ts place()), the same rotation a billboard sprite would carry, so that a robot
 * walking past, or seen from any of the floor's default orbit azimuths, still reads it face-on. It casts no shadow:
 * at this size, above every robot's head, it would leave only a speck.
 */
import { CircleGeometry, Group, Mesh, Shape, ShapeGeometry, type BufferGeometry } from 'three';
import type { Materials } from './materials';
import type { Geometries } from './props';
import type { RobotKind } from './robot';
import { isFairmindAgent } from '../../src/scene/fairmind';

/** The name of a robot's badge group (robot.group.getObjectByName), for picking it out in tests and in the scene graph. */
export const FAIRMIND_BADGE_NAME = 'fairmind-badge';

/**
 * Sizing, in a built robot's own local units (its group's frame, before its kind's KIND_SCALE, robot.ts): `y` clears
 * the top of the kind's head — an intern's bare monitor-head crests at 1.04 there, a workflow agent's hard hat at
 * 1.195 — with a little daylight above it; `r` is the disc's radius, chosen so a 0.55 intern's badge (the smallest a
 * kind draws) still reads at floor distance; `mark` scales the mark's own authoring square (markShapes, [-0.5, 0.5]
 * either way) down to fit inside the disc with a margin.
 *
 * Exported so `fairmind-forms.ts` can match its own enlarged per-family call forms to this same scale (`r`,
 * `mark`) and reuse `y.workflow` as the one head-clearance height every kind now shares (`robot.ts`
 * `FAIRMIND_FORM_Y`) — a call form shows on every kind, including `'session'`, which never gets this badge at all.
 */
export const BADGE = { y: { intern: 1.18, workflow: 1.34 }, r: 0.14, mark: 0.3 } as const;

/** A point of a centreline, in the mark's own authoring square: x right, y up, both roughly [-0.5, 0.5]. */
type Pt = readonly [number, number];

/** `b` to `a`, as a unit vector; (0, 1) when they coincide (a zero-length segment contributes no turn). */
function unit(a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len < 1e-9 ? [0, 1] : [dx / len, dy / len];
}

/**
 * The filled band of a stroke of this `width` along the centreline `pts` (robot.ts's tieBlade and dome build a part
 * each from a primitive; a hand-drawn mark has no such primitive, so this is the one its shapes are built from): at
 * each point, the band's edge sits half the width along the average of its two segments' normals, so that a bend
 * does not pinch or gape. Butt ends: the mark's own strokes end inside another shape, or at a corner, never bare.
 */
function strokeShape(pts: readonly Pt[], width: number): Shape {
  const n = pts.length;
  const normals: Pt[] = pts.map((p, i) => {
    const dirs: Pt[] = [];
    if (i > 0) dirs.push(unit(pts[i - 1]!, p));
    if (i < n - 1) dirs.push(unit(p, pts[i + 1]!));
    const sum = dirs.reduce((s, [dx, dy]) => [s[0] + dx, s[1] + dy] as Pt, [0, 0] as Pt);
    const len = Math.hypot(sum[0], sum[1]) || 1;
    // The direction's own normal (rotated a quarter turn) is the band's edge direction at that point.
    return [-sum[1] / len, sum[0] / len];
  });
  const half = width / 2;
  const left = pts.map((p, i) => [p[0] + normals[i]![0] * half, p[1] + normals[i]![1] * half] as Pt);
  const right = pts.map((p, i) => [p[0] - normals[i]![0] * half, p[1] - normals[i]![1] * half] as Pt);
  const shape = new Shape();
  shape.moveTo(...left[0]!);
  for (const p of left.slice(1)) shape.lineTo(...p);
  for (const p of [...right].reverse()) shape.lineTo(...p);
  shape.closePath();
  return shape;
}

/**
 * The head's profile, left-facing, as an open stroke (the FairMind Studio favicon): the forehead's slant down to the nose's
 * ledge, the chin's drop, the jaw's bottom, and the hook that curves up the back of the head, to its own rounded cap.
 * Traced from the reference pixel for pixel (a flood fill of its white pixels, by row), then centred.
 */
const PROFILE: readonly Pt[] = [
  [-0.154, 0.275],
  [-0.338, -0.074],
  [-0.282, -0.096],
  [-0.282, -0.276],
  [0.217, -0.276],
  [0.263, -0.18],
  [0.248, -0.146],
];
const PROFILE_WIDTH = 0.08;

/**
 * The brain's two stacked "S" bars, as one ribbon folding four times (traced the same way as PROFILE): each fold is a
 * tooth the width of the mark's own stroke, its ends connected by a short stroke down to the next, alternating sides;
 * the ribbon narrows into its own tail at the bottom.
 */
const BARS: readonly Pt[] = [
  [0.033, 0.269],
  [0.323, 0.269],
  [0.288, 0.188],
  [-0.098, 0.188],
  [-0.067, 0.11],
  [0.385, 0.11],
  [0.35, 0.026],
  [0.033, 0.026],
  [0.192, -0.055],
  [0.241, -0.093],
];
const BARS_WIDTH = 0.07;

/** The mark's geometry, built once: the profile and the bars, one strip each, merged into a single flat mesh. */
function markShapes(): Shape[] {
  return [strokeShape(PROFILE, PROFILE_WIDTH), strokeShape(BARS, BARS_WIDTH)];
}

/**
 * The mark's own shared geometry (the profile and the bars, `markShapes`), by the key every user of it must agree
 * on: this badge, and the on-call headset's Fairmind earpiece (robot.ts HEADSET, hq-mcp-switchboard proposal.md §4
 * "FairMind VIP: reuses the existing fairmind-badge.ts mark geometry … 0 new geometry"). Exported rather than left
 * for a second caller to re-derive the key string by hand, which `Geometries.shared` would otherwise accept
 * silently as a second, unrelated geometry if the string ever drifted.
 */
export function fairmindMarkGeometry(geo: Geometries): BufferGeometry {
  return geo.shared('fairmind-badge-mark', () => new ShapeGeometry(markShapes()));
}

/**
 * Gives `root` (a robot's top-level group) its Fairmind badge, over its head, facing forward and hidden: floor-scene.ts
 * sets it to show (setFairmindBadge) once it knows the agent's own type, and turns it to the camera every frame
 * (orientFairmindBadge). A session's robot never gets one (`kind === 'session'`): a session carries no agent type, so
 * it could never show one anyway, and the budget (ui/test/renderer/budget.test.ts) counts only what is shown.
 *
 * The disc and the mark are built once per scene, through `geo` and `mats` (the same Geometries and Materials every
 * other part of the floor shares and frees on dispose, props.ts, materials.ts): every robot's badge reuses them, so
 * showing one costs two draw calls and never a new geometry or material.
 */
export function attachFairmindBadge(root: Group, kind: RobotKind, geo: Geometries, mats: Materials): Group | null {
  if (kind === 'session') return null;
  const discGeo = geo.shared(`fairmind-badge-disc-${BADGE.r}`, () => new CircleGeometry(BADGE.r, 24));
  const markGeo = fairmindMarkGeometry(geo);
  const group = new Group();
  group.name = FAIRMIND_BADGE_NAME;
  group.position.set(0, BADGE.y[kind], 0);
  group.visible = false;
  const disc = new Mesh(discGeo, mats.fairmindDisc);
  disc.castShadow = false;
  disc.receiveShadow = false;
  const mark = new Mesh(markGeo, mats.fairmindMark);
  mark.position.z = 0.004;
  mark.scale.setScalar(BADGE.mark);
  mark.castShadow = false;
  mark.receiveShadow = false;
  group.add(disc, mark);
  root.add(group);
  return group;
}

/** Shows the badge for an agent of this type, hides it for any other: the one classifier (src/scene/fairmind.ts) decides. */
export function setFairmindBadge(badge: Group | null, type: string | null): void {
  if (badge) badge.visible = isFairmindAgent(type);
}

/** Turns a shown badge to face the camera: `facing` undoes its robot's own yaw, `azimuth` (world.ts) turns it the rest of the way to the camera, as a billboard would. A hidden badge is left alone: nothing reads its rotation while it does not show. */
export function orientFairmindBadge(badge: Group | null, facing: number, azimuth: number): void {
  if (badge && badge.visible) badge.rotation.y = azimuth - facing;
}
