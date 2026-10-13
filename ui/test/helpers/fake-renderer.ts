import type { FloorDetail } from '../../../src/scene/types';
import type { RendererModule } from '../../lib/renderer';
import type { FloorView, Target, ThemeTokens } from '../../renderer/index';
import { readThemeTokens } from '../../renderer/theme';

/** A floor view that records what the stage asks of it, and lets a test send its events. */
export interface FakeView extends FloorView {
  host: { canvas: HTMLCanvasElement; labels: HTMLElement };
  /** The theme it was mounted with: the `data-theme` of <html> when the stage read it ('system' without one). */
  theme: ThemeTokens;
  mountedTheme: string;
  /** In order: 'floor <key> <desks>', 'theme <data-theme>', 'select <kind> <id> [pan]' or 'select - [pan]', 'rotate <step>', 'reset', 'dispose'. */
  calls: string[];
  emit(event: 'select' | 'activate', target: Target | null): void;
}

export interface FakeRenderer {
  /** The stage's loader. Its mountFloorView makes fake views, or throws `fail`. */
  load: () => Promise<RendererModule>;
  views: FakeView[];
}

type Listener = (target: Target | null) => void;

const deskCount = (floor: FloorDetail) => floor.islands.reduce((n, island) => n + island.desks.length, 0);

export function fakeRenderer(opts: { fail?: unknown } = {}): FakeRenderer {
  const views: FakeView[] = [];
  /** Each theme the stage read, with the `data-theme` <html> had at that moment. */
  const read = new WeakMap<ThemeTokens, string>();
  const themeOf = (tokens: ThemeTokens) => read.get(tokens) ?? 'not read by the stage';
  const module: RendererModule = {
    readThemeTokens(css: (name: string) => string, reducedMotion: boolean) {
      const tokens = readThemeTokens(css, reducedMotion);
      read.set(tokens, document.documentElement.getAttribute('data-theme') ?? 'system');
      return tokens;
    },
    mountFloorView(host: { canvas: HTMLCanvasElement; labels: HTMLElement }, theme: ThemeTokens): FloorView {
      if (opts.fail !== undefined) throw opts.fail;
      const listeners = { select: new Set<Listener>(), activate: new Set<Listener>() };
      const calls: string[] = [];
      const view = {
        host,
        theme,
        mountedTheme: themeOf(theme),
        calls,
        setFloor: (floor: FloorDetail) => void calls.push(`floor ${floor.key} ${deskCount(floor)}`),
        setTheme: (next: ThemeTokens) => void calls.push(`theme ${themeOf(next)}`),
        select: (target: Target | null, o?: { pan?: boolean }) => void calls.push(`select ${target ? `${target.kind} ${target.id}` : '-'}${o?.pan ? ' pan' : ''}`),
        rotate: (step: -1 | 1) => void calls.push(`rotate ${step}`),
        resetView: () => void calls.push('reset'),
        on(event: 'select' | 'activate', fn: Listener) {
          listeners[event].add(fn);
          return () => void listeners[event].delete(fn);
        },
        emit(event: 'select' | 'activate', target: Target | null) {
          for (const fn of [...listeners[event]]) fn(target);
        },
        dispose: () => void calls.push('dispose'),
      };
      views.push(view as FakeView);
      return view as FakeView;
    },
  };
  return { load: () => Promise.resolve(module), views };
}
