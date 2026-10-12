/**
 * Every material of the floor, shared and built from the theme tokens. A theme change recolours them in place, so
 * nothing in the scene is rebuilt; a desk changing state swaps its screen to another shared material.
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
}

const SURFACES = {
  floor: { color: 'scene-floor' },
  wall: { color: 'scene-wall' },
  base: { color: 'scene-base' },
  lobby: { color: 'scene-floor', mix: ['scene-base', 0.55] },
  desk: { color: 'scene-desk', roughness: 0.7 },
  deskOff: { color: 'scene-desk', roughness: 0.7, shade: 0.55 },
  leg: { color: 'scene-leg' },
  chair: { color: 'scene-chair' },
  monitor: { color: 'scene-monitor', roughness: 0.5 },
  key: { color: 'scene-key' },
  plant: { color: 'scene-plant' },
  pot: { color: 'scene-pot' },
  elevator: { color: 'scene-elevator', roughness: 0.4 },
  frame: { color: 'scene-frame' },
  paper: { color: 'scene-paper' },
  shell: { color: 'bot-shell', roughness: 0.45 },
  visor: { color: 'bot-visor', emissive: 'bot-visor', intensity: 'visor-int' },
  window: { color: 'window-glow', emissive: 'window-glow', intensity: 'window-int' },
  lamp: { color: 'lamp-glow', emissive: 'lamp-glow', intensity: 'lamp-int' },
} as const satisfies Record<string, Recipe>;

export type Surface = keyof typeof SURFACES;

/** How much of the repo colour a rug takes over the floor colour. */
export const RUG_MIX = 0.3;
/** Joints and feet: the body colour, darker. */
export const JOINT_SHADE = 0.62;
/** A screen's glass; the state colour glows over it. */
export const SCREEN_GLASS = '#0a0a0a';

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
  /** The selection ring, in the accent colour. */
  readonly ring: MeshBasicMaterial;
  private readonly recipes: Array<[MeshStandardMaterial, Recipe]> = [];
  private readonly bodies: MeshStandardMaterial[] = [];
  private readonly joints: MeshStandardMaterial[] = [];
  private readonly rugs: MeshStandardMaterial[] = [];
  private readonly ties: MeshStandardMaterial[] = [];
  private readonly noTie: MeshStandardMaterial;
  private readonly screens = new Map<ColorToken | null, MeshStandardMaterial>();
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
    for (const token of new Set(Object.values(SCREEN_TOKEN))) {
      this.screens.set(token, new MeshStandardMaterial({ color: SCREEN_GLASS, roughness: 0.4, metalness: 0 }));
    }
    this.ring = new MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
    this.applyTheme(theme);
  }

  /** A robot's body, and the rug and lamp shade of its island, by repo slot. */
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

  screen(state: ShownState): MeshStandardMaterial {
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
    for (const [token, m] of this.screens) {
      if (token) m.emissive.set(theme.colors[token]);
      else m.emissive.setRGB(0, 0, 0);
      m.emissiveIntensity = token ? theme.numbers['screen-int'] : 0;
    }
    this.ring.color.set(theme.colors.accent);
  }

  all(): Material[] {
    return [...this.recipes.map(([m]) => m), ...this.screens.values(), this.ring];
  }

  dispose(): void {
    for (const m of this.all()) m.dispose();
  }

  private make(recipe: Recipe): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ roughness: recipe.roughness ?? 0.85, metalness: 0 });
    this.recipes.push([m, recipe]);
    return m;
  }
}
