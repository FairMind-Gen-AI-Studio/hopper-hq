/**
 * The 3D floor view (outline §2.10): mount it on a canvas and a label layer, feed it FloorDetail and theme tokens,
 * and listen for 'select' and 'activate'. Framework-agnostic; Part E's FloorStage mounts it.
 */
import { WebGLRenderer } from 'three';
import type { FloorDetail } from '../../src/scene/types';
import type { ThemeTokens } from './theme';
import { createFloorView } from './view';

export type { ThemeTokens } from './theme';
export { readThemeTokens, COLOR_TOKENS, NUMBER_TOKENS } from './theme';

export class WebGLUnavailableError extends Error {
  constructor(message = 'This browser could not create a WebGL 2 context.') {
    super(message);
    this.name = 'WebGLUnavailableError';
  }
}

export interface FloorView {
  /** Replaces the floor. Desks are diffed by sessionId; the shell rebuilds only when size/core/island rects change. */
  setFloor(floor: FloorDetail): void;
  setTheme(theme: ThemeTokens): void;
  /** Highlights a desk (ring + label); pan: true eases the camera to it. Null clears. */
  select(sessionId: string | null, opts?: { pan?: boolean }): void;
  /** Rotates the camera by one 90° step around the vertical axis. */
  rotate(step: -1 | 1): void;
  resetView(): void;
  /** 'select': click on a desk, robot or label (null on empty floor). 'activate': double-click or Enter on a desk (the UI focuses its pane). */
  on(event: 'select', fn: (sessionId: string | null) => void): () => void;
  on(event: 'activate', fn: (sessionId: string) => void): () => void;
  dispose(): void;
}

/** Throws WebGLUnavailableError when a WebGL context cannot be created. */
export function mountFloorView(host: { canvas: HTMLCanvasElement; labels: HTMLElement }, theme: ThemeTokens): FloorView {
  let context: WebGL2RenderingContext | null = null;
  try {
    context = host.canvas.getContext('webgl2', { alpha: true, antialias: true, depth: true, stencil: false, powerPreference: 'default' });
  } catch {
    context = null;
  }
  // A canvas a disposed view has used hands back its lost context: it cannot draw again.
  if (!context || context.isContextLost()) throw new WebGLUnavailableError();
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas: host.canvas, context, antialias: true, alpha: true });
  } catch (err) {
    throw new WebGLUnavailableError(err instanceof Error ? err.message : String(err));
  }
  return createFloorView(host, theme, renderer);
}
