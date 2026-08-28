import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  srcDir: 'src',
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  server: {
    port: 4322,
  },
});

