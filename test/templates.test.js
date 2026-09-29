'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {BotDb}=require('../src/db');
const {createTelegramApi,clearMockCalls,getMockCalls}=require('../src/telegram');
for(const name of ['shop','uploader','post_composer','channel_manager','quiz','downloader']) {
  test(`template ${name} responds to start`, async()=> {
    clearMockCalls();
    const db=new BotDb(':memory:');
    const scoped=db.getBotScopedDb('test_'+name);
    const api=createTelegramApi('123456789:ABCdefGHIjklMNOpqrsTUVwxyZ12345',{mock:true});
    const template=require('../src/templates/'+name);
    assert.equal(typeof template.handle,'function');
    await template.handle({update:{message:{from:{id:123},chat:{id:123,type:'private'},message_id:1,text:'/start'}},bot:{id:'test_'+name,owner_id:123,config:'{}'},db:scoped,api});
    assert.ok(getMockCalls().some(call=>call.method==='sendMessage' || call.method==='sendPoll'),'start should produce a Telegram response');
    db.close();
  });
}
