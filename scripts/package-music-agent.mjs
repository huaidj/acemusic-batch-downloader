import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => value.startsWith('--') ? [...out, [value.slice(2), all[index + 1]]] : out, []));
if (!args.out || !args.ffmpeg || !args.ffprobe || !args['node-license'] || !args['ffmpeg-license']) throw new Error('Provide --out, --ffmpeg, --ffprobe, --node-license and --ffmpeg-license.');
const out = path.resolve(args.out);
if (!/^[EF]:[\\/]/i.test(out) || fs.existsSync(out)) throw new Error('Use a new absolute E:/F: staging directory; existing folders are never replaced.');
if (execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()) throw new Error('Commit the reviewed source before packaging.');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
fs.mkdirSync(out, { recursive: true });
const sourceRoots = ['agent', 'src', 'icons', 'design', 'mixdesk'];
for (const item of sourceRoots) fs.cpSync(path.join(repo, item), path.join(out, item), { recursive: true, filter: source => {
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Source junction/symlink requires explicit review.');
  const name = path.basename(source);
  return !name.startsWith('.') && !/\.(?:sqlite(?:-wal|-shm)?|db|log|part|bak)$/i.test(name) && !['node_modules','__pycache__'].includes(name);
} });
for (const file of ['manifest.json', 'package.json', 'README.md', 'PRIVACY.md', 'LICENSE']) fs.copyFileSync(path.join(repo, file), path.join(out, file));
fs.mkdirSync(path.join(out, 'scripts'));
fs.copyFileSync(path.join(repo, 'scripts/portable-start.ps1'), path.join(out, 'scripts/portable-start.ps1'));
fs.mkdirSync(path.join(out, 'runtime'));
for (const [alias, source] of [['node.exe', process.execPath], ['ffmpeg.exe', args.ffmpeg], ['ffprobe.exe', args.ffprobe]]) fs.copyFileSync(source, path.join(out, 'runtime', alias), fs.constants.COPYFILE_EXCL);
fs.mkdirSync(path.join(out, 'licenses'));
fs.copyFileSync(args['node-license'], path.join(out, 'licenses/Node-LICENSE.txt'));
fs.copyFileSync(args['ffmpeg-license'], path.join(out, 'licenses/FFmpeg-LICENSE.txt'));
fs.writeFileSync(path.join(out, 'Start-HuaiDJ.cmd'), '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\portable-start.ps1"\r\nif errorlevel 1 exit /b 1\r\nstart "" "http://127.0.0.1:18792/music"\r\n');
fs.writeFileSync(path.join(out, 'Stop-HuaiDJ.cmd'), '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\portable-start.ps1" -Stop\r\n');
fs.writeFileSync(path.join(out, 'MCP-config.example.json'), JSON.stringify({ mcpServers: { 'huaidj-ace-agent': {
  command: '<absolute-package-folder>/runtime/node.exe', args: ['<absolute-package-folder>/agent/mcp.mjs'],
  env: { ACE_HUB_URL: 'http://127.0.0.1:18792', ACE_MUSIC_CONTROLLED_RUN: 'true' },
} } }, null, 2));
fs.writeFileSync(path.join(out, '開始使用.md'), `# HuaiDJ 音樂中樞便攜包\n\n雙擊 Start-HuaiDJ.cmd，開啟 http://127.0.0.1:18792/music。Node 與 FFmpeg 已附，不需要 npm 安裝。資料預設在 F:\\DevData\\Runtime\\HuaiDJ-ACE-Portable；停止按 Stop-HuaiDJ.cmd，紀錄保留。\n\n預設為隔離預覽，不讀登入、不生成、不啟用研究費用。連真帳戶與付費授權由操作者另行設定；不把提示詞審閱當費用批准。參數及接線見 agent/MUSIC-AGENT.md、agent/CREATE-API.md。完整源碼提交 ${commit}。\n\n這是 Windows 便攜資料夾，不修改系統、宿主 MCP 或既有 ACE 服務；換機的硬體與聽感仍需驗收。Node/FFmpeg 第三方授權在 licenses。不要把 Cookie、API key 或真實曲庫放進此套件。\n`);
const rows = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file);
    else { const bytes = fs.readFileSync(file); rows.push({ path: path.relative(out, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  }
}
walk(out);
fs.writeFileSync(path.join(out, 'PACKAGE-MANIFEST.json'), JSON.stringify({ schema: 'huaidj.music-agent.portable.v1', created_at: new Date().toISOString(), source_commit: commit, runtime_version: process.version, credentials_included: false, music_included: false, files: rows }, null, 2));
console.log(JSON.stringify({ ok: true, files: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), source_commit: commit, out }));
