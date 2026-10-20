/**
 * FairMind's per-family VIP forms, shown big above the head while a call is live (hq-mcp-switchboard proposal.md
 * §2 "FairMind tool families" / §5 Phase 3; user-decisions.md Q2 "Brain-core orb first"; round-2 enlargement, see
 * robot.ts's own comment at `FAIRMIND_FORM_Y`): once a FairMind call is classified into its family (`classifyMcp`,
 * `tool-label.ts`), the robot shows that family's own motif in the same screen slot the agent-identity badge
 * occupies (`fairmind-badge.ts`), at the same visual scale — not the tiny earpiece bead the MVP drew it on, which
 * read as a stray dot at floor-view distance (round-1 feedback: the Brain orb at bead scale, 0.024 radius, was
 * "a tiny teal dot on the side of the head"). The headset's own hook and bead stay put at the ear, small, still
 * coloured by the call (`robot.ts` `HEADSET`/`setOnCall`) — the earpiece accent that ties the big form above the
 * head back to "a call, at this robot" without the form itself having to carry that cue:
 *
 * - Studio   — a drafting roll: a teal cylinder, like a blueprint tucked under an arm.
 * - General  — a document beam: a standing teal pane, the projects/sessions/RAG archive's own light.
 * - Brain    — a glowing teal orb ringed in gold: the decision graph's own core, and the most polished of the
 *              five (the user's own Q2 decision) — the only form with two meshes instead of one.
 * - Insights — a ticker: a wide, flat gold strip, telemetry always writing itself out.
 * - Code     — a wireframe teal cube: the code graph's own repo, drawn in line, not fill.
 * - default  — the brand mark alone (`fairmind-badge.ts`'s own mark geometry, at the badge's own scale), for a
 *              FairMind call with no family at all.
 *
 * Every mesh is `MeshBasicMaterial`, fixed teal (`mats.fairmindDisc`/`fairmindMark`/`fairmindWire`) or fixed gold
 * (`mats.fairmindGold`) — never a theme token, so the brand holds by day and by night (`materials.ts` `Recipe.
 * fixed`), the same discipline `FAIRMIND_TEAL` already keeps — and every mesh is `cast: false` (no new shadow
 * casters, the same budget rule the headset itself was built under, robot.ts HEADSET). All six forms are built
 * once, hidden, as siblings on one group (`attachFairmindForms`); `setFairmindForm` shows the one the call's
 * family picked and hides the rest, no rebuild, mirroring `setOnCall`/`setSmoking`. `robot.ts` parents that group
 * directly on the robot's own top-level group — not the neck, and not the headset — at `FAIRMIND_FORM_Y`, the
 * same height and the same "never tips or nods with the head" reasoning `fairmind-badge.ts` already gives its own
 * badge; `orientFairmindForms` (below) billboards it to the camera every frame for the same reason the badge does:
 * several of these forms (General's pane, Insights' ticker, the default mark's own flat profile) would foreshorten
 * to a sliver from the side otherwise.
 */
import { Group, Mesh, MeshBasicMaterial, Object3D, type BufferGeometry } from 'three';
import type { Materials } from './materials';
import { BADGE, fairmindMarkGeometry } from './fairmind-badge';
import type { Geometries } from './props';

/** A FairMind call's family (`OnCallView.family`, `classifyMcp`'s five prefixes), or `'default'` for none. */
export type FairmindFormKey = 'default' | 'Studio' | 'General' | 'Brain' | 'Insights' | 'Code';

const FORM_KEYS = ['default', 'Studio', 'General', 'Brain', 'Insights', 'Code'] as const satisfies readonly FairmindFormKey[];

/**
 * A call's family to the form key that shows it: an unrecognised or absent family reads as `'default'` — the
 * "sensible default form" a family:null FairMind call still deserves (`bulk_update_status`, `process_journal`,
 * every call outside the five prefixes `classifyMcp` knows, and any future prefix this table hasn't caught up to).
 */
export function fairmindFormOf(family: string | null): FairmindFormKey {
  return (FORM_KEYS as readonly string[]).includes(family ?? '') ? (family as FairmindFormKey) : 'default';
}

/** The group every form hangs from, and each form's own root object, by key, for `setFairmindForm` to toggle. */
export interface FairmindForms {
  group: Group;
  byKey: Readonly<Record<FairmindFormKey, Object3D>>;
}

/** A mesh that never casts or receives a shadow: above the head, at this size, either would cost a draw for little gain. */
function cheapMesh(parent: Object3D, geometry: BufferGeometry, material: MeshBasicMaterial): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);
  return mesh;
}

/**
 * Builds the six hidden forms on `parent` at local (0, 0, 0) (the caller positions `parent` itself, at
 * `FAIRMIND_FORM_Y` above the robot's own top-level group, robot.ts) and returns the handle `setFairmindForm`
 * needs. Sized to match `fairmind-badge.ts`'s own badge (disc radius 0.14, mark scale 0.3) — the screen real
 * estate this phase now shares with it — rather than the MVP's bead scale (a 0.03-radius earpiece bead's own
 * neighbourhood). `0 new geometry` in the sense every other part of the floor already claims it (props.ts
 * `Geometries.shared`): each shape is a `geo.ball`/`rod`/`box`/`arc` the cache has not seen at this exact size
 * before, the same way the bar cart's dozen box sizes or the coffee machine's own rods are, never a hand-authored
 * `BufferGeometry`, so no new geometry *kind* enters the scene, only new cached sizes of the kinds every prop
 * already draws from.
 */
export function attachFairmindForms(parent: Group, geo: Geometries, mats: Materials): FairmindForms {
  const byKey: Record<FairmindFormKey, Object3D> = {} as Record<FairmindFormKey, Object3D>;

  // default: the brand mark alone, at the real badge's own mark scale (BADGE.mark) — this call form and the badge
  // occupy the very same spot above the head (robot.ts FAIRMIND_FORM_Y), so a family-less FairMind call reads as
  // literally the badge's own mark, no disc behind it (the mesh-count test below pins this at one mesh).
  const defaultMark = cheapMesh(parent, fairmindMarkGeometry(geo), mats.fairmindMark);
  defaultMark.position.z = 0.01;
  defaultMark.scale.setScalar(BADGE.mark);
  byKey.default = defaultMark;

  // Studio: a drafting roll, a teal cylinder laid on a diagonal, like a blueprint tucked under an arm — tilted on
  // two axes, not laid flat on one, so its own length still reads from the floor's usual viewing angles instead of
  // foreshortening to a circle the same silhouette as every other form's own footprint.
  const studio = cheapMesh(parent, geo.rod(0.055, 0.055, 0.22), mats.fairmindDisc);
  studio.rotation.z = Math.PI / 2.3;
  studio.rotation.x = Math.PI / 5;
  byKey.Studio = studio;

  // General (+ rag_): a document beam, a standing teal pane — the projects/sessions/RAG archive's own light.
  const general = cheapMesh(parent, geo.box(0.085, 0.22, 0.016), mats.fairmindDisc);
  byKey.General = general;

  // Brain: the premium beat (user-decisions.md Q2) — a glowing teal core ringed in gold, the only two-mesh form,
  // the one place this phase spends its second colour on a second mesh rather than a single-mesh form's own trim.
  const brain = new Group();
  cheapMesh(brain, geo.ball(0.09), mats.fairmindDisc);
  const ring = cheapMesh(brain, geo.arc(0.13, 0.014, Math.PI * 2), mats.fairmindGold);
  ring.rotation.x = Math.PI / 2;
  parent.add(brain);
  byKey.Brain = brain;

  // Insights: a ticker — a wide, flat gold strip, telemetry always writing itself out (the one form gold enough
  // to read as "always outgoing" on its own, rather than teal with a gold trim).
  const insights = cheapMesh(parent, geo.box(0.24, 0.05, 0.014), mats.fairmindGold);
  byKey.Insights = insights;

  // Code: a wireframe cube — the code graph's own repo, drawn in line, not fill.
  const code = cheapMesh(parent, geo.box(0.16, 0.16, 0.16), mats.fairmindWire);
  byKey.Code = code;

  for (const key of FORM_KEYS) byKey[key].visible = false;
  return { group: parent, byKey };
}

/**
 * Shows the one form the call's family picked, hides the rest; hides every form for a non-FairMind call or none
 * at all. Mirrors `setOnCall`'s own "no rebuild" discipline — only `.visible` ever changes.
 */
export function setFairmindForm(forms: FairmindForms, call: { fairmind: boolean; family: string | null } | null): void {
  const shown = call?.fairmind ? fairmindFormOf(call.family) : null;
  for (const key of FORM_KEYS) forms.byKey[key].visible = key === shown;
}

/**
 * Turns the form group to face the camera, the same billboard `fairmind-badge.ts`'s `orientFairmindBadge` gives
 * its own badge, and for the same reason: several of the six forms are thin on one axis (General's pane,
 * Insights' ticker, the default mark's own flat profile) and would foreshorten to a sliver from most of the
 * floor's own orbit azimuths otherwise. Unlike the badge, this group carries no `.visible` of its own to gate the
 * write on — `setFairmindForm` already hides every child while none applies — so it is always safe, and cheap, to
 * set; a hidden group's rotation is never seen.
 */
export function orientFairmindForms(forms: FairmindForms, facing: number, azimuth: number): void {
  forms.group.rotation.y = azimuth - facing;
}
