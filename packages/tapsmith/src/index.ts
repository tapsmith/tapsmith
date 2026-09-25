/**
 * Tapsmith — Mobile app testing framework.
 *
 * Public API re-exports.
 */

// First, before any module that reads import.meta while loading: explains a
// CommonJS load without import.meta instead of crashing mid-import (PILOT-382).
import './module-format-guard.js';

// Device
export { Device, type SwipeOptions, type AppResetOptions, type AppResetResult } from './device.js';

// Device management types
export type { LaunchAppOptions, OpenDeepLinkOptions, AppState, Orientation, ColorScheme } from './grpc-client.js';

// ElementHandle
export {
  ElementHandle,
  StrictModeViolationError,
  isStrictModeViolation,
  type FilterOptions,
  type BoundingBox,
  type LocatorOptions,
} from './element-handle.js';

// Assertions
export { expect, flushSoftErrors, type TapsmithAssertions, type WebViewAssertions, type GenericAssertions, type PollOptions } from './expect.js';

// Test runner
export {
  test,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  type TestFn,
  type DescribeFn,
  type TestFixtures,
  type TestResult,
  type SuiteResult,
  type TestStatus,
  type UseOptions,
} from './runner.js';

// Fixtures
export {
  type FixtureScope,
  type FixtureDefinitions,
  type BuiltinFixtures,
} from './fixtures.js';

// API request fixture
export { APIRequestContext, TapsmithAPIResponse, type APIRequestOptions } from './api-request.js';

// Network interception
export {
  Route,
  TapsmithRequest,
  FetchedAPIResponse,
  type RouteContinueOptions,
  type RouteFulfillOptions,
  type NetworkResponseEventData,
} from './network.js';

// Config
export { defineConfig, loadConfig, type TapsmithConfig, type ProjectConfig, type ScreenshotMode, type TraceMode, type TraceConfig, type AppResetMode, type AppResetScope } from './config.js';

// Reporters
export {
  type TapsmithReporter,
  type FullResult,
  type ReporterConfig,
  type ReporterDescription,
} from './reporter.js';

// gRPC client (advanced usage)
export { TapsmithGrpcClient } from './grpc-client.js';

// Tracing
export { Tracing, type TracingStartOptions, type TracingStopOptions } from './trace/tracing.js';

// WebView testing
export { WebViewHandle } from './webview-handle.js';
export { WebViewLocator } from './webview-locator.js';

// ESLint plugin
export { default as eslintPlugin } from './eslint-plugin/index.js';
