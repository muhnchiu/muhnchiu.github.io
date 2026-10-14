import { localizeHtml } from '../build-locales.mjs';

// Astro serves simplified Markdown in development. Mirror the build's language
// routes there too, so changing fonts/layouts cannot conceal a broken switch.
export function localeMiddleware(req, res, next) {
  const originalUrl = req.url ?? '/';
  const url = new URL(originalUrl, 'http://localhost');
  if (url.pathname.startsWith('/_') || /\.[a-z0-9]+$/i.test(url.pathname)) return next();
  const simplified = /^\/zh-hans(?:\/|$)/.test(url.pathname);
  const pathname = simplified ? url.pathname.replace(/^\/zh-hans/, '') || '/' : url.pathname;
  const route = pathname.endsWith('/') ? pathname : `${pathname}/`;
  if (simplified) req.url = pathname + url.search;

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const chunks = [];
  let html;
  const buffer = (chunk, encoding) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  res.write = (chunk, encoding, callback) => {
    html ??= String(res.getHeader('content-type') ?? '').includes('text/html');
    if (!html) return originalWrite(chunk, encoding, callback);
    if (chunk) chunks.push(buffer(chunk, encoding));
    const done = typeof encoding === 'function' ? encoding : callback;
    done?.();
    return true;
  };
  res.end = (chunk, encoding, callback) => {
    html ??= String(res.getHeader('content-type') ?? '').includes('text/html');
    req.url = originalUrl;
    if (!html) return originalEnd(chunk, encoding, callback);
    if (chunk) chunks.push(buffer(chunk, encoding));
    const source = Buffer.concat(chunks).toString('utf8');
    const output = localizeHtml(source, route, simplified ? 'simplified' : 'traditional');
    if (!res.headersSent) res.removeHeader('content-length');
    return originalEnd(output, typeof encoding === 'function' ? encoding : callback);
  };
  next();
}

export default function devLocales() {
  return {
    name: 'horizon-dev-locales',
    hooks: {
      'astro:server:setup': ({ server }) => { server.middlewares.use(localeMiddleware); },
    },
  };
}
