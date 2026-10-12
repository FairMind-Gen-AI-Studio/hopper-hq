/** Short messages at the bottom of the page: what a click did, or why it could not. Svelte store contract, no Svelte import. */
import { cleanText } from '../../src/scene/text';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export interface Toasts {
  subscribe(run: (list: readonly Toast[]) => void): () => void;
  /** Returns the toast's id, or -1 when there is nothing to show. */
  show(text: string, tone?: Toast['tone']): number;
  dismiss(id: number): void;
  clear(): void;
}

/** How long a toast stays: errors stay longer, to be read. */
export const TOAST_MS: Record<Toast['tone'], number> = { info: 4000, error: 6000 };
export const MAX_TOASTS = 3;

export function createToasts(): Toasts {
  let list: readonly Toast[] = [];
  let nextId = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const subscribers = new Set<(list: readonly Toast[]) => void>();

  function publish(next: readonly Toast[]): void {
    for (const t of list) {
      if (!next.includes(t)) {
        clearTimeout(timers.get(t.id));
        timers.delete(t.id);
      }
    }
    list = next;
    for (const run of [...subscribers]) run(list);
  }

  return {
    subscribe(run) {
      subscribers.add(run);
      run(list);
      return () => void subscribers.delete(run);
    },
    show(text, tone = 'info') {
      const clean = cleanText(text, 300);
      if (!clean) return -1;
      const toast: Toast = { id: nextId++, text: clean, tone };
      timers.set(toast.id, setTimeout(() => publish(list.filter((t) => t.id !== toast.id)), TOAST_MS[tone]));
      publish([...list, toast].slice(-MAX_TOASTS));
      return toast.id;
    },
    dismiss(id) {
      publish(list.filter((t) => t.id !== id));
    },
    clear() {
      publish([]);
    },
  };
}
