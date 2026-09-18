// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import starlightLinksValidator from 'starlight-links-validator'
import starlightImageZoom from 'starlight-image-zoom'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  site: 'https://tapsmith.dev',
  integrations: [
    starlight({
      title: 'Tapsmith',
      logo: {
        light: './src/assets/logo.png',
        dark: './src/assets/logo-dark.png',
        replacesTitle: true,
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/samsmithyeah/tapsmith' },
      ],
      plugins: [starlightLinksValidator(), starlightImageZoom()],
      customCss: ['./src/styles/global.css'],
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Installation & First Test', slug: 'getting-started' },
            { label: 'Writing Tests', slug: 'writing-tests' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Locators', slug: 'guides/locators' },
            { label: 'Network Interception', slug: 'guides/network' },
            { label: 'WebView Testing', slug: 'guides/webview' },
            { label: 'Trace Viewer', slug: 'guides/trace-viewer' },
            { label: 'Watch Mode', slug: 'guides/watch-mode' },
            { label: 'UI Mode', slug: 'guides/ui-mode' },
            { label: 'Warm App Reset', slug: 'guides/warm-reset' },
            { label: 'Parallel Execution', slug: 'guides/parallel-and-sharding' },
            { label: 'Multi-Device Tests', slug: 'guides/multi-device' },
            { label: 'Debugging', slug: 'guides/debugging' },
            { label: 'MCP Server', slug: 'guides/mcp-server' },
            { label: 'AI Coding Agents', slug: 'guides/agents' },
          ],
        },
        {
          label: 'Platform',
          items: [
            { label: 'CI Setup', slug: 'platform/ci-setup' },
            { label: 'iOS Physical Devices', slug: 'platform/ios-physical-devices' },
            { label: 'iOS Network Capture', slug: 'platform/ios-network-capture' },
            {
              label: 'iOS Device Network Tracing',
              slug: 'platform/ios-physical-device-network-tracing',
            },
          ],
        },
        {
          label: 'API Reference',
          items: [
            { label: 'Locators', slug: 'reference/api/locators' },
            { label: 'Device', slug: 'reference/api/device' },
            { label: 'ElementHandle', slug: 'reference/api/element-handle' },
            { label: 'Assertions', slug: 'reference/api/assertions' },
            { label: 'Network', slug: 'reference/api/network' },
            { label: 'WebView', slug: 'reference/api/webview' },
            { label: 'Test Runner', slug: 'reference/api/test-runner' },
            { label: 'Request Fixture', slug: 'reference/api/request' },
            { label: 'Tracing', slug: 'reference/api/tracing' },
            { label: 'Reporters', slug: 'reference/api/reporters' },
            { label: 'CLI', slug: 'reference/api/cli' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration', slug: 'reference/configuration' },
            { label: 'Environment Variables', slug: 'reference/environment-variables' },
            { label: 'Telemetry', slug: 'reference/telemetry' },
          ],
        },
        { label: 'Changelog', slug: 'changelog' },
      ],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
})
