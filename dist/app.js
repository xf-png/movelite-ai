import { CATEGORIES, DEFAULT_SETTINGS, normalizeItem, validateSettings, solvePlans } from './engine.js?v=1.0.0';
import { parseInventory, categorizeWithEmbeddings, serializeWorkspace, parseWorkspaceBackup, createTasks, createCalendar, createMarkdownReport, createListing } from './inventory.js?v=1.0.0';
import { loadLocalModel, unloadLocalModel } from './model.js?v=1.0.0';
import { createDemo, todayISO, daysFromToday } from './demo.js?v=1.0.0';

const $ = selector => document.querySelector(selector);
const E = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = (name, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} aria-hidden="true"><use href="#i-${name}"/></svg>`;
const currency = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value) || 0);
const volume = value => (value / 1000).toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
const hours = value => Number((value / 60).toFixed(1)).toString();
const categoryName = value => CATEGORIES.find(category => category.id === value)?.label || '其他';
const categoryEmoji = { furniture: '🪑', electronics: '💻', kitchen: '☕', clothing: '🧥', books: '📚', sports: '🏕️', sentimental: '💌', other: '📦' };
const actionName = { keep: '带去新家', sell: '转让', donate: '转赠', recycle: '回收处理' };
const conditionName = { good: '正常使用', worn: '有使用痕迹', broken: '已损坏' };
const viewTitles = { overview: '决策工作台', inventory: '物品清单', tasks: '行动清单', about: '项目与业务思路' };
const storageKey = 'movelite:workspace:1';
const preferenceKey = 'movelite:save:1';
const state = { ...createDemo(), view: 'overview', scene: 'graduation', selectedPlan: 'keep', result: null, computing: false, computeError: '', persist: false, saveError: '', savedAt: null, filter: 'all', inventoryFilter: 'all', search: '', quotesOpen: false, embedder: null, aiBusy: false, aiAbort: null, undo: [] };
let optimizer = null, computeTimer, computeDeadline, requestId = 0, toastTimer;

function workspace() { return { items: state.items, settings: state.settings, completed: state.completed, actualIncome: state.actualIncome }; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
function pendingDrafts() { return state.items.filter(item => !item.confirmed); }
function selectedPlan() { return state.result?.plans.find(plan => plan.id === state.selectedPlan) || null; }
function actualTotal() { return Object.entries(state.actualIncome).reduce((sum, [id, amount]) => sum + (state.completed[id] === 'sell' ? amount : 0), 0); }
function completedTask(task) { return state.completed[task.itemId] === task.action; }
function taskData() {
  try { return { tasks: selectedPlan()?.feasible ? createTasks(selectedPlan(), state.items, state.settings) : [], error: '' }; }
  catch (error) { return { tasks: [], error: error.message }; }
}
function remember() {
  state.undo.push(serializeWorkspace(workspace()));
  if (state.undo.length > 20) state.undo.shift();
}
function save() {
  state.saveError = '';
  if (state.persist) {
    try { localStorage.setItem(storageKey, serializeWorkspace(workspace())); state.savedAt = new Date(); }
    catch { state.saveError = '本机保存失败。你仍可继续使用，请导出备份后再离开。'; }
  }
  updateChrome();
}
function changed({ recompute = true } = {}) { save(); if (recompute) scheduleSolve(); else render(); }
function changeView(view) { state.view = view; render(); $('#main-view').focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
function updateChrome() {
  $('#main-view').setAttribute('aria-busy', String(state.computing));
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === state.view); if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  $('#view-title').textContent = viewTitles[state.view];
  $('#nav-count').textContent = String(state.items.length);
  const tasks = taskData().tasks;
  const pending = tasks.filter(task => !completedTask(task)).length;
  $('#nav-task-count').textContent = pending ? String(pending) : '';
  $('#save-label').textContent = state.saveError ? '保存失败 · 请导出备份' : state.persist ? '计划已保存在此浏览器' : '资料仅在当前页面';
  $('#undo-button').disabled = !state.undo.length;
  $('#ai-label').textContent = state.aiBusy ? 'AI 正在准备' : state.embedder ? '本地 AI 已就绪' : 'AI 辅助归类';
  $('#ai-dot').classList.toggle('ready', Boolean(state.embedder));
  if ($('#storage-dialog').open) updateStorage();
}
function scheduleSolve() {
  clearTimeout(computeTimer); clearTimeout(computeDeadline);
  optimizer?.terminate(); optimizer = null;
  requestId++;
  state.computing = true; state.computeError = ''; state.result = null;
  render();
  computeTimer = setTimeout(runSolve, 180);
}
function runSolve() {
  const id = requestId;
  const items = state.items.map(item => state.completed[item.id] ? { ...item, lock: state.completed[item.id] } : item);
  const finish = result => {
    if (id !== requestId) return;
    clearTimeout(computeDeadline); optimizer?.terminate(); optimizer = null;
    state.result = result; state.computing = false;
    if (!result.plans.some(plan => plan.id === state.selectedPlan && plan.feasible)) state.selectedPlan = result.plans.find(plan => plan.feasible)?.id || 'keep';
    render();
  };
  const fail = message => { if (id !== requestId) return; clearTimeout(computeDeadline); optimizer?.terminate(); optimizer = null; state.computing = false; state.computeError = message; render(); };
  try {
    if (typeof Worker === 'undefined') { finish(solvePlans(items, state.settings)); return; }
    optimizer = new Worker(new URL('./optimizer.worker.js?v=1.0.0', import.meta.url), { type: 'module' });
    optimizer.onmessage = ({ data }) => { if (data.requestId !== id) return; if (data.type === 'result') finish(data.result); else fail(data.message || '计算失败，请检查输入。'); };
    optimizer.onerror = event => { event.preventDefault(); fail('方案计算未完成，请稍后重试或减少物品数量。'); };
    computeDeadline = setTimeout(() => fail('这次计算用时较长，请减少物品数量或调整限制后重试。'), 15000);
    optimizer.postMessage({ type: 'solve', requestId: id, items, settings: state.settings });
  } catch (error) { fail(error.message); }
}
function render() {
  const active = document.activeElement;
  const focus = active?.id && $('#main-view').contains(active) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const y = window.scrollY;
  $('#main-view').innerHTML = ({ overview: overviewView, inventory: inventoryView, tasks: tasksView, about: aboutView }[state.view])();
  updateChrome();
  if (focus) {
    const next = document.getElementById(focus.id);
    if (next) { next.focus({ preventScroll: true }); if (focus.start !== null) try { next.setSelectionRange(focus.start, focus.end); } catch {} }
  }
  if (Math.abs(window.scrollY - y) > 5) window.scrollTo({ top: y, behavior: 'instant' });
}

function heroArt() {
  return `<div class="hero-illustration" aria-hidden="true"><svg viewBox="0 0 340 190" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="181" cy="164" rx="131" ry="16" fill="#e9edde" stroke="none"/><path d="M60 159V58l61-37 62 37v101" stroke="#c6d3b7" stroke-dasharray="4 5"/><path d="m46 68 75-45 76 45" stroke="#b1c59b" stroke-width="2"/><path d="M129 81h41v75h-41z" fill="#e2e9d5" stroke="#c9d7b8"/><path d="M85 62h22v28H85z" fill="#edf1e4" stroke="#c5d4b1"/><path d="M96 62v28M85 76h22" stroke="#c5d4b1"/><path d="m168 124 41-21 42 21v40l-42 20-41-20z" fill="#d3dfbf" stroke="#a8be89"/><path d="m168 124 41 21 42-21M209 145v39m-21-70 42 21" stroke="#9cb77c"/><path d="m228 118 26-14 27 14v43l-27 14-26-14z" fill="#f0e0c5" stroke="#d3b78e"/><path d="m228 118 26 14 27-14M254 132v43m-14-64 27 14" stroke="#c5a477"/><path d="M112 157v-31c0-18 14-32 32-32s31 13 31 31v32" fill="#f8f9f2" stroke="#b8c9a4"/><path d="M112 145h63m-55 0v21m47-21v21" stroke="#9db787" stroke-width="3"/><path d="M286 153v-35" stroke="#a4b98b" stroke-width="2"/><path d="M286 137c-23-5-28-23-12-24 13 0 15 14 12 24ZM286 127c17-3 23-15 12-18-12-2-16 11-12 18Z" fill="#b9cba2" stroke="#a5ba8c"/><path d="M274 153h24l-4 17h-16z" fill="#d8c4a8" stroke="#c7b08f"/><circle cx="239" cy="58" r="22" fill="#eff3e5" stroke="none"/><path d="m230 58 6 6 12-13" stroke="#a6bc88" stroke-width="2"/><path d="m205 30 3 8m-15-1 7 4m4-17-1 7" stroke="#b1c49a" stroke-width="2"/><path d="M54 113c-11-8-18-2-13 5 2 4 8 8 13 13 5-5 12-9 14-14 3-8-6-13-14-4Z" fill="#e6c3aa" stroke="none"/></svg></div>`;
}
function statsCards() {
  const confirmed = state.items.filter(item => item.confirmed);
  const total = confirmed.reduce((sum, item) => sum + item.volumeL, 0);
  return `<div class="stats-grid">${[
    ['box', '已确认物品', confirmed.length, '组', pendingDrafts().length ? `${pendingDrafts().length} 组草稿等待确认` : '每一组都有自己的下一站'],
    ['home', '当前物品体积', volume(total), 'm³', '整组估计体积合计'],
    ['leaf', '可带走容量', volume(state.settings.capacityL), 'm³', '新家准备留给这些物品的空间'],
    ['clock', '闲置处理时间', hours(state.settings.timeMinutes), '小时', '不含带走物品的打包时间'],
  ].map(([symbol, label, value, unit, detail]) => `<div class="stat-card"><span class="stat-icon">${icon(symbol)}</span><span class="stat-label">${label}</span><b class="stat-value number-quiet">${E(value)}<small>${unit}</small></b><span class="stat-detail">${E(detail)}</span></div>`).join('')}</div>`;
}
function constraintsPanel() {
  return `<section class="panel panel-pad"><div class="panel-header"><div class="panel-title">${icon('home')}<h3>先给下一站，画个边界</h3></div><small>改一改，就会重新计算</small></div><div class="constraints-grid"><label class="field"><span>带走容量 <b class="range-value">${volume(state.settings.capacityL)} m³</b></span><input id="capacity-range" data-setting="capacityL" type="range" min="0" max="10000" step="100" value="${state.settings.capacityL}" aria-label="可带走容量"><div class="range-labels"><span>0 m³</span><span>10 m³</span></div></label><label class="field"><span>处理闲置能花多少时间 <b class="range-value">${hours(state.settings.timeMinutes)} 小时</b></span><input id="time-range" data-setting="timeMinutes" type="range" min="0" max="720" step="30" value="${state.settings.timeMinutes}" aria-label="闲置处理可用时间"><div class="range-labels"><span>0 小时</span><span>12 小时</span></div></label><label class="field"><span>搬家日期</span><input id="move-date" data-setting="moveDate" type="date" min="${todayISO()}" value="${E(state.settings.moveDate)}"></label><div class="field"><span>重要的东西，先留住</span><p class="field-help" style="margin-top:0">在物品旁点击${icon('lock')}，锁定带走。<br>已完成的行动也会固定去向。</p></div></div><details class="quote-details" ${state.quotesOpen ? 'open' : ''}><summary>车型容量与固定报价 · 初始值为示例</summary><div class="quote-grid">${state.settings.tiers.map((tier, index) => `<div class="quote-box"><b>${E(tier.name)}</b><label class="field"><span>可装体积 m³</span><input id="tier-volume-${index}" data-tier="${index}" data-tier-field="capacityL" type="number" min="0.01" max="10" step="0.01" value="${tier.capacityL / 1000}" aria-label="${E(tier.name)}容量"></label><label class="field"><span>整车报价 元</span><input id="tier-price-${index}" data-tier="${index}" data-tier-field="price" type="number" min="0" max="100000" step="0.01" value="${tier.price}" aria-label="${E(tier.name)}报价"></label></div>`).join('')}</div><p class="field-help">初始车型与报价为虚构示例，请改成你获得的报价。按当前输入中能装下的车型取最低价，少带几件不一定降低运费；这里不是平台实时报价。</p></details></section>`;
}
function planCards() {
  const descriptions = { keep: '更看重使用与情感分量', budget: '更看重转让意向价与支出', quick: '更看重处理闲置的时间' };
  const symbols = { keep: 'heart', budget: 'wallet', quick: 'clock' };
  return `<section><div class="plan-intro"><h3>三种选择，没有标准答案</h3><span class="compute-label">${state.computing ? `<span class="spinner"></span>正在计算` : state.result ? `${icon('check')}已按限制计算` : ''}</span></div>${state.computeError ? `<div class="inline-warning">${E(state.computeError)}<button class="subtle-link" data-command="recompute">再试一次</button></div>` : ''}<div class="plan-cards">${(state.result?.plans || ['keep', 'budget', 'quick'].map((id, index) => ({ id, label: ['多留一点', '少花一点', '快一点'][index], feasible: true, metrics: null }))).map(plan => `<button class="plan-card ${state.selectedPlan === plan.id ? 'selected' : ''} ${!plan.feasible ? 'infeasible' : ''}" data-plan="${plan.id}" aria-pressed="${state.selectedPlan === plan.id}" ${state.computing ? 'disabled' : ''}><span class="plan-top">${icon(symbols[plan.id])}${state.selectedPlan === plan.id && plan.feasible ? '<span class="plan-tag">当前方案</span>' : ''}</span><h4>${E(plan.label)}</h4><p class="plan-desc">${descriptions[plan.id]}</p><div class="plan-main number-quiet">${!plan.feasible ? '暂无可行方案' : plan.metrics ? `${volume(plan.metrics.keptVolumeL)}<small>m³ 带走</small>` : '—'}</div><div class="plan-data">${plan.metrics ? `<span>${plan.metrics.keepCount} 组带走</span><span>${plan.metrics.handlingMinutes} 分钟处置</span>` : `<span>${state.computing ? '请稍等片刻' : !plan.feasible ? '查看下方原因' : '确认物品后计算'}</span>`}</div></button>`).join('')}</div><p class="plan-note">${icon('info')}容量、时间和车型按 10 升 / 5 分钟保守规划。初始车型报价仅为示例，请先核对；转让意向价不代表成交。</p></section>`;
}
function decisionList() {
  const plan = selectedPlan();
  if (state.computing) return `<section class="panel"><div class="empty-state"><span class="spinner"></span><p>正在把每件物品，放进合适的方案…</p></div></section>`;
  if (plan && !plan.feasible) return `<section class="panel"><div class="empty-state">${icon('info')}<h3>现在的条件，还装不下这个决定</h3><p>${E(plan.reason)}</p><div class="button-row"><button class="secondary-button" data-view="inventory">检查锁定物品</button></div></div></section>`;
  if (!plan?.actions.length) return `<section class="panel"><div class="empty-state">${icon('box')}<h3>${pendingDrafts().length ? '先确认物品，再让方案开始' : '下一站，从一件物品开始'}</h3><p>${pendingDrafts().length ? '草稿中的体积、金额与耗时需要你检查后确认。' : '添加自己的物品，或粘贴一段清单。'}</p><div class="button-row"><button class="primary-button" data-command="paste">粘贴清单</button><button class="secondary-button" data-view="inventory">查看物品</button></div></div></section>`;
  const actions = plan.actions.filter(action => state.filter === 'all' || action.action === state.filter);
  return `<section class="panel"><div class="list-heading"><h3>每件物品，都说明白</h3><button class="subtle-link" data-command="export-report">导出方案 ${icon('down')}</button></div><div class="filters">${[['all', '全部'], ...Object.entries(actionName)].map(([id, label]) => `<button class="filter-button ${state.filter === id ? 'active' : ''}" data-filter="${id}">${label} ${id === 'all' ? plan.actions.length : plan.actions.filter(action => action.action === id).length}</button>`).join('')}</div>${actions.length ? actions.map(action => {
    const item = state.items.find(item => item.id === action.itemId);
    const locked = item.lock !== 'auto' || state.completed[item.id];
    return `<div class="decision-row"><div class="item-identity"><span class="item-avatar">${categoryEmoji[item.category]}</span><div><b>${E(item.name)}</b><small>${E(item.room)} · ${item.volumeL} 升${item.quantity > 1 ? ` · ${item.quantity} 件一组` : ''}</small></div></div><span class="action-pill ${action.action}">${actionName[action.action]}</span><p class="decision-reason">${E(action.reason)}</p><div class="row-actions"><button class="icon-button ${locked ? 'locked' : ''}" data-lock="${E(item.id)}" aria-label="${E(item.name)}${locked ? '已锁定，点击调整' : '锁定带走'}" title="${locked ? '已锁定，点击调整' : '锁定带走'}">${icon('lock')}</button><button class="icon-button" data-edit="${E(item.id)}" aria-label="编辑${E(item.name)}" title="编辑物品">${icon('edit')}</button></div></div>`;
  }).join('') : '<div class="empty-state"><p>这个方案没有此类物品。</p></div>'}</section>`;
}
function sidePanels() {
  const plan = selectedPlan(), metrics = plan?.metrics;
  const capacity = state.settings.capacityL;
  const kept = metrics?.keptVolumeL || 0;
  const data = taskData();
  const nextTasks = data.tasks.filter(task => !completedTask(task)).slice(0, 3);
  return `<aside class="side-column"><section class="panel panel-pad"><div class="side-title"><h3>新家的空间，刚刚好</h3>${icon('home')}</div><div class="capacity-number number-quiet">${metrics ? volume(kept) : '—'}<small>m³</small><span>/ ${volume(capacity)}</span></div><div class="capacity-track"><div class="capacity-fill" style="width:${capacity ? Math.min(100, kept / capacity * 100) : 0}%"></div></div><div class="capacity-legend"><b>带去新家</b><span>容量上限 ${volume(capacity)} m³</span></div>${metrics ? `<div class="side-divider"></div><div class="mini-metric"><span>少带走的体积</span><b>${volume(metrics.freedVolumeL)} m³</b></div><div class="mini-metric"><span>整组转让意向收入</span><b>¥ ${currency(metrics.resaleIncome)}</b></div><div class="mini-metric"><span>回收处理预计费用</span><b>¥ ${currency(metrics.recycleCost)}</b></div><div class="quote-choice">${icon('truck')}<div><b>${E(plan.transportQuote?.name || '暂无报价')}</b><small>按规划体积 ${volume(metrics.plannedVolumeL)} m³ 选车</small></div><span>¥${currency(metrics.transportCost)}</span></div><div class="mini-metric"><span>预计净支出</span><b>${metrics.netOutlay < 0 ? '−' : ''}¥ ${currency(Math.abs(metrics.netOutlay))}</b></div><p class="side-note">净支出 = 车型报价 + 处理费用 − 意向转让收入。负数为预计结余，未计成交不确定性，也不是已到账收入。</p>` : `<p class="side-note">确认物品并生成可行方案后，会在这里看到体积、车型与支出变化。</p>`}</section><section class="panel panel-pad"><div class="side-title"><h3>把下一步，变成一小步</h3>${icon('calendar')}</div>${data.error ? `<p class="side-note">${E(data.error)}</p>` : nextTasks.length ? nextTasks.map((task, index) => `<div class="next-task"><span>0${index + 1}</span><div><b>${E(task.title)}</b><small>${E(task.dueDate.slice(5).replace('-', '月'))}日前 · ${task.action === 'keep' ? '打包时间自行安排' : `约 ${task.minutes} 分钟`}</small></div></div>`).join('') : `<p class="side-note">${data.tasks.length ? '这份清单的行动已全部完成。' : '选择一个可行方案，行动会按搬家日期整理好。'}</p>`}<button class="secondary-button side-cta" data-view="tasks">打开行动清单 ${icon('arrow')}</button></section><div class="gentle-card">${icon('leaf')}<h3>留住的是需要，不是负担。</h3><p>那些暂时不用的东西，<br>也许能在别处开启下一段故事。</p></div></aside>`;
}
function overviewView() {
  const samples = state.items.some(item => item.origin === 'sample');
  return `<div class="fade-in"><section class="hero"><div><span class="section-eyebrow">A LITTLE LIGHTER, A LITTLE HAPPIER</span><h1>带着刚刚好的东西，<br>去<em>下一站。</em></h1><p>把容量、时间和偏好摆在一起，找到更合适的去留组合。<br>你在意的东西，总有它的位置。</p></div>${heroArt()}</section><div class="scene-controls"><label class="scene-select">体验一个搬家场景<select id="scene-select" aria-label="示例场景"><option value="graduation" ${state.scene === 'graduation' ? 'selected' : ''}>毕业跨城搬家</option><option value="smallhome" ${state.scene === 'smallhome' ? 'selected' : ''}>换到小户型</option><option value="urgent" ${state.scene === 'urgent' ? 'selected' : ''}>三天内急搬</option></select></label><div class="button-row">${samples ? '<span class="sample-pill">含虚构示例数据</span>' : '<span class="tag">我的物品与估计</span>'}<button class="subtle-link" data-command="new-project">开始我的计划 ↗</button></div></div>${state.saveError ? `<div class="inline-warning">${E(state.saveError)}</div>` : ''}${pendingDrafts().length ? `<div class="inline-warning">${pendingDrafts().length} 组草稿还没确认，暂不进入方案。<button class="subtle-link" data-command="show-drafts">去确认 →</button></div>` : ''}${statsCards()}<div class="dashboard-grid"><div class="main-column">${constraintsPanel()}${planCards()}${decisionList()}</div>${sidePanels()}</div></div>`;
}

function inventoryView() {
  const drafts = pendingDrafts();
  const visible = state.items.filter(item => (state.inventoryFilter === 'all' || state.inventoryFilter === 'draft' && !item.confirmed || state.inventoryFilter === 'locked' && (item.lock !== 'auto' || state.completed[item.id])) && `${item.name} ${item.room} ${categoryName(item.category)}`.toLowerCase().includes(state.search.toLowerCase()));
  return `<div class="fade-in"><div class="page-heading"><div><span class="eyebrow">THINGS THAT MAKE A HOME</span><h2>你想带走的，都在这里。</h2><p>先把物品记下来，再确认属于它的空间和下一站。</p></div><div class="button-row"><button class="secondary-button" data-command="paste">${icon('list')}粘贴清单</button><button class="primary-button" data-command="add">${icon('plus')}添加物品</button></div></div><div class="inventory-toolbar"><div class="button-row">${[['all', `全部 ${state.items.length}`], ['draft', `待确认 ${drafts.length}`], ['locked', '已锁定']].map(([id, label]) => `<button class="filter-button ${state.inventoryFilter === id ? 'active' : ''}" data-inventory-filter="${id}">${label}</button>`).join('')}<button class="subtle-link" data-command="ai" ${!drafts.length ? 'disabled' : ''}>${icon('spark')}AI 归类草稿</button></div><input class="search-field" type="search" id="inventory-search" maxlength="100" placeholder="找一件物品或一个房间…" aria-label="搜索物品" value="${E(state.search)}"></div>${drafts.length ? '<div class="inline-warning">草稿中的类别和参考体积只是起点。请打开每件物品，核对整组体积、意向金额与耗时后确认。AI 只建议类别，不会替你估价。</div>' : ''}${visible.length ? `<div class="inventory-grid">${visible.map(item => `<article class="panel inventory-card ${!item.confirmed ? 'draft-card' : ''}"><div class="inventory-card-top"><span class="item-avatar">${categoryEmoji[item.category]}</span><span class="tag ${!item.confirmed ? 'sample-pill' : ''}">${!item.confirmed ? '待确认' : state.completed[item.id] ? '行动已完成' : item.lock !== 'auto' ? `已锁定 · ${actionName[item.lock]}` : categoryName(item.category)}</span></div><h3>${E(item.name)}</h3><p class="inventory-meta">${E(item.room)} · ${item.quantity} 件一组 · ${conditionName[item.condition]}</p><div class="inventory-values"><div><span>整组估计体积</span><b>${item.volumeL} 升</b></div><div><span>整组转让意向价</span><b>${item.resalePrice ? `¥ ${currency(item.resalePrice)}` : '未填写'}</b></div></div>${!item.confirmed ? `<p class="draft-note">${item.origin === 'semantic' ? 'AI 建议类别 · ' : '规则草稿 · '}${E(categoryName(item.category))} · 尚未进入方案</p>` : ''}<div class="inventory-card-footer"><span class="inventory-meta">使用重要性 ${item.priority}/5</span><button class="subtle-link" data-edit="${E(item.id)}">${item.confirmed ? '调整物品' : '检查并确认'} ${icon('arrow')}</button></div></article>`).join('')}</div>` : `<section class="panel"><div class="empty-state">${icon('box')}<h3>${state.search || state.inventoryFilter !== 'all' ? '这里暂时没有符合条件的物品' : '先记一件，计划就开始了'}</h3><p>${state.search ? '试试其他关键词，或切回全部物品。' : '可以一件件添加，也可以粘贴一段物品清单。'}</p><div class="button-row"><button class="primary-button" data-command="paste">粘贴清单</button><button class="secondary-button" data-command="add">添加物品</button></div></div></section>`}<p class="field-help" style="margin-top:20px">共 ${state.items.length}/40 组。每一条按整组处理，体积、金额与耗时无需再乘数量；想拆开处理，可以分成多条。</p></div>`;
}
function tasksView() {
  const data = taskData();
  const done = data.tasks.filter(completedTask).length;
  const percent = data.tasks.length ? done / data.tasks.length * 100 : 0;
  const groups = new Map();
  for (const task of data.tasks) { if (!groups.has(task.dueDate)) groups.set(task.dueDate, []); groups.get(task.dueDate).push(task); }
  return `<div class="fade-in"><div class="page-heading"><div><span class="eyebrow">ONE SMALL STEP AT A TIME</span><h2>下一步，做这一点就好。</h2><p>按“${E(selectedPlan()?.label || '当前')}”方案安排。日期是建议截止时间，不会自动预约或发送提醒。</p></div><button class="secondary-button" data-view="overview">回到方案比较 ${icon('arrow')}</button></div>${data.error ? `<div class="inline-warning">${E(data.error)}<button class="subtle-link" data-view="overview">去调整日期 →</button></div>` : ''}<div class="task-layout"><div>${data.tasks.length ? [...groups].map(([date, tasks]) => `<section class="panel task-group"><div class="task-date-header">${icon('calendar')}<time datetime="${date}">${E(date.replace('-', ' 年 ').replace('-', ' 月 '))} 日前</time><span>${date === todayISO() ? '从今天开始' : `${tasks.length} 项行动`}</span></div>${tasks.map(task => `<div class="task-row ${completedTask(task) ? 'done' : ''}"><input type="checkbox" data-task="${E(task.itemId)}" data-task-action="${task.action}" ${completedTask(task) ? 'checked' : ''} aria-label="完成${E(task.title)}"><div class="task-body"><b>${E(task.title)}</b><p>${task.action === 'keep' ? '打包时核对数量。打包时间不计入闲置处置预算。' : task.action === 'sell' ? `预计处理 ${task.minutes} 分钟，意向价不代表成交。` : task.action === 'donate' ? `预计处理 ${task.minutes} 分钟，提前确认接收与交接方式。` : `预计处理 ${task.minutes} 分钟，实际渠道与费用请自行确认。`}</p>${task.action === 'sell' ? `<button class="subtle-link" data-listing="${E(task.itemId)}">查看转让文案草稿 ↗</button>${completedTask(task) ? `<label class="actual-income">实际到账金额（可选）<input type="number" data-actual="${E(task.itemId)}" min="0" max="100000" step="0.01" placeholder="未记录" value="${Object.hasOwn(state.actualIncome, task.itemId) ? state.actualIncome[task.itemId] : ''}" aria-label="${E(task.title)}实际收入"><span>元</span></label>` : ''}` : ''}</div><span class="action-pill ${task.action}">${actionName[task.action]}</span></div>`).join('')}</section>`).join('') : `<section class="panel"><div class="empty-state">${icon('calendar')}<h3>${state.computing ? '正在等待新方案' : '行动清单，会跟着方案一起出现'}</h3><p>先确认物品、选择可行方案，并填写搬家日期。</p><div class="button-row"><button class="primary-button" data-view="overview">去工作台</button></div></div></section>`}</div><aside class="task-side"><section class="panel panel-pad"><div class="side-title"><h3>每完成一项，就近一点</h3>${icon('check')}</div><div class="progress-big">${done}<small>/ ${data.tasks.length} 项</small></div><div class="capacity-track"><div class="capacity-fill" style="width:${percent}%"></div></div><div class="mini-metric"><span>已记录实际转让收入</span><b>¥ ${currency(actualTotal())}</b></div><p class="side-note">实际收入仅计算你已完成、并填写到账金额的转让记录，与方案意向收入分开。</p><div class="side-divider"></div><div class="task-tools"><button class="secondary-button" data-command="export-calendar" ${!data.tasks.length || state.computing ? 'disabled' : ''}>${icon('calendar')}导出未完成行动日历</button><button class="secondary-button" data-command="export-report" ${!state.result || state.computing ? 'disabled' : ''}>${icon('down')}导出 Markdown 方案</button><button class="secondary-button" data-command="storage">${icon('shield')}保存与备份</button></div><p class="side-note">标记完成后会固定该物品去向。需要修改时，先取消完成，再编辑物品。</p></section><div class="gentle-card">${icon('heart')}<h3>你不需要一次做完。</h3><p>如果来不及转让，回到物品清单，调整去向和处理时间，再看看更轻松的方案。</p></div></aside></div></div>`;
}
function aboutView() {
  return `<div class="fade-in"><div class="page-heading"><div><span class="eyebrow">A CONSUMER PRODUCT, WITH A REAL DECISION</span><h2>把搬家，做成一个能完成的决定。</h2><p>轻迁把物品、现实限制和执行进度放在同一个工作空间。</p></div><a class="secondary-button" href="https://github.com/xf-png/movelite-ai" target="_blank" rel="noopener noreferrer">${icon('github')}查看源码与说明</a></div><div class="about-grid"><section class="panel about-card"><span class="about-badge">${icon('home')}为阶段性生活变化而做</span><h3>从“我有什么”，走到“这次该怎么带”</h3><p>毕业跨城、换小户型或临时急搬，都需要在有限空间和时间里作取舍。你可以确认物品、填写报价、锁定决定，比较多留一点、少花一点、快一点三种倾向。</p><div class="flow-line"><b>物品草稿</b><span>→</span><b>人工确认</b><span>→</span><b>方案比较</b><span>→</span><b>执行复盘</b></div></section><section class="panel about-card"><span class="about-badge">${icon('spark')}AI 做它擅长的那一步</span><h3>理解物品描述，建议合适类别</h3><p>中文语义模型在浏览器中计算，用来理解描述与类别之间的关系。类别不确定时保留“其他”，不会编造体积、转让价格或市场行情。去留方案依据你确认的输入计算。</p><p style="margin-top:12px">首次 AI 约下载 47 MB，模型与运行组件由本站提供；完成后可复用浏览器缓存。</p></section><section class="panel about-card"><h3>业务模式：先验证一次搬家的价值</h3><p>当前应用免费体验。待验证的商业假设是按搬家项目一次付费，例如 ¥9.9 / ¥19.9 测试多情景与交接报告的付费意愿；当前没有真实付费、收入或用户规模数据。</p><p style="margin-top:12px">需要先观察真实搬家用户能否生成可行方案、如何修改建议，以及是否完成行动，再决定是否值得收费。</p><a class="subtle-link" style="margin-top:16px" href="https://github.com/xf-png/movelite-ai/blob/main/docs/商业模式与竞品分析.md" target="_blank" rel="noopener noreferrer">查看竞品对比与验证计划 ↗</a></section><section class="panel about-card"><h3>可解释，也能由你改写</h3><ul><li>最多 40 组物品；容量不超过 10 m³，处理时间不超过 12 小时。</li><li>按 10 升、5 分钟保守分档；超限会明确提示无可行方案。</li><li>搬运费采用你填写的车型固定报价，转让收入只是意向估计。</li><li>已完成行动固定去向；预计金额与实际到账分开记录。</li></ul></section><section class="panel about-card about-wide"><h3>你的物品，留在你的设备</h3><p>默认仅保存在当前页面。你可以主动开启浏览器本地保存，或导出 JSON 备份、Markdown 方案与日历文件。规则整理的草稿和 AI 建议都需人工确认。应用不会自动发布二手信息、联系商家、预订服务或收取费用。</p><div class="button-row" style="margin-top:18px"><button class="secondary-button" data-command="storage">${icon('shield')}管理保存与备份</button><button class="secondary-button" data-command="ai">${icon('spark')}试试 AI 辅助归类</button></div></section></div></div>`;
}

function openItem(id) {
  if (!id && state.items.length >= 40) { toast('最多支持 40 组物品，可先合并同类或删除不再需要的条目。'); return; }
  const old = state.items.find(item => item.id === id);
  const item = old || { id: '', name: '', category: 'other', room: '未分组', quantity: 1, volumeL: '', priority: 3, sentiment: 0, resalePrice: 0, saleMinutes: 45, donateMinutes: 15, recycleMinutes: 10, recycleFee: 0, condition: 'good', lock: 'auto', confirmed: false, notes: '', origin: 'manual' };
  const completed = Boolean(state.completed[item.id]);
  const select = (name, entries, value, extra = '') => `<select name="${name}" id="item-${name}" ${extra}>${entries.map(([id, label]) => `<option value="${id}" ${id === String(value) ? 'selected' : ''}>${E(label)}</option>`).join('')}</select>`;
  const numeric = (name, label, min, max, step = 1) => `<label class="field"><span>${label}</span><input id="item-${name}" name="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${item[name]}" required></label>`;
  $('#item-dialog-title').textContent = old ? old.confirmed ? '调整这件物品' : '检查草稿，确认再出发' : '添加一件想带走的东西';
  $('#item-form').dataset.id = item.id;
  $('#item-form').innerHTML = `${!item.confirmed && old ? `<div class="inline-warning">这是${item.origin === 'semantic' ? 'AI 辅助归类后的' : '规则整理的'}草稿。体积可能是参考值，请按实际情况检查；金额为你的意向估计。</div>` : ''}<div class="form-grid"><label class="field full"><span>物品名称</span><input id="item-name" name="name" maxlength="100" required value="${E(item.name)}" placeholder="例如：人体工学椅"></label><label class="field"><span>物品类别</span>${select('category', CATEGORIES.map(category => [category.id, category.label]), item.category)}</label><label class="field"><span>放在哪个房间</span><input name="room" id="item-room" maxlength="40" value="${E(item.room)}" required></label>${numeric('quantity', '整组件数', 1, 99)}${numeric('volumeL', '整组总体积（升）', 1, 10000, 0.1)}<label class="field"><span>使用重要性</span>${select('priority', [['1', '1 · 很少用'], ['2', '2 · 偶尔用'], ['3', '3 · 有时用'], ['4', '4 · 经常用'], ['5', '5 · 非常重要']], item.priority)}</label><label class="field"><span>情感分量</span>${select('sentiment', [['0', '0 · 没有特别回忆'], ['1', '1 · 有一点在意'], ['2', '2 · 挺舍不得'], ['3', '3 · 对我很重要']], item.sentiment)}</label><label class="field"><span>物品状态</span>${select('condition', Object.entries(conditionName), item.condition)}</label><label class="field"><span>我的去留决定</span>${select('lock', [['auto', '让方案建议'], ['keep', '必须带走'], ['sell', '只考虑转让'], ['donate', '决定转赠'], ['recycle', '决定回收处理']], completed ? state.completed[item.id] : item.lock, completed ? 'disabled' : '')}</label><p class="field-help full" style="margin-top:0">“非常重要”仍是可比较的偏好。一定要带的东西，请选择“必须带走”。${completed ? '这项行动已完成，需先取消完成才能修改去向。' : ''}</p><div class="form-section">转让与处理估计 · 全部按整组填写</div>${numeric('resalePrice', '整组转让意向金额（元）', 0, 100000, 0.01)}${numeric('saleMinutes', '转让沟通与交接（分钟）', 0, 720)}${numeric('donateMinutes', '转赠交接（分钟）', 0, 720)}${numeric('recycleMinutes', '回收处理（分钟）', 0, 720)}${numeric('recycleFee', '整组处理费用（元）', 0, 10000, 0.01)}<p class="field-help">没有填写转让金额时，方案不会建议转让；损坏物品不会建议转赠或普通转让。</p><label class="field full"><span>备注（可选）</span><textarea id="item-notes" name="notes" rows="2" maxlength="500">${E(item.notes)}</textarea></label></div><label class="confirm-choice"><input type="checkbox" name="confirmed" id="item-confirmed" ${item.confirmed ? 'checked' : ''} ${completed ? 'disabled' : ''}><span>我已确认整组体积、意向金额与耗时，允许这组物品进入方案。</span></label><p class="inline-error" id="item-error" role="alert"></p><div class="dialog-actions">${old ? `<button class="danger-button" type="button" data-delete="${E(item.id)}">删除此条</button>` : ''}<button class="secondary-button" type="button" data-close>取消</button><button class="primary-button" type="submit">${old && !old.confirmed ? '保存并更新方案' : '保存物品'}</button></div>`;
  $('#item-dialog').showModal();
  $('#item-name').focus();
}
function openPaste() { $('#paste-error').textContent = ''; $('#paste-dialog').showModal(); $('#paste-text').focus(); }
function updateAI() {
  const drafts = pendingDrafts().length;
  $('#ai-draft-info').textContent = drafts ? `当前有 ${drafts} 组待确认物品。分类后仍需你逐项确认。` : '先添加或粘贴待确认物品，再使用 AI 辅助归类。';
  $('#enable-ai').disabled = !drafts || state.aiBusy;
  $('#enable-ai').innerHTML = `${icon('spark')}${state.embedder ? '归类待确认物品' : '启用并归类待确认物品'}`;
  $('#ai-progress').hidden = !state.aiBusy;
  updateChrome();
}
function openAI() { $('#ai-error').textContent = ''; updateAI(); $('#ai-dialog').showModal(); }
function updateStorage() {
  $('#persist-toggle').checked = state.persist;
  $('#storage-status').textContent = state.saveError || (state.persist ? `当前计划保存在此浏览器${state.savedAt ? `，最近保存于 ${state.savedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}。更换设备前可导出备份。` : '尚未开启本地保存。刷新后会重新显示示例计划。');
}
function openStorage() { updateStorage(); $('#storage-dialog').showModal(); }
function download(name, text, type) { const url = URL.createObjectURL(new Blob([text], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function exportReport() {
  if (!state.result || state.computing) { toast('请先等待方案计算完成。'); return; }
  try { const text = createMarkdownReport(state.result, state.selectedPlan, state.items, state.settings) + `\n## 执行记录\n\n已标记完成 ${Object.keys(state.completed).length} 项。实际已记录转让收入：${currency(actualTotal())} 元。\n`; download(`MoveLite-方案-${state.settings.moveDate || todayISO()}.md`, text, 'text/markdown;charset=utf-8'); toast('方案已导出为 Markdown。'); } catch (error) { toast(error.message); }
}
function exportCalendar() {
  const data = taskData();
  if (data.error) { toast(data.error); return; }
  const tasks = data.tasks.filter(task => !completedTask(task));
  if (!tasks.length) { toast('目前没有需要导出的未完成行动。'); return; }
  try { download(`MoveLite-行动-${state.settings.moveDate}.ics`, createCalendar(tasks), 'text/calendar;charset=utf-8'); toast('日历文件已导出，可自行导入日历应用。'); } catch (error) { toast(error.message); }
}

function replaceProject(data, scene) {
  if (state.items.length && !window.confirm('这会替换当前计划。需要保留时，请先在“保存与备份”导出。确定继续吗？')) return false;
  remember(); Object.assign(state, data); state.scene = scene; state.selectedPlan = 'keep'; state.filter = 'all'; state.inventoryFilter = 'all'; state.search = ''; changed(); return true;
}
function cancelAI() {
  state.aiAbort?.abort(); unloadLocalModel(); state.embedder = null;
  $('#ai-progress-text').textContent = '已取消，可以稍后重试。';
}
async function classifyDrafts() {
  const drafts = pendingDrafts();
  if (!drafts.length || state.aiBusy) return;
  state.aiBusy = true; state.aiAbort = new AbortController();
  const signal = state.aiAbort.signal;
  $('#ai-error').textContent = ''; updateAI();
  const progress = event => {
    if (signal.aborted) return;
    $('#ai-progress-text').textContent = event.status === 'classifying' ? `正在整理类别 ${event.completed}/${event.total}` : event.message || '正在加载本站模型…';
    if (Number.isFinite(event.progress)) $('#ai-progress-bar').value = Math.max(0, Math.min(100, event.progress)); else $('#ai-progress-bar').removeAttribute('value');
  };
  try {
    const embedder = state.embedder || await loadLocalModel(progress, { signal });
    state.embedder = embedder;
    const classified = await categorizeWithEmbeddings(drafts, embedder, { signal, onProgress: progress });
    if (signal.aborted) return;
    const byId = new Map(classified.map(item => [item.id, item]));
    remember(); state.items = state.items.map(item => byId.has(item.id) && !item.confirmed ? byId.get(item.id) : item);
    state.view = 'inventory'; state.inventoryFilter = 'draft'; changed();
    state.aiBusy = false; $('#ai-dialog').close();
    toast(`已建议 ${classified.length} 组物品的类别；不确定项保留“其他”，请逐项确认。`);
  } catch (error) {
    if (signal.aborted || error.name === 'AbortError') $('#ai-error').textContent = '已取消。你仍可手动确认物品、生成方案。';
    else { $('#ai-error').textContent = error.message || '模型未完成加载，请检查网络后重试。'; unloadLocalModel(); state.embedder = null; }
  } finally { state.aiBusy = false; state.aiAbort = null; updateAI(); }
}

document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]');
  if (close) { close.closest('dialog')?.close(); return; }
  const button = event.target.closest('button,a');
  if (!button || button.disabled) return;
  if (button.dataset.view) { changeView(button.dataset.view); return; }
  if (button.dataset.plan) { state.selectedPlan = button.dataset.plan; state.filter = 'all'; render(); return; }
  if (button.dataset.filter) { state.filter = button.dataset.filter; render(); return; }
  if (button.dataset.inventoryFilter) { state.inventoryFilter = button.dataset.inventoryFilter; render(); return; }
  if (button.dataset.edit) { openItem(button.dataset.edit); return; }
  if (button.dataset.lock) {
    const item = state.items.find(item => item.id === button.dataset.lock);
    if (state.completed[item.id]) { toast('这项行动已完成。请先在行动清单取消完成，再调整去向。'); return; }
    remember(); item.lock = item.lock === 'auto' ? 'keep' : 'auto'; changed(); toast(item.lock === 'keep' ? '已锁定带走。' : '已解除锁定，将重新比较。'); return;
  }
  if (button.dataset.delete) {
    remember(); const id = button.dataset.delete; state.items = state.items.filter(item => item.id !== id); delete state.completed[id]; delete state.actualIncome[id]; $('#item-dialog').close(); changed(); toast('物品已移除，可以使用顶部撤销按钮恢复。'); return;
  }
  if (button.dataset.listing) {
    try { $('#listing-text').value = createListing(state.items.find(item => item.id === button.dataset.listing), state.settings.moveDate); $('#listing-dialog').showModal(); } catch (error) { toast(error.message); }
    return;
  }
  switch (button.dataset.command) {
    case 'add': openItem(); break;
    case 'paste': openPaste(); break;
    case 'ai': openAI(); break;
    case 'storage': openStorage(); break;
    case 'export-report': exportReport(); break;
    case 'export-calendar': exportCalendar(); break;
    case 'recompute': scheduleSolve(); break;
    case 'show-drafts': state.inventoryFilter = 'draft'; changeView('inventory'); break;
    case 'new-project': {
      const empty = { items: [], settings: { ...DEFAULT_SETTINGS, moveDate: daysFromToday(14), tiers: DEFAULT_SETTINGS.tiers.map(tier => ({ ...tier })) }, completed: {}, actualIncome: {} };
      if (replaceProject(empty, '')) { changeView('inventory'); toast('新的搬家计划已开始。先添加自己的物品吧。'); }
      break;
    }
  }
});

document.addEventListener('input', event => {
  const input = event.target;
  if (input.id === 'inventory-search') { state.search = input.value; render(); }
  if (input.matches('input[type=range][data-setting]')) {
    const label = input.closest('.field').querySelector('.range-value');
    label.textContent = input.dataset.setting === 'capacityL' ? `${volume(Number(input.value))} m³` : `${hours(Number(input.value))} 小时`;
  }
});
document.addEventListener('toggle', event => { if (event.target.matches?.('.quote-details')) state.quotesOpen = event.target.open; }, true);
document.addEventListener('change', event => {
  const input = event.target;
  if (input.dataset.setting || input.dataset.tier !== undefined) {
    try {
      const next = { ...state.settings, tiers: state.settings.tiers.map(tier => ({ ...tier })) };
      if (input.dataset.setting) next[input.dataset.setting] = input.dataset.setting === 'moveDate' ? input.value : Number(input.value);
      else next.tiers[Number(input.dataset.tier)][input.dataset.tierField] = Number(input.value) * (input.dataset.tierField === 'capacityL' ? 1000 : 1);
      const valid = validateSettings(next); remember(); state.settings = valid; changed();
    } catch (error) { toast(error.message); render(); }
  }
  if (input.id === 'scene-select') { const scene = input.value; if (!replaceProject(createDemo(scene), scene)) render(); }
  if (input.dataset.task) {
    const item = state.items.find(item => item.id === input.dataset.task);
    if (!item || state.computing) { render(); return; }
    if (!input.checked && Object.hasOwn(state.actualIncome, item.id) && !window.confirm('取消完成也会移除这条实际到账记录。可以用顶部撤销按钮恢复。确定继续吗？')) { render(); return; }
    remember();
    if (input.checked) { state.completed[item.id] = input.dataset.taskAction; item.lock = input.dataset.taskAction; }
    else { delete state.completed[item.id]; delete state.actualIncome[item.id]; }
    changed();
    toast(input.checked ? '已记为完成，并固定这件物品的去向。' : '已取消完成。需要改去向时，可编辑物品解除锁定。');
  }
  if (input.dataset.actual) {
    const id = input.dataset.actual;
    if (state.completed[id] !== 'sell') return;
    const value = input.value === '' ? null : Number(input.value);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100000)) { toast('请填写 0 至 100000 元的实际到账金额。'); render(); return; }
    remember(); if (value === null) delete state.actualIncome[id]; else state.actualIncome[id] = Math.round(value * 100) / 100;
    changed({ recompute: false });
  }
});

$('#item-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const old = state.items.find(item => item.id === event.currentTarget.dataset.id);
    const id = old?.id || (globalThis.crypto?.randomUUID?.() ?? `item-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const input = { ...fields, id, confirmed: old && state.completed[id] ? true : fields.confirmed === 'on', lock: state.completed[id] || fields.lock || 'auto', origin: old?.origin === 'semantic' && old.category === fields.category ? 'semantic' : 'manual' };
    for (const key of ['quantity', 'volumeL', 'priority', 'sentiment', 'resalePrice', 'saleMinutes', 'donateMinutes', 'recycleMinutes', 'recycleFee']) input[key] = Number(input[key]);
    const item = normalizeItem(input);
    if (!old && state.items.length >= 40) throw new Error('最多支持 40 组物品。');
    const nextItems = old ? state.items.map(existing => existing.id === id ? item : existing) : [...state.items, item];
    serializeWorkspace({ ...workspace(), items: nextItems });
    remember(); state.items = nextItems;
    $('#item-dialog').close(); changed(); toast(item.confirmed ? '物品已确认，方案会重新比较。' : '已存为待确认草稿，暂不进入方案。');
  } catch (error) { $('#item-error').textContent = error.message; }
});
$('#paste-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const items = parseInventory($('#paste-text').value);
    if (!items.length) throw new Error('先写下一件物品，再生成草稿。');
    if (state.items.length + items.length > 40) throw new Error(`当前已有 ${state.items.length} 组，再添加 ${items.length} 组会超过 40 组；请减少内容或先清理清单。`);
    const ids = new Set(state.items.map(item => item.id));
    for (const item of items) { if (ids.has(item.id)) item.id = globalThis.crypto?.randomUUID?.() ?? `item-${Date.now()}-${Math.random().toString(36).slice(2)}`; ids.add(item.id); }
    remember(); state.items.push(...items); state.view = 'inventory'; state.inventoryFilter = 'draft'; state.search = '';
    $('#paste-dialog').close(); $('#paste-text').value = ''; changed(); toast(`已整理 ${items.length} 组草稿，确认后再进入方案。`);
  } catch (error) { $('#paste-error').textContent = error.message; }
});

$('#header-add').addEventListener('click', () => openItem());
$('#sidebar-paste').addEventListener('click', openPaste);
$('#open-ai').addEventListener('click', openAI);
$('#enable-ai').addEventListener('click', classifyDrafts);
$('#cancel-ai').addEventListener('click', cancelAI);
$('#ai-dialog').addEventListener('close', () => { if (state.aiBusy) cancelAI(); });
$('#open-storage').addEventListener('click', openStorage);
$('#undo-button').addEventListener('click', () => {
  if (!state.undo.length) return;
  try { Object.assign(state, parseWorkspaceBackup(state.undo.pop())); changed(); toast('已撤销最近一次修改。'); } catch (error) { toast(error.message); }
});
$('#persist-toggle').addEventListener('change', event => {
  if (event.target.checked) {
    try { const text = serializeWorkspace(workspace()); localStorage.setItem(storageKey, text); localStorage.setItem(preferenceKey, 'true'); state.persist = true; state.savedAt = new Date(); state.saveError = ''; }
    catch { state.persist = false; state.saveError = '无法开启本地保存。当前页面仍可使用，请导出备份。'; }
  } else {
    try { localStorage.removeItem(storageKey); localStorage.removeItem(preferenceKey); state.persist = false; state.savedAt = null; state.saveError = ''; }
    catch { state.saveError = '未能移除浏览器保存，请在浏览器站点设置中清除数据。'; }
  }
  updateStorage(); updateChrome();
});
$('#export-backup').addEventListener('click', () => { try { download(`MoveLite-备份-${todayISO()}.json`, serializeWorkspace(workspace()), 'application/json;charset=utf-8'); toast('已导出备份，包含你的物品文字与金额。'); } catch (error) { toast(error.message); } });
$('#restore-backup').addEventListener('click', () => $('#backup-file').click());
$('#backup-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('备份最大 1 MB。');
    const data = parseWorkspaceBackup(await file.text());
    if (!window.confirm('恢复会替换当前计划、完成状态和收入记录。确定继续吗？')) return;
    remember(); Object.assign(state, data); state.selectedPlan = 'keep'; state.scene = ''; state.filter = 'all'; state.inventoryFilter = 'all'; state.search = ''; $('#storage-dialog').close(); changed(); toast('计划已恢复，正在重新计算。');
  } catch (error) { toast(error.message); }
  finally { event.target.value = ''; }
});
$('#copy-listing').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#listing-text').value); toast('文案已复制，发布前请补充并核对细节。'); }
  catch { $('#listing-text').focus(); $('#listing-text').select(); toast('请手动复制已选中的文案。'); }
});

try {
  if (localStorage.getItem(preferenceKey) === 'true') {
    const raw = localStorage.getItem(storageKey);
    if (raw) { Object.assign(state, parseWorkspaceBackup(raw)); state.persist = true; state.scene = ''; }
    else { state.saveError = '找到保存设置，但没有可恢复的计划。可导入备份；当前展示示例。'; }
  }
} catch { state.saveError = '无法读取本地计划，当前展示示例。可以在保存与备份中恢复 JSON。'; }
scheduleSolve();
