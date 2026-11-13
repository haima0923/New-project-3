#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { parseInput } = require('../server/utils/parser');
const { applyFinalParseSafety } = require('../server/utils/parse-safety');
const clock = { businessDate:'2026-07-15', businessTimezone:'Asia/Shanghai', nowInstant:'2026-07-15T02:00:00.000Z' };
let passed = 0, total = 0, modelCalls = 0;
const startup = { suppressedListeners:0 };
const serverFile = path.resolve(__dirname, '../server/src/server.js');
const actualRequire = createRequire(serverFile);
const context = vm.createContext({
  module:{exports:{}}, console:{log(){}}, Buffer, setTimeout, clearTimeout,
  require(name) {
    if (name === 'http') return {createServer(){return {listen(port,host,callback){startup.suppressedListeners++;callback();}};}};
    if (name === './config') return {getConfig:()=>({port:0,authRequired:true}),assertAuthConfig(){},isRealAiEnabled:()=>false};
    if (name === './ai/model') {
      const blocked = () => {modelCalls++;throw new Error('MODEL_CALL_NOT_ALLOWED');};
      return {createInternalParseRouteContext:blocked,parseWithAi:blocked,queryWithAi:blocked,transcribeWithAi:blocked};
    }
    return actualRequire(name);
  }
});
vm.runInContext(fs.readFileSync(serverFile,'utf8') + '\nmodule.exports={decideServerParseRoute,countPotentialItemFactEvidence};',context,{filename:serverFile});
const { decideServerParseRoute, countPotentialItemFactEvidence } = context.module.exports;
function check(name,run){total++;try{run();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+': '+e.message);process.exitCode=1;}}
function parse(text){const result=parseInput(Object.assign({text,state:{},source:'typed',context:'input'},clock));assert.strictEqual(result.original_text,text);return result;}
function route(text,extra={}){return decideServerParseRoute(Object.assign({text,rawText:text,extractedText:text,source:'typed',context:'input'},clock,extra));}
for(const [product,unit] of [['三角架','个'],['六角螺丝','个'],['八角桌','个'],['三角支架','个'],['三件套','套'],['四件套工具','套'],['两件套礼盒','套']]){
  check('明确商品与采购数量：'+product,()=>{const r=parse(`王总下单${product}500${unit}，每${unit}6元，11月30日交`);assert.strictEqual(r.fields.productName,product);assert.strictEqual(r.fields.quantity,'500');assert.strictEqual(r.fields.unitPrice,'6');assert.strictEqual(r.fields.amount,'3000');assert.strictEqual(r.fields.items.length,1);assert.strictEqual(r.fields.items[0].productName,product);assert(!r.low_confidence_fields.includes('productName'));});
}
for(const [product,quantity] of [['三件套','五百'],['四件套工具','两百']]){
  check('中文采购数量与无标点计价：'+product,()=>{const r=parse(`王总下单${product}${quantity}套六元一套11月30日交`);assert.strictEqual(r.fields.productName,product);assert.strictEqual(r.fields.quantity,quantity==='五百'?'500':'200');assert.strictEqual(r.fields.unitPrice,'6');assert.strictEqual(r.fields.items.length,1);});
}
for(const product of ['三件套','四件套工具','两件套礼盒'])check('名称内部数字不能补采购量：'+product,()=>{const text=`王总下单${product}每套6元，11月30日交`;const r=parse(text);assert.strictEqual(r.fields.productName,product);assert.strictEqual(r.fields.quantity,'');assert.strictEqual(r.fields.amount,'');assert(r.missing_fields.includes('quantity'));assert.notStrictEqual(route(text).route,'AUTO_DEEP');});
for(const product of ['三角架','六角螺丝'])check('形状名不能补单价：'+product,()=>{const r=parse(`王总下单${product}500个，11月30日交`);assert.strictEqual(r.fields.productName,product);assert.strictEqual(r.fields.unitPrice,'');assert.strictEqual(r.fields.amount,'');});
check('普通三件仍为采购量3',()=>{const r=parse('王总下单礼品盒三件，每件6元，11月30日交');assert.strictEqual(r.fields.quantity,'3');assert.strictEqual(r.fields.amount,'18');});
check('价格紧邻日期不会变小数',()=>{const r=parse('王总下单四件套工具100套每套3元8月15日交');assert.strictEqual(r.fields.unitPrice,'3');assert.strictEqual(r.fields.amount,'300');});
check('真实3元8口语价保留',()=>{const r=parse('王总下单三件套100套，3元8一套，11月30日交');assert.strictEqual(r.fields.unitPrice,'3.8');assert.strictEqual(r.fields.amount,'380');});
check('实际三角钱仍为单价',()=>{assert.strictEqual(parse('王总下单礼品盒100个，每个三角钱，11月30日交').fields.unitPrice,'0.3');});
const numericText='王总下单三件套500套，每套6元；三角架100个，每个5元；11月30日交。';
check('数字商品名多商品及服务端独立路由',()=>{const r=route(numericText);assert.strictEqual(r.route,'AUTO_DEEP');assert.strictEqual(r.localDraft.original_text,numericText);assert.deepStrictEqual(Array.from(r.localDraft.fields.items,i=>[i.productName,i.quantity,i.unitPrice]),[['三件套','500','6'],['三角架','100','5']]);assert.strictEqual(r.localDraft.fields.amount,'3500');assert.strictEqual(countPotentialItemFactEvidence(numericText),2);assert(/^[a-f0-9]{64}$/.test(r.originalTextFingerprint));});
check('伪造客户端草稿不改变服务端重验',()=>{const clean=route(numericText),forged=route(numericText,{route:'FAST_LOCAL',requestedRoute:'FAST_LOCAL',provider:'REAL',localDraft:{intent:'order',fields:{items:[]}}});assert.strictEqual(forged.route,clean.route);const snapshot=value=>{const draft=JSON.parse(JSON.stringify(value));delete draft.id;delete draft.createdAt;return draft;};assert.deepStrictEqual(snapshot(forged.localDraft),snapshot(clean.localDraft));assert.strictEqual(forged.originalTextFingerprint,clean.originalTextFingerprint);});
check('普通多商品保持AUTO_DEEP',()=>{assert.strictEqual(route('王总下单水杯100个，每个5元；纸袋200个，每个2元；11月30日交。').route,'AUTO_DEEP');});
check('普通订单本地及缺交期追问',()=>{assert.strictEqual(route('王总下单水杯100个，每个5元，11月30日交。').route,'FAST_LOCAL');const r=route('王总下单水杯100个，每个5元。');assert.strictEqual(r.route,'ASK_USER');assert.strictEqual(r.localDraft.fields.dueDate,'');});
check('单价计量单位冲突仍阻断',()=>{const text='王总下单三件套500套，每个6元，11月30日交';const r=parse(text);assert.strictEqual(r.fields.amount,'');assert.notStrictEqual(route(text).route,'AUTO_DEEP');});
check('原话总价冲突保持',()=>{const text='王总下单三件套500套，每套6元，总价4000元，11月30日交';const r=parse(text);assert(r.field_conflicts.some(c=>c.field==='amount'));assert.notStrictEqual(route(text).route,'AUTO_DEEP');});
for(const bad of ['三角钱','五块五','三个'])check('价格与数量不能冒充商品：'+bad,()=>{const r=parse('王总下单礼品盒500个，每个6元，11月30日交');r.fields.productName=bad;r.fields.items[0].productName=bad;const reviewed=applyFinalParseSafety(r,clock);assert(reviewed.final_parse_safety.field_validations.invalid_fields.includes('productName'));});
check('待收与收款意图保持',()=>{assert.strictEqual(parse('王总还欠5000元，11月30日收').intent,'receivable');assert.strictEqual(parse('王总付了5000元').intent,'payment');});
check('测试未启动真实HTTP或模型',()=>{assert.strictEqual(startup.suppressedListeners,1);assert.strictEqual(modelCalls,0);});
console.log(`Server numeric product boundaries: ${passed}/${total} passed`);
