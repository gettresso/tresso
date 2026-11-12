import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/__tests__/setup.ts'],
      exclude: [...configDefaults.exclude, 'e2e/**'],
      root: fileURLToPath(new URL('./', import.meta.url)),
      // The desktop frame reads its numbers from its stylesheet (platform/frame.ts imports it with ?raw), and its tests
      // check colours against main.css; without this Vitest hands every stylesheet over empty.
      css: { include: [/assets\/(frame|main)\.css/] },
    },
  }),
)
