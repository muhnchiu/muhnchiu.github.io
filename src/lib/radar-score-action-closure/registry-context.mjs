import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sha256,canonical} from '../radar-judgment/provider.mjs';
import {validateRegistryPair} from '../radar-registry/validator.ts';
/** Read-only post-commit audit binding. File presence alone is never a committed receipt. */
export async function readCommittedRegistryContext(store){
  const paths={event:join(store,'radar-event-registry.jsonl'),observation:join(store,'radar-observation-registry.jsonl'),journal:join(store,'radar-registry-transaction.json'),audit:join(store,'audit/registry-operations.jsonl')};
  const bytes=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([key,path])=>[key,await readFile(path)])));
  const parse=b=>b.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
  const pair={events:parse(bytes.event),observations:parse(bytes.observation)};
  if(!validateRegistryPair(pair).valid)throw Error('REGISTRY_SEMANTIC_CONFLICT');
  const journal=JSON.parse(bytes.journal);const audit=parse(bytes.audit);
  if(journal.state!=='COMMITTED'||journal.eventFinalSha256!==sha256(bytes.event)||journal.observationFinalSha256!==sha256(bytes.observation)||!audit.some(a=>a.operation==='WRITE_RESULT'&&a.success===true&&a.transactionId===journal.transactionId))throw Error('REGISTRY_STATE_MISMATCH');
  const records=pair.observations.map(obs=>{
    const event=pair.events.find(e=>e.eventKey===obs.eventKey);
    const writes=audit.filter(a=>a.operation==='WRITE_RESULT'&&a.success===true&&a.eventKey===obs.eventKey&&a.observationId===obs.observationId&&a.transactionId);
    const receipt=writes.at(-1);const states={NEW_EVENT:'NEW',DUPLICATE_OBSERVATION:'DUPLICATE'};const eventState=states[receipt?.disposition];
    if(!receipt||!eventState||eventState!==event.lastEventState||receipt.source?.radar!==(obs.radar==='security'?'SEC':obs.radar.toUpperCase())||receipt.source?.sourceName!==obs.sourceName||receipt.evidenceReference!==obs.sourceUrl)throw Error('REGISTRY_STATE_MISMATCH');
    return {event,observation:obs,registryResult:{committed:true,registryWriteStatus:'COMMITTED',eventKey:event.eventKey,eventState,duplicate:eventState==='DUPLICATE',transactionId:receipt.transactionId,observationId:obs.observationId,policyVersion:'1.0'},provenance:{authority:'REGISTRY_POLICY_1.0',method:'VERIFIED_PAIR_COMMITTED_JOURNAL_AND_SUCCESSFUL_POST_COMMIT_WRITE_RESULT',auditRef:'registry-audit:sha256:'+sha256(bytes.audit),auditHash:sha256(bytes.audit),receiptHash:sha256(canonical(receipt)),journalHash:sha256(bytes.journal),eventRegistryHash:sha256(bytes.event),observationRegistryHash:sha256(bytes.observation)}};
  });
  return {records,hashes:Object.fromEntries(Object.entries(bytes).map(([key,b])=>[key,{path:paths[key],sha256:sha256(b)}]))};
}
