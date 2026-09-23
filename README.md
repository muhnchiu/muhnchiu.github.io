# Horizon

Horizon is a static Astro site published to GitHub Pages. Markdown in `src/content/` remains the Simplified Chinese source of truth.

## Chinese display

`npm run build` first runs Astro, then `scripts/build-locales.mjs` converts the generated HTML with OpenCC's standard Simplified-to-Traditional mapping. The original routes display Traditional Chinese; `/zh-hans/` contains Simplified Chinese copies. The header switch keeps visitors on the corresponding page, and each version has its own canonical URL and language alternates. No browser-side text conversion is used.

Only human-readable text and descriptive metadata are converted. URLs, slugs, IDs, data attributes, code, and scripts are left unchanged. To keep a Chinese name exactly as written, add it to `protectedTerms` in the build script or wrap it in `<span translate="no">...</span>` in Markdown.

For a local preview of both languages, run `npm run build` followed by `npm run preview`. `npm run dev` runs Astro directly, so it shows the unconverted Simplified source and does not generate `/zh-hans/` pages.

## Typography

English text and the HORIZON wordmark use Geist. Research H1/H2 and Radar H1 use Iansui (芫荽), with LXGW WenKai TC as a fallback. Featured article titles also use Iansui; quotations retain LXGW WenKai TC. Chinese body text uses Noto Sans TC or a system Traditional Chinese sans-serif. Dates, signals, metadata, and code use Geist Mono.

The bundled [Iansui](https://github.com/ButTaiwan/iansui), [LXGW WenKai TC](https://github.com/lxgw/LxgwWenkaiTC), [Geist](https://github.com/vercel/geist-font), and Geist Mono fonts use the SIL Open Font License 1.1. License files are supplied by the installed Fontsource packages.
