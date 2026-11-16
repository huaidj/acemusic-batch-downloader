import fs from 'node:fs';
import { spawn } from 'node:child_process';
// Node 24 on Windows does not expand a directory passed to --test.
const files = fs.readdirSync('test/unit').filter(name => name.endsWith('.mjs')).sort().map(name => 'test/unit/' + name);
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
