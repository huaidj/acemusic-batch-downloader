#!/usr/bin/env node
// 產生兩種 zip：
//   dist/<name>-<version>-store.zip  → Chrome Web Store 用（只有 manifest/src/icons）
//   dist/<name>-<version>-full.zip   → GitHub Release 用（完整 repo 內容，排除本機/內部檔）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNoSecrets } from '../agent/lib/secret-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const name = 'acemusic-batch-downloader';
const dist = path.join(ROOT, 'dist');
const tmp = path.join(dist, '.pack');
const isWin = process.platform === 'win32';

const STORE_ITEMS = ['manifest.json', 'src', 'icons', 'naming'];
const FULL_ITEMS = [
  'manifest.json', 'src', 'icons', 'naming', 'agent', 'native', 'mixdesk', 'player', 'docs',
  'design', 'scripts/repair-wavs.mjs',
  'README.md', 'CHANGELOG.md', 'LICENSE', 'PRIVACY.md', 'CHROMEWEBSTORE.md', 'RELEASING.md', 'package.json', '更新本機工具.cmd',
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.loopx', '.pack', 'player-state', 'organize-backups', 'metadata-backups']);
const PRIVATE_FILE = /^(?:\.env(?:\..*)?|session\.json|history\.json|agent-state\.json|verified-audio\.json|browser-download-state\.json|download-log\.json|page-.*\.json|host-build\.json)$/i;

function rimraf(target) {
  const absolute = path.resolve(target), relative = path.relative(dist, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Refusing to remove a target outside the build directory');
  fs.rmSync(absolute, { recursive: true, force: true });
}

function stage(items) {
  rimraf(tmp);
  fs.mkdirSync(tmp, { recursive: true });
  for (const item of items) {
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) continue;
    const to = path.join(tmp, item);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, {
      recursive: true,
      filter: (source) => {
        const base = path.basename(source);
        if (SKIP_DIRS.has(base)) return false;
        if (PRIVATE_FILE.test(base) || fs.lstatSync(source).isSymbolicLink()) return false;
        if (/^(?:AGENTS|PLAN|HANDOFF|CODEX_HANDOFF|CONTRACT|VERIFICATION|SITE-API|FINDINGS)\.(?:md|docx|html)$/i.test(base) || /\.bak(?:[-.].*)?$/i.test(base)) return false;
        if (base === '__pycache__') return false;
        if (/\.(pyc|log|tmp|part)$/i.test(base)) return false;
        return true;
      },
    });
  }
}

/** 讀 ZIP 中央目錄的檔名；任何反斜線、絕對路徑或 .. 都讓打包失敗，不交出壞包。 */
function zipEntryNames(file) {
  const buffer = fs.readFileSync(file);
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('ZIP 結尾目錄不存在：' + file);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目錄損壞：' + file);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function assertPortableZip(file) {
  const bad = zipEntryNames(file).filter((name) => name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..'));
  if (bad.length) throw new Error(`ZIP 含不可攜路徑（${bad.length}）：${bad.slice(0, 3).join(', ')}`);
}

function zip(fromDir, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  rimraf(outFile);
  if (isWin) {
    // Windows PowerShell 5 的 ZipFile 會寫出反斜線路徑（naming\app.js），Chrome Web Store 與非 Windows 解壓會出錯；
    // 系統內建 bsdtar 依 ZIP 規格寫正斜線。
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', outFile, ...fs.readdirSync(fromDir)], { cwd: fromDir, stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-qr', outFile, '.'], { cwd: fromDir, stdio: 'inherit' });
  }
  assertPortableZip(outFile);
  return fs.statSync(outFile).size;
}

// 脫敏：金鑰只從執行環境拿來比對，命中就中止打包（錯誤訊息不含金鑰內容）。
const SECRET_ENV_KEYS = ['DEEPSEEK_API_KEY', 'ACE_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'HF_TOKEN'].map((key) => process.env[key]).filter(Boolean);

stage(STORE_ITEMS);
// Chrome Web Store 不接受 manifest 內的 "key"（本機載入未封裝時才需要固定 ID）；商店包一律剝掉。
const storeManifestPath = path.join(tmp, 'manifest.json');
const storeManifest = JSON.parse(fs.readFileSync(storeManifestPath, 'utf8'));
delete storeManifest.key;
delete storeManifest.update_url;
fs.writeFileSync(storeManifestPath, JSON.stringify(storeManifest, null, 2) + '\n');
if (storeManifest.key) throw new Error('商店包 manifest 仍含 key');
assertNoSecrets(tmp, { keys: SECRET_ENV_KEYS });
const storeFile = path.join(dist, `${name}-${version}-store.zip`);
const storeSize = zip(tmp, storeFile);

stage(FULL_ITEMS);
assertNoSecrets(tmp, { keys: SECRET_ENV_KEYS });
const fullFile = path.join(dist, `${name}-${version}-full.zip`);
const fullSize = zip(tmp, fullFile);
rimraf(tmp);

console.log(`store: ${storeFile} (${storeSize} bytes)`);
console.log(`full : ${fullFile} (${fullSize} bytes)`);
