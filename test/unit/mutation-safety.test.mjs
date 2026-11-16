import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import * as ACE from '../../agent/lib/ace.mjs';
import { withLibraryWriteLease } from '../../agent/lib/library-lease.mjs';

function wav() {
  const b = Buffer.alloc(60); b.write('RIFF'); b.writeUInt32LE(52, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(88200, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(16, 40); return b;
}
async function sandbox() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'acedl-mutation-'));
  const stateDir = path.join(dir, 'state'), downloadDir = path.join(dir, 'downloads');
  await fsp.mkdir(stateDir); await fsp.mkdir(downloadDir);
  const cfg = { stateDir, downloadDir, baseUrl: 'http://127.0.0.1:1', ua: 'Isolated fixture', stateFile: path.join(stateDir, 'agent-state.json'), historyFile: path.join(stateDir, 'history.json'), sessionFile: path.join(stateDir, 'session.json'), logFile: path.join(stateDir, 'agent.log') };
  await fsp.writeFile(cfg.sessionFile, JSON.stringify({ cookie: 'fixture_session=not-a-real-secret', ua: cfg.ua }));
  return cfg;
}
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const song = (id) => ({ task_id: id, meta: { title: 'Same Title' }, status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1', local_audio: `/data/${id}.mp3`, stems: {} });

test('API requests and each redirect keep the account cookie on its original origin only', async (t) => {
  const cfg = await sandbox(); const cdnCookies = [], siteCookies = []; const marker = Math.random().toString(36).slice(2);
  const cdn = await serve(t, (req, res) => { cdnCookies.push({ path: req.url, cookie: req.headers.cookie || '' }); res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav()); });
  cfg.baseUrl = await serve(t, (req, res) => {
    siteCookies.push({ path: req.url, cookie: req.headers.cookie || '' });
    if (req.url.startsWith('/api/status')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [{ id: 'acemusic-v1.1', lossy: false }] })); }
    if (req.url.startsWith('/api/songs/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ audio: req.url.includes('redirect') ? '/redirect.wav?scope=' + marker : cdn + '/' + marker + '/source.wav' })); }
    res.writeHead(302, { Location: cdn + '/' + marker + '/redirected.wav' }); res.end();
  });
  const result = await ACE.runDownload({ cfg, songs: [song('direct-' + marker), song('redirect-' + marker)], options: { types: ['wav'] } });
  assert.equal(result.done, 2, JSON.stringify(result)); assert.equal(result.failed, 0, JSON.stringify(result));
  const ownSite = siteCookies.filter((row) => row.path.includes(marker)), ownCdn = cdnCookies.filter((row) => row.path.includes(marker));
  assert.ok(ownSite.length >= 3 && ownSite.every((row) => row.cookie.includes('fixture_session=')), JSON.stringify(siteCookies));
  assert.equal(ownCdn.length, 2, JSON.stringify(cdnCookies)); assert.ok(ownCdn.every((row) => row.cookie === ''), JSON.stringify(cdnCookies));
});

test('parallel mutation entry points retain both tasks and assign distinct same-title folders', async (t) => {
  const cfg = await sandbox();
  cfg.baseUrl = await serve(t, (req, res) => {
    if (req.url.startsWith('/api/status')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [{ id: 'acemusic-v1.1', lossy: false }] })); }
    if (req.url.includes('as=parts')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ audio: '/source.wav' })); }
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav()); }, 30);
  });
  const result = await Promise.all(['a', 'b'].map((id) => ACE.runDownload({ cfg, songs: [song(id)], options: { types: ['wav'] } })));
  assert.deepEqual(result.map((row) => row.done), [1, 1]);
  const state = JSON.parse(await fsp.readFile(cfg.stateFile, 'utf8'));
  assert.deepEqual(Object.keys(state.history).sort(), ['a', 'b']);
  assert.notEqual(state.folderByTask.a, state.folderByTask.b);
  assert.ok(fs.existsSync(state.history.a.files.wav.absolute)); assert.ok(fs.existsSync(state.history.b.files.wav.absolute));
  assert.equal(fs.existsSync(path.join(cfg.stateDir, 'library-write.lock')), false);
  await withLibraryWriteLease(cfg, () => withLibraryWriteLease(cfg, async () => true));
});

test('a forced download preserves the previous local file and progress errors cannot mark success as failure', async (t) => {
  const cfg = await sandbox(); let version=1;
  cfg.baseUrl=await serve(t,(req,res)=>{
    if(req.url.startsWith('/api/status')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({models:[{id:'acemusic-v1.1',lossy:false}]}));}
    if(req.url.includes('as=parts')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({audio:'/source.wav'}));}
    const bytes=wav();bytes[44]=version;res.setHeader('Content-Type','audio/wav');res.end(bytes);
  });
  const args={cfg,songs:[song('changed-source')],options:{types:['wav'],force:true},onProgress:()=>{throw new Error('fixture view disconnected');}};
  const first=await ACE.runDownload(args); assert.equal(first.failed,0); assert.equal(first.done,1);
  const original=JSON.parse(await fsp.readFile(cfg.stateFile,'utf8')).history['changed-source'].files.wav.absolute;
  version=2;
  const second=await ACE.runDownload(args); assert.equal(second.failed,0); assert.equal(second.done,1);
  const current=JSON.parse(await fsp.readFile(cfg.stateFile,'utf8')).history['changed-source'].files.wav.absolute;
  assert.notEqual(current,original);
  assert.equal((await fsp.readFile(original))[44],1);
  assert.equal((await fsp.readFile(current))[44],2);
  const log=await fsp.readFile(cfg.logFile,'utf8');
  const events=log.trim().split('\n').map(line=>JSON.parse(line.slice(line.indexOf(' ')+1)));
  assert.equal(events.filter(row=>row.event==='file_complete').length,2);
  assert.equal(events.filter(row=>row.event==='download_done'&&row.failed===0&&row.stateSaved).length,2);
  assert.equal(new Set(events.map(row=>row.runId)).size,2);
  assert.equal(log.includes('fixture_session'),false);
});

test('content deduplication never substitutes an equal-byte MP3 extension for a WAV', async () => {
  const cfg = await sandbox(); const root = path.join(cfg.downloadDir, 'ai音樂');
  const a = path.join(root, '成品WAV', 'Song.wav'), b = path.join(root, '成品MP3', 'Song.mp3');
  await fsp.mkdir(path.dirname(a), { recursive: true }); await fsp.mkdir(path.dirname(b), { recursive: true });
  await fsp.writeFile(a, wav()); await fsp.writeFile(b, wav());
  const result = await ACE.dedupeContent({ cfg, commit: true });
  assert.equal(result.duplicateCount, 0); assert.equal(result.moved, 0);
  assert.ok(fs.existsSync(a)); assert.ok(fs.existsSync(b));
});

test('MP3 extraction preserves an uploaded WAV and never publishes a renamed MP3', async () => {
  const cfg = await sandbox(); const original = path.join(cfg.downloadDir, 'original.wav'); await fsp.writeFile(original, wav());
  const upload = { ...song('upload'), capability: 'music_transcribe', model: undefined, local_audio: '/original.wav' };
  const result = await ACE.extractFullMp3s({ cfg, songs: [upload] });
  assert.equal(result.total, 0); assert.equal(result.downloaded, 0); assert.equal(result.unsupported.length, 1);
  assert.deepEqual(await fsp.readFile(original), wav());
});

test('song-copy cleanup preserves equal-size different content and archives only exact same-format copies', async () => {
  const cfg = await sandbox(); const root = path.join(cfg.downloadDir, 'ai音樂');
  const source = path.join(root, 'Song', 'Song.mp3'), target = path.join(root, '成品MP3', 'Song.mp3');
  await fsp.mkdir(path.dirname(source), { recursive: true }); await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(source, 'take-B'); await fsp.writeFile(target, 'take-A');
  assert.equal((await ACE.dedupeSongCopies({ cfg })).removed, 0);
  assert.equal(await fsp.readFile(source, 'utf8'), 'take-B');
  await fsp.writeFile(source, 'take-A');
  const second = await ACE.dedupeSongCopies({ cfg }); assert.equal(second.archived, 1); assert.equal(second.savedBytes, 0);
  const state = JSON.parse(await fsp.readFile(cfg.stateFile, 'utf8'));
  assert.equal(state.removedPaths[source.toLowerCase()], target);
  assert.ok((await fsp.readdir(path.join(cfg.stateDir, 'organize-backups'))).length > 0);
});
