import fs from 'node:fs';
import path from 'node:path';
import { createResearchService } from '../research/service.mjs';
import { createMusicArtifactCollector } from './music-artifacts.mjs';
import { createMusicPerformance } from './music-performance.mjs';

function readConfiguration(file) {
  if (!file) return {};
  try {
    if (fs.statSync(file).size > 65536) return {};
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
const unwrap = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 1 && (text[0] === '"' && text.at(-1) === '"' || text[0] === "'" && text.at(-1) === "'") ? text.slice(1, -1).trim() : text;
};

// Only process configuration can select credentials, destinations and budgets.
// A request body cannot supply an environment variable name or a config path.
export function createMusicRuntime({ cfg, createApi, env = process.env }) {
  const settings = readConfiguration(env.ACE_MUSIC_RUNTIME_CONFIG);
  const stateDir = path.join(cfg.stateDir, 'music-agent');
  const researchSettings = readConfiguration(env.ACE_RESEARCH_CONFIG_FILE);
  let researchConfig = {};
  if (researchSettings.enabled === true && researchSettings.api_key_env === 'DEEPSEEK_API_KEY') {
    researchConfig = {
      api_key: unwrap(env.DEEPSEEK_API_KEY), base_url: unwrap(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'),
      budget_usd: researchSettings.budget_usd, max_requests: researchSettings.max_requests,
      expires_at: researchSettings.expires_at, grant_id: researchSettings.grant_id,
      allowed_kinds: researchSettings.allowed_kinds,
      allowed_fetch_hosts: Array.isArray(researchSettings.allowed_fetch_hosts) ? researchSettings.allowed_fetch_hosts : [],
    };
  }
  const research = createResearchService({ stateDir: path.join(stateDir, 'research'), config: researchConfig });
  const artifactsDir = env.ACE_MUSIC_ARTIFACTS_DIR || settings.artifacts_dir || path.join(stateDir, 'artifacts');
  let artifactCollector;
  const collector = { collect(input) {
    artifactCollector ||= createMusicArtifactCollector({ cfg, artifactsDir, transport: { status: query => createApi.getTransport().status(query) },
      allowedRedirectOrigins: Array.isArray(settings.audio_redirect_origins) ? settings.audio_redirect_origins : [] });
    return artifactCollector.collect(input);
  } };
  const performance = createMusicPerformance({ external: {
    base_url: settings.mixcore_url || '', owner: 'BadDJ MixCore project owner',
  } });
  const interval = Number(settings.poll_interval_ms);
  return { research, collector, performance, artifactsDir, pollIntervalMs: Number.isSafeInteger(interval) && interval >= 1000 && interval <= 3600000 ? interval : 10000 };
}
