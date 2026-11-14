/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const routerUrl = env.ROUTER_URL || 'http://192.168.1.1';

  return {
    // Served from /www/netui/ on the router; relative base keeps assets working
    // whatever path uhttpd exposes it under.
    base: './',
    plugins: [preact(), tailwindcss()],
    server: {
      proxy: {
        '/ubus': { target: routerUrl, changeOrigin: true, secure: false },
      },
    },
    build: {
      target: 'es2022',
      reportCompressedSize: true,
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
