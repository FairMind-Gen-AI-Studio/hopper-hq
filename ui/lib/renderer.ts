/**
 * The 3D floor renderer, three.js included, is most of the UI's code, and only an open floor needs it. It loads
 * the first time a floor opens, as its own file, so the building view starts without it.
 */
import type * as Renderer from '../renderer/index';

/** What the floor stage uses of the renderer. */
export type RendererModule = Pick<typeof Renderer, 'mountFloorView' | 'readThemeTokens'>;

export function loadRenderer(): Promise<RendererModule> {
  return import('../renderer/index');
}
