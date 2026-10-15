/**
 * Every material of the floor, shared and built from the theme tokens. A theme change recolours them in place, so
 * nothing in the scene is rebuilt. Desk screens share one material and glow in the colour each is given, by its desk's
 * state (screenColor): the floor gives them their colours again on a theme change.
 */
import { Color, MeshBasicMaterial, MeshStandardMaterial, type Material } from 'three';
import { FEATURE_SLOTS, REPO_SLOTS } from '../../src/scene/palette';
import type { ShownState } from '../../src/scene/types';
import type { ColorToken, NumberToken, ThemeTokens } from './theme';

/** How a material takes its colours from the theme. */
interface Recipe {
  color: ColorToken;
  roughness?: number;
  /** Mixes the colour toward a second token by this amount. */
  mix?: readonly [ColorToken, number];
  /** Multiplies the colour (a darker variant of the token). */
  shade?: number;
  emissive?: ColorToken;
  intensity?: NumberToken;
  /** See-through at this opacity, writing no depth: glass. */
  opacity?: number;
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
  private readonly recipes: Array<[MeshStandardMaterial, Recipe]> = [];
  private readonly bodies: MeshStandardMaterial[] = [];
  private readonly joints: MeshStandardMaterial[] = [];
  private readonly rugs: MeshStandardMaterial[] = [];
  private readonly ties: MeshStandardMaterial[] = [];
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
    for (const token of new Set(Object.values(SCREEN_TOKEN))) this.screens.set(token, new Color());
    this.screen = new MeshBasicMaterial();
    this.ring = new MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
    this.contact = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: CONTACT_OPACITY, depthWrite: false });
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

  /**
   * The colour a screen shows in a state: the state's colour at the theme's screen intensity, as an emissive screen
   * glows, or dark glass when it is off. Shared: never change it.
   */
  screenColor(state: ShownState): Color {
    return this.screens.get(SCREEN_TOKEN[state])!;
  }

  /** Recolours every material in place. */
  applyTheme(theme: ThemeTokens): void {
    for (const [m, r] of this.recipes) {
      m.color.set(theme.colors[r.color]);
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
    return [...this.recipes.map(([m]) => m), this.screen, this.ring, this.contact];
  }

  dispose(): void {
    for (const m of this.all()) m.dispose();
  }

  private make(recipe: Recipe): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ roughness: recipe.roughness ?? 0.85, metalness: 0 });
    if (recipe.opacity !== undefined) {
      m.transparent = true;
      m.opacity = recipe.opacity;
      m.depthWrite = false;
    }
    this.recipes.push([m, recipe]);
    return m;
  }
}
