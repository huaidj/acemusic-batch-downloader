import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config } from './config.mjs';

function health(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (response) => {
      const chunks = []; let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; if (bytes < 16384) chunks.push(chunk); else response.destroy(); });
      response.on('end', () => { try { resolve({ reachable: true, data: JSON.parse(Buffer.concat(chunks)) }); } catch { resolve({ reachable: true }); } });
      response.on('error', () => resolve({ reachable: true }));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve({ reachable: false }));
  });
}

async function selectSong(port, songId) {
  if (!songId) return;
  if (typeof songId !== 'string' || songId.length > 256 || /[\x00-\x1f]/.test(songId)) throw new Error('歌曲 ID 不正確');
  const body = Buffer.from(JSON.stringify({ songId }));
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/select', method: 'POST', timeout: 1500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, (res) => { res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('播放器版本需更新後才能定位歌曲'))); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('播放器定位逾時'))); req.end(body);
  });
}

/**
 * 換成磁碟上的新版播放器服務：先請服務自己重新啟動（1.8.0 起支援）；舊版不支援時，
 * 只結束「在這個連接埠回應 huaidj-player 的那個程序」，再用新檔案啟動。
 */
export async function restartPlayer(cfg = config(), { port = Number(process.env.ACE_PLAYER_PORT || 8790) } = {}) {
  const installed = installedVersion();
  const existing = await health(port);
  if (existing.data?.service !== 'huaidj-player') return { ...(await startPlayer(cfg, { port })), restarted: false };
  if (existing.data.version === installed) return { ok: true, restarted: false, alreadyCurrent: true, version: installed, pid: existing.data.pid };
  let graceful = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) });
    graceful = response.status === 202;
  } catch { /* 舊版沒有這個端點 */ }
  if (!graceful) {
    try { process.kill(Number(existing.data.pid)); } catch (err) { throw new Error('無法結束舊的播放器服務（pid ' + existing.data.pid + '）：' + (err.code || err.message)); }
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const now = await health(port);
    if (graceful && now.data?.version === installed) return { ok: true, restarted: true, graceful, version: installed, pid: now.data.pid };
    if (!graceful && !now.reachable) return { ...(await startPlayer(cfg, { port })), restarted: true, graceful, previousVersion: existing.data.version };
  }
  throw new Error('舊的播放器服務沒有在 10 秒內結束或換新');
}

function installedVersion() {
  try { return JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../manifest.json', import.meta.url)), 'utf8')).version || ''; } catch { return ''; }
}

export async function startPlayer(cfg = config(), { port = Number(process.env.ACE_PLAYER_PORT || 8790), songId = '' } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('播放器連接埠不正確');
  const url = `http://127.0.0.1:${port}`;
  const existing = await health(port);
  if (existing.data?.service === 'huaidj-player') {
    await selectSong(port, songId);
    const installed = installedVersion();
    return { ok: true, alreadyRunning: true, url, pid: existing.data.pid, version: existing.data.version, installedVersion: installed, outdated: !!installed && existing.data.version !== installed };
  }
  if (existing.reachable) throw new Error('播放器連接埠由其他程式使用，已保留該程式');
  const script = fileURLToPath(new URL('../../player/server.mjs', import.meta.url));
  if (!fs.existsSync(script)) throw new Error('尚未安裝播放器檔案，請更新完整套件');
  const stateDir = process.env.ACE_PLAYER_STATE_DIR || path.join(cfg.stateDir, 'player-state');
  await fsp.mkdir(stateDir, { recursive: true });
  const log = await fsp.open(path.join(stateDir, 'player.log'), 'a');
  try {
    const child = spawn(process.execPath, [script], { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: {
      ...process.env, ACE_STATE_DIR: cfg.stateDir, ACE_DOWNLOAD_DIR: cfg.downloadDir, ACE_PLAYER_STATE_DIR: stateDir, ACE_PLAYER_PORT: String(port),
    } });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  for (let attempt = 0; attempt < 25; attempt++) {
    const result = await health(port);
    if (result.data?.service === 'huaidj-player') { await selectSong(port, songId); return { ok: true, alreadyRunning: false, url, pid: result.data.pid, version: result.data.version }; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('播放器啟動未完成，請查看 player.log；沒有停止其他程式');
}
