import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localizeHtml } from '../scripts/build-locales.mjs';
import { localeMiddleware } from '../scripts/integrations/dev-locales.mjs';
const source = '<!doctype html><html lang="zh-CN"><head><title>雷达</title></head><body><h1>开发者效率雷达日报</h1><a data-language="zh-Hant" href="/">繁</a><a data-language="zh-Hans" href="/zh-hans/">简</a><a href="/radar/dev/">开发</a><code>开发</code><script>const name="开发";</script></body></html>';
test('traditional and simplified routes use distinct text and preserve counterpart paths', () => {
  const traditional = localizeHtml(source, '/radar/dev/', 'traditional');
  const simplified = localizeHtml(source, '/radar/dev/', 'simplified');
  assert.match(traditional, /lang="zh-Hant"/);
  assert.match(traditional, /<h1>開發者效率雷達日報<\/h1>/);
  assert.match(simplified, /lang="zh-Hans"/);
  assert.match(simplified, /<h1>开发者效率雷达日报<\/h1>/);
  assert.match(traditional, /href="\/zh-hans\/radar\/dev\/"/);
  assert.match(simplified, /data-language="zh-Hant" href="\/radar\/dev\/"/);
  assert.match(traditional, /<code>开发<\/code>/);
  assert.match(traditional, /const name="开发"/);
});
for (const [url, expectedRoute, expectedText] of [
  ['/radar/dev/', '/radar/dev/', '開發者效率雷達日報'],
  ['/zh-hans/radar/dev/?q=1', '/radar/dev/?q=1', '开发者效率雷达日报'],
]) test(`development HTML response is localized for ${url}`, () => {
  const req = { url };
  const headers = new Map([['content-type','text/html'],['content-length',999]]);
  let output;
  const res = { getHeader: k => headers.get(k), removeHeader: k => headers.delete(k), write() {}, end: chunk => {output=chunk;} };
  localeMiddleware(req,res,()=>{assert.equal(req.url, expectedRoute);res.write(source.slice(0,70));res.end(source.slice(70));});
  assert.match(output,new RegExp(`<h1>${expectedText}</h1>`));
  assert.equal(headers.has('content-length'),false);
  assert.equal(req.url,url);
});
test('Astro may send HTML headers before its final chunk', () => {
  const req = {url:'/radar/'};
  let output;
  const res = {headersSent:true,getHeader:()=> 'text/html',removeHeader:()=>{throw new Error('headers already sent');},write(){},end:chunk=>{output=chunk;}};
  localeMiddleware(req,res,()=>{res.write(source.slice(0,70));res.end(source.slice(70));});
  assert.match(output,/<h1>開發者效率雷達日報<\/h1>/);
});
