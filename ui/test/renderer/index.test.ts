import { describe, expect, it } from 'vitest';
import { COLOR_TOKENS, NUMBER_TOKENS, WebGLUnavailableError, mountFloorView, readThemeTokens } from '../../renderer/index';
import { dayTheme } from '../../renderer/theme';

describe('mountFloorView', () => {
  it('throws WebGLUnavailableError when the browser gives no WebGL 2 context, and leaves the page alone', () => {
    // happy-dom has no WebGL: getContext answers null, as a browser without WebGL does.
    const canvas = document.createElement('canvas');
    const labels = document.createElement('div');
    let error: unknown = null;
    try {
      mountFloorView({ canvas, labels }, dayTheme());
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WebGLUnavailableError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('WebGLUnavailableError');
    expect(labels.className).toBe('');
    expect(labels.children).toHaveLength(0);
    expect(canvas.hasAttribute('tabindex')).toBe(false);
  });

  it('throws it too for a canvas whose context was lost, as after an earlier dispose', () => {
    const canvas = document.createElement('canvas');
    const lost = { isContextLost: () => true };
    canvas.getContext = (() => lost) as unknown as HTMLCanvasElement['getContext'];
    expect(() => mountFloorView({ canvas, labels: document.createElement('div') }, dayTheme())).toThrow(WebGLUnavailableError);
  });

  it('exposes the theme reader and the token lists for the UI', () => {
    expect(COLOR_TOKENS).toContain('scene-floor');
    expect(NUMBER_TOKENS).toContain('screen-int');
    expect(readThemeTokens(() => '', false)).toEqual(dayTheme());
  });
});
