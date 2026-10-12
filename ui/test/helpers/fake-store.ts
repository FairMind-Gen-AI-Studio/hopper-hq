import type { ClientState, ClientStore } from '../../lib/store';
import type { FloorDetail } from '../../../src/scene/types';
import { makeFloor } from './fixtures';

export interface FakeStore extends ClientStore {
  /** Every change of the watched floor, in order. */
  watched: (string | null)[];
  closed: boolean;
  set(patch: Partial<ClientState>): void;
}

/** A store that answers watchFloor at once, from the fixtures (or `floors`), and lets the test push any state. */
export function fakeStore(initial: Partial<ClientState> = {}, floors: (key: string) => FloorDetail | null = makeFloor): FakeStore {
  let state: ClientState = { connection: 'live', scene: null, floorKey: null, floor: undefined, ...initial };
  const subscribers = new Set<(s: ClientState) => void>();
  const store: FakeStore = {
    watched: [],
    closed: false,
    subscribe(run) {
      subscribers.add(run);
      run(state);
      return () => void subscribers.delete(run);
    },
    get: () => state,
    watchFloor(key) {
      // As the real store: watching the floor it already watches changes nothing.
      if (store.watched.length > 0 && key === state.floorKey) return;
      store.watched.push(key);
      store.set({ floorKey: key, floor: key === null ? undefined : floors(key) });
    },
    close() {
      store.closed = true;
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const run of [...subscribers]) run(state);
    },
  };
  return store;
}
