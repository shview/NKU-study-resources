import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
const root = path.resolve(import.meta.dirname, '..');
const password = 'synthetic-S2-admin-password';

test('S3 moderation HTTP contracts, private reports, scoped conflicts and public revocation', { timeout: 120000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nku-s3-moderation-'));
  const app = path.join(dir, 'app'), dataDir = path.join(dir, 'data'), dbPath = path.join(dir, 'state.sqlite');
  const oldPublicFeedback = Array.from({ length: 8 }, (_, index) => ({
    id: `legacy-public-${index}`, type: 'bug', title: `historical public ${index}`,
    content: `HISTORICAL_PUBLIC_BODY_${index}`, status: index < 4 ? 'approved' : 'completed',
    reply: `HISTORICAL_PUBLIC_REPLY_${index}`, repliedAt: '2026-09-01T01:00:00.000Z',
    hidden: false, private: false, contact: 'PRIVATE_CONTACT_MUST_STAY_PRIVATE',
  }));
  await fs.mkdir(app); await fs.mkdir(dataDir);
  await fs.cp(path.join(root, 'server'), path.join(app, 'server'), { recursive: true });
  await fs.symlink(path.join(root, 'node_modules'), path.join(app, 'node_modules'));
  // Actual HTTP/publication/persistence, with a tiny synthetic static build in a
  // separate source tree. This is not an Astro UI/build acceptance test.
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'check:content': 'node fixture-build.mjs check', build: 'node fixture-build.mjs build' } }));
  await fs.writeFile(path.join(app, 'fixture-build.mjs'), "import fs from 'node:fs'; if(process.argv[2]==='build'){fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<h1>synthetic S2 acceptance</h1>');}");
  for (const name of ['about','feedback','footer','guides','home','links','manifest','participate','reviews']) await fs.copyFile(path.join(root, 'src/data/fixtures', `${name}.json`), path.join(dataDir, `${name}.json`));
  for (const [kind, key, item] of [
    ['reviews','reviews',{ id:'legacy-review',courseTitle:'synthetic',teacher:'synthetic',content:'private original content',status:'approved',hidden:false }],
    ['feedback','items',{ id:'legacy-report',title:'private complaint title',content:'private complaint body',type:'report',private:true,status:'pending',hidden:false }],
  ]) {
    const file = path.join(dataDir, `${kind}.json`); const data = JSON.parse(await fs.readFile(file)); data[key] = [item];
    if(kind === 'feedback') data[key].push({id:'legacy-unknown',title:'old pending',content:'legacy-private-origin-unknown',type:'bug',status:'pending'}, ...oldPublicFeedback);
    if(kind === 'reviews') data.rules = {...data.rules,submissionOpen:true,minLength:5,hourlyLimit:100,dailyLimit:100,submissionOptions:{allowCustomCourse:true,allowCustomTeacher:true}};
    await fs.writeFile(file, JSON.stringify(data));
  }
  await fs.writeFile(path.join(dataDir, 'notify-settings.json'), '{"enabled":false,"guide_feedback_enabled":false}');
  await fs.writeFile(path.join(dataDir, 'backup-settings.json'), '{"autoEnabled":false,"r2DataBackup":false,"webdavEnabled":false}');
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child, db, output = '';
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', DATA_DIR: dataDir, STATE_DB_PATH: dbPath,
    ADMIN_HOST: '127.0.0.1', ADMIN_PORT: String(port), ADMIN_ORIGIN: base, ADMIN_INITIAL_PASSWORD: password,
    ADMIN_SECRET_FILE: path.join(dir, 'admin-secret'), BACKUP_SECRET_FILE: path.join(dataDir, 'backup-secrets.json'),
    PUBLIC_DIR: path.join(dir, 'public/current'), PUBLIC_RELEASES_DIR: path.join(dir, 'public/releases'), TRUSTED_PROXIES: '127.0.0.1/32' };
  async function start() {
    output = ''; child = spawn(process.execPath, ['server/admin-server.mjs'], { cwd: app, env, stdio: ['ignore','pipe','pipe'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(output)), 15000);
      const collect = chunk => { output += chunk; if (output.includes('NKUStudy admin API listening')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', collect); child.stderr.on('data', collect); child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); }); });
  }
  async function stop() { if (child?.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
  t.after(async () => { await stop(); db?.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await start(); db = new Database(dbPath); db.pragma('busy_timeout=5000');
  let sequence = 0;
  async function request(route, { method = 'GET', cookie = '', body, status = 200, provenance = true, binary = false, extraHeaders = {} } = {}) {
    const marker = `s3-moderation-${++sequence}`;
    const headers = { cookie, 'user-agent': marker, 'x-forwarded-for': '198.51.100.75', 'content-type': 'application/json' };
    Object.assign(headers, extraHeaders);
    if (provenance) Object.assign(headers, { origin: base, 'sec-fetch-site': 'same-origin', 'x-nkustudy-admin-request': '1' });
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const value = binary ? bytes : JSON.parse(bytes);
    assert.equal(response.status, status, `${route}: ${binary ? (response.status === status ? 'binary' : bytes.toString()) : JSON.stringify(value)}\n${output}`);
    const rows = db.prepare('SELECT * FROM admin_audit_log WHERE user_agent=? ORDER BY id').all(marker);
    if (route.startsWith('/admin-api/')) { assert.ok(rows.length >= 1, `missing audit ${route}`); assert.equal(rows[0].status, status); assert.equal(rows[0].path, route.split('?')[0]); }
    return { value, rows, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const cookie = (await request('/admin-api/login', {method:'POST',body:{username:'Shview',password}})).cookie;
  const A = await request('/api/v1/auth/web-register', {method:'POST',body:{nickname:'S3-owner-A',password}});
  const B = await request('/api/v1/auth/web-register', {method:'POST',body:{nickname:'S3-owner-B',password}});
  db.prepare('UPDATE mp_users SET phone=?,phone_verified_at=? WHERE id=?').run('13800001234',Date.now(),A.value.data.user.id);
  const read = async kind => (await request(`/admin-api/${kind}`,{cookie})).value;
  const patch = async (kind,id,changes,revision,status=200) => {
    const current = revision || (await read(kind)).itemRevisions[id];
    return request(`/admin-api/${kind}/${id}`,{method:'PATCH',cookie,body:{expectedItemRevision:current,changes},status});
  };
  const settings = async (kind,changes,revision,status=200) => request(`/admin-api/${kind}/settings`,{method:'PATCH',cookie,body:{expectedSettingsRevision:revision || (await read(kind)).settingsRevision,changes},status});
  const report = {title:'指南反馈：私密投诉',content:'[guide_id=x] PRIVATE_REPORT_SENTINEL',contact:'CONTACT_SENTINEL',reportUrl:'https://example.invalid/private-reference'};
  const legacy = await read('reviews');
  assert.equal(legacy.data.reviews[0].decisionSource,'legacy_visibility_import');
  assert.equal(legacy.data.reviews[0].publicationState,'approved');
  assert.equal((await request('/review-api/reviews')).value.reviews.length,1);
  assert.equal((await request('/feedback-api/feedback')).value.items.length,8);
  await patch('feedback','legacy-unknown',{publicationDecision:'approve'},undefined,400);
  const beforeRestart = await fs.readFile(path.join(dataDir,'feedback.json'),'utf8');
  await stop(); await start();
  assert.equal(await fs.readFile(path.join(dataDir,'feedback.json'),'utf8'),beforeRestart,'migration is idempotent');

  await t.test('eight historical public feedback rows and replies survive migration; later revocation survives restart', async () => {
    const publicRows = (await request('/feedback-api/feedback')).value.items;
    const stored = (await read('feedback')).data.items;
    for (const original of oldPublicFeedback) {
      const visible = publicRows.find(item => item.id === original.id);
      for (const key of ['title', 'content', 'reply', 'repliedAt']) assert.equal(visible[key], original[key]);
      assert.equal(visible.contact, undefined);
      const row = stored.find(item => item.id === original.id);
      assert.equal(row.decisionSource, 'legacy_feedback_visibility_import');
      assert.equal(row.reviewedBy, undefined, 'do not manufacture historical administrator approval');
      assert.equal(row.reviewedAt, undefined);
      assert.equal(row.replyVisibility, 'public');
    }
    await patch('feedback', 'legacy-public-0', { hidden: true });
    await patch('feedback', 'legacy-public-1', { publicationDecision: 'revoke' });
    await patch('feedback', 'legacy-public-1', { handlingStatus: 'completed', hidden: false });
    await stop(); await start();
    const afterRestart = (await request('/feedback-api/feedback')).value.items;
    assert.equal(afterRestart.length, 6);
    assert.equal(afterRestart.some(item => ['legacy-public-0', 'legacy-public-1'].includes(item.id)), false);
    assert.equal((await read('feedback')).data.items.find(item => item.id === 'legacy-public-1').publicationState, 'pending');
    // Isolate later submission assertions from these synthetic history rows.
    for (let index = 2; index < 8; index += 1) await patch('feedback', `legacy-public-${index}`, { hidden: true });
  });

  await t.test('anonymous report and legacy aliases persist privately despite normal and guide switches; invalid credentials fail', async () => {
    await settings('feedback',{rules:{submissionOpen:false,minLength:1900}});
    const anon = await request('/feedback-api/report',{method:'POST',body:{...report,type:'bug',private:false}});
    assert.equal(anon.value.accepted,true); assert.equal(anon.value.private,true); assert.equal(anon.value.replyAvailable,false);
    await request('/feedback-api/report',{method:'POST',body:report,extraHeaders:{authorization:'Bearer invalid'},status:401});
    const own = await request('/feedback-api/submit',{method:'POST',cookie:A.cookie,body:{...report,type:'complaint'}});
    assert.equal(own.value.replyAvailable,true);
    const honey = await request('/feedback-api/report',{method:'POST',body:{...report,website:'bot'}});
    assert.equal(honey.value.accepted,false);
    await request('/feedback-api/submit',{method:'POST',cookie:A.cookie,body:{title:'normal',content:'normal feedback',type:'bug'},status:403});
    for(const route of ['/feedback-api/report','/feedback-api/submit','/feedback-api/report']) await request(route,{method:'POST',body:{...report,type:'report'},extraHeaders:{'x-forwarded-for':'198.51.100.87'}});
    await request('/feedback-api/submit',{method:'POST',body:{...report,type:'complaint'},extraHeaders:{'x-forwarded-for':'198.51.100.87'},status:429});
    const saved = await patch('feedback',own.value.receiptId,{handlingStatus:'completed',reply:'OWNER_REPLY_SENTINEL'});
    assert.equal(saved.value.data.private,true); assert.equal(saved.value.data.repliedBy,'Shview');
    await patch('feedback',own.value.receiptId,{publicationDecision:'approve'},undefined,400);
    await patch('feedback',own.value.receiptId,{replyVisibility:'public'},undefined,400);
    const ownList = (await request('/api/v1/me/feedback',{cookie:A.cookie})).value.data;
    assert.ok(ownList.items.some(item=>item.id===own.value.receiptId && item.reply==='OWNER_REPLY_SENTINEL'));
    const other = (await request('/api/v1/me/feedback',{cookie:B.cookie})).value.data;
    assert.equal(other.total,0);
    const publicText = JSON.stringify((await request('/feedback-api/feedback')).value);
    for(const text of ['PRIVATE_REPORT_SENTINEL','OWNER_REPLY_SENTINEL','CONTACT_SENTINEL','private-reference']) assert.equal(publicText.includes(text),false);
    await request(`/admin-api/feedback/${own.value.receiptId}`,{cookie:A.cookie,status:401});
    await request(`/admin-api/feedback/${own.value.receiptId}`,{status:401});
    await stop(); await start();
    const restoredOwn = (await request('/api/v1/me/feedback',{cookie:A.cookie})).value.data.items.find(item=>item.id===own.value.receiptId);
    assert.equal(restoredOwn.reply,'OWNER_REPLY_SENTINEL');
    assert.equal((await request('/api/v1/me/feedback',{cookie:B.cookie})).value.data.total,0);
    const restoredAdmin = (await request(`/admin-api/feedback/${own.value.receiptId}`,{cookie})).value.data;
    assert.equal(restoredAdmin.private,true);
    assert.equal(restoredAdmin.handlingStatus,'completed');
    assert.equal(JSON.stringify((await request('/feedback-api/feedback')).value).includes('OWNER_REPLY_SENTINEL'),false);
  });

  await t.test('single-item CAS separates completed, reply and publication; settings and another row do not conflict',async()=>{
    await settings('feedback',{rules:{submissionOpen:true,minLength:5,hourlyLimit:100,dailyLimit:100}});
    const first = await request('/feedback-api/submit',{method:'POST',cookie:A.cookie,body:{title:'normal A',content:'NORMAL_A_SENTINEL',type:'bug',schemaVersion:1,status:'approved',publicationState:'approved',decisionSource:'legacy_feedback_visibility_import',privacySource:'verified_legacy_feedback_origin',legacyVisibilitySource:'old-public',replyVisibility:'public'}});
    const second = await request('/feedback-api/submit',{method:'POST',cookie:A.cookie,body:{title:'normal B',content:'NORMAL_B_SENTINEL',type:'feature'}});
    const a=first.value.receiptId,b=second.value.receiptId;
    const initial=await read('feedback');
    assert.equal(initial.data.items.find(item=>item.id===a).publicationState,'pending','new client data cannot claim historical visibility');
    assert.equal(initial.data.items.find(item=>item.id===a).decisionSource,'submission_pending');
    await settings('feedback',{title:'Updated settings'});
    const saved=await patch('feedback',a,{handlingStatus:'completed',reply:'submitter reply'},initial.itemRevisions[a]);
    await patch('feedback',b,{handlingStatus:'processing'},initial.itemRevisions[b]);
    assert.equal(saved.value.publicEligible,false);
    assert.equal((await request('/feedback-api/feedback')).value.items.length,0);
    const conflict=await patch('feedback',a,{hidden:true},initial.itemRevisions[a],409);
    assert.equal(conflict.value.code,'ITEM_CONFLICT'); assert.equal(conflict.value.currentItem.reply,'submitter reply');
    await patch('feedback',a,{content:'rewritten'},undefined,400);
    await patch('feedback',a,{handled_by:'spoof'},undefined,400);
    await patch('feedback',a,{reply:'x'.repeat(2001)},undefined,400);
    await patch('feedback',a,{publicationDecision:'approve'});
    let pub=(await request('/feedback-api/feedback')).value.items;
    assert.equal(pub.length,1); assert.equal(pub[0].reply,undefined);
    await patch('feedback',a,{replyVisibility:'public'});
    pub=(await request('/feedback-api/feedback')).value.items;
    assert.equal(pub[0].reply,'submitter reply');
    await patch('feedback',a,{publicationDecision:'revoke'});
    await patch('feedback',a,{hidden:false,handlingStatus:'completed'});
    assert.equal((await request('/feedback-api/feedback')).value.items.length,0);
    let current=await read('feedback');
    const original=structuredClone(current.data); const row=current.data.items.find(item=>item.id===a); row.hidden=true; row.handled_by='forged-actor';
    await request('/admin-api/feedback',{method:'POST',cookie,body:{data:current.data,expectedRevision:current.revision}});
    current=await read('feedback'); assert.equal(current.data.items.find(item=>item.id===a).handled_by,undefined);
    current.data.items.find(item=>item.id===a).type='report';
    await request('/admin-api/feedback',{method:'POST',cookie,body:{data:current.data,expectedRevision:current.revision},status:400});
    const missing=await request('/admin-api/feedback/missing',{method:'PATCH',cookie,body:{expectedItemRevision:'x',changes:{hidden:true}},status:404});
    assert.equal(missing.value.code,'ITEM_NOT_FOUND');
    const audit=JSON.stringify(db.prepare('SELECT * FROM admin_audit_log').all());
    for(const text of ['NORMAL_A_SENTINEL','OWNER_REPLY_SENTINEL','submitter reply','forged-actor']) assert.equal(audit.includes(text),false);
  });

  await t.test('an in-flight feedback body uses the newly reduced quota at persistence time',async()=>{
    const raw = JSON.stringify({title:'slow quota request',content:'SLOW_BODY_MUST_NOT_PERSIST',type:'bug'});
    let pendingRequest;
    const response = new Promise((resolve,reject)=>{
      pendingRequest = http.request(base+'/feedback-api/submit',{method:'POST',headers:{cookie:A.cookie,'content-type':'application/json','content-length':Buffer.byteLength(raw),'user-agent':'S3-SLOW-QUOTA','x-forwarded-for':'198.51.100.75'}},res=>{
        let text='';res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
      });
      pendingRequest.on('error',reject);
      pendingRequest.write(raw.slice(0,10));
    });
    const queue = path.join(dataDir,'log-queue/user');
    let admitted=false;
    try {
      for(let tries=0;tries<200 && !admitted;tries++) {
        for(const name of await fs.readdir(queue)) {
          if(!name.endsWith('.json'))continue;
          const envelope=JSON.parse(await fs.readFile(path.join(queue,name)));
          admitted ||= envelope.payload?.pending && envelope.payload.row?.includes('S3-SLOW-QUOTA');
        }
        if(!admitted)await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(admitted,true,'request reached durable admission before settings changed');
      await settings('feedback',{rules:{hourlyLimit:1}});
      pendingRequest.end(raw.slice(10));
      const rejected=await response;
      assert.equal(rejected.status,429);assert.equal(rejected.body.code,'RATE_LIMITED');
      assert.equal(JSON.stringify((await read('feedback')).data).includes('SLOW_BODY_MUST_NOT_PERSIST'),false);
    } finally { pendingRequest.destroy(); }
  });

  await t.test('configured automatic review approval keeps rule evidence and revocation removes every derived public view immediately',async()=>{
    await settings('reviews',{rules:{moderationRequired:false,keywordFilter:{enabled:false,words:['blockedword']}}});
    const auto=await request('/review-api/submit',{method:'POST',cookie:A.cookie,body:{courseTitle:'S3 synthetic course',teacher:'S3_UNIQUE_TEACHER',rating:5,content:'blockedword AUTO_SENTINEL'}});
    assert.equal(auto.value.accepted,true);assert.equal(auto.value.pending,false);
    const data=await read('reviews'), row=data.data.reviews.find(item=>item.teacher==='S3_UNIQUE_TEACHER');
    assert.equal(row.decisionSource,'automatic_rules');assert.equal(row.ruleSnapshot.keywordFilter.enabled,false);assert.equal(row.ruleConfiguredBy,'Shview');
    const paths=['/review-api/reviews','/api/v1/home','/api/v1/courses','/api/v1/review-groups','/api/v1/search-index','/api/v1/search-data'];
    assert.equal(JSON.stringify((await request('/api/v1/review-groups')).value).includes('S3_UNIQUE_TEACHER'),true);
    await patch('reviews',row.id,{hidden:true},data.itemRevisions[row.id]);
    for(const route of paths){const response=await request(route,{extraHeaders:{'if-none-match':'"old-cached-response"'}});assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(JSON.stringify(response.value).includes('S3_UNIQUE_TEACHER'),false,route);}
    await patch('reviews',row.id,{hidden:false});
    assert.equal(JSON.stringify((await request('/api/v1/review-groups')).value).includes('S3_UNIQUE_TEACHER'),true);
    await patch('reviews',row.id,{publicationDecision:'revoke'});
    await patch('reviews',row.id,{hidden:false});
    assert.equal(JSON.stringify((await request('/api/v1/review-groups')).value).includes('S3_UNIQUE_TEACHER'),false);
    await settings('reviews',{rules:{keywordFilter:{enabled:true,words:['blockedword']}}});
    const pending=await request('/review-api/submit',{method:'POST',cookie:A.cookie,body:{courseTitle:'S3 synthetic course',teacher:'teacher',rating:5,content:'blockedword pending review'}});
    assert.equal(pending.value.pending,true);
    await request('/review-api/submit',{method:'POST',body:{courseTitle:'x',teacher:'x',rating:5,content:'authenticated required'},status:401});
  });
});
