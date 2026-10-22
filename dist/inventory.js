/**
 * MoveLite import, classification, backup and local export utilities.
 * Rule drafts are never confirmed automatically. Semantic classification needs
 * an explicitly supplied real embedder and never changes prices or dimensions.
 * This module contains no network, storage writes, DOM or external publishing.
 */
import { normalizeItem, validateSettings, availableActions, CATEGORIES } from './engine.js';

const ITEM_KEYS = ['id', 'name', 'category', 'room', 'quantity', 'volumeL', 'priority', 'sentiment', 'resalePrice', 'saleMinutes', 'donateMinutes', 'recycleMinutes', 'recycleFee', 'condition', 'lock', 'confirmed', 'notes', 'origin'];
const SETTINGS_KEYS = ['capacityL', 'timeMinutes', 'moveDate', 'tiers'];
const ACTIONS = ['keep', 'sell', 'donate', 'recycle'];
const ACTION_LABELS = { keep: '带走', sell: '转让', donate: '赠送 / 捐赠', recycle: '回收 / 处理' };
const ROOM_NAMES = ['客厅', '卧室', '厨房', '书房', '阳台', '储物间', '其他'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_ITEMS = 40;
const MAX_BACKUP_BYTES = 1024 * 1024;
const DAY = 86400000;
const encoder = new TextEncoder();
let sequence = 0;

const RULES = [
  { id: 'sentimental', words: /相册|纪念|手办|奖杯|奖牌|信件|玩偶|礼物|珍藏|婚纱/u, volumeL: 20 },
  { id: 'sports', words: /自行车|滑板|瑜伽|运动|球拍|篮球|足球|哑铃|健身|帐篷|露营|滑雪/u, volumeL: 70 },
  { id: 'electronics', words: /电脑|笔记本|显示器|相机|手机|路由器|键盘|电视|耳机|平板|音箱|游戏机|打印机/u, volumeL: 30 },
  { id: 'kitchen', words: /厨具|餐具|电饭煲|微波炉|咖啡机|冰箱|烤箱|空气炸锅|锅|碗|杯|盘|水壶/u, volumeL: 25 },
  { id: 'furniture', words: /桌|椅|沙发|床|柜|凳|书架|收纳架/u, volumeL: 200 },
  { id: 'clothing', words: /衣服|衣物|外套|裤|裙|鞋|被褥|被子|床单|毛巾|毯|围巾/u, volumeL: 40 },
  { id: 'books', words: /书|教材|资料|文件|纸|笔记|文具/u, volumeL: 35 },
];

function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label}格式不正确。`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label}必须是普通数据。`);
  return value;
}
function whitelist(object, keys) {
  const result = {};
  for (const key of keys) if (own(object, key)) result[key] = object[key];
  return result;
}
function safeIdentifier(value) {
  if (typeof value !== 'string' || FORBIDDEN_KEYS.has(value) || !value || value.length > 100 || /[\u0000-\u0020\u007f]/u.test(value)) throw new TypeError('物品标识不正确。');
  return value;
}
function ensureItems(items) {
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new RangeError(`最多支持 ${MAX_ITEMS} 条物品。`);
  const seen = new Set();
  return items.map(input => {
    const record = plainRecord(input, '物品');
    safeIdentifier(record.id);
    if (seen.has(record.id)) throw new TypeError('物品标识不能重复。');
    seen.add(record.id);
    return normalizeItem(whitelist(record, ITEM_KEYS));
  });
}
function checkAmount(value, label, maximum = 100000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) throw new TypeError(`${label}必须是 0 至 ${maximum} 的有限金额。`);
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function cleanControls(value) { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ''); }
function chineseNumber(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  if (value === '一百') return 100;
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes('十')) {
    const [tens, units] = value.split('十');
    return (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0);
  }
  return digits[value] ?? Number.NaN;
}

function ruleCategory(text) {
  return RULES.find(rule => rule.words.test(text)) ?? { id: 'other', volumeL: 40 };
}
function newId() {
  if (globalThis.crypto?.randomUUID) return `item-${globalThis.crypto.randomUUID()}`;
  sequence++;
  return `item-${Date.now().toString(36)}-${sequence.toString(36)}`;
}
function timeFrom(text, expression) {
  const match = text.match(expression);
  if (!match) return null;
  const value = Number(match[1]) * (/小时|钟头|hour|hr/iu.test(match[2]) ? 60 : 1);
  if (!Number.isFinite(value) || value < 0 || value > 720) throw new RangeError('单项处理时间需在 0 至 720 分钟之间。');
  return Math.ceil(value);
}

/** Lines / semicolons form indivisible item groups; all amounts are group totals. */
export function parseInventory(text, { idFactory = newId } = {}) {
  if (typeof text !== 'string') throw new TypeError('请粘贴文字清单。');
  if (text.length > 20000) throw new RangeError('文字清单最多 20,000 字符。');
  if (typeof idFactory !== 'function') throw new TypeError('物品标识生成器不正确。');
  const rows = text.split(/[\r\n;；]+/u).map(row => cleanControls(row).trim()).filter(Boolean);
  if (!rows.length) return [];
  if (rows.length > MAX_ITEMS) throw new RangeError(`最多导入 ${MAX_ITEMS} 条，请拆分清单。`);
  const output = rows.map((raw, index) => {
    let row = raw.replace(/^\s*(?:[-*•]\s+|\d+[.)、](?!\d)\s*)/u, '').trim();
    let room = '其他';
    const roomMatch = row.match(/^([^:：]{1,8})\s*[:：]\s*/u);
    if (roomMatch && ROOM_NAMES.includes(roomMatch[1].trim())) {
      room = roomMatch[1].trim();
      row = row.slice(roomMatch[0].length);
    }
    const category = ruleCategory(row);
    const quantityMatch = row.match(/(?<!每)(\d+|一百|[一二两三四五六七八九十]{1,3})\s*(箱|把|台|件|个|套|袋|组|册|本|只|张|盏|辆|对|双)/u);
    const quantity = quantityMatch ? chineseNumber(quantityMatch[1]) : 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new RangeError(`第 ${index + 1} 条数量需在 1 至 99 之间。`);
    const volumePattern = /([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(立方米|立方|m3|m³|㎥|毫升|ml|升|l|方)(?:\s*\/\s*(箱|把|台|件|个|套|袋|组|册|本|只|张|盏|辆|对|双))?/iu;
    const volumeMatch = row.match(volumePattern);
    let volumeL;
    let referenceVolume = false;
    if (volumeMatch) {
      const amount = Number(volumeMatch[1].replace(/,/gu, ''));
      if (!Number.isFinite(amount) || amount <= 0) throw new RangeError(`第 ${index + 1} 条体积必须大于 0。`);
      const factor = /立方|m3|m³|㎥|方/iu.test(volumeMatch[2]) ? 1000 : /毫升|ml/iu.test(volumeMatch[2]) ? 0.001 : 1;
      const before = row.slice(0, volumeMatch.index);
      const each = Boolean(volumeMatch[3]) || /每(?:箱|把|台|件|个|套|袋|组|册|本|只|张|盏|辆|对|双)\s*$/u.test(before);
      volumeL = Math.ceil(amount * factor * (each ? quantity : 1));
    } else {
      const specific = /沙发|床/u.test(row) ? 700 : /椅/u.test(row) ? 120 : /桌/u.test(row) ? 250 : /笔记本电脑|手提电脑/u.test(row) ? 15 : category.volumeL;
      volumeL = specific * quantity;
      referenceVolume = true;
    }
    if (!Number.isFinite(volumeL) || volumeL < 1 || volumeL > 10000) throw new RangeError(`第 ${index + 1} 条整组体积需在 1 至 10,000 升之间。`);
    const priceMatch = row.match(/(?:转让|出售|挂牌|售价|标价|预计回收)(?:价|价格)?\s*[:：]?\s*[¥￥]?\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:元|块|rmb|人民币)?/iu);
    let resalePrice = priceMatch ? checkAmount(Number(priceMatch[1].replace(/,/gu, '')), `第 ${index + 1} 条转让金额`) : 0;
    if (priceMatch && (/每(?:箱|把|台|件|个|套|袋|组|册|本|只|张|盏|辆|对|双)\s*$/u.test(row.slice(0, priceMatch.index)) || /^\s*\/(?:箱|把|台|件|个|套|袋|组|册|本|只|张|盏|辆|对|双)/u.test(row.slice(priceMatch.index + priceMatch[0].length)))) resalePrice = checkAmount(resalePrice * quantity, `第 ${index + 1} 条整组金额`);
    const genericMinutes = timeFrom(row, /(?:处理|处置)(?:耗时|用时|时间|需要|需)?\s*[:：]?\s*([+-]?\d+(?:\.\d+)?)\s*(分钟|分|小时|钟头|hours?|hrs?)/iu);
    const saleMinutes = timeFrom(row, /(?:转让|出售|卖出)(?:准备|沟通|处理)?(?:耗时|用时|时间|需要|需)\s*[:：]?\s*([+-]?\d+(?:\.\d+)?)\s*(分钟|分|小时|钟头|hours?|hrs?)/iu) ?? genericMinutes ?? 45;
    const donateMinutes = timeFrom(row, /(?:赠送|捐赠)(?:准备|处理)?(?:耗时|用时|时间|需要|需)\s*[:：]?\s*([+-]?\d+(?:\.\d+)?)\s*(分钟|分|小时|钟头|hours?|hrs?)/iu) ?? genericMinutes ?? 15;
    const recycleMinutes = timeFrom(row, /(?:回收|丢弃)(?:准备|处理)?(?:耗时|用时|时间|需要|需)\s*[:：]?\s*([+-]?\d+(?:\.\d+)?)\s*(分钟|分|小时|钟头|hours?|hrs?)/iu) ?? genericMinutes ?? 10;
    const feeMatch = row.match(/(?:回收|处理|处置)(?:费|费用)\s*[:：]?\s*[¥￥]?\s*([+-]?\d+(?:\.\d+)?)\s*(?:元|块)?/u);
    const lock = /必须(?:带|留)|一定(?:带|留)|必带|不可丢/u.test(row) ? 'keep' : 'auto';
    const condition = /损坏|故障|不能用|无法使用|破损|坏了/u.test(row) ? 'broken' : /磨损|旧的|旧款|使用痕迹/u.test(row) ? 'worn' : 'good';
    let name = row.split(/，|(?<!\d),|,(?!\d)/u)[0]
      .replace(volumePattern, '')
      .replace(/每(?:箱|把|台|件|个|套|袋|组|册|本|只|张|盏|辆|对|双)/gu, '')
      .replace(/^(?:\d+|一百|[一二两三四五六七八九十]{1,3})\s*(?:箱|把|台|件|个|套|袋|组|册|本|只|张|盏|辆|对|双)\s*/u, '')
      .replace(/(?:必须(?:带走|保留)|一定(?:带走|保留)|必带|不可丢)/gu, '')
      .replace(/(?:转让|出售|挂牌|售价|标价|预计回收)(?:价|价格)?\s*[:：]?\s*[¥￥]?\s*[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:元|块|rmb|人民币)?/giu, '')
      .replace(/(?:处理|处置|转让|出售|卖出|赠送|捐赠|回收|丢弃)(?:准备|沟通|处理)?(?:耗时|用时|时间|需要|需)\s*[:：]?\s*[+-]?\d+(?:\.\d+)?\s*(?:分钟|分|小时|钟头|hours?|hrs?)/giu, '')
      .replace(/\s+/gu, ' ').trim();
    if (!name || /^[\d\s.]+$/u.test(name)) throw new TypeError(`第 ${index + 1} 条缺少物品名称。`);
    if (name.length > 80) throw new RangeError(`第 ${index + 1} 条名称过长，请把补充内容放到逗号后。`);
    const note = `${referenceVolume ? '体积为规则参考值；' : '体积按输入单位换算；'}价格、成色与处理耗时均需确认。原始输入：${raw}`;
    return normalizeItem({ id: safeIdentifier(idFactory(index, raw)), name, category: category.id, room, quantity, volumeL, priority: lock === 'keep' ? 5 : 3, sentiment: category.id === 'sentimental' ? 2 : 0, resalePrice, saleMinutes, donateMinutes, recycleMinutes, recycleFee: feeMatch ? checkAmount(Number(feeMatch[1]), '回收费用', 10000) : 0, condition, lock, confirmed: false, notes: note.slice(0, 500), origin: 'rule' });
  });
  return ensureItems(output);
}

function aborted(signal) {
  if (signal?.aborted) throw new DOMException('已取消物品分类。', 'AbortError');
}
function cosine(a, b) {
  let dot = 0, left = 0, right = 0;
  for (let index = 0; index < a.length; index++) { dot += a[index] * b[index]; left += a[index] ** 2; right += b[index] ** 2; }
  if (!left || !right) throw new TypeError('模型返回了零向量，无法进行语义分类。');
  return dot / Math.sqrt(left * right);
}
function notify(callback, event) { try { callback?.(event); } catch { /* UI progress must not alter results. */ } }
async function embedWithCancellation(embed, texts, signal) {
  const pending = Promise.resolve().then(() => embed(texts));
  if (!signal) return pending;
  let listener;
  const stopped = new Promise((resolve, reject) => {
    listener = () => reject(new DOMException('已取消物品分类。', 'AbortError'));
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) listener();
  });
  try { return await Promise.race([pending, stopped]); }
  finally { signal.removeEventListener('abort', listener); }
}

/** Real embedding similarity only; no rules silently replace a failed model. */
export async function categorizeWithEmbeddings(items, embed, { onProgress, signal } = {}) {
  const normalized = ensureItems(items);
  if (typeof embed !== 'function') throw new TypeError('请先加载本地 AI 模型。');
  aborted(signal);
  if (!normalized.length) return [];
  const categories = CATEGORIES.filter(category => category.id !== 'other');
  const prototypes = categories.map(category => `${category.label}。${category.description}`);
  const descriptions = normalized.map(item => `搬家物品：${item.name}。${item.notes.replace(/原始输入：/u, '')}`.slice(0, 400));
  notify(onProgress, { status: 'classifying', progress: 0, completed: 0, total: normalized.length });
  const vectors = await embedWithCancellation(embed, [...prototypes, ...descriptions], signal);
  aborted(signal);
  if (!Array.isArray(vectors) || vectors.length !== prototypes.length + descriptions.length || !Array.isArray(vectors[0]) || !vectors[0].length) throw new TypeError('模型向量数量不正确。');
  const dimensions = vectors[0].length;
  if (vectors.some(vector => !Array.isArray(vector) || vector.length !== dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new TypeError('模型返回了无效向量。');
  const output = normalized.map((item, index) => {
    aborted(signal);
    const vector = vectors[categories.length + index];
    const ranked = categories.map((category, position) => ({ category, score: cosine(vector, vectors[position]) })).sort((a, b) => b.score - a.score);
    const selected = ranked[0].score >= 0.25 && ranked[0].score - (ranked[1]?.score ?? -1) >= 0.012 ? ranked[0].category.id : 'other';
    notify(onProgress, { status: 'classifying', progress: Math.round((index + 1) / normalized.length * 100), completed: index + 1, total: normalized.length });
    return { ...item, category: selected, origin: 'semantic' };
  });
  return output;
}

function validDate(value, label, allowEmpty = false) {
  if (allowEmpty && value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError(`${label}需为有效的 YYYY-MM-DD 日期。`);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new TypeError(`${label}不是有效日期。`);
  return value;
}
function normalizedSettings(input) {
  const record = plainRecord(input, '方案设置');
  const safe = whitelist(record, SETTINGS_KEYS);
  if (own(safe, 'moveDate')) validDate(safe.moveDate, '搬家日期', true);
  if (own(safe, 'tiers')) {
    if (!Array.isArray(safe.tiers)) throw new TypeError('搬运报价格式不正确。');
    safe.tiers = safe.tiers.map(tier => whitelist(plainRecord(tier, '车型报价'), ['id', 'name', 'capacityL', 'price']));
  }
  return validateSettings(safe);
}
function workspaceData(input) {
  const record = plainRecord(input, '工作区');
  const items = ensureItems(record.items);
  const settings = normalizedSettings(record.settings);
  const ids = new Set(items.map(item => item.id));
  const itemMap = new Map(items.map(item => [item.id, item]));
  const completed = Object.create(null);
  const actualIncome = Object.create(null);
  const completeInput = record.completed === undefined ? {} : plainRecord(record.completed, '完成状态');
  const incomeInput = record.actualIncome === undefined ? {} : plainRecord(record.actualIncome, '实际收入');
  for (const [id, action] of Object.entries(completeInput)) {
    safeIdentifier(id);
    if (!ids.has(id) || !ACTIONS.includes(action)) throw new TypeError('完成状态引用了不存在的物品或动作。');
    const item = itemMap.get(id);
    if (!item.confirmed) throw new TypeError('待确认草稿不能标记为已完成，请先确认物品数据。');
    if (!availableActions(item).includes(action)) throw new TypeError('完成状态与物品状态或转让金额不兼容。');
    if (item.lock !== 'auto' && item.lock !== action) throw new TypeError('完成状态与物品锁定决定不一致。');
    completed[id] = action;
  }
  for (const [id, amount] of Object.entries(incomeInput)) {
    safeIdentifier(id);
    if (!ids.has(id)) throw new TypeError('实际收入引用了不存在的物品。');
    if (completed[id] !== 'sell') throw new TypeError('实际收入只能记录在已经完成转让的物品上。');
    actualIncome[id] = checkAmount(amount, '实际收入');
  }
  return { items, settings, completed, actualIncome };
}
export function serializeWorkspace(workspace) {
  const data = workspaceData(workspace);
  const output = JSON.stringify({ schema: 'movelite-workspace', version: 1, ...data }, null, 2);
  if (encoder.encode(output).length > MAX_BACKUP_BYTES) throw new RangeError('工作区备份最大 1 MB。');
  return output;
}
export function parseWorkspaceBackup(text) {
  if (typeof text !== 'string' || encoder.encode(text).length > MAX_BACKUP_BYTES) throw new RangeError('备份文件需为不超过 1 MB 的 JSON 文字。');
  let input;
  try { input = JSON.parse(text); } catch { throw new TypeError('备份不是有效的 JSON 文件。'); }
  plainRecord(input, '备份');
  if (input.schema !== 'movelite-workspace' || input.version !== 1) throw new TypeError('不支持这个备份版本。');
  return workspaceData(input);
}

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function addDays(iso, days) { return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10); }
function getToday(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError('当前日期不正确。');
    return validDate(`${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`, '当前日期');
  }
  return validDate(value ?? todayString(), '当前日期');
}

/** Dates are suggested deadlines, not promises of completed sales or pickups. */
export function createTasks(plan, items, settings, { today } = {}) {
  if (!plan?.feasible) return [];
  const normalized = ensureItems(items);
  const options = normalizedSettings(settings);
  const moveDate = validDate(options.moveDate, '搬家日期');
  const current = getToday(today);
  if (moveDate < current) throw new RangeError('搬家日期已过去，请先更新日期再生成行动清单。');
  if (!Array.isArray(plan.actions)) throw new TypeError('方案缺少物品动作。');
  const itemMap = new Map(normalized.map(item => [item.id, item]));
  const seen = new Set();
  const offsets = { sell: -7, donate: -3, recycle: -2, keep: -1 };
  const titles = { sell: '发布转让：', donate: '联系接收：', recycle: '安排处理：', keep: '打包带走：' };
  return plan.actions.map(action => {
    if (!action || !ACTIONS.includes(action.action) || !itemMap.has(action.itemId) || seen.has(action.itemId)) throw new TypeError('方案含无效或重复的物品动作。');
    seen.add(action.itemId);
    const item = itemMap.get(action.itemId);
    const target = addDays(moveDate, offsets[action.action]);
    const dueDate = target < current ? current : target;
    const minutes = action.action === 'keep' ? 0 : item[`${action.action === 'sell' ? 'sale' : action.action}Minutes`];
    const details = action.action === 'sell' ? `整组意向转让金额：${money(item.resalePrice)} 元；这是用户估计，不代表已成交。` : action.action === 'keep' ? '打包时间未计入闲置处置预算，请自行安排。' : action.action === 'donate' ? '先确认接收方是否接收以及交接时间。' : `用户估计处理费用：${money(item.recycleFee)} 元；先自行确认可用渠道。`;
    return { id: `${item.id}:${action.action}`, itemId: item.id, action: action.action, title: `${titles[action.action]}${item.name}`, dueDate, minutes, description: `${details}\n用户填写整组体积：${item.volumeL} 升。${action.reason ? `\n方案说明：${String(action.reason)}` : ''}` };
  }).sort((left, right) => left.dueDate.localeCompare(right.dueDate) || ACTIONS.indexOf(left.action) - ACTIONS.indexOf(right.action) || left.itemId.localeCompare(right.itemId));
}

function icsEscape(value) {
  return cleanControls(String(value)).replace(/\\/gu, '\\\\').replace(/\r\n|\r|\n/gu, '\\n').replace(/;/gu, '\\;').replace(/,/gu, '\\,');
}
function foldIcs(line) {
  const result = [];
  let current = '', length = 0;
  for (const character of line) {
    const bytes = encoder.encode(character).length;
    if (length + bytes > 75) { result.push(current); current = ' '; length = 1; }
    current += character; length += bytes;
  }
  result.push(current);
  return result.join('\r\n');
}
function stableHash(value) {
  let hash = 2166136261;
  for (const byte of encoder.encode(value)) { hash ^= byte; hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
export function createCalendar(tasks) {
  if (!Array.isArray(tasks) || tasks.length > MAX_ITEMS) throw new RangeError('日历最多支持 40 个物品任务。');
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MoveLite//Local Moving Plan//ZH-CN', 'CALSCALE:GREGORIAN'];
  const seen = new Set();
  tasks.forEach((task, index) => {
    plainRecord(task, '日历任务');
    if (typeof task.id !== 'string' || !task.id || seen.has(task.id)) throw new TypeError('日历任务标识不正确或重复。');
    seen.add(task.id);
    if (typeof task.title !== 'string' || task.title.length > 300 || typeof task.description !== 'string' || task.description.length > 3000) throw new TypeError('日历任务内容过长或不正确。');
    const date = validDate(task.dueDate, '任务日期');
    lines.push('BEGIN:VEVENT', `UID:movelite-${stableHash(task.id)}-${index}@movelite.local`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${date.replace(/-/gu, '')}`, `DTEND;VALUE=DATE:${addDays(date, 1).replace(/-/gu, '')}`, `SUMMARY:${icsEscape(task.title)}`, `DESCRIPTION:${icsEscape(task.description)}`, 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.map(foldIcs).join('\r\n') + '\r\n';
}

function money(value) { return Number.isFinite(value) ? Number(value).toFixed(2) : '—'; }
function markdown(value) {
  return cleanControls(String(value)).replace(/\s+/gu, ' ').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/[\\`*_{}\[\]()#+.!|]/gu, '\\$&');
}
export function createMarkdownReport(result, selectedPlan, items, settings) {
  const normalized = ensureItems(items);
  const options = normalizedSettings(settings);
  const plan = typeof selectedPlan === 'string' ? result?.plans?.find(entry => entry.id === selectedPlan) : selectedPlan;
  if (!plan) throw new TypeError('请先选择一个方案。');
  const lines = ['# 轻迁 MoveLite 搬家方案', '', `搬家日期：${options.moveDate || '尚未设置'}  `, `新家可用容量：${options.capacityL} 升  `, `闲置处置时间：${options.timeMinutes} 分钟  `, `未确认草稿：${Number(result?.excludedDrafts) || 0} 条`, '', '金额来自用户填写的意向价和车型报价，不代表成交或搬家公司实时报价。物品按整组处理；容量和时间采用保守分档。', '', '## 方案比较', '', '| 方案 | 带走体积（升） | 处置时间（分钟） | 计划转让收入（元） | 车型报价（元） | 预计净支出（元） |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const entry of result?.plans ?? [plan]) {
    if (!entry.feasible) { lines.push(`| ${markdown(entry.label ?? entry.id)} | 无可行方案 | — | — | — | — |`); continue; }
    const metrics = entry.metrics;
    lines.push(`| ${markdown(entry.label ?? entry.id)} | ${metrics.keptVolumeL} | ${metrics.handlingMinutes} | ${money(metrics.resaleIncome)} | ${money(metrics.transportCost)} | ${money(metrics.netOutlay)} |`);
  }
  lines.push('', `## 选择：${markdown(plan.label ?? plan.id)}`, '');
  if (!plan.feasible) { lines.push(markdown(plan.reason || '容量或处理时间限制下没有可行方案。')); return lines.join('\n') + '\n'; }
  const itemMap = new Map(normalized.map(item => [item.id, item]));
  lines.push('| 物品 | 动作 | 原因 |', '| --- | --- | --- |');
  for (const action of plan.actions) {
    const item = itemMap.get(action.itemId);
    if (!item || !ACTIONS.includes(action.action)) throw new TypeError('方案含无效的物品引用。');
    lines.push(`| ${markdown(item.name)} | ${ACTION_LABELS[action.action]} | ${markdown(action.reason || '')} |`);
  }
  lines.push('', '计划转让收入和已经到账的收入是两项不同记录；本报告不将预计收入当成已实现收入。', '', '当前导出为本地文件，没有自动发布二手信息、预约服务或发送通知。');
  return lines.join('\n') + '\n';
}

/** A factual template for user review, never an automatic marketplace listing. */
export function createListing(input, moveDate = '') {
  const item = ensureItems([input])[0];
  if (moveDate) validDate(moveDate, '搬家日期');
  const condition = { good: '可正常使用（按我在清单中的标注）', worn: '有使用痕迹（请补充具体情况）', broken: '已标注为损坏 / 需要维修' }[item.condition];
  return [
    `【搬家转让】${item.name}`,
    '',
    `整组数量：${item.quantity}`,
    `意向价：${item.resalePrice > 0 ? `${money(item.resalePrice)} 元（可自行调整，不代表市场估价）` : '待我填写'}`,
    `我标注的状态：${condition}`,
    `整组估计体积：${item.volumeL} 升；实际尺寸待补充。`,
    moveDate ? `希望在 ${moveDate} 前协商交接，实际时间待双方确认。` : '交接时间：待双方确认。',
    item.notes ? `我的备注：${cleanControls(item.notes)}` : '',
    '',
    '发布前请补充实拍照片、实际尺寸、配件情况和交付方式，并核对价格与描述。',
  ].filter((line, index, array) => line !== '' || index === 1 || array[index - 1] !== '').join('\n');
}
