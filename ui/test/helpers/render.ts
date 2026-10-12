import { flushSync, mount, unmount, type Component } from 'svelte';

const mounted: Array<() => void> = [];

/** Mounts a component into a fresh element under <body>. `cleanup()` (in afterEach) unmounts everything. */
export function render<Props extends Record<string, any>>(component: Component<Props>, props: Props): HTMLElement {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(component, { target, props });
  flushSync();
  mounted.push(() => {
    unmount(instance);
    target.remove();
  });
  return target;
}

export function cleanup(): void {
  while (mounted.length) mounted.pop()!();
  document.body.replaceChildren();
}

/** An element's text with whitespace collapsed, as a reader would see it. */
export function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Clicks, then lets Svelte update the DOM. */
export function click(el: Element | null | undefined): void {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).click();
  flushSync();
}
