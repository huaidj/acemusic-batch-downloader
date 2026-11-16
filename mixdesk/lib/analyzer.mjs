import { spawn } from 'node:child_process';
import path from 'node:path';

const failure = (files, code, message) => files.map((file) => ({ path: file, ok: false, error: { code, message } }));

/** Run a bounded analyzer process without occupying the HTTP event loop. */
export async function analyzeFiles(files, {
  executable = 'python',
  analyzer,
  timeoutMs = 600000,
  maxOutputBytes = 64 * 1024 * 1024,
  maxErrorBytes = 256 * 1024,
  env = process.env,
} = {}) {
  if (!files.length) return [];
  const boundedTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 600000;
  const boundedOutput = Number.isFinite(Number(maxOutputBytes)) && Number(maxOutputBytes) > 0 ? Number(maxOutputBytes) : 64 * 1024 * 1024;
  const boundedError = Number.isFinite(Number(maxErrorBytes)) && Number(maxErrorBytes) > 0 ? Number(maxErrorBytes) : 256 * 1024;
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (code, message) => {
      child?.kill('SIGKILL');
      finish(failure(files, code, message));
    };
    try {
      child = spawn(executable, [analyzer, ...files], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
    } catch (err) {
      return finish(failure(files, 'ANALYZER_START_FAILED', String(err.message || err)));
    }
    timer = setTimeout(() => stop('ANALYZER_TIMEOUT', `音訊分析超時（${boundedTimeout} ms）`), boundedTimeout);
    child.on('error', (err) => finish(failure(files, 'ANALYZER_START_FAILED', String(err.message || err))));
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > boundedOutput) return stop('ANALYZER_OUTPUT_LIMIT', '音訊分析輸出超過上限');
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > boundedError) return stop('ANALYZER_OUTPUT_LIMIT', '音訊分析錯誤輸出超過上限');
      stderr.push(chunk);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 500);
        return finish(failure(files, 'ANALYZER_EXIT_FAILED', `音訊分析程序結束（${signal || code}）${detail ? ': ' + detail : ''}`));
      }
      let results;
      try {
        results = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        if (!Array.isArray(results)) throw new Error('expected array');
      } catch {
        return finish(failure(files, 'ANALYZER_INVALID_JSON', '音訊分析未回傳有效的結果陣列'));
      }
      finish(files.map((file) => {
        const matches = results.filter((item) => item && typeof item.path === 'string' && path.resolve(item.path) === path.resolve(file));
        if (matches.length !== 1) return failure([file], 'ANALYZER_MISSING_RESULT', '音訊分析結果缺失或重複')[0];
        const result = matches[0];
        if (result.ok !== true) {
          const message = typeof result.error === 'string' ? result.error : result.error?.message;
          return failure([file], 'ANALYZER_FILE_FAILED', String(message || '無法分析此音檔').slice(0, 500))[0];
        }
        return result;
      }));
    });
  });
}
