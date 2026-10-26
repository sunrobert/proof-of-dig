import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/server.mjs';
import { createDb, migrate } from '../src/db.mjs';
import { SAMPLE } from '../src/sample-bank.mjs';
import { seedBank } from '../src/bank.mjs';
import { makeDay, addDays } from './helpers.mjs';
import { SITE } from '../src/config.mjs';
import { etDate, resetAt, normalize, matchAnswer, TIER_SCORES } from '../public/rules.mjs';
import { homePage, infoPage } from '../src/html.mjs';

async function service(){const DB=createDb({url:':memory:'});await migrate(DB);const env={DB,LOCAL_DEVELOPMENT:'true',ASSETS:{fetch:async()=>new Response('not found',{status:404})}};let cookie='';return{env,async call(path,data,extra={}){const r=await handle(new Request('http://localhost:3051'+path,{...(data===undefined?{}:{method:'POST',body:JSON.stringify(data),headers:{'Content-Type':'application/json','Cookie':cookie,...extra}}),...(data===undefined?{headers:{Cookie:cookie,...extra}}:{})}),env);if(r.headers.get('Set-Cookie'))cookie=r.headers.get('Set-Cookie').split(';')[0];return{status:r.status,body:await r.json()}},cookie:()=>cookie};}

test('New York reset follows DST rather than device midnight',()=>{
  assert.equal(etDate(Date.parse('2026-10-17T03:59:59Z')),'2026-10-16');
  assert.equal(etDate(Date.parse('2026-10-17T04:00:00Z')),'2026-10-17');
  assert.equal(new Date(resetAt('2026-10-17')).toISOString(),'2026-10-18T04:00:00.000Z');
  assert.equal(new Date(resetAt('2026-12-17')).toISOString(),'2026-12-18T05:00:00.000Z');
});
test('answer matching normalizes accents, uses known aliases and avoids short fuzzy guesses',()=>{
  assert.equal(normalize('São Tomé & Príncipe'),'saotomeandprincipe');
  assert.equal(matchAnswer('Dogecoim',SAMPLE.prompts[0].answers).answer,'Dogecoin');
  assert.equal(matchAnswer('Dogecoim',SAMPLE.prompts[0].answers).correction,true);
  assert.equal(matchAnswer('xyz',SAMPLE.prompts[3].answers),null);
  assert.equal(matchAnswer('zzzzzzzzzz',SAMPLE.prompts[0].answers),null);
});
test('seven rounds are scored on server; retries cannot duplicate points; other browsers cannot read the run',async()=>{
  const s=await service();let{body:game}=await s.call('/api/start',{});const id=game.runId;
  const correction=await s.call('/api/answer',{runId:id,round:0,answer:'Dogecoim'});assert.equal(correction.body.correction,'Dogecoin');
  const rejected=await s.call('/api/answer',{runId:id,round:0,answer:'zzzzzzzzzz'});assert.equal(rejected.body.rejected,true);
  for(let i=0;i<7;i++){
    const answer=SAMPLE.prompts[i].answers.find(a=>a.tier==='satoshi').answer;
    const result=await s.call('/api/answer',{runId:id,round:i,answer,confirm:true,score:99999});assert.equal(result.status,200);assert.equal(result.body.result.score,TIER_SCORES.satoshi);game=result.body.state;
    const duplicate=await s.call('/api/answer',{runId:id,round:i,answer});assert.equal(duplicate.body.alreadyScored,true);assert.equal(duplicate.body.state.results.length,i+1);
    if(i<6){const n=await s.call('/api/next',{runId:id});assert.equal(n.body.round,i+1);}
  }
  assert.equal(game.score,700);assert.equal(game.completed,true);
  const same=await s.call('/api/start',{});assert.equal(same.body.runId,id);
  const review=await s.call('/api/review?run='+id);assert.equal(review.status,200);assert.equal(review.body.betterThan,null);assert.equal(review.body.population,0);
  const other=await service();const missing=await other.call('/api/state?run='+id);assert.equal(missing.status,404);
  const csrf=await s.call('/api/start',{}, {Origin:'https://evil.example'});assert.equal(csrf.status,403);
  s.env.DB.close();other.env.DB.close();
});
test('review stays locked, pause is server-side and practice is separate',async()=>{
  const s=await service();const{body:g}=await s.call('/api/start',{});
  assert.equal((await s.call('/api/review?run='+g.runId)).status,403);
  const paused=await s.call('/api/pause',{runId:g.runId,paused:true});assert.ok(paused.body.pausedAt);
  const resumed=await s.call('/api/pause',{runId:g.runId,paused:false});assert.equal(resumed.body.pausedAt,null);assert.ok(resumed.body.roundStart>=g.roundStart);
  assert.equal((await s.call('/api/start',{practice:true})).status,403);
  s.env.DB.close();
});
test('expired server windows cannot score late answers or be revived by pausing',async()=>{
  const s=await service();const{body:g}=await s.call('/api/start',{});
  s.env.LOCAL_DEVELOPMENT='false';
  await s.env.DB.prepare('UPDATE runs SET round_start=? WHERE id=?').bind(Date.now()-30000,g.runId).run();
  const paused=await s.call('/api/pause',{runId:g.runId,paused:true});assert.equal(paused.body.pausedAt,null);
  const late=await s.call('/api/answer',{runId:g.runId,round:0,answer:SAMPLE.prompts[0].answers.find(a=>a.tier==='satoshi').answer,confirm:true,timeout:true});
  assert.equal(late.body.result.score,0);assert.equal(late.body.state.round,1);s.env.DB.close();
});
test('openkrillion-only routes are gone',async()=>{
  const s=await service();
  for(const path of ['/llms.txt','/llms-full.txt','/pricing.md','/models.md','/BingSiteAuth.xml','/media/assets/og.png']){const r=await handle(new Request('http://localhost:3051'+path),s.env);assert.equal(r.status,404,path);}
  const admin=await s.call('/api/admin/sync',{});assert.equal(admin.status,404);
  s.env.DB.close();
});
test('home page has no ad trackers, AI links, guide or krillion branding',()=>{
  const html=homePage();
  assert.doesNotMatch(html,/plausible|gtag|clarity|chatgpt|perplexity|grok|id="guide"|lang=zh/i);
  assert.doesNotMatch(html,/krillion/i);
  const about=infoPage('/about');assert.match(about,/OpenKrillion/);assert.ok(about.includes('https://github.com/VulcanEon/openkrillion.com-service'));
});
test('player cookie is ct_player',async()=>{
  const s=await service();const r=await handle(new Request('http://localhost:3051/api/start',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}}),s.env);
  assert.match(r.headers.get('Set-Cookie'),/^ct_player=/);s.env.DB.close();
});
test('rate limit keys use x-forwarded-for',async()=>{
  const s=await service();
  const post=ip=>handle(new Request('http://localhost:3051/api/feedback',{method:'POST',body:'{}',headers:{'Content-Type':'application/json','x-forwarded-for':ip+', 10.0.0.1'}}),s.env);
  let last;for(let i=0;i<101;i++)last=await post('1.1.1.1');
  assert.equal(last.status,429);
  assert.notEqual((await post('2.2.2.2')).status,429);
  s.env.DB.close();
});

async function finishDaily(s,day){
  let{body:g}=await s.call('/api/start',{});
  for(let i=0;i<7;i++){const r=await s.call('/api/answer',{runId:g.runId,round:i,answer:'',timeout:true});g=r.body.state;if(i<6)await s.call('/api/next',{runId:g.runId});}
  assert.equal(g.completed,true);return g;
}
const walk=(v,f)=>{if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){f(k);walk(x,f);}};
test('practice locked until daily done',async()=>{
  const s=await service();
  const early=await s.call('/api/start',{practice:true});assert.equal(early.status,403);assert.ok(early.body.error);
  await finishDaily(s);
  const practice=await s.call('/api/start',{practice:true});assert.equal(practice.status,200);assert.equal(practice.body.mode,'practice');
  s.env.DB.close();
});
test('no answers leak before completion',async()=>{
  const s=await service();const today=etDate();s.env.LAUNCH_DATE=today;
  const days=[makeDay(1,'leak'),makeDay(2,'leak')];await seedBank(s.env.DB,days,{launchDate:today});
  for(const path of ['/api/today','/api/today?date='+addDays(today,1)]){
    const r=await s.call(path);const text=JSON.stringify(r.body);
    walk(r.body,k=>assert.notEqual(k,'answers'));
    for(const p of days[0].prompts)for(const a of p.answers)assert.ok(!text.includes(a.answer),a.answer);
    for(const p of days[1].prompts)assert.ok(!text.includes(p.text),p.text);
    assert.equal(r.body.prompts[0].text,days[0].prompts[0].text);
  }
  const{body:g}=await s.call('/api/start',{});
  await s.call('/api/answer',{runId:g.runId,round:0,answer:'leak1p0x0'});
  const st=JSON.stringify((await s.call('/api/state?run='+g.runId)).body);
  for(const p of days[0].prompts)for(const a of p.answers)if(a.answer!=='leak1p0x0')assert.ok(!st.includes(a.answer),a.answer);
  assert.equal((await s.call('/api/review?run='+g.runId)).status,403);
  s.env.DB.close();
});
test('run started before midnight scores against its own date',async(t)=>{
  const s=await service();const real=Date.now;t.after(()=>{Date.now=real;});
  const D='2026-12-10',launch=D;s.env.LAUNCH_DATE=launch;
  await seedBank(s.env.DB,[makeDay(1,'mid'),makeDay(2,'mid')],{launchDate:launch});
  Date.now=()=>Date.parse('2026-12-11T04:59:50Z');assert.equal(etDate(),D);
  const{body:g}=await s.call('/api/start',{});assert.equal(g.date,D);
  Date.now=()=>Date.parse('2026-12-11T05:00:05Z');assert.equal(etDate(),'2026-12-11');
  const r=await s.call('/api/answer',{runId:g.runId,round:0,answer:'mid1p0gem'});
  assert.equal(r.body.result.score,100);assert.equal(r.body.result.promptText,'mid day 1 prompt 0');
  s.env.DB.close();
});
test('bank exhausted reruns day 1 with its re-tiered answers; the snapshot sticks',async()=>{
  const { puzzleFor } = await import('../src/puzzles.mjs');
  const { mkdtempSync } = await import('node:fs');const { tmpdir } = await import('node:os');
  const url='file:'+mkdtempSync(tmpdir()+'/ct-')+'/t.db';
  const a=createDb({url});await migrate(a);const today=etDate(),launch=addDays(today,-2);
  await seedBank(a,[makeDay(1,'ex'),makeDay(2,'ex')],{launchDate:launch});
  const bankDay=async tier=>{const c=JSON.parse((await a.prepare('SELECT content FROM bank WHERE day=1').first()).content);c.prompts[0].answers[1].tier=tier;await a.prepare('UPDATE bank SET content=? WHERE day=1').bind(JSON.stringify(c)).run();};
  await bankDay('og');
  const p=await puzzleFor(a,today,launch);
  assert.deepEqual(p.prompts.map(x=>x.id),makeDay(1,'ex').prompts.map(x=>x.id));
  assert.equal(p.dayNumber,3);assert.equal(p.prompts[0].answers[1].tier,'og');assert.equal(p.rerunOf,1);
  assert.equal((await a.prepare('SELECT source FROM puzzles WHERE date=?').bind(today).first()).source,'rerun');
  await bankDay('holder');
  const b=createDb({url});  // fresh handle: no in-memory cache, so this reads the stored snapshot
  assert.equal((await puzzleFor(b,today,launch)).prompts[0].answers[1].tier,'og');
  a.close();b.close();
});
test('server uses the launch date stored by the seed',async()=>{
  const s=await service();const today=etDate();
  await seedBank(s.env.DB,[makeDay(1,'ld'),makeDay(2,'ld'),makeDay(3,'ld')],{launchDate:addDays(today,-1)});
  const r=await s.call('/api/today');assert.equal(r.body.dayNumber,2);assert.equal(r.body.prompts[0].id,'ld2p0');
  s.env.DB.close();
});
test('origin check compares hosts and the cookie is Secure behind an https proxy',async()=>{
  const s=await service();
  const r=await handle(new Request('http://game.test/api/start',{method:'POST',body:'{}',headers:{'Content-Type':'application/json',Origin:'https://game.test','x-forwarded-proto':'https'}}),s.env);
  assert.equal(r.status,200);assert.match(r.headers.get('Set-Cookie'),/; Secure/);
  const evil=await handle(new Request('http://game.test/api/start',{method:'POST',body:'{}',headers:{'Content-Type':'application/json',Origin:'https://evil.test'}}),s.env);
  assert.equal(evil.status,403);
  s.env.DB.close();
});
test('without SITE_URL, links use the request origin instead of localhost',async()=>{
  const s=await service();const env={...s.env,SITE_URL:''};
  const html=await (await handle(new Request('https://play.example/'),env)).text();
  assert.ok(html.includes('https://play.example/assets/og.png'));assert.ok(!html.includes('localhost'));
  s.env.DB.close();
});
test('fresh database serves the sample',async()=>{
  const s=await service();const r=await s.call('/api/today');
  assert.equal(r.body.sample,true);assert.deepEqual(r.body.prompts.map(p=>p.text),SAMPLE.prompts.map(p=>p.text));
  s.env.DB.close();
});
test('rejected guesses are logged',async()=>{
  const s=await service();const{body:g}=await s.call('/api/start',{});
  const r=await s.call('/api/answer',{runId:g.runId,round:0,answer:'zzzzzzzzzz'});assert.equal(r.body.rejected,true);
  const rows=(await s.env.DB.prepare('SELECT * FROM rejections').all()).results;
  assert.equal(rows.length,1);assert.equal(rows[0].date,etDate());assert.equal(rows[0].prompt_id,SAMPLE.prompts[0].id);assert.equal(rows[0].raw,'zzzzzzzzzz');
  s.env.DB.close();
});
test('server rejects a real name from another prompt instead of correcting it to a gem', async () => {
  const s = await service(); const today = etDate(); s.env.LAUNCH_DATE = today;
  const d = makeDay(1, 'ty'); d.prompts[0].answers[0].answer = 'PoloniDEX'; d.prompts[1].answers[1].answer = 'Poloniex';
  await seedBank(s.env.DB, [d], { launchDate: today });
  const { body: g } = await s.call('/api/start', {});
  const r = await s.call('/api/answer', { runId: g.runId, round: 0, answer: 'Poloniex' });
  assert.equal(r.body.rejected, true, JSON.stringify(r.body));
  s.env.DB.close();
});

test('cookieless Vercel Web Analytics loads in production only',()=>{
  assert.match(homePage({}),/\/_vercel\/insights\/script\.js/);
  assert.match(infoPage('/about',{}),/\/_vercel\/insights\/script\.js/);
  assert.doesNotMatch(homePage({LOCAL_DEVELOPMENT:'true'}),/_vercel\/insights/);
  assert.match(infoPage('/privacy',{}),/Vercel Web Analytics, which sets no cookies/);
});

test('unknown pages get a friendly HTML 404, API misses stay JSON',async()=>{
  const s=await service();
  const page=await handle(new Request('http://localhost:3051/nope'),s.env);
  assert.equal(page.status,404);assert.match(page.headers.get('Content-Type'),/text\/html/);
  const html=await page.text();assert.match(html,/Nothing down here/);assert.match(html,/href="\/"/);assert.match(html,/noindex/);
  const api=await handle(new Request('http://localhost:3051/api/nope'),s.env);
  assert.equal(api.status,404);assert.match(api.headers.get('Content-Type'),/json/);
  s.env.DB.close();
});
