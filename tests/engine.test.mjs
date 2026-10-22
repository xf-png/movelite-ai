import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeItem, validateSettings, getTransportQuote, solvePlans,
  DEFAULT_SETTINGS, OBJECTIVES, QUANTIZATION,
} from '../dist/engine.js';

const item = (id, values = {}) => ({ id, name: `物品 ${id}`, volumeL: 100, confirmed: true, ...values });
const settings = values => ({ ...DEFAULT_SETTINGS, tiers: DEFAULT_SETTINGS.tiers.map(tier => ({ ...tier })), ...values });
const actions = ['keep', 'sell', 'donate', 'recycle'];
const minutes = (row, action) => action === 'keep' ? 0 : row[action === 'sell' ? 'saleMinutes' : action === 'donate' ? 'donateMinutes' : 'recycleMinutes'];

// Independent enumeration of every complete assignment for small problems.
// It does not use the implementation's transitions, objective evaluator or quote
// selector, and checks the DP against the documented discretized problem.
function exhaustive(rawItems, rawSettings, objective) {
  const rows = rawItems.map(normalizeItem).filter(row => row.confirmed);
  const input = validateSettings(rawSettings);
  const capacity = Math.floor(input.capacityL / 10) * 10;
  const availableTime = Math.floor(input.timeMinutes / 5) * 5;
  let best = null;
  function visit(index, volume, time, score) {
    if (volume > capacity || time > availableTime) return;
    if (index === rows.length) {
      const eligiblePrices = volume === 0 ? [0] : input.tiers.filter(tier => tier.capacityL >= volume).map(tier => tier.price);
      if (!eligiblePrices.length) return;
      const quote = Math.min(...eligiblePrices);
      const total = score - Math.round(quote * 100) * objective.moneyWeight;
      if (best === null || total > best) best = total;
      return;
    }
    const row = rows[index];
    for (const action of actions) {
      if (row.lock !== 'auto' && row.lock !== action) continue;
      if ((action === 'sell' || action === 'donate') && row.condition === 'broken') continue;
      if (action === 'sell' && row.resalePrice <= 0) continue;
      const nextVolume = volume + (action === 'keep' ? Math.ceil(row.volumeL / 10) * 10 : 0);
      const nextTime = time + Math.ceil(minutes(row, action) / 5) * 5;
      let value;
      if (action === 'keep') value = 100 * (row.priority * objective.keepWeight + row.sentiment * objective.sentimentWeight);
      else {
        const release = row.sentiment * objective.releaseSentimentWeight * 100;
        const effort = minutes(row, action) * objective.timeWeight * 100;
        value = action === 'sell' ? Math.round(row.resalePrice * 100) * objective.moneyWeight - effort - release
          : action === 'donate' ? objective.donationBonus * 100 - effort - release
          : -objective.recyclingPenalty * 100 - effort - release - Math.round(row.recycleFee * 100) * objective.moneyWeight;
      }
      visit(index + 1, nextVolume, nextTime, score + value);
    }
  }
  visit(0, 0, 0, 0);
  return best;
}

function assertConstraints(result, rawItems, rawSettings) {
  const rows = rawItems.map(normalizeItem).filter(row => row.confirmed);
  const input = validateSettings(rawSettings);
  for (const plan of result.plans.filter(plan => plan.feasible)) {
    assert.equal(plan.actions.length, rows.length);
    assert.equal(new Set(plan.actions.map(action => action.itemId)).size, rows.length);
    let exactVolume = 0, exactTime = 0;
    for (const choice of plan.actions) {
      const row = rows.find(row => row.id === choice.itemId);
      assert.ok(row);
      if (row.lock !== 'auto') assert.equal(choice.action, row.lock);
      if (row.condition === 'broken') assert.ok(['keep', 'recycle'].includes(choice.action));
      if (choice.action === 'keep') exactVolume += row.volumeL;
      exactTime += minutes(row, choice.action);
    }
    assert.ok(exactVolume <= input.capacityL);
    assert.ok(exactTime <= input.timeMinutes);
    assert.equal(plan.metrics.keptVolumeL, Math.round(exactVolume * 100) / 100);
    assert.equal(plan.metrics.handlingMinutes, exactTime);
    assert.ok(plan.metrics.plannedVolumeL >= exactVolume);
    assert.ok(plan.metrics.plannedHandlingMinutes >= exactTime);
    assert.ok(plan.transportQuote.capacityL >= plan.metrics.plannedVolumeL);
    assert.equal(plan.metrics.netOutlay, Math.round((plan.metrics.transportCost + plan.metrics.recycleCost - plan.metrics.resaleIncome) * 100) / 100);
  }
}

test('all three objectives match exhaustive search over a mixed six-item problem', () => {
  const rows = [
    item('a', { volumeL: 50, priority: 5, sentiment: 2, resalePrice: 100, saleMinutes: 35 }),
    item('b', { volumeL: 60, priority: 2, resalePrice: 260, saleMinutes: 30 }),
    item('c', { volumeL: 40, priority: 4, resalePrice: 90, saleMinutes: 20, donateMinutes: 10 }),
    item('d', { volumeL: 20, priority: 1, resalePrice: 80, saleMinutes: 15, recycleMinutes: 5 }),
    item('e', { volumeL: 50, condition: 'broken', priority: 1, recycleFee: 12.50 }),
    item('f', { volumeL: 10, priority: 5, sentiment: 3, lock: 'keep' }),
  ];
  const input = settings({ capacityL: 130, timeMinutes: 80, tiers: [
    { id: 's', name: '小车', capacityL: 80, price: 110 },
    { id: 'm', name: '中车', capacityL: 150, price: 140 },
    { id: 'l', name: '大车', capacityL: 500, price: 210 },
  ] });
  const result = solvePlans(rows, input);
  for (const objective of OBJECTIVES) assert.equal(result.plans.find(plan => plan.id === objective.id).score, exhaustive(rows, input, objective));
  assertConstraints(result, rows, input);
});

test('seeded small randomized problems agree with independent exhaustive assignments', () => {
  let seed = 72421;
  const random = max => { seed = (1664525 * seed + 1013904223) >>> 0; return seed % max; };
  for (let sample = 0; sample < 12; sample++) {
    const rows = Array.from({ length: 4 }, (_, index) => item(`${sample}-${index}`, {
      volumeL: 1 + random(60), priority: 1 + random(5), sentiment: random(4),
      resalePrice: random(4) ? random(300) : 0,
      saleMinutes: random(7) * 5, donateMinutes: random(4) * 5, recycleMinutes: random(3) * 5,
      condition: random(5) === 0 ? 'broken' : 'good',
      lock: random(8) === 0 ? 'keep' : 'auto',
    }));
    const input = settings({ capacityL: 40 + random(110), timeMinutes: random(16) * 5 });
    const result = solvePlans(rows, input);
    for (const objective of OBJECTIVES) {
      const expected = exhaustive(rows, input, objective);
      const actual = result.plans.find(plan => plan.id === objective.id);
      assert.equal(actual.feasible, expected !== null, `sample ${sample}, ${objective.id}`);
      assert.equal(actual.score, expected, `sample ${sample}, ${objective.id}`);
    }
    assertConstraints(result, rows, input);
  }
});

test('fixed vehicle quotes do not claim proportional savings and choose the cheapest fitting tier', () => {
  const tiers = [
    { id: 'small', name: '小车', capacityL: 1000, price: 300 },
    { id: 'large', name: '大车促销报价', capacityL: 2000, price: 250 },
  ];
  assert.equal(getTransportQuote(100, tiers).price, 250);
  assert.equal(getTransportQuote(999, tiers).price, 250);
  assert.equal(getTransportQuote(1500, tiers).id, 'large');
  assert.equal(getTransportQuote(2001, tiers), null);
  assert.equal(getTransportQuote(0, tiers).price, 0);
  const result = solvePlans([item('a', { volumeL: 100, lock: 'keep' })], settings({ tiers }));
  assert.equal(result.plans[0].metrics.transportCost, 250);
  assert.equal(result.baseline.cost, 250);
});

test('locked keep and non-keep actions survive every objective without multiplying group quantity', () => {
  const rows = [item('books', { quantity: 3, volumeL: 60, lock: 'keep' }), item('chair', { volumeL: 120, resalePrice: 200, lock: 'sell', saleMinutes: 20 })];
  const input = settings({ capacityL: 60, timeMinutes: 20 });
  const result = solvePlans(rows, input);
  for (const plan of result.plans) {
    assert.equal(plan.feasible, true);
    assert.equal(plan.metrics.keptVolumeL, 60);
    assert.equal(plan.metrics.resaleIncome, 200);
    assert.equal(plan.metrics.keepCount, 1);
    assert.equal(plan.metrics.sellCount, 1);
  }
  assertConstraints(result, rows, input);
});

test('forced keep over capacity explains infeasibility rather than silently changing decisions', () => {
  const result = solvePlans([item('memory', { name: '纪念箱', volumeL: 201, lock: 'keep' })], settings({ capacityL: 200 }));
  for (const plan of result.plans) {
    assert.equal(plan.feasible, false);
    assert.match(plan.reason, /锁定带走.*210.*200/u);
    assert.deepEqual(plan.actions, []);
    assert.equal(plan.metrics, null);
  }
});

test('broken items cannot be sold or donated; an incompatible lock is diagnosed', () => {
  for (const lock of ['sell', 'donate']) {
    const result = solvePlans([item('broken', { condition: 'broken', resalePrice: 200, lock })]);
    assert.ok(result.plans.every(plan => !plan.feasible && /损坏/.test(plan.reason)));
  }
  const rows = [item('broken', { condition: 'broken', resalePrice: 5000 })];
  const input = settings({ capacityL: 0, timeMinutes: 10 });
  const result = solvePlans(rows, input);
  assert.ok(result.plans.every(plan => plan.actions[0].action === 'recycle'));
  assertConstraints(result, rows, input);
});

test('locked zero-price transfer and excessive locked handling time are rejected', () => {
  const noPrice = solvePlans([item('sale', { resalePrice: 0, lock: 'sell' })]);
  assert.ok(noPrice.plans.every(plan => !plan.feasible && /金额/.test(plan.reason)));
  const tooLong = solvePlans([item('sale', { resalePrice: 100, saleMinutes: 6, lock: 'sell' })], settings({ timeMinutes: 9 }));
  assert.ok(tooLong.plans.every(plan => !plan.feasible && /10 分钟/.test(plan.reason)));
});

test('missing vehicle capacity is never replaced with an invented quote', () => {
  const input = settings({ capacityL: 2000, timeMinutes: 0, tiers: [{ id: 'small', name: '仅此报价', capacityL: 500, price: 100 }] });
  const result = solvePlans([item('large', { volumeL: 1000, lock: 'keep' })], input);
  assert.equal(result.baseline.transportQuote, null);
  assert.equal(result.baseline.cost, null);
  assert.ok(result.plans.every(plan => !plan.feasible && /车型/.test(plan.reason)));
});

test('zero time permits keeping or explicitly zero-time disposal, never free invented effort', () => {
  const impossible = solvePlans([item('a', { volumeL: 100, recycleMinutes: 5, donateMinutes: 5, saleMinutes: 5 })], settings({ capacityL: 0, timeMinutes: 0 }));
  assert.ok(impossible.plans.every(plan => !plan.feasible));
  const zeroTime = solvePlans([item('a', { volumeL: 100, recycleMinutes: 0 })], settings({ capacityL: 0, timeMinutes: 0 }));
  assert.ok(zeroTime.plans.every(plan => plan.feasible && plan.actions[0].action === 'recycle' && plan.metrics.handlingMinutes === 0));
});

test('draft rows stay out of capacity, income and transport baseline until confirmed', () => {
  const result = solvePlans([item('ready', { volumeL: 50, lock: 'keep' }), item('draft', { volumeL: 9000, resalePrice: 99999, confirmed: false })]);
  assert.equal(result.excludedDrafts, 1);
  assert.equal(result.baseline.volumeL, 50);
  for (const plan of result.plans) {
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].itemId, 'ready');
    assert.equal(plan.metrics.resaleIncome, 0);
  }
});

test('conservative volume/time quantization never crosses real input limits at boundaries', () => {
  const rows = [item('fractional', { volumeL: 10.01, lock: 'keep' })];
  assert.ok(solvePlans(rows, settings({ capacityL: 19.99 })).plans.every(plan => !plan.feasible));
  const result = solvePlans(rows, settings({ capacityL: 20 }));
  assert.ok(result.plans.every(plan => plan.metrics.plannedVolumeL === 20 && plan.metrics.keptVolumeL === 10.01));
  assert.deepEqual(result.quantization, QUANTIZATION);
  const time = solvePlans([item('t', { lock: 'recycle', recycleMinutes: 6 })], settings({ capacityL: 0, timeMinutes: 10 }));
  assert.ok(time.plans.every(plan => plan.metrics.handlingMinutes === 6 && plan.metrics.plannedHandlingMinutes === 10));
});

test('money remains exact to cents across transport, sale and disposal totals', () => {
  const rows = [item('keep', { lock: 'keep' }), item('sell', { lock: 'sell', resalePrice: 200.25 }), item('recycle', { lock: 'recycle', recycleFee: 2.05 })];
  const result = solvePlans(rows, settings({ tiers: [{ id: 'quote', name: '我的报价', capacityL: 1000, price: 103.55 }] }));
  assert.ok(result.plans.every(plan => plan.metrics.netOutlay === -94.65));
});

test('empty projects are valid, deterministic and free from stale assignments', () => {
  const empty = solvePlans([], settings({ capacityL: 0, timeMinutes: 0 }));
  assert.ok(empty.plans.every(plan => plan.feasible && plan.actions.length === 0 && plan.metrics.netOutlay === 0));
  const rows = [item('a', { priority: 2 }), item('b', { resalePrice: 120 })];
  const input = settings({ capacityL: 100, timeMinutes: 30 });
  assert.deepEqual(solvePlans(rows, input).plans, solvePlans(rows, input).plans);
  assert.equal(solvePlans([], input).baseline.volumeL, 0);
});

test('schema rejects malformed/oversized values and drops foreign computed metadata', () => {
  assert.throws(() => normalizeItem(item('bad', { volumeL: '100' })), /有限数字/);
  assert.throws(() => normalizeItem(item('bad', { volumeL: Infinity })), /有限数字/);
  assert.throws(() => normalizeItem(item('bad', { saleMinutes: -1 })), /之间/);
  assert.throws(() => normalizeItem(item('bad', { confirmed: 'true' })), /布尔/);
  assert.throws(() => validateSettings(settings({ moveDate: '2026-02-30' })), /日期/);
  assert.throws(() => validateSettings(settings({ tiers: [] })), /车型/);
  assert.throws(() => solvePlans([item('same'), item('same')]), /重复/);
  assert.throws(() => solvePlans(Array.from({ length: 41 }, (_, index) => item(String(index)))), /40/);
  const normalized = normalizeItem(item('literal', { name: '<img src=x onerror=alert(1)>', chosenAction: 'sell', score: 999999, vector: [1, 2] }));
  assert.equal(normalized.name, '<img src=x onerror=alert(1)>');
  assert.equal(normalized.chosenAction, undefined);
  assert.equal(normalized.score, undefined);
  assert.equal(normalized.vector, undefined);
});
