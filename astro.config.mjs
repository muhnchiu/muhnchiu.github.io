// @ts-check
import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import articlePresentation from './scripts/markdown/article-presentation.mjs';

// GitHub Pages 项目页 site: https://muhnchiu.github.io/
export default defineConfig({
  site: 'https://muhnchiu.github.io',
  base: '/',
  output: 'static',
  markdown: { processor: satteri({ mdastPlugins: [articlePresentation] }) },
  build: {
    inlineStylesheets: 'auto',
  },
});
