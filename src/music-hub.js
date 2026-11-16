// Stateless MV3 client: business state stays in the selected local Hub.
(function (root) {
  'use strict';
  const KEY = 'aceMusicHubUrl';
  function normalize(value) {
    const url = new URL(value || 'http://127.0.0.1:8788');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('中樞網址只接受本機 http://127.0.0.1:連接埠。');
    return url.origin;
  }
  function create({ chromeApi, fetchImpl }) {
    async function base() { const stored = await chromeApi.storage.local.get(KEY); return normalize(stored[KEY]); }
    async function read(url) {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error('中樞無法讀取，請確認啟動網址及本機授權。');
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw new Error('中樞回應超過上限。');
      return JSON.parse(text);
    }
    async function status() {
      const url = await base();
      const capabilities = await read(url + '/capabilities');
      if (capabilities.name !== 'ace-agent-hub' || capabilities.apiVersion !== 1 || !capabilities.musicAgent) return { ok: false, status: 'unsupported', base_url: url, error: '這個 Hub 尚未提供音樂工作台，請選擇新版中樞網址。' };
      const state = await read(url + '/music/state');
      if (state.ok !== true || !Array.isArray(state.jobs) || !Array.isArray(state.assets)) throw new Error('中樞狀態格式未通過核對。');
      return { ok: true, base_url: url, workspace_url: url + '/music',
        jobs: state.jobs.length, assets: state.assets.length,
        awaiting_listen: state.assets.filter(item => item.human_listen?.status === 'awaiting_listen').length,
        running: state.jobs.filter(job => ['submitting', 'queued', 'generating', 'collecting'].includes(job.status)).length };
    }
    return {
      async dispatch(message) {
        try {
          if (message.type === 'ACE_MUSIC_HUB_GET_CONFIG') return { ok: true, base_url: await base() };
          if (message.type === 'ACE_MUSIC_HUB_CONFIG') { const url = normalize(message.base_url); await chromeApi.storage.local.set({ [KEY]: url }); return { ok: true, base_url: url }; }
          if (message.type === 'ACE_MUSIC_HUB_STATUS') return await status();
          if (message.type === 'ACE_MUSIC_HUB_OPEN') { const current = await status(); if (!current.ok) return current; await chromeApi.tabs.create({ url: current.workspace_url }); return { ok: true, workspace_url: current.workspace_url }; }
          if (message.type === 'ACE_MUSIC_HUB_PROMPT') {
            const url = await base();
            return { ok: true, text: `請連接我本機的 HuaiDJ 音樂中樞 ${url}。先讀 /capabilities 與 /music/capabilities；所有準備、任務、研究、產物與回饋都由同一 Hub 管理。先產生可審閱預覽；付費、上傳及自動繼續只依伺服器已批准範圍執行。提交結果未知時保留原任務與幂等鍵，不重送。不要將 Cookie、API key 或私人音訊放進提示詞。` };
          }
          return { ok: false, error: '未知中樞入口操作。' };
        } catch { return { ok: false, status: 'unavailable', error: '無法連接所選本機中樞；請先啟動工作台並核對網址。' }; }
      },
    };
  }
  root.AceMusicHub = { create, normalize };
})(globalThis);
