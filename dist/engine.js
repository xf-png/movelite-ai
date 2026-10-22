/**
 * MoveLite's local decision engine. No DOM, network calls or model dependency.
 * Values, timings and quotes are user estimates, never market valuations.
 * Each row is an indivisible group: quantity is descriptive, all numeric values
 * already describe the complete group and must not be multiplied again.
 */
export const CATEGORIES = Object.freeze([
  { id: 'furniture', label: '家具', description: '桌子、椅子、沙发、床、柜子等家具。' },
  { id: 'electronics', label: '电器数码', description: '电脑、显示器、电视、音响和生活电器。' },
  { id: 'kitchen', label: '厨房用品', description: '锅具、餐具、杯子、厨具和厨房小物。' },
  { id: 'clothing', label: '衣物寝具', description: '衣服、鞋子、包、被褥和寝具。' },
  { id: 'books', label: '书籍资料', description: '书籍、笔记、教材、纸质资料和文具。' },
  { id: 'sports', label: '运动户外', description: '体育器材和户外装备，例如羽毛球拍、网球拍、篮球、哑铃、瑜伽垫、露营帐篷、睡袋和登山包。' },
  { id: 'sentimental', label: '纪念物品', description: '照片、纪念品、礼物和承载回忆的收藏。' },
  { id: 'other', label: '其他', description: '尚未归类的个人物品。' },
].map(Object.freeze));

export const LIMITS = Object.freeze({ items: 40, capacityL: 10000, timeMinutes: 720 });
export const QUANTIZATION = Object.freeze({ volumeL: 10, timeMinutes: 5 });
export const DEFAULT_SETTINGS = Object.freeze({
  capacityL: 1800,
  timeMinutes: 300,
  moveDate: '',
  tiers: Object.freeze([
    Object.freeze({ id: 'small', name: '小型车', capacityL: 1000, price: 160 }),
    Object.freeze({ id: 'medium', name: '中型车', capacityL: 2000, price: 260 }),
    Object.freeze({ id: 'large', name: '大型车', capacityL: 4000, price: 450 }),
  ]),
});

// Ordinal preference weights, not learned accuracy, money or calibrated utility.
// Monetary inputs are compared in cents to keep the DP's score deterministic.
export const OBJECTIVES = Object.freeze([
  Object.freeze({ id: 'keep', label: '多留一点', keepWeight: 250, sentimentWeight: 350, moneyWeight: 1, timeWeight: 1, donationBonus: 30, recyclingPenalty: 10, releaseSentimentWeight: 30 }),
  Object.freeze({ id: 'budget', label: '少花一点', keepWeight: 100, sentimentWeight: 200, moneyWeight: 3, timeWeight: 1, donationBonus: 20, recyclingPenalty: 10, releaseSentimentWeight: 30 }),
  Object.freeze({ id: 'quick', label: '快一点', keepWeight: 120, sentimentWeight: 200, moneyWeight: 1, timeWeight: 8, donationBonus: 40, recyclingPenalty: 20, releaseSentimentWeight: 30 }),
]);

const ACTIONS = Object.freeze(['keep', 'sell', 'donate', 'recycle']);
const ACTION_LABELS = Object.freeze({ keep: '带走', sell: '转让', donate: '转赠', recycle: '回收处理' });
const CATEGORY_IDS = new Set(CATEGORIES.map(category => category.id));
const CONDITIONS = new Set(['good', 'worn', 'broken']);
const ORIGINS = new Set(['manual', 'rule', 'semantic', 'sample']);
const LOCKS = new Set(['auto', ...ACTIONS]);
const cents = value => Math.round(value * 100);
const money = value => Math.round(value * 100) / 100;
const sum = values => values.reduce((total, value) => total + value, 0);

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label}必须是对象。`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label}格式不正确。`);
  return value;
}

function text(value, label, max, fallback = '') {
  if (value === undefined) value = fallback;
  if (typeof value !== 'string') throw new TypeError(`${label}必须是文字。`);
  const normalized = value.trim();
  if (normalized.length > max) throw new RangeError(`${label}最多 ${max} 个字符。`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) throw new TypeError(`${label}含有无效控制字符。`);
  return normalized;
}

function number(value, label, min, max, { fallback, integer = false } = {}) {
  if (value === undefined && fallback !== undefined) value = fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label}必须是有限数字。`);
  if (value < min || value > max) throw new RangeError(`${label}应在 ${min} 至 ${max} 之间。`);
  if (integer && !Number.isInteger(value)) throw new TypeError(`${label}必须是整数。`);
  return value;
}

function enumeration(value, valid, label, fallback) {
  if (value === undefined) value = fallback;
  if (!valid.has(value)) throw new TypeError(`${label}不在支持的选项中。`);
  return value;
}

/** Return only trusted schema fields; computed scores or foreign metadata drop. */
export function normalizeItem(input) {
  const item = plainObject(input, '物品');
  const id = text(item.id, '物品编号', 80);
  const name = text(item.name, '物品名称', 100);
  if (!id || !name) throw new TypeError('物品编号和名称不能为空。');
  if (item.confirmed !== undefined && typeof item.confirmed !== 'boolean') throw new TypeError('确认状态必须是布尔值。');
  return {
    id,
    name,
    category: enumeration(item.category, CATEGORY_IDS, '物品类别', 'other'),
    room: text(item.room, '房间', 40, '未分组'),
    quantity: number(item.quantity, '整组数量', 1, 99, { fallback: 1, integer: true }),
    volumeL: number(item.volumeL, '整组体积（升）', 1, LIMITS.capacityL),
    priority: number(item.priority, '使用重要性', 1, 5, { fallback: 3, integer: true }),
    sentiment: number(item.sentiment, '情感分量', 0, 3, { fallback: 0, integer: true }),
    resalePrice: money(number(item.resalePrice, '整组转让金额', 0, 100000, { fallback: 0 })),
    saleMinutes: number(item.saleMinutes, '转让耗时', 0, LIMITS.timeMinutes, { fallback: 45, integer: true }),
    donateMinutes: number(item.donateMinutes, '转赠耗时', 0, LIMITS.timeMinutes, { fallback: 15, integer: true }),
    recycleMinutes: number(item.recycleMinutes, '处理耗时', 0, LIMITS.timeMinutes, { fallback: 10, integer: true }),
    recycleFee: money(number(item.recycleFee, '整组处理费用', 0, 10000, { fallback: 0 })),
    condition: enumeration(item.condition, CONDITIONS, '物品状态', 'good'),
    lock: enumeration(item.lock, LOCKS, '锁定决定', 'auto'),
    confirmed: item.confirmed ?? false,
    notes: text(item.notes, '备注', 500),
    origin: enumeration(item.origin, ORIGINS, '录入来源', 'manual'),
  };
}

function validDate(value) {
  if (value === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function normalizeTiers(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) throw new TypeError('请填写 1 至 8 档车型容量和报价。');
  const seen = new Set();
  return input.map((raw, index) => {
    const tier = plainObject(raw, '车型报价');
    const id = text(tier.id, '车型编号', 40, `tier-${index + 1}`);
    const name = text(tier.name, '车型名称', 40, `车型 ${index + 1}`);
    if (!id || !name || seen.has(id)) throw new TypeError('车型编号和名称不能为空，编号不能重复。');
    seen.add(id);
    return {
      id,
      name,
      capacityL: number(tier.capacityL, '车型容量（升）', 1, LIMITS.capacityL),
      price: money(number(tier.price, '车型报价', 0, 100000)),
    };
  });
}

export function validateSettings(input = DEFAULT_SETTINGS) {
  const settings = plainObject(input, '搬家设置');
  const moveDate = text(settings.moveDate, '搬家日期', 10);
  if (!validDate(moveDate)) throw new TypeError('请填写真实有效的搬家日期（YYYY-MM-DD）。');
  return {
    capacityL: number(settings.capacityL, '可带走容量（升）', 0, LIMITS.capacityL, { fallback: DEFAULT_SETTINGS.capacityL }),
    timeMinutes: number(settings.timeMinutes, '处置可用时间', 0, LIMITS.timeMinutes, { fallback: DEFAULT_SETTINGS.timeMinutes, integer: true }),
    moveDate,
    tiers: normalizeTiers(settings.tiers ?? DEFAULT_SETTINGS.tiers),
  };
}

/** Fixed quote by vehicle capacity, not a proportional estimate per item. */
export function getTransportQuote(volumeL, tiers = DEFAULT_SETTINGS.tiers) {
  number(volumeL, '规划体积', 0, LIMITS.items * LIMITS.capacityL);
  if (volumeL === 0) return { id: 'none', name: '无需搬运', capacityL: 0, price: 0 };
  let selected = null;
  for (const tier of normalizeTiers(tiers)) {
    if (tier.capacityL < volumeL) continue;
    if (!selected || tier.price < selected.price || (tier.price === selected.price && tier.capacityL < selected.capacityL)) selected = tier;
  }
  return selected ? { ...selected } : null;
}

export function availableActions(rawItem) {
  const item = normalizeItem(rawItem);
  return ACTIONS.filter(action => action === 'keep' || action === 'recycle' || (item.condition !== 'broken' && (action === 'donate' || item.resalePrice > 0)));
}

function actionTime(item, action) {
  return action === 'keep' ? 0 : item[action === 'sell' ? 'saleMinutes' : action === 'donate' ? 'donateMinutes' : 'recycleMinutes'];
}

/** Public objective function permits independent exhaustive correctness checks. */
export function evaluateAction(rawItem, action, objectiveId) {
  const item = normalizeItem(rawItem);
  const objective = OBJECTIVES.find(option => option.id === objectiveId);
  if (!objective) throw new TypeError('不支持的方案倾向。');
  if (!availableActions(item).includes(action)) throw new TypeError('此物品不能使用该处理方式。');
  if (action === 'keep') return (item.priority * objective.keepWeight + item.sentiment * objective.sentimentWeight) * 100;
  const releasePenalty = item.sentiment * objective.releaseSentimentWeight * 100;
  const timePenalty = actionTime(item, action) * objective.timeWeight * 100;
  if (action === 'sell') return cents(item.resalePrice) * objective.moneyWeight - timePenalty - releasePenalty;
  if (action === 'donate') return objective.donationBonus * 100 - timePenalty - releasePenalty;
  return -objective.recyclingPenalty * 100 - timePenalty - releasePenalty - cents(item.recycleFee) * objective.moneyWeight;
}

function reasonFor(item, action, objective) {
  const lock = item.lock !== 'auto' ? `遵守你锁定的“${ACTION_LABELS[action]}”。` : '';
  const heading = `${lock}“${objective.label}”下的建议：`;
  if (action === 'keep') return `${heading}带走占用 ${item.volumeL} 升；你填写的使用重要性 ${item.priority}/5，情感分量 ${item.sentiment}/3。`;
  if (action === 'sell') return `${heading}按你填写的整组金额预计转让 ¥${item.resalePrice}，处理约 ${item.saleMinutes} 分钟，释放 ${item.volumeL} 升；不代表已成交。`;
  if (action === 'donate') return `${heading}按你填写的耗时约 ${item.donateMinutes} 分钟，释放 ${item.volumeL} 升；具体接收方式需自行安排。`;
  return `${heading}按你填写的耗时约 ${item.recycleMinutes} 分钟、处理费用 ¥${item.recycleFee}，释放 ${item.volumeL} 升。`;
}

function impossiblePlan(objective, reason) {
  return { id: objective.id, label: objective.label, feasible: false, reason, actions: [], metrics: null, transportQuote: null, score: null };
}

function preflight(items, settings, capacityUnits, timeUnits) {
  let lockedVolumeUnits = 0;
  let lockedTimeUnits = 0;
  for (const item of items) {
    if (item.lock === 'auto') continue;
    if (!availableActions(item).includes(item.lock)) {
      if (item.condition === 'broken') return `“${item.name}”标记为损坏，不能锁定为${ACTION_LABELS[item.lock]}；请修改状态或锁定决定。`;
      return `“${item.name}”锁定转让，但整组转让金额未填写（须大于 0）；请先确认金额或修改决定。`;
    }
    if (item.lock === 'keep') lockedVolumeUnits += Math.ceil(item.volumeL / QUANTIZATION.volumeL);
    else lockedTimeUnits += Math.ceil(actionTime(item, item.lock) / QUANTIZATION.timeMinutes);
  }
  if (lockedVolumeUnits > capacityUnits) return `锁定带走的物品按保守分档需要 ${lockedVolumeUnits * QUANTIZATION.volumeL} 升，超过当前容量 ${settings.capacityL} 升；请增加容量或调整锁定物品。`;
  if (lockedTimeUnits > timeUnits) return `锁定处理的物品按保守分档需要 ${lockedTimeUnits * QUANTIZATION.timeMinutes} 分钟，超过可用时间 ${settings.timeMinutes} 分钟；请增加时间或调整锁定决定。`;
  if (!getTransportQuote(lockedVolumeUnits * QUANTIZATION.volumeL, settings.tiers)) return '锁定带走的物品超过已填写车型的容量，无法引用有效报价；请补充车型报价或调整锁定物品。';
  return '';
}

function buildMetrics(items, actionCodes, transportQuote, plannedVolumeL, plannedHandlingMinutes) {
  let keptVolumeL = 0, handlingMinutes = 0, resaleCents = 0, recycleCents = 0, keptPriority = 0;
  const counts = { keepCount: 0, sellCount: 0, donateCount: 0, recycleCount: 0 };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const action = ACTIONS[actionCodes[index]];
    counts[`${action}Count`]++;
    if (action === 'keep') { keptVolumeL += item.volumeL; keptPriority += item.priority; }
    else handlingMinutes += actionTime(item, action);
    if (action === 'sell') resaleCents += cents(item.resalePrice);
    if (action === 'recycle') recycleCents += cents(item.recycleFee);
  }
  return {
    keptVolumeL: money(keptVolumeL),
    freedVolumeL: money(sum(items.map(item => item.volumeL)) - keptVolumeL),
    handlingMinutes,
    plannedVolumeL,
    plannedHandlingMinutes,
    resaleIncome: resaleCents / 100,
    transportCost: transportQuote.price,
    recycleCost: recycleCents / 100,
    netOutlay: (cents(transportQuote.price) + recycleCents - resaleCents) / 100,
    keptPriority,
    ...counts,
  };
}

function solveOne(items, settings, objective, capacityUnits, timeUnits) {
  const stride = timeUnits + 1;
  const stateCount = (capacityUnits + 1) * stride;
  let previous = new Float64Array(stateCount);
  previous.fill(Number.NEGATIVE_INFINITY);
  previous[0] = 0;
  let next = new Float64Array(stateCount);
  const history = [];
  const optionsByItem = [];

  for (const item of items) {
    const choices = availableActions(item).filter(action => item.lock === 'auto' || action === item.lock).map(action => {
      const volume = action === 'keep' ? Math.ceil(item.volumeL / QUANTIZATION.volumeL) : 0;
      const time = Math.ceil(actionTime(item, action) / QUANTIZATION.timeMinutes);
      return { code: ACTIONS.indexOf(action), volume, time, offset: volume * stride + time, score: evaluateAction(item, action, objective.id) };
    });
    optionsByItem.push(choices);
    next.fill(Number.NEGATIVE_INFINITY);
    const selected = new Uint8Array(stateCount);
    selected.fill(255);
    for (let volume = 0; volume <= capacityUnits; volume++) {
      const row = volume * stride;
      for (let time = 0; time <= timeUnits; time++) {
        const state = row + time;
        const priorScore = previous[state];
        if (priorScore === Number.NEGATIVE_INFINITY) continue;
        for (const option of choices) {
          if (volume + option.volume > capacityUnits || time + option.time > timeUnits) continue;
          const destination = state + option.offset;
          const score = priorScore + option.score;
          if (score > next[destination]) {
            next[destination] = score;
            selected[destination] = option.code;
          }
        }
      }
    }
    history.push(selected);
    const reusable = previous;
    previous = next;
    next = reusable;
  }

  let bestState = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestQuote = null;
  for (let volume = 0; volume <= capacityUnits; volume++) {
    const quote = getTransportQuote(volume * QUANTIZATION.volumeL, settings.tiers);
    if (!quote) continue;
    const quotePenalty = cents(quote.price) * objective.moneyWeight;
    for (let time = 0; time <= timeUnits; time++) {
      const state = volume * stride + time;
      if (previous[state] === Number.NEGATIVE_INFINITY) continue;
      const score = previous[state] - quotePenalty;
      // Ascending traversal makes ties prefer less space, then less time.
      if (score > bestScore) { bestScore = score; bestState = state; bestQuote = quote; }
    }
  }
  if (bestState < 0) return impossiblePlan(objective, '当前容量、处置时间和车型报价没有同时可行的组合。请增加容量或时间、补充更大车型报价，或调整锁定决定；系统没有放宽任何限制。');

  const plannedVolumeL = Math.floor(bestState / stride) * QUANTIZATION.volumeL;
  const plannedHandlingMinutes = (bestState % stride) * QUANTIZATION.timeMinutes;
  const actionCodes = new Uint8Array(items.length);
  let state = bestState;
  for (let index = items.length - 1; index >= 0; index--) {
    const code = history[index][state];
    const option = optionsByItem[index].find(candidate => candidate.code === code);
    if (!option) throw new Error('方案回溯失败，请重试。');
    actionCodes[index] = code;
    state -= option.offset;
  }
  if (state !== 0) throw new Error('方案回溯位置不正确，请重试。');
  return {
    id: objective.id,
    label: objective.label,
    feasible: true,
    reason: '',
    actions: items.map((item, index) => ({ itemId: item.id, action: ACTIONS[actionCodes[index]], reason: reasonFor(item, ACTIONS[actionCodes[index]], objective) })),
    metrics: buildMetrics(items, actionCodes, bestQuote, plannedVolumeL, plannedHandlingMinutes),
    transportQuote: bestQuote,
    score: bestScore,
  };
}

/** Solve the full, discretized multi-choice problem for each preference mode. */
export function solvePlans(rawItems = [], rawSettings = DEFAULT_SETTINGS) {
  const started = typeof performance === 'undefined' ? Date.now() : performance.now();
  if (!Array.isArray(rawItems) || rawItems.length > LIMITS.items) throw new RangeError(`每个搬家项目最多 ${LIMITS.items} 组物品。`);
  const allItems = rawItems.map(normalizeItem);
  if (new Set(allItems.map(item => item.id)).size !== allItems.length) throw new TypeError('物品编号不能重复。');
  const items = allItems.filter(item => item.confirmed);
  const settings = validateSettings(rawSettings);
  const capacityUnits = Math.floor(settings.capacityL / QUANTIZATION.volumeL);
  const timeUnits = Math.floor(settings.timeMinutes / QUANTIZATION.timeMinutes);
  const baselineVolume = money(sum(items.map(item => item.volumeL)));
  const baselineQuote = getTransportQuote(baselineVolume, settings.tiers);
  const problem = preflight(items, settings, capacityUnits, timeUnits);
  const plans = OBJECTIVES.map(objective => problem ? impossiblePlan(objective, problem) : solveOne(items, settings, objective, capacityUnits, timeUnits));
  const ended = typeof performance === 'undefined' ? Date.now() : performance.now();
  return {
    plans,
    baseline: { volumeL: baselineVolume, transportQuote: baselineQuote, cost: baselineQuote?.price ?? null },
    excludedDrafts: allItems.length - items.length,
    elapsedMs: Math.max(0, Math.round((ended - started) * 100) / 100),
    quantization: { ...QUANTIZATION },
  };
}
