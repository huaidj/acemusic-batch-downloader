// shared.mjs — 把擴充功能的 naming.js / planner.js（classic script）載入成 Node 可用的函式
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..', '..');

let cached = null;

export function loadShared() {
    if (cached) return cached;
    const ctx = { console };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const file of ['src/naming.js', 'src/planner.js']) {
        const code = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
        vm.runInContext(code, ctx, { filename: file });
    }
    cached = { N: ctx.AceDLNaming, P: ctx.AceDLPlanner };
    return cached;
}
