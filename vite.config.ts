/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';

// Modules only the lazily loaded screens use (import() in App, SystemPage,
// VpnPage, lib/oui): whole folders for Diagnostics, Setup, System, VPN and Routing & DNS. Everything else goes into the one entry chunk: left alone,
// rolldown splits the modules the entry shares with lazy chunks into a
// common chunk that loads up front anyway and compresses worse (+2 KB).
// A module missing here still works; it just loads with the entry.
const LAZY =
  /src\/(features\/(diagnostics|setup|system|vpn|routing|health)\/|features\/dashboard\/HealthBanner\.tsx|model\/(health|healthHooks|diagnostics|vpnClient|tailscale|tunnel|addons|backup|doh|routing|system|vpn)\.ts|api\/(diagnostics|tailscale|tunnel|backup)\.ts|lib\/ouiFull\.ts|components\/(AddonDialog|AddonsList)\.tsx|features\/networks\/ApPortsView\.tsx)/;

// The demo build's simulated router (src/demo and the fixtures it reads):
// its own chunk, so the entry does not carry ~45 KB of fixtures.
const DEMO = /src\/demo\/|test\/fixtures\//;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const routerUrl = env.ROUTER_URL || 'http://192.168.1.1';
  // Shown in System > About. A release build takes it from the tag
  // (release.yml sets NETUI_VERSION); otherwise package.json.
  const version = env.NETUI_VERSION || JSON.parse(readFileSync('package.json', 'utf8')).version;

  return {
    // Served from /www/netui/ on the router; relative base keeps assets working
    // whatever path uhttpd exposes it under.
    base: './',
    plugins: [preact(), tailwindcss()],
    define: { __NETUI_VERSION__: JSON.stringify(version) },
    server: {
      proxy: {
        '/ubus': { target: routerUrl, changeOrigin: true, secure: false },
      },
    },
    build: {
      target: 'es2022',
      reportCompressedSize: true,
      // The bundled dependencies' license notices, linked from System > About.
      // .txt: uhttpd serves it as text/plain, where .md would download.
      license: { fileName: 'licenses.txt' },
      rolldownOptions: {
        output: { codeSplitting: { groups: [{ name: 'index', test: (id: string) => !LAZY.test(id) && !DEMO.test(id) }] } },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./test/setup.ts'],
      // Room for findBy* waits (5 s, test/setup.ts) on a busy machine or CI runner.
      testTimeout: 15_000,
      // Externalized deps would load the real `react` peer instead of preact/compat.
      server: { deps: { inline: ['@tanstack/react-query'] } },
    },
  };
});
