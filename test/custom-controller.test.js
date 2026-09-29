'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {BotDb}=require('../src/db');
const {CustomController}=require('../src/custom/controller');
const {createTelegramApi,clearMockCalls,getMockCalls}=require('../src/telegram');

test('owner ZIP, report, token and opt-in Docker launch flow (offline)',async()=>{
  clearMockCalls();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'botmaker-control-test-'));
  const db=new BotDb(':memory:');
  const activity=[];
  const runner={start:async x=>{activity.push(['start',x.botId]);return {status:'running'}},stop:async x=>{activity.push(['stop',x.botId])},logs:async x=>({logs:'hello'})};
  const config={admin_id:42,lab_mode:true,mock_telegram:true,control_bot_token:'555555555:ABCdefGHIjklMNOpqrsTUVwxyZ99999',encryption_key:'test_secret_longer_than_32_characters',projects_dir:root,skipGvisorCheck:true};
  const c=new CustomController({db,config,runner,rewriter:async()=>({candidateFiles:[]}),downloadFile:async()=>fs.readFileSync(path.join(__dirname,'fixtures','sample-node.zip'))});
  const api=createTelegramApi(config.control_bot_token,{mock:true});
  const send=(user,text,document)=>c.handle({message:{text,message_id:13,from:{id:user},chat:{id:user,type:'private'},document},api,userId:user,chatId:user});
  try {
    assert.equal(c.enabled(99),false);
    await send(42,'/source');
    await send(42,'',{file_name:'sample-node.zip',file_size:500,file_id:'fake'});
    const project=c.list(42)[0];
    assert.ok(project?.id.startsWith('src_'));
    assert.equal(project.status,'pending_admin_approval');
    c.update(project.id,{status:'approved'});
    const token='999999999:ABCdefGHIjklMNOpqrsTUVwxyZ99999';
    await send(42,token);
    assert.equal(c.get(project.id,42).token_encrypted.includes(token),false);
    assert.equal(getMockCalls().some(x=>x.method==='deleteMessage'),true);
    await send(42,`/source_run ${project.id}`);
    assert.equal(activity.filter(x=>x[0]==='start').length,1);
    assert.equal(c.get(project.id,42).status,'running');
    await send(42,`/source_stop ${project.id}`);
    assert.equal(c.get(project.id,42).status,'stopped');
    await send(42,`/source_rewrite_confirm ${project.id}`);
    assert.equal(getMockCalls().at(-1).payload.text.includes('ابتدا /source_rewrite'),true);
    await send(42,`/source_delete ${project.id}`);
    assert.equal(c.list(42).length,0);
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
});
