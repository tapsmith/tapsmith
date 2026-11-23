import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPO_ROUTER_ROOT_ROUTE,
  _setNavigationLibrariesForTests,
  expoRouterNavigationReset,
  reactNavigationReset,
  useNavigationReset,
  type NavigationContainerLike,
  type NavigationStateLike,
} from '../navigation.js';

/**
 * A container that applies resets and navigations to its state the way the
 * real one does, as far as these tests need: a reset replaces the state; a
 * navigation (the reset link's, or the reset's own) moves the focused tab and
 * pushes onto that tab's stack.
 */
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
  it('keeps the root route and its key, drops every nested state, then navigates to the reset\'s route', () => {
    const container = fakeContainer(expoState(['index', 'new'], 'index'));
    const navigate = vi.fn();

    const reset = expoRouterNavigationReset(container, navigate);
    expect(reset('/settings?tab=2')).toBe(true);

    const state = container.state();
    expect(state?.routes).toEqual([{ name: EXPO_ROUTER_ROOT_ROUTE, key: '__root-key' }]);
    expect(state?.key).toBe('stack-root');
    expect(state?.index).toBe(0);
    expect(navigate).toHaveBeenCalledWith('/settings?tab=2');
    // Reset first, then navigate: the navigation lands on fresh state.
    expect((container.resetRoot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan(navigate.mock.invocationCallOrder[0]);
  });

  it('ends fresh whether the reset link\'s own navigation landed before or after it', () => {
    // Landed before: the link already moved to the home tab, the tasks tab
    // still holds the pushed form. The reset drops it.
    const before = fakeContainer(expoState(['index', 'new'], 'index'));
    expoRouterNavigationReset(before, vi.fn())('/');
    expect(JSON.stringify(before.state())).not.toContain('new-key');

    // Lands after: the link's queued navigation applies on top of the reset
    // state, which no longer has the tasks tab's stack.
    const after = fakeContainer(expoState(['index', 'new'], 'tasks'));
    expoRouterNavigationReset(after, vi.fn())('/');
    expect(JSON.stringify(after.state())).not.toContain('new-key');
  });

  it('leaves navigation alone while the container is not ready (a cold launch the link started)', () => {
    const container = fakeContainer(expoState(['index', 'new'], 'tasks'), false);
    const navigate = vi.fn();
    expect(expoRouterNavigationReset(container, navigate)('/')).toBe(false);
    expect(container.resetRoot).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves a state with no expo-router root route alone', () => {
    const container = fakeContainer({ routes: [{ name: 'Home', key: 'h' }] });
    const navigate = vi.fn();
    expect(expoRouterNavigationReset(container, navigate)('/')).toBe(false);
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

  it('replaces the state with the one the linking config builds for the route, as a cold launch would', () => {
    const container = fakeContainer(tabsWithStack);
    const built = { routes: [{ name: 'Home' }] };
    const getStateFromPath = vi.fn(() => built);
    const config = { screens: { Home: '' } };

    expect(reactNavigationReset(container, { config }, getStateFromPath)('/?tab=2')).toBe(true);

    expect(getStateFromPath).toHaveBeenCalledWith('/?tab=2', config);
    expect(container.resetRoot).toHaveBeenCalledWith(built);
  });

  it('uses the app\'s own getStateFromPath when its linking options have one', () => {
    const container = fakeContainer(tabsWithStack);
    const own = vi.fn(() => ({ routes: [{ name: 'Home' }] }));
    const library = vi.fn();
    reactNavigationReset(container, { getStateFromPath: own }, library)('/');
    expect(own).toHaveBeenCalled();
    expect(library).not.toHaveBeenCalled();
  });

  it('leaves the state alone without linking, with linking disabled, or for a route the config does not match', () => {
    const toState = vi.fn(() => undefined);
    for (const linking of [undefined, { enabled: false }, {}]) {
      const container = fakeContainer(tabsWithStack);
      expect(reactNavigationReset(container, linking, toState)('/nowhere')).toBe(false);
      expect(container.resetRoot).not.toHaveBeenCalled();
    }
    const notReady = fakeContainer(tabsWithStack, false);
    expect(reactNavigationReset(notReady, {}, vi.fn(() => ({ routes: [] })))('/')).toBe(false);
    expect(notReady.resetRoot).not.toHaveBeenCalled();
  });
});

describe('useNavigationReset', () => {
  afterEach(() => { _setNavigationLibrariesForTests(undefined); });

  it('is undefined when the app has no navigation library the hooks know', () => {
    _setNavigationLibrariesForTests({});
    expect(useNavigationReset()).toBeUndefined();
  });

  it('resets through expo-router\'s container and router when it is installed', () => {
    const container = fakeContainer(expoState(['index', 'new'], 'tasks'));
    const navigate = vi.fn();
    _setNavigationLibrariesForTests({ expoRouter: { router: { navigate }, useNavigationContainerRef: () => container } });

    const reset = useNavigationReset();
    expect(reset?.('/')).toBe(true);
    expect(container.resetRoot).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('reports nothing reset while expo-router\'s container is not ready', () => {
    const container = fakeContainer(undefined, false);
    _setNavigationLibrariesForTests({ expoRouter: { router: { navigate: vi.fn() }, useNavigationContainerRef: () => container } });
    expect(useNavigationReset()?.('/')).toBe(false);
  });
});
