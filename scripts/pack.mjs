#!/usr/bin/env node
// 產生兩種 zip：
//   dist/<name>-<version>-store.zip  → Chrome Web Store 用（只有 manifest/src/icons）
//   dist/<name>-<version>-full.zip   → GitHub Release 用（完整 repo 內容，排除本機/內部檔）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const name = 'acemusic-batch-downloader';
const dist = path.join(ROOT, 'dist');
const tmp = path.join(dist, '.pack');
const isWin = process.platform === 'win32';

const STORE_ITEMS = ['manifest.json', 'src', 'icons'];
const FULL_ITEMS = [
  'manifest.json', 'src', 'icons', 'agent', 'native', 'mixdesk', 'docs',
  'design', 'scripts/repair-wavs.mjs',
  'README.md', 'CHANGELOG.md', 'LICENSE', 'PRIVACY.md', 'CHROMEWEBSTORE.md', 'RELEASING.md', 'package.json',
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.loopx', '.pack']);

function rimraf(target) {
  fs.rmSync(target, { recursive: true, force: true });
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
        if (base === '__pycache__') return false;
        if (/\.(pyc|log|tmp|part)$/i.test(base)) return false;
        return true;
      },
    });
  }
}

function zip(fromDir, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  rimraf(outFile);
  if (isWin) {
    const psQuote = (value) => "'" + value.replace(/'/g, "''") + "'";
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(fromDir)}, ${psQuote(outFile)})`,
    ], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-qr', outFile, '.'], { cwd: fromDir, stdio: 'inherit' });
  }
  return fs.statSync(outFile).size;
}

stage(STORE_ITEMS);
const storeFile = path.join(dist, `${name}-${version}-store.zip`);
const storeSize = zip(tmp, storeFile);

stage(FULL_ITEMS);
const fullFile = path.join(dist, `${name}-${version}-full.zip`);
const fullSize = zip(tmp, fullFile);
rimraf(tmp);

console.log(`store: ${storeFile} (${storeSize} bytes)`);
console.log(`full : ${fullFile} (${fullSize} bytes)`);
