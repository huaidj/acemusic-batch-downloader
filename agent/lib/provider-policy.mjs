// The legacy v1.1 path remains preview-only on real services. Real submissions
// use the complete Create adapter and its independent finite authority ledger.
// Loopback is reserved for isolated legacy contract tests.
export function directGenerationPermission(cfg) {
  let url;
  try { url = new URL(cfg.baseUrl); } catch { return false; }
  const isolated = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  return isolated;
}
export function assertDirectGenerationPermission(cfg, options = {}) {
  if (options.dry_run !== false || directGenerationPermission(cfg)) return;
  throw Object.assign(new Error('真實生成尚未啟用。需要先完成使用者預算與平台使用範圍核對；請求旗標不能自行授權。'), { code: 'GENERATION_AUTHORIZATION_REQUIRED', submission_unknown: false });
}
