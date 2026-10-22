import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', sourcemap: true },
  test: { include: ['tests/**/*.test.ts'], exclude: ['tests/desktop*'], testTimeout: 20000 },
});
