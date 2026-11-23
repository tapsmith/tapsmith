import { useContext, type Context } from 'react';

/**
 * Resetting the app's navigation state on every reset, so a reset leaves it
 * where a cold launch on the reset's route would.
 *
 * Remounting the navigator (the hooks' `children`) is not enough: a
 * remounted React Navigation navigator reads its state back from the
 * navigation container above it, and that state holds every tab's nested
 * stack. A screen a test pushed inside a tab other than the one the reset
 * lands on would still be on top of that tab in the next test.
 *
 * The package depends on no navigation library, so it looks for one at run
 * time. Metro bundles a `require` inside a `try` block as an optional
 * dependency (`allowOptionalDependencies`, on by default in Metro, React
 * Native's and Expo's Metro configs): when the package is not installed the
 * `require` throws, and the hooks leave navigation alone.
 */

declare const require: (id: string) => unknown;

/**
 * The parts of a React Navigation container ref the reset uses. React
 * Navigation's has `resetRoot`; expo-router 56 and later keep their own copy
 * of React Navigation, whose container ref has only `reset` (a RESET action
 * that the root navigator handles, since only it has the root route).
 */
export interface NavigationContainerLike {
  isReady(): boolean;
  getRootState(): NavigationStateLike | undefined;
  resetRoot?(state: object): void;
  reset?(state: object): void;
}

/** Replace the container's whole state; false when it offers no way to. */
function replaceRootState(container: NavigationContainerLike, state: object): boolean {
  if (typeof container.resetRoot === 'function') container.resetRoot(state);
  else if (typeof container.reset === 'function') container.reset(state);
  else return false;
  return true;
}

/** A navigation state, as far as the reset reads it. */
export interface NavigationStateLike {
  index?: number;
  routes: readonly NavigationRouteLike[];
  [key: string]: unknown;
}

export interface NavigationRouteLike {
  name: string;
  key?: string;
  state?: unknown;
  [key: string]: unknown;
}

/** React Navigation's linking options, as `LinkingContext` holds them. */
export interface LinkingOptionsLike {
  enabled?: boolean;
  config?: unknown;
  getStateFromPath?: (path: string, config: unknown) => object | undefined;
}

/**
 * Resets the navigation state for a reset that lands on `href` (the reset
 * link's route and query, without the reset's own parameters). Returns
 * whether it reset anything.
 */
export type NavigationReset = (href: string) => boolean;

/**
 * The name expo-router gives the root route of its container, whose screen
 * renders the app's root `_layout`.
 */
export const EXPO_ROUTER_ROOT_ROUTE = '__root';

/**
 * expo-router: keep the root route — and its key, so the root layout that
 * renders the hooks stays mounted — but drop the state nested under it, so
 * every navigator inside the layout starts over from its first screen; then
 * navigate to the reset's route, as the reset link does.
 *
 * The reset link's own navigation goes through expo-router's routing queue
 * and lands a render or more after the link arrives, before or after this
 * runs. Either order ends on the route over fresh state: a navigation that
 * lands later starts from the reset state, and one that landed earlier is
 * replaced and replayed by `navigate`.
 */
export function expoRouterNavigationReset(
  container: NavigationContainerLike,
  navigate: (href: string) => void,
): NavigationReset {
  return (href) => {
    // Not ready: the container is still mounting, as on a cold launch the
    // reset link started. Its state is then the link's, built from scratch.
    if (!container.isReady()) return false;
    const root = container.getRootState();
    const rootRoute = root?.routes.find((route) => route.name === EXPO_ROUTER_ROOT_ROUTE);
    if (!root || !rootRoute) return false;
    // Everything else at the root level is kept as it is (its key, route
    // names and key sequence): expo-router 56 and later accept only a
    // complete root state, and seed the dropped nested state themselves.
    const { state: _nested, ...freshRoot } = rootRoute;
    if (!replaceRootState(container, { ...root, index: 0, routes: [freshRoot] })) return false;
    navigate(href);
    return true;
  };
}

/**
 * React Navigation without expo-router: replace the whole state with the one
 * the app's linking config builds for the reset's route — the state a cold
 * launch on that deep link starts in. Without linking (or a route the config
 * does not match) the reset link cannot navigate the app either, and the
 * state is left alone.
 */
export function reactNavigationReset(
  container: NavigationContainerLike,
  linking: LinkingOptionsLike | undefined,
  getStateFromPath: ((path: string, config: unknown) => object | undefined) | undefined,
): NavigationReset {
  return (href) => {
    if (!container.isReady() || !linking || linking.enabled === false) return false;
    const toState = linking.getStateFromPath ?? getStateFromPath;
    const state = toState?.(href, linking.config);
    if (!state) return false;
    return replaceRootState(container, state);
  };
}

interface ExpoRouterModule {
  router?: { navigate?: (href: string) => void };
  useNavigationContainerRef?: () => NavigationContainerLike | undefined;
}

interface ReactNavigationModule {
  NavigationContainerRefContext?: Context<NavigationContainerLike | undefined>;
  LinkingContext?: Context<{ options?: LinkingOptionsLike }>;
  getStateFromPath?: (path: string, config: unknown) => object | undefined;
}

interface NavigationLibraries {
  expoRouter?: ExpoRouterModule;
  reactNavigation?: ReactNavigationModule;
}

let libraries: NavigationLibraries | undefined;

/**
 * Loaded on first use rather than at import: expo-router's entry imports the
 * app's root layout, which imports this package, so requiring expo-router at
 * import time would read a half-initialised module.
 */
function loadLibraries(): NavigationLibraries {
  if (libraries) return libraries;
  let expoRouter: ExpoRouterModule | undefined;
  let reactNavigation: ReactNavigationModule | undefined;
  // Each `require` must sit directly inside its own `try` for Metro to treat
  // it as optional.
  try {
    expoRouter = require('expo-router') as ExpoRouterModule;
  } catch {
    expoRouter = undefined;
  }
  try {
    reactNavigation = require('@react-navigation/native') as ReactNavigationModule;
  } catch {
    reactNavigation = undefined;
  }
  libraries = { expoRouter, reactNavigation };
  return libraries;
}

/** @internal — tests only: stand in for the app's installed libraries. */
export function _setNavigationLibrariesForTests(next: NavigationLibraries | undefined): void {
  libraries = next;
}

const NO_CONTAINER: Context<NavigationContainerLike | undefined> | undefined = undefined;

/**
 * The navigation reset for the app this renders in, or undefined when the app
 * has no navigation library the hooks know. A hook: call it on every render,
 * unconditionally (which libraries are installed never changes while the app
 * runs, so the hooks it calls do not either).
 */
export function useNavigationReset(): NavigationReset | undefined {
  const { expoRouter, reactNavigation } = loadLibraries();
  // React Navigation's contexts, read in render. Under expo-router 55 and
  // earlier they are expo-router's too; later versions bundle their own copy
  // of React Navigation, and these then read nothing.
  const containerContext = reactNavigation?.NavigationContainerRefContext ?? NO_CONTAINER;
  const linkingContext = reactNavigation?.LinkingContext;
  const fromContext = containerContext ? useContext(containerContext) : undefined;
  const linking = linkingContext ? useContext(linkingContext) : undefined;

  const expoContainer = expoRouter?.useNavigationContainerRef?.();
  const navigate = expoRouter?.router?.navigate;
  const expoReset = expoContainer && navigate
    ? expoRouterNavigationReset(expoContainer, (href) => navigate(href))
    : undefined;
  const reactNavigationResetFn = fromContext
    ? reactNavigationReset(fromContext, readLinkingOptions(linking), reactNavigation?.getStateFromPath)
    : undefined;
  if (!expoReset && !reactNavigationResetFn) return undefined;
  // expo-router's container when it is the one running (it is ready only
  // then); otherwise the container this component renders inside.
  return (href) => (expoReset?.(href) ?? false) || (reactNavigationResetFn?.(href) ?? false);
}

/** `LinkingContext` with no provider throws on reading `options`. */
function readLinkingOptions(linking: { options?: LinkingOptionsLike } | undefined): LinkingOptionsLike | undefined {
  try {
    return linking?.options;
  } catch {
    return undefined;
  }
}
