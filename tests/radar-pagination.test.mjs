import test from 'node:test';
import assert from 'node:assert/strict';
import {paginateReports, reportPageHref, REPORTS_PER_PAGE} from '../src/lib/radar-pagination.mjs';
test('pagination covers boundary counts without missing or repeating reports',()=>{
  for(const size of [0,1,12,13,24,25,121]){
    const reports=Array.from({length:size},(_,id)=>({id}));
    const total=paginateReports(reports).totalPages;
    const pages=Array.from({length:total},(_,i)=>paginateReports(reports,i+1));
    assert.deepEqual(pages.flatMap(p=>p.entries),reports);
    assert.ok(pages.every(p=>p.entries.length<=REPORTS_PER_PAGE));
    assert.equal(total,Math.max(1,Math.ceil(size/REPORTS_PER_PAGE)));
  }
});
test('invalid pages fail instead of silently producing an empty archive',()=>{
  for(const page of [0,-1,1.5,2])assert.throws(()=>paginateReports([],page),RangeError);
});
test('first page returns to the category; subsequent pages have static URLs',()=>{
 assert.equal(reportPageHref('ai',1),'/radar/ai/#report-archive');
 assert.equal(reportPageHref('ai',2),'/radar/ai/archive/2/#report-archive');
});
