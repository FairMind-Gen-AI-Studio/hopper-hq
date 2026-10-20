/**
 * Every material of the floor, shared and built from the theme tokens. A theme change recolours them in place, so
 * nothing in the scene is rebuilt. Desk screens share one material and glow in the colour each is given, by its desk's
 * state (screenColor): the floor gives them their colours again on a theme change.
 */
import { Color, MeshBasicMaterial, MeshStandardMaterial, type Material } from 'three';
import { FEATURE_SLOTS, LINE_SLOTS, REPO_SLOTS } from '../../src/scene/palette';
import type { OnCallView, ShownState } from '../../src/scene/types';
import type { ColorToken, NumberToken, ThemeTokens } from './theme';

/** How a material takes its colours from the theme. */
interface Recipe {
  color?: ColorToken;
  roughness?: number;
  /** Mixes the colour toward a second token by this amount. */
  mix?: readonly [ColorToken, number];
  /** Multiplies the colour (a darker variant of the token). */
  shade?: number;
  emissive?: ColorToken;
  intensity?: NumberToken;
  /** See-through at this opacity, writing no depth: glass. */
  opacity?: number;
  /**
   * A '#rrggbb' colour set once and never touched again, in place of a theme token: for a persona's outfit colour
   * (ui/renderer/persona.ts, user-decisions.md OQ-3) that has no token close enough to reuse and must read the same
   * by day and by night, rather than shift with the theme as every other surface does.
   */
  fixed?: string;
}

/** How much of the repo colour a rug takes over the floor colour. */
export const RUG_MIX = 0.3;

const SURFACES = {
  floor: { color: 'scene-floor' },
  wall: { color: 'scene-wall' },
  base: { color: 'scene-base' },
  lobby: { color: 'scene-floor', mix: ['scene-base', 0.55] },
  /** The rug of a pod whose occupants share no repository, or of an empty pod. */
  rug: { color: 'scene-floor', mix: ['scene-base', RUG_MIX] },
  desk: { color: 'scene-desk', roughness: 0.7 },
  leg: { color: 'scene-leg' },
  chair: { color: 'scene-chair' },
  monitor: { color: 'scene-monitor', roughness: 0.5 },
  key: { color: 'scene-key' },
  plant: { color: 'scene-plant' },
  pot: { color: 'scene-pot' },
  elevator: { color: 'scene-elevator', roughness: 0.4 },
  frame: { color: 'scene-frame' },
  paper: { color: 'scene-paper' },
  board: { color: 'scene-board', roughness: 0.4 },
  roomFloor: { color: 'scene-floor', mix: ['s-meeting', 0.12] },
  /** The floor of a room no run holds: its light dimmed. */
  roomDim: { color: 'scene-floor', mix: ['s-meeting', 0.12], shade: 0.85 },
  glass: { color: 'scene-glass', roughness: 0.2, opacity: 0.28 },
  couch: { color: 'scene-couch', roughness: 0.9 },
  beanA: { color: 'scene-bean-a', roughness: 0.9 },
  beanB: { color: 'scene-bean-b', roughness: 0.9 },
  wood: { color: 'scene-wood', roughness: 0.6 },
  loungeRug: { color: 'scene-floor', mix: ['scene-couch', 0.25] },
  /** The bar cart's counter. */
  cart: { color: 'scene-wood', roughness: 0.5 },
  /** The bar cart's bottles. */
  bottle: { color: 'scene-bean-b', roughness: 0.3 },
  /** The bar's lime bowl: a light ceramic, apart from the shelf's own frame token, so it reads as a bowl, not a puck. */
  bowl: { color: 'scene-paper', roughness: 0.3 },
  /** The back-bar's mirror strip: the glass token, lightened, shinier and more opaque than a partition's own glass,
   * so it reads as a strip of mirror behind the bottles, not more of the back panel's own wood. */
  mirror: { color: 'scene-glass', mix: ['scene-paper', 0.3], roughness: 0.05, opacity: 0.55 },
  shell: { color: 'bot-shell', roughness: 0.45 },
  visor: { color: 'bot-visor', emissive: 'bot-visor', intensity: 'visor-int' },
  hardhat: { color: 'bot-hardhat', roughness: 0.5 },
  jet: { color: 'bot-jet', roughness: 0.5 },
  window: { color: 'window-glow', emissive: 'window-glow', intensity: 'window-int' },
  lamp: { color: 'lamp-glow', emissive: 'lamp-glow', intensity: 'lamp-int' },
  /** The cigar's body: the lounge's wood token, darker, no new theme token for a prop this small. */
  cigarBody: { color: 'scene-wood', shade: 0.7, roughness: 0.55 },
  /** Its lit tip: the working state's amber, glowing, as an ember. */
  cigarTip: { color: 's-working', emissive: 's-working', intensity: 'visor-int' },
  /** The smoke puffs: thick, off-white, smoke signals. Shared by every robot (robot.ts fades it by scale, not opacity). */
  smokePuff: { color: 'scene-wall', roughness: 1, opacity: 0.6 },
  /**
   * The gin tonic glass's own shell: the window glass token, shinier, and held more opaque than the partition it
   * shares the token with (`glass`) — at this size, as see-through as a real balloon glass would wash its own
   * swell-then-pinch silhouette out, the one shape cue that tells it apart from a tumbler or a martini glass.
   */
  gtGlass: { color: 'scene-glass', mix: ['scene-paper', 0.15], roughness: 0.3, opacity: 0.4 },
  /** The rim traced on top of the bowl (robot.ts's buildDrink): `gtGlass`'s own colour, but near-opaque, so the
   * glass's own silhouette holds a clean edge against the floor even where the shell's own (now lighter)
   * transparency would otherwise wash it out. */
  gtRim: { color: 'scene-glass', mix: ['scene-paper', 0.35], roughness: 0.1, opacity: 0.92 },
  /**
   * The tonic itself: the glass token mixed hard toward the accent blue (the one genuinely saturated blue the
   * theme carries — `window-glow` is itself nearly as pale as the glass, too close to it to read as a second,
   * distinct colour) — a clearly aqua, fizzy tint apart from the glass's own pale, barely-tinted shell (`gtGlass`,
   * deliberately lighter so the tonic is what reads, not a second layer of the same hue).
   */
  tonic: { color: 'scene-glass', mix: ['accent', 0.4], roughness: 0.2, opacity: 0.88 },
  /** The ice cubes: the paper token, with only a hint of the glass's own blue — bright and white, so they stand
   * out against the tonic's own stronger tint rather than blending into it. */
  ice: { color: 'scene-paper', mix: ['scene-glass', 0.15], roughness: 0.08 },
  /** The lime wheel's rind, on the rim: the plant token, brightened a notch past the office's own plants — with the
   * straw, one of the drink's two strongest cues, so it has to pop a little more than a leaf does. */
  limeRind: { color: 'scene-plant', mix: ['scene-paper', 0.2], roughness: 0.4 },
  /** The lime wheel's pale flesh, next to its rind (`limeRind`): the plant token, lightened further still. */
  limeFlesh: { color: 'scene-plant', mix: ['scene-paper', 0.55], roughness: 0.55 },
  /**
   * The straw: bright red, reusing the "needs you" badge's own colour purely as a plain accent (the same way
   * `cigarTip` reuses the working state's amber as a plain ember glow, no state meaning here) — picked over black
   * so it still pops against the shell's own dark edges and the floor's own shadows alike, the other of the drink's
   * two strongest cues.
   */
  straw: { color: 's-needs', mix: ['scene-paper', 0.1], roughness: 0.35 },
  /** The biliardino table's two teams of little players, in colours clearly apart at a glance: the "needs you" red
   * and the accent blue, already in every theme, so no new token is needed for a pair of jerseys. */
  foosballA: { color: 's-needs', roughness: 0.6 },
  foosballB: { color: 'accent', roughness: 0.6 },
  /**
   * The espresso machine's own polished steel body (props.ts): the frame token's own darker steel-blue, not the
   * elevator's own lighter one — that first cut landed in the same pale grey-value family as the elevator doors
   * and the robot heads (both close to `scene-elevator` itself) and so read as just another grey box, not a
   * separately metallic one. Lifted only a third of the way to paper white (so it keeps real value apart from
   * `scene-elevator`/`bot-shell`) and far less rough than a wall panel reads as, for the sharper, shinier highlight
   * a polished machine throws under the floor's own lights — with no new theme token for a prop this small.
   */
  chrome: { color: 'scene-frame', mix: ['scene-paper', 0.3], roughness: 0.05 },
  /** The machine's own amber ready light, glowing the same way the cigar's lit tip does (an ember, no state meaning
   * here either): the working state's own amber, reused as a plain accent. */
  coffeeLight: { color: 's-working', emissive: 's-working', intensity: 'visor-int' },
  /**
   * The on-call headset's dropped-call flash (hq-mcp-switchboard proposal.md §2 "Error / dropped call"): the same
   * self-glow recipe as `cigarTip`/`coffeeLight` (an ember, reusing `visor-int`), but on the "needs you" status red
   * rather than a plain accent — the one colour on this palette already reserved for an alarm, so the flash reads
   * as one even on a line slot (materials.ts `lines`) that is not itself red.
   */
  headsetError: { color: 's-needs', emissive: 's-needs', intensity: 'visor-int' },
  /**
   * Persona outfit colours (ui/renderer/persona.ts, user-decisions.md OQ-3): a role recolours a sub-agent's body,
   * the tie staying in the feature colour. Appended at the end, additive, so as not to disturb the recipes above.
   * Most personas reuse an existing surface outright (persona.ts's PERSONA_BODY: qa->wood, developer->jet,
   * generalist->chair) rather than a new entry here; these seven have no token close enough to reuse — or, for
   * security/reviewer, the nearest token (`monitor`/`leg`) is one that is *designed* to crash to near-black at
   * night (a monitor bezel, a robot leg joint), which made both outfits unreadable against the night floor
   * (fix-round-2, OQ-3's day/night bar). Debugger's hazmat yellow is the working state's amber, same token, same
   * emissive-free recipe pattern, still fully theme-aware; the rest are `fixed`, a shade the theme never touches,
   * because nothing in the existing palette reads as a secret agent's black suit, olive drab, a judge's black robe,
   * burgundy, a pale smock or navy without a theme token dedicated to it, or without one that stays visible at night.
   */
  outfitDebugger: { color: 's-working', roughness: 0.55 },
  outfitTechlead: { fixed: '#5c5f3a', roughness: 0.55 },
  /** Secret-agent black suit: a fixed charcoal, not the near-black `monitor` token (#0E1015 at night — unreadable). */
  outfitSecurity: { fixed: '#3A3E4C', roughness: 0.55 },
  outfitLibrarian: { fixed: '#6b2737', roughness: 0.55 },
  outfitDesigner: { fixed: '#e8e4d8', roughness: 0.55 },
  outfitExplorer: { fixed: '#9c8f5e', roughness: 0.55 },
  outfitPlanner: { fixed: '#1f3350', roughness: 0.55 },
  /** Judge's black robe: a fixed near-black, not the `leg` token (#15181F at night — just as unreadable). */
  outfitReviewer: { fixed: '#3A3240', roughness: 0.55 },
  /** The boss's mug and watch (user-decisions.md OQ-1): the working state's amber again, shinier, as gold. */
  bossGold: { color: 's-working', roughness: 0.3 },
  /**
   * The planner's blueprint roll (persona.ts): `scene-glass`'s own pale-blue token, but opaque — unlike `glass`
   * above, a held prop needs to actually be seen, not read through. Reusing `glass`'s 28%-opacity recipe here (the
   * original mistake) made the roll all but invisible in the left hand, the persona's only distinguishing cue.
   */
  blueprint: { color: 'scene-glass', roughness: 0.4 },
} as const satisfies Record<string, Recipe>;

export type Surface = keyof typeof SURFACES;

/** How much of the meeting colour a meeting room's floor takes over the floor colour. */
export const ROOM_MIX = SURFACES.roomFloor.mix[1];
/** How much an empty room's floor keeps of a meeting room's. */
export const ROOM_DIM = SURFACES.roomDim.shade;
/** How much a meeting room's glass partitions hide of what stands behind them. */
export const GLASS_OPACITY = SURFACES.glass.opacity;
/** Joints and feet: the body colour, darker. */
export const JOINT_SHADE = 0.62;
/** A screen that is off: dark glass. */
export const SCREEN_GLASS = '#0a0a0a';
/** How much of its colour the top of a dormant session's desk keeps. */
export const DESK_OFF = 0.55;
/** How dark the soft disc under a walking or flying robot is: a shadow's stand-in, the same by day and by night. */
export const CONTACT_OPACITY = 0.22;
/** The Fairmind brand's teal (fairmind-badge.ts): fixed, not a theme token — the badge keeps the brand's own colours by day and by night, as its mark does on fairmind.ai. */
export const FAIRMIND_TEAL = '#2ec4a5';
/** The gold accent of a FairMind per-family VIP form (hq-mcp-switchboard proposal.md §5 Phase 3; fairmind-forms.ts):
 * fixed, outside the theme, the same discipline as `FAIRMIND_TEAL` — a cap, an edge, a tick or a ring in this one
 * extra colour is what reads "distinctly premium" against a generic line's single-colour bead. tokens.css
 * `--fairmind-gold` is the façade's own copy, for the rooftop mast's own sign (Facade.svelte). */
export const FAIRMIND_GOLD = '#D4AF37';

/** The colour a desk's screen glows in, by state; idle and dormant screens are off. */
export const SCREEN_TOKEN: Record<ShownState, ColorToken | null> = {
  working: 's-working',
  needs_you: 's-needs',
  done: 's-done',
  in_meeting: 's-meeting',
  no_signal: 's-nosignal',
  idle: null,
  dormant: null,
};

/** n wrapped into 0..size-1; anything that is not an integer reads as slot 0. */
function wrap(n: number, size: number): number {
  return Number.isInteger(n) ? ((n % size) + size) % size : 0;
}

export class Materials {
  readonly surface: Record<Surface, MeshStandardMaterial>;
  /** Every desk's screen: unlit, white, so that each shows the colour its instance is given (screenColor). */
  readonly screen: MeshBasicMaterial;
  /** The selection ring, in the accent colour. */
  readonly ring: MeshBasicMaterial;
  /** The soft disc on the floor under a robot on its way, in place of its shadow. */
  readonly contact: MeshBasicMaterial;
  /** The Fairmind badge's disc and its mark (fairmind-badge.ts): fixed colour, outside the theme. */
  readonly fairmindDisc: MeshBasicMaterial;
  readonly fairmindMark: MeshBasicMaterial;
  /** The per-family VIP forms' gold accent (fairmind-forms.ts), and Code's wireframe cube: both fixed colour, outside the theme, like the disc and the mark above. */
  readonly fairmindGold: MeshBasicMaterial;
  readonly fairmindWire: MeshBasicMaterial;
  private readonly recipes: Array<[MeshStandardMaterial, Recipe]> = [];
  /** Materials made with a `fixed` colour (persona outfits with no token close enough): never touched by applyTheme. */
  private readonly fixedMaterials: MeshStandardMaterial[] = [];
  private readonly bodies: MeshStandardMaterial[] = [];
  private readonly joints: MeshStandardMaterial[] = [];
  private readonly rugs: MeshStandardMaterial[] = [];
  private readonly ties: MeshStandardMaterial[] = [];
  /** The on-call headset's band and bead, by line slot (hq-mcp-switchboard proposal.md §4 "Meshes"): one shared,
   * self-glowing material per slot, mirroring `bodies`/`ties`. A Fairmind call never indexes here (`lineColor`). */
  private readonly lines: MeshStandardMaterial[] = [];
  private readonly noTie: MeshStandardMaterial;
  private readonly screens = new Map<ColorToken | null, Color>();
  private readonly mixer = new Color();

  constructor(theme: ThemeTokens) {
    const surface: Partial<Record<Surface, MeshStandardMaterial>> = {};
    for (const [name, recipe] of Object.entries(SURFACES) as Array<[Surface, Recipe]>) surface[name] = this.make(recipe);
    this.surface = surface as Record<Surface, MeshStandardMaterial>;
    for (let n = 0; n < REPO_SLOTS; n++) {
      const token = `repo-${n}` as ColorToken;
      this.bodies.push(this.make({ color: token, roughness: 0.55 }));
      this.joints.push(this.make({ color: token, shade: JOINT_SHADE }));
      this.rugs.push(this.make({ color: 'scene-floor', mix: [token, RUG_MIX] }));
    }
    for (let n = 0; n < FEATURE_SLOTS; n++) this.ties.push(this.make({ color: `feature-${n}` as ColorToken }));
    this.noTie = this.make({ color: 'feature-none' });
    for (let n = 0; n < LINE_SLOTS; n++) this.lines.push(this.make({ color: `line-${n}` as ColorToken, emissive: `line-${n}` as ColorToken, intensity: 'visor-int' }));
    for (const token of new Set(Object.values(SCREEN_TOKEN))) this.screens.set(token, new Color());
    this.screen = new MeshBasicMaterial();
    this.ring = new MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
    this.contact = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: CONTACT_OPACITY, depthWrite: false });
    this.fairmindDisc = new MeshBasicMaterial({ color: new Color(FAIRMIND_TEAL) });
    this.fairmindMark = new MeshBasicMaterial({ color: 0xffffff });
    this.fairmindGold = new MeshBasicMaterial({ color: new Color(FAIRMIND_GOLD) });
    this.fairmindWire = new MeshBasicMaterial({ color: new Color(FAIRMIND_TEAL), wireframe: true });
    this.applyTheme(theme);
  }

  /** A robot's body, and the lamp shade of its pod, by repo slot. */
  body(slot: number): MeshStandardMaterial {
    return this.bodies[wrap(slot, REPO_SLOTS)]!;
  }

  joint(slot: number): MeshStandardMaterial {
    return this.joints[wrap(slot, REPO_SLOTS)]!;
  }

  rug(slot: number): MeshStandardMaterial {
    return this.rugs[wrap(slot, REPO_SLOTS)]!;
  }

  /** A tie by feature slot; null (a department floor) gives the neutral tie. */
  tie(slot: number | null): MeshStandardMaterial {
    return slot === null ? this.noTie : this.ties[wrap(slot, FEATURE_SLOTS)]!;
  }

  /** The on-call headset's band and bead, by line slot. */
  line(slot: number): MeshStandardMaterial {
    return this.lines[wrap(slot, LINE_SLOTS)]!;
  }

  /**
   * The colour a robot's on-call headset shows for `call` (robot.ts `setOnCall`): the dropped-call flash first (any
   * slot, any family), then Fairmind's fixed teal badge disc (never a line slot, so prod/dev collapsing to one
   * identity, materials.ts `FAIRMIND_TEAL`, never has to be distinguished from the line rotation), then the call's
   * own line slot.
   */
  lineColor(call: Pick<OnCallView, 'slot' | 'fairmind' | 'error'>): Material {
    if (call.error) return this.surface.headsetError;
    return call.fairmind ? this.fairmindDisc : this.line(call.slot);
  }

  /**
   * The colour a screen shows in a state: the state's colour at the theme's screen intensity, as an emissive screen
   * glows, or dark glass when it is off. Shared: never change it.
   */
  screenColor(state: ShownState): Color {
    return this.screens.get(SCREEN_TOKEN[state])!;
  }

  /** Recolours every material in place; a `fixed` one (persona outfits) is never in `recipes` and so never touched. */
  applyTheme(theme: ThemeTokens): void {
    for (const [m, r] of this.recipes) {
      m.color.set(theme.colors[r.color!]);
      if (r.mix) m.color.lerp(this.mixer.set(theme.colors[r.mix[0]]), r.mix[1]);
      if (r.shade !== undefined) m.color.multiplyScalar(r.shade);
      if (r.emissive && r.intensity) {
        m.emissive.set(theme.colors[r.emissive]);
        m.emissiveIntensity = theme.numbers[r.intensity];
      }
    }
    for (const [token, color] of this.screens) {
      if (token) color.set(theme.colors[token]).multiplyScalar(theme.numbers['screen-int']);
      else color.set(SCREEN_GLASS);
    }
    this.ring.color.set(theme.colors.accent);
  }

  all(): Material[] {
    return [
      ...this.recipes.map(([m]) => m),
      ...this.fixedMaterials,
      this.screen,
      this.ring,
      this.contact,
      this.fairmindDisc,
      this.fairmindMark,
      this.fairmindGold,
      this.fairmindWire,
    ];
  }

  dispose(): void {
    for (const m of this.all()) m.dispose();
  }

  private make(recipe: Recipe): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ roughness: recipe.roughness ?? 0.85, metalness: 0 });
    if (recipe.fixed) {
      m.color.set(recipe.fixed);
      this.fixedMaterials.push(m);
      return m;
    }
    if (recipe.opacity !== undefined) {
      m.transparent = true;
      m.opacity = recipe.opacity;
      m.depthWrite = false;
    }
    this.recipes.push([m, recipe]);
    return m;
  }
}
