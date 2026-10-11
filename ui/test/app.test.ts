import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import App from '../App.svelte';

let app: Record<string, unknown> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.replaceChildren();
});

describe('App', () => {
  it('mounts with the browser build of Svelte', () => {
    const target = document.body.appendChild(document.createElement('div'));
    app = mount(App, { target });
    flushSync();
    expect(target.querySelector('h1')?.textContent).toBe('Scranton HQ');
  });
});
