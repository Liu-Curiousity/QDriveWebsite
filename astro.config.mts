import { defineConfig } from 'astro/config';

export default defineConfig({
  srcDir: 'src',
  output: 'static',
  server: {
    port: 4321,
  },
});

