import test from 'node:test';
import assert from 'node:assert/strict';
import {researchPage,researchPageHref,categorySlug} from '../src/lib/research-pagination.mjs';
const entries=Array.from({length:29},(_,i)=>({data:{slug:`article-${i}`,featured:i<4,category:i<25?['AI编程']:['AI安全']}}));
test('featured overflow stays in archive and every article appears exactly once',()=>{
 const first=researchPage(entries);const pages=Array.from({length:first.totalPages},(_,i)=>researchPage(entries,'',i+1));
 const all=[...first.featured,...pages.flatMap(p=>p.entries)];
 assert.equal(first.featured.length,3);assert.equal(all.length,29);assert.equal(new Set(all.map(e=>e.data.slug)).size,29);
 assert.ok(pages.every(p=>p.entries.length<=12));assert.ok(pages.slice(1).every(p=>p.featured.length===0));
});
test('category filtering precedes pagination and includes featured articles',()=>{
 const pages=[1,2,3].map(page=>researchPage(entries,'AI编程',page));
 assert.deepEqual(pages.flatMap(p=>p.entries),entries.slice(0,25));assert.ok(pages.every(p=>p.featured.length===0));
 assert.throws(()=>researchPage(entries,'AI编程',4),RangeError);
});
test('empty results and page URLs are stable',()=>{
 assert.equal(researchPage([]).totalPages,1);assert.equal(researchPage(entries,'missing').entries.length,0);
 assert.equal(researchPageHref('',2),'/research/page/2/');
 assert.equal(researchPageHref('AI编程',2),`/research/category/${categorySlug('AI编程')}/page/2/`);
 assert.notEqual(categorySlug('AI编程'),categorySlug('AI安全'));
});
