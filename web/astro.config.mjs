// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://ikpk.su',
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/sitemap'),
    }),
  ],
  output: 'static',
});
