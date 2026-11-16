'use strict';
const $ = id => document.getElementById(id);
let terms = [], currentPlan = null, parentPlan = null, currentSession = null, state = null;
const statuses = { awaiting_authorization: '待授權 · 未提交', cancelled: '已取消 · 未提交', stopped: '已停止', active: '本機準備中' };
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
async function api(path, body) {
  const response = await fetch('/music/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || data.reason || data.status || '無法完成本機操作。');
  return data;
}
function element(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
function dictionary() {
  $('dictionary').replaceChildren(...terms.map(t => {
    const row = element('div', undefined, 'term-row');
    const name = element('label', t.zh); name.htmlFor = 'w-' + t.term_id; name.append(element('small', t.dimension));
    const weight = document.createElement('input'); Object.assign(weight, { type: 'range', min: '0', max: '1', step: '0.05', value: String(t.base_weight), id: 'w-' + t.term_id, title: t.en + '；內部抽樣權重' });
    const lockLabel = element('label', undefined, 'lock'); const lock = document.createElement('input'); Object.assign(lock, { type: 'checkbox', id: 'l-' + t.term_id, title: '鎖定：' + t.zh }); lock.setAttribute('aria-label', '鎖定：' + t.zh); lockLabel.append(lock);
    row.append(name, weight, lockLabel); return row;
  }));
}
function preview(plan) {
  currentPlan = plan; $('reviewed').checked = false; $('prepare').disabled = true;
  $('empty-preview').hidden = true; $('preview-content').hidden = false;
  $('plan-status').textContent = (plan.mode === 'idea' ? 'Idea' : 'Custom') + ' · ' + plan.requested_model;
  $('explanation').textContent = plan.original_intent;
  $('selected-terms').replaceChildren(...plan.selected_terms.map(t => element('span', t.zh + (t.locked ? ' · 已鎖定' : ''), 'term' + (t.locked ? ' locked' : ''))));
  $('translation-warning').hidden = !plan.translation_required;
  $('prompt-fields').replaceChildren(...Object.entries(plan.prompt_fields).flatMap(([key, value]) => [element('div', key, 'field-label'), element('pre', value || '（留空）')]));
  $('versions').textContent = '詞典 ' + plan.dictionary_version + ' / 編譯器 ' + plan.compiler_version;
  $('trace').textContent = JSON.stringify({ seeds: plan.seeds, changes: plan.changes, excluded: plan.exclusions, versions: plan.versions, hash: plan.hash }, null, 2);
}
function input() {
  const result = { natural_language: $('intent').value, model: $('model').value, mode: $('mode').value, seed: Number($('seed').value),
    weights: Object.fromEntries(terms.map(t => [t.term_id, Number($('w-' + t.term_id).value)])), locked_term_ids: terms.filter(t => $('l-' + t.term_id).checked).map(t => t.term_id), max_changed_dimensions: Number($('change-limit').value) };
  if (result.mode === 'custom') result.lyrics = $('lyrics').value;
  if (parentPlan) { result.parent_ids = [parentPlan.id]; result.previous_term_ids = parentPlan.selected_terms.map(t => t.term_id); }
  return result;
}
async function compile() {
  $('prepare').disabled = true; notice('正在編譯並保存預覽…');
  try { const result = await api('prompts/compile', input()); preview(result.plan); await refresh(); notice(result.plan.translation_required ? '已保留原意；請核對尚未翻譯的描述。' : '預覽已保存。核對模型與文字後，可準備一個待授權任務。'); }
  catch (err) { currentPlan = null; $('plan-status').textContent = '需要調整'; notice(err.message, true); }
}
async function refresh() {
  state = await api('state');
  const savedSession = state.sessions.find(s => s.status === 'active'); currentSession = savedSession?.id || null;
  $('jobs').replaceChildren(...state.jobs.slice(0, 8).map(j => {
    const row = element('div', undefined, 'record'); const text = element('div', statuses[j.status] || j.status); text.append(element('small', j.requested_model + ' · 無遠端任務'));
    const stop = element('button', '停止批次'); stop.type = 'button'; stop.disabled = j.status === 'cancelled'; stop.addEventListener('click', () => act(async () => { await api('sessions/stop', { session_id: j.session_id }); await refresh(); notice('已停止本機後續任務，沒有送出的遠端任務。'); })); row.append(text, stop); return row;
  }));
  if (!state.jobs.length) $('jobs').textContent = '尚無準備任務。';
  $('history').replaceChildren(...state.plans.slice(0, 6).map(p => {
    const row = element('div', undefined, 'record'); const text = element('div', p.original_intent); text.append(element('small', p.requested_model + ' · ' + p.mode + ' · seed ' + p.seeds.terms));
    const use = element('button', '檢視並沿用'); use.type = 'button'; use.addEventListener('click', () => { parentPlan = p; $('intent').value = p.original_intent; $('model').value = p.requested_model; $('mode').value = p.mode; $('lyrics-field').hidden = p.mode !== 'custom'; $('lyrics').value = p.prompt_fields.lyrics || ''; $('seed').value = p.seeds.terms;
      for (const t of terms) { $('l-' + t.term_id).checked = p.locked_term_ids.includes(t.term_id); $('w-' + t.term_id).value = p.selected_terms.find(x => x.term_id === t.term_id)?.weight ?? t.base_weight; }
      preview(p); notice('已沿用此方向作為父代；新的預覽會記錄變動與譜系。'); $('directions').scrollIntoView({ behavior: 'smooth', block: 'start' }); }); row.append(text, use); return row;
  }));
  if (!state.plans.length) $('history').textContent = '尚無預覽紀錄。';
  $('references').replaceChildren(...state.references.map(r => element('li', r.user_input + ' · ' + (r.ai_ingestion_allowed ? '已登記' : '僅供導覽 · AI 路徑關閉'))));
}
async function act(work) { try { await work(); } catch (err) { notice(err.message, true); } }
$('intent-form').addEventListener('submit', e => { e.preventDefault(); compile(); });
$('explore').addEventListener('click', () => { $('seed').value = (Number($('seed').value) + 1) >>> 0; compile(); });
$('mode').addEventListener('change', () => { $('lyrics-field').hidden = $('mode').value !== 'custom'; });
$('intent-form').addEventListener('input', () => { currentPlan = null; $('reviewed').checked = false; $('prepare').disabled = true; $('plan-status').textContent = '輸入已變更 · 請重新預覽'; });
$('reviewed').addEventListener('change', () => { $('prepare').disabled = !currentPlan || currentPlan.translation_required || !$('reviewed').checked; });
$('copy').addEventListener('click', () => act(async () => { if (!currentPlan) throw new Error('請先重新預覽。'); await navigator.clipboard.writeText(Object.entries(currentPlan.prompt_fields).map(([k,v]) => k + '\n' + v).join('\n\n')); notice('已複製實際提示詞欄位。'); }));
$('prepare').addEventListener('click', () => act(async () => {
  const plan = currentPlan; if (!plan || !$('reviewed').checked) return;
  $('prepare').disabled = true;
  if (!currentSession) currentSession = (await api('sessions', { goal: plan.original_intent, max_generations: 3, max_depth: 1 })).session.id;
  const result = await api('generations/prepare', { plan_id: plan.id, session_id: currentSession, idempotency_key: currentSession + ':' + plan.id, reviewed: true });
  await refresh(); notice('已保存待授權任務。沒有提交生成、扣費或上傳素材。'); $('prepare').disabled = false;
}));
$('register-reference').addEventListener('click', () => act(async () => { if (!$('reference-url').checkValidity() || !$('reference-url').value) throw new Error('請輸入完整參考網址。'); await api('references', { user_input: $('reference-url').value, ai_ingestion_allowed: false }); $('reference-url').value = ''; await refresh(); notice('引用已登記在本機；沒有抓取或送入 AI。'); }));
$('refresh').addEventListener('click', () => act(async () => { await refresh(); notice('已讀取本機紀錄。'); }));
act(async () => { const data = await api('dictionary'); terms = data.terms; dictionary(); await refresh(); notice('本機準備可用。ACE 與 DeepSeek 尚未送出任何請求。'); });
