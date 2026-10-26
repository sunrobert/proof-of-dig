import { SITE } from './config.mjs';
import { homePage, infoPage, notFoundPage } from './html.mjs';
import { puzzleFor as lookup } from './puzzles.mjs';
import { runRetier } from './retier.mjs';
import { TIER_SCORES, matchAnswer, etDate, resetAt, ROUND_MS, PREVIEW_MS, parseShareCode, bandFor } from '../public/rules.mjs';
import { renderCard } from './card.mjs';
import { THEMES } from '../public/themes/index.mjs';
const theme = () => THEMES[SITE.theme] || THEMES.sea;

const json = (data, status = 200, extra = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...extra } });
const fail = (message, status = 400) => json({ error: message }, status);
const playerId = request => request.headers.get('Cookie')?.match(/(?:^|;\s*)ct_player=([a-f0-9-]{36})/)?.[1];
function headers(response, additional = {}) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'X-Frame-Options': 'SAMEORIGIN', ...additional })) h.set(k, v);
  return new Response(response.body, { status: response.status, headers: h });
}
const puzzleFor = (env, date) => lookup(env.DB, date, env.LAUNCH_DATE || SITE.launchDate);
const secure = (request, url) => url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
const knownCache = new WeakMap();
const knownNames = async db => {
  if (!knownCache.has(db)) { const row = await db.prepare("SELECT value FROM meta WHERE key='known_names'").first(); knownCache.set(db, new Set(row ? JSON.parse(row.value) : [])); }
  return knownCache.get(db);
};
const dailyDone = async (env, player, date) => !!(await env.DB.prepare("SELECT 1 AS ok FROM runs WHERE player=? AND date=? AND mode='daily' AND completed=1").bind(player || '', date).first());
function promptDTO(puzzle) {
  return { date: puzzle.date, dayNumber: puzzle.dayNumber, sample: !!puzzle.sample, source: puzzle.source, resetsAt: resetAt(puzzle.date), prompts: puzzle.prompts.map(({ id, text }) => ({ id, text })) };
}
async function state(env, run) {
  const results = (await env.DB.prepare('SELECT round,raw_answer AS rawAnswer,answer,tier,score FROM answers WHERE run_id=? ORDER BY round').bind(run.id).all()).results;
  const puzzle = await puzzleFor(env, run.date);
  return { ...promptDTO(puzzle), runId: run.id, mode: run.mode, round: run.next_round, roundStart: run.round_start, pausedAt: run.paused_at || null, serverNow: Date.now(), completed: !!run.completed, results, score: results.reduce((s, r) => s + r.score, 0) };
}
async function ownRun(env, id, player) {
  if (!/^[a-f0-9-]{36}$/.test(id || '')) return null;
  return env.DB.prepare('SELECT * FROM runs WHERE id=? AND player=?').bind(id, player || '').first();
}
async function limit(env, request, player) {
  const window = Math.floor(Date.now() / 60000);
  const raw = `${player || ''}|${request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local'}|${window}`;
  const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(x => x.toString(16).padStart(2, '0')).join('');
  const count = await env.DB.prepare('INSERT INTO rate_limits(key,window,count) VALUES(?,?,1) ON CONFLICT(key,window) DO UPDATE SET count=count+1 RETURNING count').bind(key, window).first();
  if (count.count === 1) await env.DB.prepare('DELETE FROM rate_limits WHERE window<?').bind(window - 5).run();
  return count.count <= 100;
}
async function api(request, env, url) {
  const date = etDate(), path = url.pathname, player = playerId(request);
  if (request.method === 'GET' && path === '/api/today') return json(promptDTO(await puzzleFor(env, date)));
  if (request.method === 'GET' && path === '/api/health') return json({ ok: true, name: SITE.name, database: !!(await env.DB.prepare('SELECT 1 AS ok').first()) });
  if (request.method === 'GET' && path === '/api/state') {
    const run = await ownRun(env, url.searchParams.get('run'), player);
    return run ? json(await state(env, run)) : fail('Game not found on this browser.', 404);
  }
  if (request.method === 'GET' && path === '/api/review') {
    const run = await ownRun(env, url.searchParams.get('run'), player);
    if (!run?.completed || !await dailyDone(env, player, run.date)) return fail('Finish today\'s game before opening the answer sheet.', 403);
    const puzzle = await puzzleFor(env, run.date);
    const population = (await env.DB.prepare("SELECT r.id,SUM(a.score) AS score FROM runs r JOIN answers a ON a.run_id=r.id WHERE r.date=? AND r.mode='daily' AND r.completed=1 GROUP BY r.id").bind(run.date).all()).results;
    const own = await state(env, run);
    const others = population.filter(p => p.id !== run.id);
    const dist = Array.from({ length: 71 }, () => 0);
    others.forEach(p => dist[Math.min(70, Math.floor(p.score / 10))]++);
    return json({ prompts: puzzle.prompts.map(p => ({ ...p, answers: p.answers.map(a => ({ ...a, score: TIER_SCORES[a.tier] })).sort((a,b) => b.score - a.score || a.answer.localeCompare(b.answer)) })), population: others.length, betterThan: others.length >= 5 ? Math.round(others.filter(p => p.score < own.score).length / others.length * 100) : null, dist });
  }
  if (request.method === 'GET' && path === '/api/cron/retier') {
    if (!env.CRON_SECRET || request.headers.get('Authorization') !== `Bearer ${env.CRON_SECRET}`) return fail('Unknown endpoint.', 404);
    return json(await runRetier(env.DB, date));
  }
  if (request.method !== 'POST') return fail('Unknown endpoint.', 404);
  const origin = request.headers.get('Origin');
  if (origin && (() => { try { return new URL(origin).host !== url.host; } catch { return true; } })()) return fail('Cross-origin requests are not accepted.', 403);
  if (Number(request.headers.get('Content-Length') || 0) > 8000) return fail('Request is too large.', 413);
  if (!await limit(env, request, player)) return fail('Too many requests. Take a breath and try again.', 429);
  let data; try { const raw = await request.text(); if (raw.length > 8000) return fail('Request is too large.', 413); data = JSON.parse(raw); } catch { return fail('Invalid request.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('Invalid request.');
  if (path === '/api/start') {
    const id = player || crypto.randomUUID(), mode = data.practice === true ? 'practice' : 'daily';
    if (mode === 'practice' && !await dailyDone(env, player, date)) return fail('Finish today\'s daily game before practicing.', 403);
    await puzzleFor(env, date);
    let run = mode === 'daily' ? await env.DB.prepare("SELECT * FROM runs WHERE player=? AND date=? AND mode='daily'").bind(id, date).first() : null;
    if (!run) {
      const rid = crypto.randomUUID();
      await env.DB.prepare('INSERT OR IGNORE INTO runs(id,player,date,mode,round_start,created_at) VALUES(?,?,?,?,?,?)').bind(rid, id, date, mode, Date.now() + PREVIEW_MS, Date.now()).run();
      run = mode === 'daily' ? await env.DB.prepare("SELECT * FROM runs WHERE player=? AND date=? AND mode='daily'").bind(id,date).first() : await ownRun(env,rid,id);
    }
    return json(await state(env, run), 200, { 'Set-Cookie': `ct_player=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure(request, url) ? '; Secure' : ''}` });
  }
  if (path === '/api/pause') {
    const run = await ownRun(env,data.runId,player);
    if (!run) return fail('Game not found.',404);
    if (data.paused === true && !run.completed && run.round_start !== null && !run.paused_at && Date.now() <= run.round_start + ROUND_MS) {
      await env.DB.prepare('UPDATE runs SET paused_at=? WHERE id=? AND paused_at IS NULL').bind(Date.now(),run.id).run();
    } else if (data.paused === false && run.paused_at) {
      await env.DB.prepare('UPDATE runs SET round_start=round_start+?-paused_at,paused_at=NULL WHERE id=? AND paused_at IS NOT NULL').bind(Date.now(),run.id).run();
    }
    return json(await state(env,await ownRun(env,run.id,player)));
  }
  if (path === '/api/next') {
    const run = await ownRun(env, data.runId, player);
    if (!run) return fail('Game not found.',404);
    if (run.paused_at) return fail('Close the menu to resume your game.',409);
    if (!run.completed && run.round_start === null) await env.DB.prepare('UPDATE runs SET round_start=? WHERE id=? AND round_start IS NULL AND completed=0').bind(Date.now()+PREVIEW_MS,run.id).run();
    return json(await state(env, await ownRun(env,run.id,player)));
  }
  if (path === '/api/answer') {
    const run = await ownRun(env,data.runId,player);
    if (!run) return fail('Game not found.',404);
    if (run.paused_at) return fail('Close the menu to resume your game.',409);
    if (run.completed || run.round_start === null || data.round !== run.next_round) return json({ state: await state(env, run), alreadyScored: true });
    if (Date.now() < run.round_start && env.LOCAL_DEVELOPMENT !== 'true') return fail('The answer window has not opened yet.',409);
    const puzzle = await puzzleFor(env,run.date), prompt = puzzle.prompts[run.next_round];
    const raw = typeof data.answer === 'string' ? data.answer.trim().slice(0,256) : '';
    const late = Date.now() > run.round_start + ROUND_MS;
    // A small network grace period applies only to the client's timed submission.
    // A late manual request cannot revive an expired answer window.
    const timely = !late || (data.timeout === true && Date.now() <= run.round_start + ROUND_MS + 1500);
    const match = raw && timely ? matchAnswer(raw,prompt.answers,await knownNames(env.DB)) : null;
    if (!match && raw && !late && !data.timeout) {
      await env.DB.prepare('INSERT INTO rejections(date,prompt_id,raw,created_at) VALUES(?,?,?,?)').bind(run.date, prompt.id, raw, Date.now()).run();
      return json({ rejected: true, message: theme().copy.reject.replace('{answer}', raw) });
    }
    if (match?.correction && data.confirm !== true && !late && !data.timeout && data.previewCorrection !== false) return json({ correction: match.answer, original: raw });
    const result = { round: run.next_round, rawAnswer: raw || null, answer: match?.answer || null, tier: match?.tier || null, score: match ? TIER_SCORES[match.tier] : 0, quip: match?.quip || null, promptText: prompt.text };
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO answers(run_id,round,raw_answer,answer,tier,score,created_at) SELECT id,?,?,?,?,?,? FROM runs WHERE id=? AND next_round=? AND round_start IS NOT NULL AND completed=0').bind(result.round,result.rawAnswer,result.answer,result.tier,result.score,now,run.id,result.round),
      env.DB.prepare('UPDATE runs SET next_round=?,round_start=NULL,completed=? WHERE id=? AND next_round=? AND EXISTS(SELECT 1 FROM answers WHERE run_id=? AND round=?)').bind(result.round+1,result.round===6?1:0,run.id,result.round,run.id,result.round),
    ]);
    const fresh = await state(env, await ownRun(env,run.id,player));
    const accepted = fresh.results.find(r => r.round === result.round);
    return json({ result: { ...result, ...accepted }, state: fresh });
  }
  if (path === '/api/feedback') {
    if (!player) return fail('Play a game first.',403);
    const text = String(data.text || '').trim().slice(0,1000), kind = data.kind === 'suggestion' ? 'suggestion' : 'rating';
    if (!text) return fail('Please enter a message.');
    const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE player=? AND date=?').bind(player,date).first();
    if (existing.n >= 3) return fail('Thanks — enough feedback for today.',429);
    await env.DB.prepare('INSERT INTO feedback(player,date,kind,text,created_at) VALUES(?,?,?,?,?)').bind(player,date,kind,text,Date.now()).run();
    return json({ ok:true });
  }
  return fail('Unknown endpoint.',404);
}
// Single entry point for Vercel and the local dev server. Static files are served before this runs.
// Share links: /s/<code> is the game page with that result as its X/OG preview, /og/<code>.png is the card itself.
// The code holds only the day and the 7 tiers (e.g. 1-hhhdxhs), so the image can be cached forever.
const cards = new Map();
function shareImage(request, env, url) {
  const m = /^\/og\/([^/]+)\.png$/.exec(url.pathname), code = m && parseShareCode(m[1]);
  if (!code) return fail('Not found.', 404);
  const theme = THEMES[SITE.theme], host = new URL(env.SITE_URL).host, key = m[1] + host;
  if (!cards.has(key)) { if (cards.size > 500) cards.clear(); cards.set(key, renderCard({ theme, siteName: SITE.name, code, host })); }
  const png = cards.get(key);
  return new Response(request.method === 'HEAD' ? null : png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length), 'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable' } });
}
function sharePage(request, env, url) {
  const raw = url.pathname.slice(3), code = parseShareCode(raw);
  if (!code) return new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store' } });
  const theme = THEMES[SITE.theme], band = theme.bands[bandFor(code.score).tier].name, depth = (code.score * 10).toLocaleString('en-US');
  const share = {
    code: raw,
    title: `I dug ${depth}m on ${SITE.name} #${code.day}${code.practice ? ' (practice)' : ''} · ${code.score}/700 · ${band}`,
    description: 'Daily crypto trivia where rare answers dig deeper. 7 prompts, 25 seconds each. Can you beat it?',
    subline: `a friend dug ${depth}m (${code.score}/700) · can you dig deeper?`,
  };
  return new Response(request.method === 'HEAD' ? null : homePage(env, url.searchParams.get('theme'), share), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=300' } });
}
export async function handle(request, env) {
  env = { ...env, SITE_URL: env.SITE_URL || new URL(request.url).origin };
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return headers(await api(request,env,url));
      if (!['GET','HEAD'].includes(request.method)) return headers(fail('Method not allowed.',405));
      if (url.pathname.startsWith('/og/')) return headers(shareImage(request, env, url));
      if (url.pathname.startsWith('/s/')) return headers(sharePage(request, env, url));
      if (url.pathname === '/') return headers(new Response(request.method==='HEAD'?null:homePage(env,url.searchParams.get('theme')),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}}));
      if (['/privacy','/about'].includes(url.pathname)) return headers(new Response(request.method==='HEAD'?null:infoPage(url.pathname,env),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=300'}}));
      if (url.pathname === '/robots.txt') return headers(new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${(env.SITE_URL||SITE.origin)}/sitemap.xml\n`,{headers:{'Content-Type':'text/plain; charset=utf-8'}}));
      if (url.pathname === '/sitemap.xml') return headers(new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+['/','/about','/privacy'].map(p=>`<url><loc>${env.SITE_URL||SITE.origin}${p}</loc></url>`).join('')+'</urlset>',{headers:{'Content-Type':'application/xml; charset=utf-8'}}));
      return headers(new Response(request.method==='HEAD'?null:notFoundPage(env),{status:404,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=300'}}));
    } catch (e) { console.error('Request failed:',e.message); return headers(fail('The signal is temporarily lost. Please retry.',503)); }
}
