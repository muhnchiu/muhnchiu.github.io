import {performance} from 'node:perf_hooks';
import {channel} from 'node:diagnostics_channel';
import {sha256} from '../radar-judgment/provider.mjs';
export const STAGES=Array.from({length:26},(_,i)=>'Q'+i);
/** Only allowlisted scalar metadata is retained. Never retain HTTP objects or errors. */
export class QualificationTiming {
  constructor({sink=()=>{},clock=()=>performance.now()}={}){this.sink=sink;this.clock=clock;this.events=[];this.failure=false;this.currentCall=null;this.subscriptions=[];}
  mark(stage,edge='POINT',metadata={}){
    const safe={};for(const key of ['callIndex','status','bytes','errorClass','errorCode','aborted','requestHash','responseHash'])if(Object.hasOwn(metadata,key)&&['string','number','boolean'].includes(typeof metadata[key]))safe[key]=metadata[key];
    const event={stage,edge,monotonicMs:this.clock(),wallClock:new Date().toISOString(),callIndex:this.currentCall,...safe};
    this.events.push(event);try{this.sink(event);}catch{this.failure=true;}
  }
  assertReady(){if(this.failure)throw Object.assign(Error('QUALIFICATION_AUDIT_FAILURE'),{code:'QUALIFICATION_AUDIT_FAILURE'});}
  attachTransport(){
    const hooks={'undici:client:beforeConnect':['CONNECT','START'],'undici:client:connected':['CONNECT','END'],'undici:client:sendHeaders':['Q12','POINT'],'undici:request:bodyChunkReceived':['Q15','POINT'],'undici:client:connectError':['CONNECT_ERROR','POINT'],'undici:request:bodySent':['Q13','POINT'],'undici:request:headers':['Q14','POINT'],'undici:request:trailers':['TRANSPORT_BODY','END'],'undici:request:error':['TRANSPORT_ERROR','POINT']};
    for(const [name,[stage,edge]] of Object.entries(hooks)){
      const fn=message=>{if(this.currentCall===null)return;if(stage==='Q15'&&this.events.some(e=>e.stage==='Q15'&&e.callIndex===this.currentCall))return;this.mark(stage,edge,{status:message.response?.statusCode,errorClass:message.error?.name,errorCode:typeof message.error?.code==='string'?message.error.code:'',aborted:message.error?.name==='AbortError'});};
      channel(name).subscribe(fn);this.subscriptions.push([name,fn]);
    }
  }
  close(){for(const [name,fn]of this.subscriptions)channel(name).unsubscribe(fn);this.subscriptions=[];}
  snapshot(){
    const stages=STAGES.map(stage=>{const events=this.events.filter(e=>e.stage===stage),start=events.find(e=>e.edge==='START'),end=events.findLast(e=>e.edge==='END');return {stage,classification:events.length?'OBSERVED':['Q3','Q9','Q10','Q11','Q19'].includes(stage)?'NOT_EXPOSED_BY_RUNTIME':'NOT_REACHED',monotonicStart:start?.monotonicMs??null,monotonicEnd:end?.monotonicMs??null,durationMs:start&&end?end.monotonicMs-start.monotonicMs:null,events};});
    return {clock:'performance.now MONOTONIC',events:this.events,stages,sinkFailure:this.failure,notes:{Q3:'Provider credential resolved from config, not Keychain; governance signing separate.',Q9_Q11:'Native fetch diagnostic channels expose combined connection start/end, not separate DNS/TCP/TLS.',Q12:'Native Undici sendHeaders event.',Q15:'First native Undici bodyChunkReceived event; no body data retained.',Q19:'Provider typed provenance generation timestamp is not exposed; local validation is Q18.',Q23:'Observed only when fetch/text settles after signal abortion; abort emission alone is not cancellation completion.'}};
  }
}
/** Preserve native body consumption/parsing, record headers before the adapter reads body. */
export function observeFetch(fetchImpl,{timing=null}={}){
  const observed=[];
  return {observed,async fetch(input,options){
    timing?.assertReady();const row={attempted:true,responseHash:null,modelId:null,observableVersionStatus:'UNOBSERVABLE',observableVersion:null,headersReceived:false,bodyComplete:false};observed.push(row);
    timing?.mark('Q6','POINT',{bytes:Buffer.byteLength(options.body??'')});timing?.mark('Q8','START');
    try{
      const response=await fetchImpl(input,options);row.headersReceived=true;row.httpStatus=response.status;timing?.mark('Q8','END');timing?.mark('Q14','POINT',{status:response.status});timing?.assertReady();
      const wrapped=new Proxy(response,{get(target,key){
        if(key==='text')return async()=>{
          timing?.mark('Q16','START');
          try{const text=await target.text();row.bodyComplete=true;row.responseHash=sha256(text);timing?.mark('Q16','END',{bytes:Buffer.byteLength(text),responseHash:row.responseHash});timing?.mark('Q17','START');
            let json;try{json=JSON.parse(text);}catch{}if(typeof json?.model==='string')row.modelId=json.model;const version=json?.model_version??json?.modelVersion;if(typeof version==='string'&&version){row.observableVersionStatus='OBSERVABLE';row.observableVersion=version;}
            timing?.assertReady();return text;
          }catch(error){if(options.signal?.aborted)timing?.mark('Q23','POINT',{aborted:true});throw error;}
        };
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
      if(!response.ok)await wrapped.text();
      return wrapped;
    }catch(error){timing?.mark('TRANSPORT_ERROR','POINT',{errorClass:error.name,errorCode:error.code??'',aborted:options.signal?.aborted??false});if(options.signal?.aborted)timing?.mark('Q23','POINT',{aborted:true});throw error;}
  }};
}
export function instrumentAdapter(provider,timing){
  if(!timing)return provider;
  const execute=provider.adapter.execute.bind(provider.adapter);
  provider.adapter.execute=async(payload,options)=>{timing.assertReady();timing.mark('Q7','START');try{const value=await execute(payload,options);timing.mark('Q17','END');timing.mark('Q7','END');timing.mark('Q24','END');timing.assertReady();return value;}catch(error){timing.mark('Q7','END');timing.mark('Q24','END',{errorClass:error.name,errorCode:error.code??'',aborted:options.signal?.aborted??false});throw error;}};
  return provider;
}
