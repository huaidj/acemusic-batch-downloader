// test/unit/lib-load.mjs — 用 node:vm 載入 classic script 的 naming.js / planner.js，
// 取得 globalThis.AceDLNaming / AceDLPlanner（與瀏覽器 isolated world 相同的載入方式）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SRC_DIR = path.resolve(HERE, '..', '..', 'src');

export function loadAceDlScripts(files = ['naming.js', 'planner.js']) {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    Date,
    setTimeout,
    clearTimeout,
    Math,
    JSON,
  };
  const context = vm.createContext(sandbox);
  for (const file of files) {
    const code = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    vm.runInContext(code, context, { filename: `src/${file}` });
  }
  return {
    context,
    naming: context.AceDLNaming,
    planner: context.AceDLPlanner,
  };
}
