import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPO_ROUTER_ROOT_ROUTE,
  _setNavigationLibrariesForTests,
  expoRouterNavigationReset,
  reactNavigationReset,
  useNavigationReset,
  waitForNavigationToSettle,
  type NavigationContainerLike,
  type NavigationStateLike,
} from '../navigation.js';

/** A container whose reset replaces its state, as the real one does. */
function fakeContainer(initial: NavigationStateLike | undefined, ready = true) {
  let state = initial;
  const container: NavigationContainerLike & { state: () => NavigationStateLike | undefined } = {
    isReady: () => ready,
    getRootState: () => state,
    resetRoot: vi.fn((next: object) => { state = next as NavigationStateLike; }),
    state: () => state,
  };
  return container;
}

/** expo-router's root: the `__root` route renders the root layout, whose tabs hold their own stacks. */
function expoState(tasksStack: string[], focusedTab: 'index' | 'tasks'): NavigationStateLike {
  return {
    key: 'stack-root',
    index: 0,
    stale: false,
    routeKeySeq: 3,
    routeNames: [EXPO_ROUTER_ROOT_ROUTE],
    routes: [{
      name: EXPO_ROUTER_ROOT_ROUTE,
      key: '__root-key',
      state: {
        key: 'tabs',
        index: focusedTab === 'index' ? 0 : 1,
        routes: [
          { name: 'index', key: 'index-key' },
          { name: 'tasks', key: 'tasks-key', state: { index: tasksStack.length - 1, routes: tasksStack.map((name) => ({ name, key: `${name}-key` })) } },
        ],
      },
    }],
  };
}

describe('expo-router navigation reset', () => {
  it('resets through the container\'s reset when it has no resetRoot (expo-router 56 and later)', async () => {
    let state: NavigationStateLike | undefined = expoState(['index', 'new'], 'index');
    const reset = vi.fn((next: object) => { state = next as NavigationStateLike; });
    const container: NavigationContainerLike = { isReady: () => true, getRootState: () => state, reset };
    const navigate = vi.fn();

    expect(await expoRouterNavigationReset(container, navigate)('/')).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);
    // A complete root state: key, route names and key sequence kept.
    expect(state).toMatchObject({ key: 'stack-root', stale: false, routeNames: [EXPO_ROUTER_ROOT_ROUTE], routeKeySeq: 3 });
    expect(state?.routes).toEqual([{ name: EXPO_ROUTER_ROOT_ROUTE, key: '__root-key' }]);
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('leaves navigation alone when the container can reset nothing', async () => {
    const container: NavigationContainerLike = { isReady: () => true, getRootState: () => expoState(['index'], 'index') };
    const navigate = vi.fn();
    expect(await expoRouterNavigationReset(container, navigate)('/')).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps the root route and its key, drops every nested state, then navigates to the reset\'s route', async () => {
    const container = fakeContainer(expoState(['index', 'new'], 'index'));
    const navigate = vi.fn();

    const reset = expoRouterNavigationReset(container, navigate);
    expect(await reset('/settings?tab=2')).toBe(true);

    const state = container.state();
    expect(state?.routes).toEqual([{ name: EXPO_ROUTER_ROOT_ROUTE, key: '__root-key' }]);
    expect(state?.key).toBe('stack-root');
    expect(state?.index).toBe(0);
    expect(navigate).toHaveBeenCalledWith('/settings?tab=2');
    // Reset first, then navigate: the navigation lands on fresh state.
    expect((container.resetRoot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan(navigate.mock.invocationCallOrder[0]);
  });

  it('ends fresh whether the reset link\'s own navigation landed before or after it', async () => {
    // Landed before: the link already moved to the home tab, the tasks tab
    // still holds the pushed form. The reset drops it.
    const before = fakeContainer(expoState(['index', 'new'], 'index'));
    await expoRouterNavigationReset(before, vi.fn())('/');
    expect(JSON.stringify(before.state())).not.toContain('new-key');

    // Lands after: the link's queued navigation applies on top of the reset
    // state, which no longer has the tasks tab's stack.
    const after = fakeContainer(expoState(['index', 'new'], 'tasks'));
    await expoRouterNavigationReset(after, vi.fn())('/');
    expect(JSON.stringify(after.state())).not.toContain('new-key');
  });

  it('leaves navigation alone while no navigator is mounted under the container', async () => {
    const container = fakeContainer(expoState(['index', 'new'], 'tasks'), false);
    const navigate = vi.fn();
    expect(await expoRouterNavigationReset(container, navigate)('/')).toBe(false);
    expect(container.resetRoot).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves a state with no expo-router root route alone', async () => {
    const container = fakeContainer({ routes: [{ name: 'Home', key: 'h' }] });
    const navigate = vi.fn();
    expect(await expoRouterNavigationReset(container, navigate)('/')).toBe(false);
    expect(container.resetRoot).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('React Navigation reset', () => {
  const tabsWithStack: NavigationStateLike = {
    index: 0,
    routes: [
      { name: 'Home', key: 'home' },
      { name: 'Tasks', key: 'tasks', state: { index: 1, routes: [{ name: 'List' }, { name: 'New' }] } },
    ],
  };

  it('replaces the state with the one the linking config builds for the route, as a cold launch would', async () => {
    const container = fakeContainer(tabsWithStack);
    const built = { routes: [{ name: 'Home' }] };
    const getStateFromPath = vi.fn(() => built);
    const config = { screens: { Home: '' } };

    expect(await reactNavigationReset(container, { config }, getStateFromPath)('/?tab=2')).toBe(true);

    expect(getStateFromPath).toHaveBeenCalledWith('/?tab=2', config);
    expect(container.resetRoot).toHaveBeenCalledWith(built);
  });

  it('uses the app\'s own getStateFromPath when its linking options have one', async () => {
    const container = fakeContainer(tabsWithStack);
    const own = vi.fn(() => ({ routes: [{ name: 'Home' }] }));
    const library = vi.fn();
    await reactNavigationReset(container, { getStateFromPath: own }, library)('/');
    expect(own).toHaveBeenCalled();
    expect(library).not.toHaveBeenCalled();
  });

  it('leaves the state alone without linking, with linking disabled, or for a route the config does not match', async () => {
    const toState = vi.fn(() => undefined);
    for (const linking of [undefined, { enabled: false }, {}]) {
      const container = fakeContainer(tabsWithStack);
      expect(await reactNavigationReset(container, linking, toState)('/nowhere')).toBe(false);
      expect(container.resetRoot).not.toHaveBeenCalled();
    }
    const notReady = fakeContainer(tabsWithStack, false);
    expect(await reactNavigationReset(notReady, {}, vi.fn(() => ({ routes: [] })))('/')).toBe(false);
    expect(notReady.resetRoot).not.toHaveBeenCalled();
  });
});

describe('expo-router root key on a linking reset (expo-router 55 and earlier)', () => {
  it('keeps the root route\'s key, so the root layout that renders the hooks stays mounted', async () => {
    const container = fakeContainer(expoState(['index', 'new'], 'tasks'));
    // What expo-router's getStateFromPath builds: a partial state, no keys.
    const built = { routes: [{ name: EXPO_ROUTER_ROOT_ROUTE, state: { routes: [{ name: 'index' }] } }] };

    expect(await reactNavigationReset(container, { getStateFromPath: () => built }, undefined)('/')).toBe(true);

    expect(container.state()?.routes).toEqual([
      { name: EXPO_ROUTER_ROOT_ROUTE, key: '__root-key', state: { routes: [{ name: 'index' }] } },
    ]);
  });
});

describe('waiting for navigation to settle', () => {
  afterEach(() => { vi.useRealTimers(); });

  function listeningContainer(state: NavigationStateLike) {
    const listeners = new Set<() => void>();
    let current = state;
    const container: NavigationContainerLike = {
      isReady: () => true,
      getRootState: () => current,
      addListener: (_event, listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const commit = (next: NavigationStateLike) => { current = next; for (const l of listeners) l(); };
    return { container, commit, listeners };
  }

  it('resolves only once the dispatched updates have committed and gone quiet', async () => {
    vi.useFakeTimers();
    const before = expoState(['index'], 'index');
    const { container, commit, listeners } = listeningContainer(before);
    let settled = false;
    void waitForNavigationToSettle(container, before).then(() => { settled = true; });

    // The reset and the navigation land a render or more later.
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    commit(expoState(['index'], 'index'));
    await vi.advanceTimersByTimeAsync(100);
    commit(expoState(['index'], 'tasks'));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it('gives up after a bounded wait when nothing commits', async () => {
    vi.useFakeTimers();
    const before = expoState(['index'], 'index');
    const { container, listeners } = listeningContainer(before);
    let settled = false;
    void waitForNavigationToSettle(container, before).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true);
    expect(listeners.size).toBe(0);
  });
});

describe('useNavigationReset', () => {
  afterEach(() => { _setNavigationLibrariesForTests(undefined); });

  it('is undefined when the app has no navigation library the hooks know', async () => {
    _setNavigationLibrariesForTests({});
    expect(useNavigationReset()).toBeUndefined();
  });

  it('resets through expo-router\'s container and router when it is installed', async () => {
    const container = fakeContainer(expoState(['index', 'new'], 'tasks'));
    const navigate = vi.fn();
    _setNavigationLibrariesForTests({ expoRouter: { router: { navigate }, useNavigationContainerRef: () => container } });

    const reset = useNavigationReset();
    expect(await reset?.('/')).toBe(true);
    expect(container.resetRoot).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('reports nothing reset while expo-router\'s container is not ready', async () => {
    const container = fakeContainer(undefined, false);
    _setNavigationLibrariesForTests({ expoRouter: { router: { navigate: vi.fn() }, useNavigationContainerRef: () => container } });
    expect(await useNavigationReset()?.('/')).toBe(false);
  });
});
