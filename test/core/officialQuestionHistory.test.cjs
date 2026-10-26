'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../resources/officialQuestionHistory.js'),'utf8');
const {project,candidates,create}=new Function(source+';return {project:__companionQuestionProject,candidates:__companionQuestionCandidates,create:__companionCreateQuestionHistory};')();
const q=(id='q',count=2)=>({id,type:'agentMessage',questions:Array.from({length:count},(_,i)=>({title:'PRIVATE question '+i,options:['PRIVATE option']}))});
const prompt=(id='prompt')=>({id,type:'userMessage',content:[{type:'text',text:'PRIVATE prompt'}]});
const key=(id,index)=>JSON.stringify(['request_user_input_async',id,index]);
function answer(id='a',indices=[0],questionId='q'){
 const values=indices.map(index=>({questionItemId:key(questionId,index),question:'PRIVATE title',answer:'PRIVATE answer'}));
 return {id,type:'userMessage',content:[{type:'text',text:'context\n## My request:\n<send_user_message_question_reply>'+JSON.stringify(values)+'</send_user_message_question_reply>'}]};
}
function harness(){
 const h={seq:0,epoch:0,view:{},completed:[]};
 h.api=create({currentEpoch:()=>h.epoch,complete:data=>h.completed.push(data)});
 h.track=(method,params={},view=h.view,threadId='t')=>{const r={requestId:String(++h.seq),method,params:{threadId,...params},threadId,webview:view,requestSeq:h.seq,liveEpoch:h.epoch};h.api.track(r);return r;};
 h.receive=(r,data,error)=>h.api.receive(r,data,error);
 h.root=(itemsView='notLoaded',extra={},view=h.view,threadId='t')=>h.track('thread/turns/list',{itemsView,sortDirection:'desc',cursor:null,...extra},view,threadId);
 h.meta=(r,id='turn',items=[],itemsView='notLoaded',extra={})=>h.receive(r,{data:[{id,status:'completed',startedAt:null,items,itemsView,...extra}],nextCursor:null});
 h.page=(cursor,data,nextCursor,extra={},view=h.view)=>{const r=h.track('thread/items/list',{turnId:'turn',sortDirection:'desc',cursor,...extra},view);return h.receive(r,{data:data.map(item=>({turnId:'turn',item})),nextCursor});};
 return h;
}

test('projection retains only IDs and exact per-question reply keys',()=>{
 const projected=[project(prompt()),project(q()),project(answer())];
 assert.deepEqual(candidates(projected),[{itemId:'q',questionKeys:[key('q',1)]}]);
 assert(!JSON.stringify(projected).includes('PRIVATE'));
 assert.deepEqual(candidates([...projected,project(answer('b',[1]))]),[]);
 const rejected={...answer(),type:'steeringUserMessage',status:'rejected',input:answer().content};
 assert.deepEqual(project(rejected).answerKeys,[]);
 assert.deepEqual(project({...rejected,status:'accepted'}).answerKeys,[key('q',0)]);
 assert.deepEqual(project({id:'plain',type:'agentMessage',text:'Ordinary'}).questionKeys,[]);
 assert.deepEqual(project(prompt()).answerKeys,[]);
});

test('malformed and over-limit question/reply inputs abstain instead of implying no question',()=>{
 for(const item of [null,{},q('q',129),{...q(),questions:'bad'},{...q(),questions:[null]},answer('',[0])])assert.equal(project(item),null);
 assert.equal(project({id:'a',type:'userMessage',content:[{type:'text',text:'<send_user_message_question_reply>{bad}</send_user_message_question_reply>'}]}),null);
 assert.equal(project({id:'a',type:'userMessage',content:[{type:'text',text:'x'.repeat(65537)}]}),null);
 assert.equal(project(q('x'.repeat(4096))),null);
});

test('natural native resume initialTurnsPage emits a complete compact latest turn with null time',()=>{
 const h=harness(),r=h.track('thread/resume',{excludeTurns:true,initialTurnsPage:{limit:5,itemsView:'full',sortDirection:'desc'}});
 assert.equal(h.receive(r,{thread:{id:'t',turns:[]},initialTurnsPage:{data:[{id:'turn',status:'completed',startedAt:null,itemsView:'full',items:[prompt(),q(),answer()]}],nextCursor:'older-turns'}}),true);
 assert.equal(h.completed.length,1);assert.equal(h.completed[0].turn.startedAt,null);
 assert.deepEqual(candidates(h.completed[0].items),[{itemId:'q',questionKeys:[key('q',1)]}]);
 assert(!JSON.stringify(h.completed).includes('PRIVATE'));
 assert.equal(h.receive(r,{thread:{id:'t'},initialTurnsPage:{data:[],nextCursor:null}}),false);
});

test('inline full latest turn is independent of older-turn pagination but missing itemsView defaults summary',()=>{
 const h=harness();assert.equal(h.meta(h.root('full'),'turn',[q()],'full'),true);
 const other=harness(),r=other.track('thread/turns/list',{cursor:null});
 assert.equal(other.meta(r,'turn',[q()],'full'),false);assert.equal(other.completed.length,0);
 assert.equal(other.meta(other.root('full'),'turn',[q()],'summary'),false);
});

for(const direction of ['asc','desc'])test('gap-free item chain '+direction+' closes only at explicit null',()=>{
 const h=harness();h.meta(h.root());
 assert.equal(h.page(null,[q()], 'page2',{sortDirection:direction}),false);
 assert.equal(h.page('page2',[answer()],{type:'item',itemId:'anchor3'},{sortDirection:direction}),false);
 assert.equal(h.completed.length,0);
 assert.equal(h.page({type:'item',itemId:'anchor3'},[prompt()],null,{sortDirection:direction}),true);
 assert.deepEqual(candidates(h.completed[0].items),[{itemId:'q',questionKeys:[key('q',1)]}]);
});

test('ascending turn root proves newest only if entire turn list is complete',()=>{
 const h=harness(),r=h.root('full',{sortDirection:'asc'});
 const data=[{id:'old',status:'completed',items:[q('old')]},{id:'turn',status:'completed',items:[q()]}];
 assert.equal(h.receive(r,{data,nextCursor:'more'}),false);assert.equal(h.completed.length,0);
 const r2=h.root('full',{sortDirection:'asc'});assert.equal(h.receive(r2,{data,nextCursor:null}),true);assert.equal(h.completed[0].turn.id,'turn');
});

test('missing, malformed, cyclic and skipped item cursors never complete',()=>{
 const cases=[(h)=>h.page(null,[q()],undefined),(h)=>h.page('not-root',[q()],null),(h)=>{h.page(null,[q()],'p');return h.page('p',[prompt()],'p');},(h)=>h.page(null,[q()],''),(h)=>h.page(null,[q()],{type:'unknown',itemId:'x'})];
 for(const run of cases){const h=harness();h.meta(h.root());assert.equal(run(h),false);assert.equal(h.completed.length,0);assert.equal(h.page(null,[q()],null),false);}
});

test('wrong turn, malformed page and invalid projection invalidate rather than completing empty evidence',()=>{
 const h=harness();h.meta(h.root());const r=h.track('thread/items/list',{turnId:'turn',cursor:null});
 assert.equal(h.receive(r,{data:[{turnId:'OTHER',item:q()}],nextCursor:null}),false);
 for(const items of [[null],[{}],[q('q',129)],[{id:'bad',type:'agentMessage',questions:{}}]]){
  const k=harness();assert.equal(k.meta(k.root('full'),'turn',items,'full'),false);assert.equal(k.completed.length,0);
 }
});

test('same item IDs deduplicate only identical projections, including answer keys',()=>{
 const h=harness();h.meta(h.root());h.page(null,[q(),answer()],'p');assert.equal(h.page('p',[q(),answer()],null),true);assert.equal(h.completed[0].items.length,2);
 const k=harness();k.meta(k.root());k.page(null,[answer('same',[0])],'p');assert.equal(k.page('p',[answer('same',[1])],null),false);assert.equal(k.completed.length,0);
});

test('new root supersedes old generation; roots from separate panels cannot merge or regress newer completion',()=>{
 const h=harness(),old=h.root('full'),fresh=h.root('full');assert.equal(h.meta(old,'old',[q()],'full'),false);assert.equal(h.meta(fresh,'turn',[q()],'full'),true);
 const k=harness(),viewB={},a=k.root('full'),b=k.root('full',{},viewB);assert.equal(k.meta(b,'new',[q()],'full'),true);assert.equal(k.meta(a,'old',[q()],'full'),false);
 const cross=harness();cross.meta(cross.root());assert.equal(cross.page(null,[q()],null,{},{}),false);assert.equal(cross.completed.length,0);
});

test('live epoch change between header and item request invalidates the whole chain',()=>{
 const h=harness();h.meta(h.root());h.epoch++;assert.equal(h.page(null,[q()],null),false);assert.equal(h.completed.length,0);
 const k=harness(),r=k.root('full');k.epoch++;assert.equal(k.meta(r,'turn',[q()],'full'),false);
});

test('error, abandon, disposal and clear cannot revive old chains or generations',()=>{
 for(const mode of ['error','forget','dispose','clear']){
  const h=harness(),r=h.root();h.meta(r);const p=h.track('thread/items/list',{turnId:'turn',cursor:null});
  if(mode==='error')h.receive(p,null,{message:'failure'});else if(mode==='forget')h.api.forget(p);else if(mode==='dispose')h.api.disposeWebview(h.view);else h.api.clear();
  const fresh=h.root('full');assert.equal(h.receive(p,{data:[{turnId:'turn',item:q()}],nextCursor:null}),false);assert.equal(h.meta(fresh,'turn',[q()],'full'),true);
 }
});

test('group eviction is bounded and old generation cannot ABA-match a recreated view',()=>{
 const h=harness(),old=h.root('full');for(let i=0;i<16;i++)h.root('full',{}, {index:i},'other'+i);
 const fresh=h.root('full');assert.equal(h.meta(old,'old',[q()],'full'),false);assert.equal(h.meta(fresh,'turn',[q()],'full'),true);
});

test('item, page and question bounds fail closed',()=>{
 for(const items of [Array.from({length:513},(_,i)=>prompt('p'+i)),Array.from({length:33},(_,i)=>q('q'+i))]){
  const h=harness();assert.equal(h.meta(h.root('full'),'turn',items,'full'),false);assert.equal(h.completed.length,0);
 }
 const h=harness();h.meta(h.root());for(let i=0;i<16;i++)assert.equal(h.page(i?'p'+i:null,[prompt('p'+i)],'p'+(i+1)),false);
 assert.equal(h.page('p16',[q()],null),false);assert.equal(h.completed.length,0);
});

test('resume identity and malformed latest headers never expose another turn',()=>{
 for(const thread of [{id:'other'},{id:'t',hostId:'remote'},null]){
  const h=harness(),r=h.track('thread/resume',{initialTurnsPage:{itemsView:'full'}});
  assert.equal(h.receive(r,{thread,initialTurnsPage:{data:[{id:'turn',status:'completed',items:[q()]}],nextCursor:null}}),false);
 }
 for(const data of [[{}],[{id:'turn',status:'mystery',items:[q()]}],[{id:'turn',status:'completed',startedAt:Infinity,items:[q()]}],[{id:'turn',status:'completed',items:[q()]},null]]){
  const h=harness();assert.equal(h.receive(h.root('full'),{data,nextCursor:null}),false);assert.equal(h.completed.length,0);
 }
});
