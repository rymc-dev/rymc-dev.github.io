// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  // TODO: replace with your real domain once hosting is decided
  site: 'https://ryanmckee.dev',
  integrations: [mdx(), sitemap()],
  markdown: {
    shikiConfig: { theme: 'github-dark-dimmed' },
  },
});
