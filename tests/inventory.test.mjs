import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, normalizeItem, CATEGORIES } from '../dist/engine.js';
import { parseInventory, categorizeWithEmbeddings, serializeWorkspace, parseWorkspaceBackup, createTasks, createCalendar, createMarkdownReport, createListing } from '../dist/inventory.js';

const settings = { ...DEFAULT_SETTINGS, moveDate: '2026-11-05', tiers: DEFAULT_SETTINGS.tiers.map(tier => ({ ...tier })) };
const item = overrides => normalizeItem({ id: 'chair', name: '木椅', category: 'furniture', room: '客厅', quantity: 1, volumeL: 120, priority: 3, sentiment: 0, resalePrice: 80, saleMinutes: 45, donateMinutes: 15, recycleMinutes: 10, recycleFee: 0, condition: 'good', lock: 'auto', confirmed: true, notes: '', origin: 'manual', ...overrides });

test('rule import converts per-unit quantities and explicit units but never confirms drafts', () => {
  const rows = parseInventory('书房：3箱书，每箱40升，转让120元；椅子 0.12m3，转让80.50元\n相册 2L 必须带走', { idFactory: index => `row-${index}` });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].quantity, 3);
  assert.equal(rows[0].volumeL, 120);
  assert.equal(rows[0].resalePrice, 120);
  assert.equal(rows[0].room, '书房');
  assert.equal(rows[1].volumeL, 120);
  assert.equal(rows[1].resalePrice, 80.5);
  assert.equal(rows[2].lock, 'keep');
  assert.ok(rows.every(row => row.confirmed === false && row.origin === 'rule'));
  assert.ok(rows.every(row => !('marketValue' in row)));
});

test('group totals are not multiplied twice; reference estimates are labelled', () => {
  const rows = parseInventory('两箱衣服，总体积80L\n3箱书 120L\n电脑', { idFactory: index => `group-${index}` });
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].volumeL, 80);
  assert.equal(rows[1].volumeL, 120);
  assert.match(rows[2].notes, /规则参考/);
  assert.equal(rows[2].resalePrice, 0);
  const each = parseInventory('3箱书 40L/箱，每箱转让20元', { idFactory: () => 'each' })[0];
  assert.equal(each.volumeL, 120);
  assert.equal(each.resalePrice, 60);
  const formatted = parseInventory('沙发 1,000L，转让1,234.50元', { idFactory: () => 'formatted' })[0];
  assert.equal(formatted.volumeL, 1000);
  assert.equal(formatted.resalePrice, 1234.5);
  assert.equal(formatted.name, '沙发');
});

test('rules preserve inert text and reject invalid quantities, volumes and excess rows', () => {
  globalThis.__inventoryInjected = false;
  const dangerous = parseInventory('<img src=x onerror="__inventoryInjected=true"> 20L', { idFactory: () => 'safe-text' });
  assert.ok(dangerous[0].name.includes('<img'));
  assert.equal(globalThis.__inventoryInjected, false);
  assert.throws(() => parseInventory('100箱书'), /数量/);
  assert.throws(() => parseInventory('书 -20L'), /大于 0/);
  assert.throws(() => parseInventory('书 11m3'), /体积/);
  assert.throws(() => parseInventory(Array(41).fill('椅子').join('\n')), /40/);
  assert.throws(() => parseInventory('a'.repeat(20001)), /20,000/);
  assert.throws(() => parseInventory('椅子\n书', { idFactory: () => 'duplicate' }), /重复/);
  assert.throws(() => parseInventory('椅子', { idFactory: () => undefined }), /标识/);
});

test('semantic classification uses supplied vectors without changing user estimates or confirmation', async () => {
  const categories = CATEGORIES.filter(category => category.id !== 'other');
  const chosen = categories.findIndex(category => category.id === 'books');
  const draft = item({ id: 'draft', category: 'other', confirmed: false, volumeL: 71, resalePrice: 123.45, lock: 'keep' });
  const calls = [];
  const output = await categorizeWithEmbeddings([draft], async texts => {
    calls.push(texts);
    return texts.map((text, index) => Array.from({ length: categories.length }, (_, dimension) => Number(dimension === (index < categories.length ? index : chosen))));
  });
  assert.equal(calls.length, 1);
  assert.equal(output[0].category, 'books');
  assert.equal(output[0].origin, 'semantic');
  for (const key of ['volumeL', 'resalePrice', 'lock', 'confirmed', 'name']) assert.equal(output[0][key], draft[key]);
  assert.equal(draft.category, 'other');
});

test('semantic failures and cancellation remain visible instead of becoming rule answers', async () => {
  await assert.rejects(categorizeWithEmbeddings([item()], null), /AI 模型/);
  await assert.rejects(categorizeWithEmbeddings([item()], async () => [[NaN]]), /向量/);
  await assert.rejects(categorizeWithEmbeddings([item()], async texts => texts.map(() => [0, 0])), /零向量/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(categorizeWithEmbeddings([item()], async () => { throw new Error('must not run'); }, { signal: controller.signal }), error => error.name === 'AbortError');
  const later = new AbortController();
  await assert.rejects(categorizeWithEmbeddings([item()], async texts => { later.abort(); return texts.map(() => [1, 0]); }, { signal: later.signal }), error => error.name === 'AbortError');
  const hanging = new AbortController();
  const promise = categorizeWithEmbeddings([item()], () => new Promise(() => {}), { signal: hanging.signal });
  hanging.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
});

test('backup roundtrip preserves typed workspace data while dropping unknown data', () => {
  const source = { items: [{ ...item({ lock: 'sell' }), vectors: [[1]], photo: 'private-base64' }], settings: { ...settings, token: 'not-a-real-token' }, completed: { chair: 'sell' }, actualIncome: { chair: 75.5 }, chat: ['ignore'] };
  const json = serializeWorkspace(source);
  const roundtrip = parseWorkspaceBackup(json);
  assert.equal(roundtrip.items[0].volumeL, 120);
  assert.equal(roundtrip.actualIncome.chair, 75.5);
  assert.equal(roundtrip.completed.chair, 'sell');
  assert.ok(!json.includes('private-base64'));
  assert.ok(!json.includes('not-a-real-token'));
  assert.ok(!('vectors' in roundtrip.items[0]));
  assert.equal(source.items[0].vectors.length, 1);
});

test('malformed backups cannot create prototype entries or incorrect financial records', () => {
  const valid = JSON.parse(serializeWorkspace({ items: [item()], settings, completed: {}, actualIncome: {} }));
  const backup = changes => JSON.stringify({ ...valid, ...changes });
  assert.throws(() => parseWorkspaceBackup(backup({ version: 2 })), /版本/);
  assert.throws(() => parseWorkspaceBackup(backup({ items: [item(), item()] })), /重复/);
  assert.throws(() => parseWorkspaceBackup(backup({ settings: { ...settings, moveDate: '2026-02-31' } })), /日期/);
  assert.throws(() => parseWorkspaceBackup(backup({ completed: { chair: 'sell' }, actualIncome: { chair: '75' } })), /金额/);
  assert.throws(() => parseWorkspaceBackup(backup({ completed: { chair: 'auto' } })), /动作/);
  assert.throws(() => parseWorkspaceBackup(backup({ actualIncome: { unknown: 50 } })), /不存在/);
  assert.throws(() => parseWorkspaceBackup('x'.repeat(1024 * 1024 + 1)), /1 MB/);
  const pollution = JSON.parse(backup({ completed: {} }));
  pollution.completed = JSON.parse('{"__proto__":"keep"}');
  assert.throws(() => parseWorkspaceBackup(JSON.stringify(pollution)), /标识/);
  assert.equal({}.polluted, undefined);
});

test('unconfirmed drafts can be backed up but cannot bypass confirmation through completion', () => {
  const draft = item({ confirmed: false, origin: 'rule' });
  const validDraft = { items: [draft], settings, completed: {}, actualIncome: {} };
  assert.equal(parseWorkspaceBackup(serializeWorkspace(validDraft)).items[0].confirmed, false);
  assert.throws(() => serializeWorkspace({ ...validDraft, completed: { chair: 'keep' } }), /草稿.*完成/);
  const forged = JSON.parse(serializeWorkspace(validDraft));
  forged.completed.chair = 'sell';
  forged.actualIncome.chair = 75;
  assert.throws(() => parseWorkspaceBackup(JSON.stringify(forged)), /草稿.*完成/);
});

test('realized income requires completed sale and is retained independently of the estimate', () => {
  const workspace = { items: [item()], settings, completed: {}, actualIncome: { chair: 75 } };
  assert.throws(() => serializeWorkspace(workspace), /已经完成转让/);
  assert.throws(() => serializeWorkspace({ ...workspace, completed: { chair: 'keep' } }), /已经完成转让/);
  assert.throws(() => serializeWorkspace({ ...workspace, completed: { chair: 'donate' } }), /已经完成转让/);
  const settled = parseWorkspaceBackup(serializeWorkspace({ ...workspace, items: [item({ lock: 'sell' })], completed: { chair: 'sell' } }));
  assert.equal(settled.completed.chair, 'sell');
  assert.equal(settled.items[0].resalePrice, 80);
  assert.equal(settled.actualIncome.chair, 75);
});

test('completed actions must remain compatible with condition, entered price and locked choice', () => {
  const workspace = { items: [item()], settings, completed: { chair: 'sell' }, actualIncome: {} };
  assert.throws(() => serializeWorkspace({ ...workspace, items: [item({ condition: 'broken' })] }), /不兼容/);
  assert.throws(() => serializeWorkspace({ ...workspace, items: [item({ resalePrice: 0 })] }), /不兼容/);
  assert.throws(() => serializeWorkspace({ ...workspace, items: [item({ lock: 'keep' })] }), /锁定决定/);
  assert.throws(() => serializeWorkspace({ ...workspace, items: [item({ condition: 'broken' })], completed: { chair: 'donate' } }), /不兼容/);
  const recycled = parseWorkspaceBackup(serializeWorkspace({ ...workspace, items: [item({ condition: 'broken', lock: 'recycle' })], completed: { chair: 'recycle' } }));
  assert.equal(recycled.completed.chair, 'recycle');
});

test('task deadlines handle short lead time, month transitions and past moving dates', () => {
  const items = [item(), item({ id: 'book', name: '书', category: 'books' }), item({ id: 'album', name: '相册', category: 'sentimental' })];
  const plan = { feasible: true, actions: [{ itemId: 'chair', action: 'sell' }, { itemId: 'book', action: 'donate' }, { itemId: 'album', action: 'keep' }] };
  const tasks = createTasks(plan, items, { ...settings, moveDate: '2026-11-02' }, { today: '2026-10-31' });
  assert.deepEqual(tasks.map(task => task.dueDate), ['2026-10-31', '2026-10-31', '2026-11-01']);
  assert.equal(tasks[0].minutes, 45);
  assert.equal(tasks[2].minutes, 0);
  assert.match(tasks[2].description, /未计入/);
  assert.throws(() => createTasks(plan, items, { ...settings, moveDate: '2026-10-30' }, { today: '2026-10-31' }), /已过去/);
  assert.deepEqual(createTasks({ feasible: false }, items, settings), []);
});

test('calendar uses all-day events, safe UIDs and UTF-8 byte folding without injected fields', () => {
  const tasks = [{ id: 'one\nATTENDEE:evil@example.invalid', itemId: 'chair', action: 'sell', title: '发布转让：' + '有纪念意义的书籍'.repeat(15) + '\nBEGIN:VEVENT', dueDate: '2026-12-31', minutes: 45, description: '说明：a,b;c\\d\n地点另行确认' }];
  const calendar = createCalendar(tasks);
  assert.ok(calendar.endsWith('\r\n'));
  assert.ok(!calendar.replace(/\r\n/gu, '').includes('\n'), 'Every physical line uses CRLF');
  const lines = calendar.split('\r\n');
  assert.equal(lines.filter(line => line === 'BEGIN:VEVENT').length, 1);
  assert.ok(lines.every(line => new TextEncoder().encode(line).length <= 75));
  const unfolded = calendar.replace(/\r\n /gu, '');
  assert.match(unfolded, /DTSTART;VALUE=DATE:20261231/);
  assert.match(unfolded, /DTEND;VALUE=DATE:20270101/);
  assert.match(unfolded, /a\\,b\\;c\\\\d\\n/);
  assert.ok(!lines.some(line => line.startsWith('ATTENDEE:')));
  assert.match(unfolded, /SUMMARY:.*\\nBEGIN:VEVENT/u);
});

test('listing and Markdown export use user facts and keep planned income distinct', () => {
  const malicious = item({ name: '<script>alert(1)</script>|[链接](x)', notes: '只含自己输入的信息', condition: 'worn' });
  const listing = createListing(malicious, '2026-11-05');
  assert.match(listing, /80\.00 元/);
  assert.match(listing, /有使用痕迹/);
  assert.ok(!listing.includes('九成新'));
  const plan = { id: 'budget', label: '少花一点', feasible: true, metrics: { keptVolumeL: 0, handlingMinutes: 45, resaleIncome: 80, transportCost: 0, netOutlay: -80 }, actions: [{ itemId: 'chair', action: 'sell', reason: '用户输入的计划' }] };
  const report = createMarkdownReport({ plans: [plan], excludedDrafts: 2 }, plan, [malicious], settings);
  assert.ok(!report.includes('<script>'));
  assert.match(report, /&lt;script&gt;/);
  assert.match(report, /未确认草稿：2/);
  assert.match(report, /不将预计收入当成已实现收入/);
  assert.ok(report.includes('\\|'));
});
