#!/usr/bin/env node

// Syncs documentation from docs/ (repo root) into the Starlight content
// directory. Run before `astro build` or `astro dev` to pick up changes.
//
// What it does:
//   1. Copies each docs/*.md file into src/content/docs/<target>, adding
//      Starlight frontmatter (title + description) and stripping the
//      leading `# Heading`.
//   2. Splits api-reference.md into 11 focused sub-pages under
//      src/content/docs/reference/api/.
//   3. Rewrites internal cross-reference links to match Starlight's
//      URL scheme (e.g. `locators.md` → `/guides/locators/`).

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
const DOCS = join(ROOT, 'docs')
const OUT = join(ROOT, 'website', 'src', 'content', 'docs')

// ─── File mapping: source → target + frontmatter ───

const FILES = [
  {
    src: 'getting-started.md',
    dest: 'getting-started.md',
    title: 'Installation & First Test',
    desc: 'Get up and running with Tapsmith in minutes. Install, configure, and write your first mobile test.',
  },
  {
    src: 'writing-tests.md',
    dest: 'writing-tests.md',
    title: 'Writing Tests',
    desc: 'Learn how to structure tests, use screen objects, manage test state, and follow best practices.',
  },
  {
    src: 'locators.md',
    dest: 'guides/locators.md',
    title: 'Locators',
    desc: 'Choose the right locator strategy for reliable, accessible mobile element queries.',
  },
  {
    src: 'network.md',
    dest: 'guides/network.md',
    title: 'Network Interception',
    desc: 'Mock, modify, and inspect HTTP requests with Playwright-style route handlers.',
  },
  {
    src: 'webview.md',
    dest: 'guides/webview.md',
    title: 'WebView Testing',
    desc: 'Test hybrid apps by switching between native and web contexts.',
  },
  {
    src: 'trace-viewer.md',
    dest: 'guides/trace-viewer.md',
    title: 'Trace Viewer',
    desc: 'Record and inspect step-by-step test execution with screenshots, hierarchy, and network.',
  },
  {
    src: 'warm-reset.md',
    dest: 'guides/warm-reset.md',
    title: 'Warm App Reset',
    desc: 'Reset app state in under a second with @tapsmith/react-native and automatic per-test isolation.',
  },
  {
    src: 'watch-mode.md',
    dest: 'guides/watch-mode.md',
    title: 'Watch Mode',
    desc: 'Fast terminal-based iteration with persistent device sessions.',
  },
  {
    src: 'ui-mode.md',
    dest: 'guides/ui-mode.md',
    title: 'UI Mode',
    desc: 'Browser-based interactive test runner with MCP integration.',
  },
  {
    src: 'parallel-and-sharding.md',
    dest: 'guides/parallel-and-sharding.md',
    title: 'Parallel Execution',
    desc: 'Run tests across multiple devices with work-stealing distribution and CI sharding.',
  },
  {
    src: 'multi-device.md',
    dest: 'guides/multi-device.md',
    title: 'Multi-Device Tests',
    desc: 'Drive two app sessions from one test with device groups (use.devices).',
  },
  {
    src: 'debugging.md',
    dest: 'guides/debugging.md',
    title: 'Debugging',
    desc: 'Troubleshoot test failures, flaky tests, and common issues.',
  },
  {
    src: 'mcp-server.md',
    dest: 'guides/mcp-server.md',
    title: 'MCP Server',
    desc: 'Integrate Tapsmith with AI coding agents via the Model Context Protocol.',
  },
  {
    src: 'agents.md',
    dest: 'guides/agents.md',
    title: 'AI Coding Agents',
    desc: 'Set up and run Tapsmith unattended from Claude Code, Codex, or Cursor.',
  },
  {
    src: 'ci-setup.md',
    dest: 'platform/ci-setup.md',
    title: 'CI Setup',
    desc: 'Run Tapsmith tests in GitHub Actions and other CI environments.',
  },
  {
    src: 'ios-physical-devices.md',
    dest: 'platform/ios-physical-devices.md',
    title: 'iOS Physical Devices',
    desc: 'Set up Tapsmith for testing on physical iOS devices.',
  },
  {
    src: 'ios-network-capture.md',
    dest: 'platform/ios-network-capture.md',
    title: 'iOS Network Capture',
    desc: 'Configure HTTPS interception on iOS simulators.',
  },
  {
    src: 'ios-physical-device-network-tracing.md',
    dest: 'platform/ios-physical-device-network-tracing.md',
    title: 'iOS Device Network Tracing',
    desc: 'Network capture on physical iOS devices.',
  },
  {
    src: 'configuration.md',
    dest: 'reference/configuration.md',
    title: 'Configuration',
    desc: 'All tapsmith.config.ts options with defaults and examples.',
  },
  {
    src: 'environment-variables.md',
    dest: 'reference/environment-variables.md',
    title: 'Environment Variables',
    desc: 'Environment variables for the Tapsmith daemon and CI.',
  },
  {
    src: 'telemetry.md',
    dest: 'reference/telemetry.md',
    title: 'Telemetry',
    desc: 'Exactly what anonymous usage data Tapsmith collects, what it never does, and how to opt out.',
  },
  {
    src: 'trace-format.md',
    dest: 'reference/trace-format.md',
    title: 'Trace Archive Format',
    desc: 'The versioned contract for what a Tapsmith trace .zip contains, with its JSON Schema.',
  },
]

// ─── API reference split definitions ───
// Each entry defines a slice of api-reference.md by start/end markers.

const API_SPLITS = [
  {
    dest: 'reference/api/locators.md',
    title: 'Locators',
    desc: 'Find UI elements with getByText, getByRole, getByDescription, and other locator methods.',
    startMarker: '## Locators',
    endMarker: '## Device',
  },
  {
    dest: 'reference/api/device.md',
    title: 'Device',
    desc: 'Device-level actions: swipe, press keys, launch apps, manage permissions, and control device state.',
    startMarker: '## Device',
    endMarker: '### Network Interception',
  },
  {
    dest: 'reference/api/network.md',
    title: 'Network',
    desc: 'Intercept, mock, and modify network requests with the Route API.',
    startMarker: '### Network Interception',
    endMarker: '## ElementHandle',
  },
  {
    dest: 'reference/api/element-handle.md',
    title: 'ElementHandle',
    desc: 'Tap, type, scroll, drag, and query elements with the lazy locator API.',
    startMarker: '## ElementHandle',
    endMarker: '## Assertions',
  },
  {
    dest: 'reference/api/assertions.md',
    title: 'Assertions',
    desc: 'Auto-waiting assertions for locators and generic value assertions.',
    startMarker: '## Assertions',
    endMarker: '## Test Runner',
  },
  {
    dest: 'reference/api/test-runner.md',
    title: 'Test Runner',
    desc: 'Define tests, describe blocks, hooks, fixtures, projects, and configuration.',
    startMarker: '## Test Runner',
    endMarker: '## API Request Fixture',
  },
  {
    dest: 'reference/api/request.md',
    title: 'Request Fixture',
    desc: 'Make HTTP requests from tests with the request fixture.',
    startMarker: '## API Request Fixture',
    endMarker: '## Configuration',
  },
  // Skip ## Configuration — it has its own standalone doc
  {
    dest: 'reference/api/tracing.md',
    title: 'Tracing',
    desc: 'Record step-by-step traces with screenshots, hierarchy, and network.',
    startMarker: '## Tracing',
    endMarker: '## Reporters',
  },
  {
    dest: 'reference/api/reporters.md',
    title: 'Reporters',
    desc: 'Built-in and custom reporters for test results.',
    startMarker: '## Reporters',
    endMarker: '## CLI',
  },
  {
    dest: 'reference/api/cli.md',
    title: 'CLI',
    desc: 'Command-line interface, flags, and video recording.',
    startMarker: '## CLI',
    endMarker: '## WebView Testing',
  },
  {
    dest: 'reference/api/webview.md',
    title: 'WebView',
    desc: 'Test hybrid apps with CSS selectors in WebView contexts.',
    startMarker: '## WebView Testing',
    endMarker: null,
  },
]

// ─── Link rewriting rules ───

// Map from source filename to website path.
// The rewriter handles both `(file.md)` and `(./file.md)` forms,
// and strips any trailing `#anchor` since anchors rarely survive the split.
const LINK_MAP = {
  'locators.md': '/guides/locators/',
  'network.md': '/guides/network/',
  'webview.md': '/guides/webview/',
  'trace-viewer.md': '/guides/trace-viewer/',
  'watch-mode.md': '/guides/watch-mode/',
  'ui-mode.md': '/guides/ui-mode/',
  'warm-reset.md': '/guides/warm-reset/',
  'parallel-and-sharding.md': '/guides/parallel-and-sharding/',
  'multi-device.md': '/guides/multi-device/',
  'debugging.md': '/guides/debugging/',
  'mcp-server.md': '/guides/mcp-server/',
  'agents.md': '/guides/agents/',
  'ci-setup.md': '/platform/ci-setup/',
  'ios-physical-devices.md': '/platform/ios-physical-devices/',
  'ios-network-capture.md': '/platform/ios-network-capture/',
  'ios-physical-device-network-tracing.md': '/platform/ios-physical-device-network-tracing/',
  'getting-started.md': '/getting-started/',
  'writing-tests.md': '/writing-tests/',
  'configuration.md': '/reference/configuration/',
  'environment-variables.md': '/reference/environment-variables/',
  'telemetry.md': '/reference/telemetry/',
  'trace-format.md': '/reference/trace-format/',
}

// Build regex-based rewrites from the map
const LINK_REWRITES = Object.entries(LINK_MAP).map(([file, dest]) => {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    new RegExp(`\\((?:\\.\\/)?(?:docs\\/)?${escaped}(#[^)]*)?\\)`, 'g'),
    (_, anchor) => `(${dest}${anchor || ''})`,
  ]
})

// Special cases for api-reference.md (split into multiple pages)
LINK_REWRITES.push(
  [/\((?:\.\/)?api-reference\.md#video-recording\)/g, '(/reference/api/cli/)'],
  [/\((?:\.\/)?api-reference\.md(?:#[^)]*)??\)/g, '(/reference/api/locators/)'],
)

// Cross-section anchors within the monolithic API reference that now
// point to content in different split files
LINK_REWRITES.push(
  [/\(#scoping\)/g, '(/reference/api/element-handle/)'],
  [/\(#video-recording\)/g, '(/reference/api/cli/)'],
  [/\(#api-request-fixture\)/g, '(/reference/api/request/)'],
  [/\(#reusable-auth-state\)/g, '(/reference/api/test-runner/)'],
  [/\(#projects\)/g, '(/reference/api/test-runner/)'],
  [/\(#strict-mode\)/g, '(/reference/api/locators/#strict-mode)'],
)

// ─── Helpers ───

function rewriteLinks(content) {
  for (const [pattern, replacement] of LINK_REWRITES) {
    content = content.replace(pattern, replacement)
  }
  // Docs reference images as `images/<file>` so they render on GitHub;
  // the images dir is copied flat into website/public, so serve from `/`.
  // Handles both inline `](images/...)` and reference-style `]: images/...`.
  content = content
    .replace(/\]\((?:\.\/)?images\//g, '](/')
    .replace(/\]:\s*(?:\.\/)?images\//g, ']: /')
  return content
}

function stripFirstHeading(content) {
  return content.replace(/^# .+(?:\r?\n)+/, '')
}

function addFrontmatter(content, title, description) {
  const escape = (str) => str.replace(/"/g, '\\"')
  return `---\ntitle: "${escape(title)}"\ndescription: "${escape(description)}"\n---\n\n${content}`
}

function ensureDir(filePath) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function writeDoc(destPath, content) {
  const fullPath = join(OUT, destPath)
  ensureDir(fullPath)
  writeFileSync(fullPath, content)
}

// ─── Clean output directory to remove stale files ───

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ─── Sync individual doc files ───

let count = 0

for (const file of FILES) {
  const srcPath = join(DOCS, file.src)
  if (!existsSync(srcPath)) {
    console.warn(`  skip: ${file.src} (not found)`)
    continue
  }

  let content = readFileSync(srcPath, 'utf-8')
  content = stripFirstHeading(content)
  content = rewriteLinks(content)
  content = addFrontmatter(content, file.title, file.desc)

  writeDoc(file.dest, content)
  count++
}

// ─── Split API reference ───

const apiRefPath = join(DOCS, 'api-reference.md')
if (existsSync(apiRefPath)) {
  const apiContent = readFileSync(apiRefPath, 'utf-8')
  const lines = apiContent.split(/\r?\n/)

  for (const split of API_SPLITS) {
    const startIdx = lines.findIndex((l) => l.startsWith(split.startMarker))
    if (startIdx === -1) {
      console.warn(`  skip api split: ${split.dest} (marker "${split.startMarker}" not found)`)
      continue
    }

    let endIdx
    if (split.endMarker) {
      endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith(split.endMarker))
      if (endIdx === -1) endIdx = lines.length
    } else {
      endIdx = lines.length
    }

    // Extract section, trim trailing --- dividers and blank lines
    let section = lines.slice(startIdx, endIdx).join('\n').trim()
    section = section.replace(/\n---\s*$/, '').trim()

    // Demote the section heading (## → remove, content starts clean)
    section = section.replace(/^##+ .+\n+/, '')

    section = rewriteLinks(section)
    section = addFrontmatter(section, split.title, split.desc)

    writeDoc(split.dest, section)
    count++
  }
}

// ─── Copy images directory ───

const IMAGES_SRC = join(DOCS, 'images')
const IMAGES_DEST = join(ROOT, 'website', 'public')
if (existsSync(IMAGES_SRC)) {
  cpSync(IMAGES_SRC, IMAGES_DEST, { recursive: true })
}

console.log(`sync-docs: ${count} files written to src/content/docs/`)
