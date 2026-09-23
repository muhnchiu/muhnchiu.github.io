// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages 项目页 site: https://muhnchiu.github.io/
export default defineConfig({
  site: 'https://muhnchiu.github.io',
  base: '/',
  output: 'static',
  build: {
    inlineStylesheets: 'auto',
  },
});
