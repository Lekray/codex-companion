'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const adapter=require('../../scripts/official261021.cjs');
function fixture(){
  const reports=[],listeners=new Map(),timers=new Map();let timerSeq=0;
  const context=vm.createContext({Date,Math,setTimeout:fn=>{timers.set(++timerSeq,fn);return timerSeq;},clearTimeout:id=>timers.delete(id),
    __companionDispatch:(type,data)=>reports.push({type,...data}),
    __companionSubscribe:(type,handler)=>{listeners.set(type,handler);return()=>listeners.delete(type);}});
  vm.runInContext(adapter.modelWebviewSource(),context);
  return {c:context,reports,listeners,timers,receive:message=>listeners.get('companion-project-model')(message)};
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
const local=()=>({current:{conversationId:null,hostId:'local'}});
test('a newer rejected choice does not suppress an older successful choice',async()=>{
  const f=fixture(),a=deferred(),b=deferred();let count=0;
  const pick=f.c.__companionModelWrapSet(()=>++count===1?a.promise:b.promise,local());
  const first=pick('a','low'),second=pick('b','high');b.reject(Error('failed'));await assert.rejects(second);a.resolve(true);await first;
  assert.deepEqual(f.reports.map(x=>x.model),['a']);
});
test('older success cannot overwrite a newer successful choice',async()=>{
  const f=fixture(),a=deferred(),b=deferred();let count=0;
  const pick=f.c.__companionModelWrapSet(()=>++count===1?a.promise:b.promise,local());
  const first=pick('a','low'),second=pick('b','high');b.resolve(true);await second;a.resolve(true);await first;
  assert.deepEqual(f.reports.map(x=>x.model),['b']);
});
test('native setters receive a local-only option and restore is never reported as user intent',()=>{
  const f=fixture(),options=[],cell=local();
  const pick=f.c.__companionModelWrapSet((m,e,o)=>{options.push(o);return true;},cell);
  pick('a','low',{__companionRestore:true});assert.equal(f.reports.length,0);assert.equal(options[0].persistAsDefault,false);assert.equal(options[0].__companionRestore,undefined);
  cell.current={hostId:'local',conversationId:'saved'};pick('b','high');assert.equal(options[1],undefined);assert.equal(f.reports[0].conversationId,'saved');
});
test('invocation metadata is captured before navigation and a thrown setter leaves no pending choice',async()=>{
  const f=fixture(),cell=local(),done=deferred();const pick=f.c.__companionModelWrapSet(()=>done.promise,cell);
  const result=pick('a','low');cell.current={conversationId:'saved',hostId:'remote'};done.resolve(true);await result;
  assert.equal(f.reports[0].hostId,'local');assert.equal(f.reports[0].conversationId,null);
  const bad=f.c.__companionModelWrapSet(()=>{throw Error('bad');},local());assert.throws(()=>bad('a','low'));assert.equal(f.c.__companionModelState('').pending,0);
});
function restoreFixture(){
  const f=fixture(),calls=[];const cell={current:{conversationId:null,hostId:'local',locked:false,catalog:null,status:'pending',settings:{isLoading:true},selection:{setModelAndReasoningEffort:(...args)=>{calls.push(args);return true;}}}};
  const stop=f.c.__companionModelRestoreStart(cell);return{...f,cell,calls,stop};
}
function ready(f){f.cell.current={...f.cell.current,status:'success',settings:{isLoading:false},catalog:{models:[{model:'a',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}};}
test('a stored pair waits for the catalog and applies using the latest render data',()=>{
  const f=restoreFixture(),request=f.reports[0];f.receive({requestId:request.requestId,valid:true,model:'a',effort:'high',projectKey:'project-a'});assert.equal(f.calls.length,0);
  ready(f);f.c.__companionModelApplyCurrent();assert.equal(f.calls.length,1);assert.equal(f.calls[0][2].persistAsDefault,false);assert.equal(f.calls[0][2].__companionRestore,true);
  f.c.__companionModelApplyCurrent();assert.equal(f.calls.length,1);assert.equal(f.c.__companionModelBus().projectKey,'project-a');f.stop();assert.equal(f.listeners.size,0);
});
test('pending retries survive catalog identity changes and cleanup cancels timers',()=>{
  const f=restoreFixture();f.receive({requestId:f.reports[0].requestId,pending:true});ready(f);f.c.__companionModelApplyCurrent();assert.equal(f.timers.size,1);
  [...f.timers.values()][0]();assert.equal(f.reports.length,2);f.stop();assert.equal(f.timers.size,0);assert.equal(f.listeners.size,0);
});
test('a user choice wins over delayed restore, and a new HOME generation starts fresh',()=>{
  const f=restoreFixture();ready(f);const request=f.reports[0],pick=f.c.__companionModelWrapSet(()=>true,local());pick('b','low');
  f.receive({requestId:request.requestId,valid:true,model:'a',effort:'high'});assert.equal(f.calls.length,0);f.stop();
  const stop=f.c.__companionModelRestoreStart(f.cell);assert.equal(f.reports.at(-1).type,'companion-project-model-request');assert.equal(f.c.__companionModelState('').userChose,false);stop();
});
test('saved, remote and policy-locked composers never request or apply project defaults',()=>{
  for(const change of [{conversationId:'saved'},{hostId:'remote'},{locked:true}]){const f=fixture();f.c.__companionModelRestoreStart({current:{conversationId:null,hostId:'local',...change}})();assert.equal(f.reports.length,0);}
});
test('a native new-thread draft may restore preferences when the model is not policy locked',()=>{
  const f=fixture();
  const stop=f.c.__companionModelRestoreStart({current:{conversationId:null,hostId:'local',managedDraft:true,locked:false}});
  assert.equal(f.reports.length,1);assert.equal(f.reports[0].type,'companion-project-model-request');stop();
});
test('the native ordinary-HOME setter updates the native optimistic atom without writing defaults',async()=>{
  const original=fs.readFileSync(path.join(__dirname,'../../.artifacts/update-024/originals',adapter.MODEL_SETTINGS),'utf8');
  const patched=adapter.transformStage(adapter.MODEL_SETTINGS,original,'workflow');const begin=patched.indexOf('x=async(e,t,n)=>{');const end=patched.indexOf('},n[6]=b',begin);assert(begin>=0&&end>begin);
  const sets=[];let defaults=0,cleared=0;
  const c=vm.createContext({et:()=>{},l:{get:()=>({serviceTier:'fast'}),set:(...args)=>sets.push(args)},r:null,g:false,b:'a',_:false,p:false,__companionHost:{hostId:'local',cwd:'project'},Qe:'native-optimistic',qe:'native-tier-override',Ye:x=>['default',x.hostId,x.cwd],N:()=>({clearPrewarmedThreads:async()=>{cleared++;}}),h:{hostId:'local',setModelAndReasoningEffort:()=>{defaults++;return true;}}});
  const setter=vm.runInContext('('+patched.slice(begin+2,end+1)+')',c);assert.equal(await setter('a','high',{persistAsDefault:false}),true);assert.equal(defaults,0);assert.equal(cleared,1);assert.equal(sets[0][0],'native-optimistic');assert.equal(sets[0][2].reasoningEffort,'high');assert.equal(sets[0][2].serviceTier,'fast');await setter('b','low',{persistAsDefault:false,serviceTier:'standard'});assert.equal(sets[1][0],'native-tier-override');assert.equal(sets[2][2].serviceTier,'standard');assert.equal(defaults,0);
});
