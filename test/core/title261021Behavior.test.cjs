'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const adapter=require('../../scripts/official261021.cjs');
function report({host='local',title='Renamed local chat',resolved='server-thread',route='client-thread'}={}) {
  const text=fs.readFileSync(path.join(__dirname,'../../.artifacts/update-024/originals',adapter.CONVERSATION_PAGE),'utf8');
  const generated=adapter.transformStage(adapter.CONVERSATION_PAGE,text,'titles');
  const start=generated.indexOf('__companionLocalTitleInit();var __companionTitleText=');
  const ending='},[a,c,l,u,__companionTitleText]);',end=generated.indexOf(ending,start);
  assert(start>=0&&end>start);const messages=[],selected=[];let cleanup;
  const context=vm.createContext({a:resolved,c:route,l:host,u:host,__companionLocalTitleAtom:'native-title',
    __companionLocalTitleInit:()=>{},y:(atom,id)=>{selected.push({atom,id});return title;},
    Q:{useEffect:effect=>{cleanup=effect();}},__companionDispatch:(type,payload)=>messages.push({type,...payload})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../resources/officialTabTitles.js'),'utf8'),context);
  vm.runInContext(generated.slice(start,end+ending.length),context);
  return {messages,selected,cleanup,parse:context.__companionTabTitlePayload};
}
test('the local page reports the native renamed title and resolves client/server route identities',()=>{
  const f=report();assert.deepEqual(f.selected,[{atom:'native-title',id:'server-thread'}]);
  assert.equal(f.messages[0].threadId,'server-thread');assert.equal(f.messages[0].routeThreadId,'client-thread');
  assert.equal(f.messages[0].route,'/local/client-thread');assert.equal(f.messages[0].title,'Renamed local chat');
  assert.equal(f.parse(f.messages[0],'/local/').reset,false);f.cleanup();assert.equal(f.messages[1].reset,true);
});
test('remote and untitled local views reset the tab instead of reporting a local title',()=>{
  for(const input of [{host:'remote'},{title:''},{route:null}]){const f=report(input);assert.equal(f.messages[0].reset,true);assert.equal(f.messages[0].threadId,null);}
});
