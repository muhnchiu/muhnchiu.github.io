import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenCC from 'opencc-js';
import { parse, parseFragment, serialize } from 'parse5';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(projectRoot, 'dist');
const siteUrl = 'https://muhnchiu.github.io';
const simplifiedPrefix = '/zh-hans';
const toTraditional = OpenCC.Converter({ from: 'cn', to: 't' });

// Add Chinese brand or product names here when their exact spelling must stay fixed.
// Markdown can also protect a phrase with <span translate="no">...</span>.
const protectedTerms = ['阿里云百炼', '企业微信', '小众软件', '少数派', '阿里云', '多乐士', '钉钉', '微信'];
const skipTags = new Set(['script', 'style', 'pre', 'code', 'kbd', 'samp', 'svg', 'math', 'textarea', 'template', 'noscript']);
const textAttributes = new Set(['alt', 'title', 'placeholder', 'aria-label']);

async function collectHtml(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'zh-hans') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectHtml(absolute, files);
    else if (entry.name.endsWith('.html')) files.push(absolute);
  }
  return files;
}

function routeFor(relativePath) {
  const relative = relativePath.split(path.sep).join('/');
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'index.html'.length)}`;
  return `/${relative}`;
}

function getAttr(node, name) {
  return node.attrs?.find((attr) => attr.name === name)?.value;
}

function setAttr(node, name, value) {
  node.attrs ??= [];
  const attr = node.attrs.find((entry) => entry.name === name);
  if (attr) attr.value = value;
  else node.attrs.push({ name, value });
}

function removeAttr(node, name) {
  if (node.attrs) node.attrs = node.attrs.filter((attr) => attr.name !== name);
}

function findElement(node, tagName) {
  if (node.tagName === tagName) return node;
  for (const child of node.childNodes ?? []) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function convertPreservingTerms(value) {
  const preserved = [];
  let text = value;
  for (const term of protectedTerms) {
    if (!text.includes(term)) continue;
    const token = `\uE000${preserved.length}\uE001`;
    preserved.push(term);
    text = text.replaceAll(term, token);
  }
  return toTraditional(text)
    .replaceAll('搜索', '搜尋')
    .replace(/\uE000(\d+)\uE001/g, (_, index) => preserved[Number(index)]);
}

function convertVisibleText(node, inheritedSkip = false) {
  const skipped = inheritedSkip
    || skipTags.has(node.tagName)
    || getAttr(node, 'translate') === 'no'
    || node.attrs?.some((attr) => attr.name === 'data-no-convert');

  if (node.nodeName === '#text' && !skipped && /[\u3400-\u9fff]/u.test(node.value)) {
    node.value = convertPreservingTerms(node.value);
  }

  if (!skipped && node.attrs) {
    for (const attr of node.attrs) {
      const isDescriptionMeta = node.tagName === 'meta' && attr.name === 'content'
        && (getAttr(node, 'name') === 'description'
          || ['og:title', 'og:description'].includes(getAttr(node, 'property')));
      if ((textAttributes.has(attr.name) || isDescriptionMeta) && /[\u3400-\u9fff]/u.test(attr.value)) {
        attr.value = convertPreservingTerms(attr.value);
      }
    }
  }

  for (const child of node.childNodes ?? []) convertVisibleText(child, skipped);
}

function updateMetadata(document, route, language) {
  const html = findElement(document, 'html');
  const head = findElement(document, 'head');
  if (!html || !head) throw new Error(`Missing html/head for ${route}`);
  setAttr(html, 'lang', language === 'traditional' ? 'zh-Hant' : 'zh-Hans');

  const traditionalUrl = `${siteUrl}${route}`;
  const simplifiedUrl = `${siteUrl}${simplifiedPrefix}${route}`;
  const canonical = language === 'traditional' ? traditionalUrl : simplifiedUrl;

  for (const node of head.childNodes ?? []) {
    if (node.tagName === 'link' && getAttr(node, 'rel') === 'canonical') setAttr(node, 'href', canonical);
    if (node.tagName === 'meta' && getAttr(node, 'property') === 'og:url') setAttr(node, 'content', canonical);
  }

  const alternates = parseFragment(
    `<link rel="alternate" hreflang="zh-Hant" href="${traditionalUrl}">`
      + `<link rel="alternate" hreflang="zh-Hans" href="${simplifiedUrl}">`
      + `<link rel="alternate" hreflang="x-default" href="${traditionalUrl}">`,
  );
  for (const node of alternates.childNodes) {
    node.parentNode = head;
    head.childNodes.push(node);
  }
}

function updateLinks(node, route, language, knownRoutes) {
  if (node.tagName === 'a') {
    const targetLanguage = getAttr(node, 'data-language');
    if (targetLanguage) {
      setAttr(node, 'href', targetLanguage === 'zh-Hans' ? `${simplifiedPrefix}${route}` : route);
      if ((language === 'simplified' && targetLanguage === 'zh-Hans')
        || (language === 'traditional' && targetLanguage === 'zh-Hant')) setAttr(node, 'aria-current', 'page');
      else removeAttr(node, 'aria-current');
    } else if (language === 'simplified') {
      const href = getAttr(node, 'href');
      if (href?.startsWith('/') && !href.startsWith('//') && !href.startsWith(simplifiedPrefix)) {
        const pathname = new URL(href, siteUrl).pathname;
        const normalized = pathname.endsWith('/') || path.extname(pathname) ? pathname : `${pathname}/`;
        if (knownRoutes.has(normalized)) setAttr(node, 'href', `${simplifiedPrefix}${href}`);
      }
    }
  }
  for (const child of node.childNodes ?? []) updateLinks(child, route, language, knownRoutes);
}

const htmlFiles = await collectHtml(distRoot);
const routeFiles = htmlFiles.map((absolute) => ({
  absolute,
  relative: path.relative(distRoot, absolute),
  route: routeFor(path.relative(distRoot, absolute)),
}));
const knownRoutes = new Set(routeFiles.map(({ route }) => route));

for (const { absolute, relative, route } of routeFiles) {
  const source = await readFile(absolute, 'utf8');

  const traditional = parse(source);
  convertVisibleText(traditional);
  updateMetadata(traditional, route, 'traditional');
  updateLinks(traditional, route, 'traditional', knownRoutes);
  await writeFile(absolute, serialize(traditional));

  const simplified = parse(source);
  updateMetadata(simplified, route, 'simplified');
  updateLinks(simplified, route, 'simplified', knownRoutes);
  const simplifiedPath = path.join(distRoot, 'zh-hans', relative);
  await mkdir(path.dirname(simplifiedPath), { recursive: true });
  await writeFile(simplifiedPath, serialize(simplified));
}

console.log(`Localized ${routeFiles.length} pages: traditional default and simplified under ${simplifiedPrefix}/.`);
