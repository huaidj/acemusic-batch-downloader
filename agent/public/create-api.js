'use strict';
const $ = id => document.getElementById(id);
let prepared = null;
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
async function api(action, body) {
  const response = await fetch('/create-api/' + action, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok || value.ok === false) throw new Error(value.reason || value.error || value.message || value.status || '操作未完成');
  return value;
}
function rows(schema, prefix = '') {
  const list = [];
  for (const branch of schema.oneOf || schema.anyOf || []) list.push(...rows(branch, prefix));
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    const name = prefix + key;
    const row = document.createElement('div'); row.className = 'record';
    const label = document.createElement('div'); const fieldName = document.createElement('span'); fieldName.textContent = name; label.append(fieldName);
    const desc = document.createElement('small'); desc.textContent = prop.description || prop.title || (prop.enum ? prop.enum.join(' / ') : prop.type || '依模型及模式'); label.append(desc);
    const type = document.createElement('small'); type.textContent = (Array.isArray(prop.type) ? prop.type.join(' | ') : prop.type || '條件物件') + (prop.minimum !== undefined ? ' ≥' + prop.minimum : '') + (prop.maximum !== undefined ? ' ≤' + prop.maximum : '') + (prop.maxLength ? ' · 最多 ' + prop.maxLength + ' 字' : ''); row.append(label, type); list.push(row);
    const nested = [...rows({ properties: prop.properties, oneOf: prop.oneOf, anyOf: prop.anyOf }, name + '.'), ...(prop.items ? rows(prop.items, name + '[].') : [])];
    if (nested.length) { const group = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = name + ' · 展開欄位'; group.append(summary, ...nested); list.push(group); }
  }
  return list;
}
async function act(work) { try { await work(); } catch (err) { prepared = null; $('copy').disabled = true; notice(err.message, true); } }
$('validate').addEventListener('click', () => act(async () => {
  const input = JSON.parse($('request-json').value); prepared = await api('prepare', input);
  $('native-request').textContent = JSON.stringify(prepared.request, null, 2);
  $('request-state').textContent = '已準備 · ' + prepared.requested_model + ' · hash ' + prepared.request_hash;
  $('copy').disabled = false; notice('參數通過本機契約檢查。沒有送出生成、讀取登入或上傳。');
}));
$('request-json').addEventListener('input', () => { prepared = null; $('copy').disabled = true; $('request-state').textContent = '輸入已變更，請重新驗證。'; });
$('copy').addEventListener('click', () => act(async () => { if (!prepared) return; await navigator.clipboard.writeText(JSON.stringify(prepared.request, null, 2)); notice('已複製原生 API 請求。'); }));
$('live-preview').addEventListener('click', () => act(async () => { notice('正在唯讀核對站點狀態…'); const value = await api('preview', JSON.parse($('request-json').value)); $('live-result').hidden = false; $('live-result').textContent = JSON.stringify(value, null, 2); notice('即時核對完成。沒有送出生成 POST。'); }));
act(async () => { const capabilities = await api('capabilities'); $('parameter-list').replaceChildren(...rows(capabilities.input_schema)); $('capabilities').textContent = JSON.stringify(capabilities, null, 2); const auth = await fetch('/create-api/authority').then(r => r.json()); $('authority').textContent = JSON.stringify(auth, null, 2);
  prepared = await api('prepare', JSON.parse($('request-json').value)); $('native-request').textContent = JSON.stringify(prepared.request, null, 2); $('request-state').textContent = '範例已通過本機驗證 · 未提交'; $('copy').disabled = false;
  notice('完整參數契約已載入。範例只在本機驗證，沒有送出生成。'); });
