import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaDisplay, quotaFreshness, remainingQuotaPercent } from '../../src/quotaDisplay';
import { quotaReport } from '../../src/quotaPresentation';
import type { QuotaState } from '../../src/quotaMonitor';
import type { QuotaBucket, QuotaWindow } from '../../src/quotas';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

function bucket(
  id: string,
  name: string,
  primary: QuotaWindow | null = null,
  secondary: QuotaWindow | null = null,
): QuotaBucket {
  return { id, name, primary, secondary };
}

function state(buckets: QuotaBucket[], updatedAt: number | null = NOW, stale = false): QuotaState {
  return { buckets, updatedAt, stale };
}

function window(usedPercent: number, durationMins: number | null, resetOffsetMs: number | null = 60 * 60_000): QuotaWindow {
  return {
    usedPercent,
    windowDurationMins: durationMins,
    resetsAt: resetOffsetMs === null ? null : (NOW + resetOffsetMs) / 1000,
  };
}

test('compact status ranks the two most consumed windows, keeps real durations and counts omissions', () => {
  const code = bucket('code', 'Code');
  code.primary = window(40, 300);
  code.secondary = window(90, 10080);
  const review = bucket('review', 'Review');
  review.primary = window(95, 60);

  const display = quotaDisplay(state([code, review]), false, NOW);

  assert.equal(display.freshness, 'fresh');
  assert.equal(display.severity, 'warning');
  assert.equal(display.text, '$(codex-companion-logo) · Review: 1h used 95% · Code: 7d used 90% · +1');
});

test('severity uses the maximum across all windows, including omitted ones, and preserves over-100 values', () => {
  const code = bucket('code', 'Code');
  code.primary = window(10, 60);
  code.secondary = window(100, 300);
  const review = bucket('review', 'Review');
  review.primary = window(20, 60);

  const display = quotaDisplay(state([code, review]), false, NOW);
  assert.equal(display.severity, 'error');
  assert.ok(display.text.includes('100%'));
  assert.ok(display.text.includes('+1'));

  for (const [used, severity] of [
    [89.9, 'normal'],
    [90, 'warning'],
    [99.9, 'warning'],
    [100, 'error'],
    [150, 'error'],
  ] as const) {
    const candidate = bucket('code', 'Code', window(used, 60));
    const result = quotaDisplay(state([candidate]), false, NOW);
    assert.equal(result.severity, severity);
    assert.ok(result.text.includes(`${used}%`));
  }
});

test('remaining percentage is clamped to 0..100 and never rounds server values', () => {
  assert.equal(remainingQuotaPercent(0), 100);
  assert.equal(remainingQuotaPercent(37.5), 62.5);
  assert.equal(remainingQuotaPercent(90), 10);
  assert.equal(remainingQuotaPercent(100), 0);
  assert.equal(remainingQuotaPercent(150), 0);
  assert.equal(remainingQuotaPercent(-20), 100);
  assert.equal(remainingQuotaPercent(Number.POSITIVE_INFINITY), 0);
  assert.equal(remainingQuotaPercent(Number.NaN), 0);
});

test('long bucket names are bounded and individual windows are valid metered windows', () => {
  const long = bucket('long', 'A very long bucket name', window(91, 300));
  const other = bucket('other', 'Other');
  other.individual = { usedPercent: 100, resetsAt: (NOW + 60 * 60_000) / 1000 };

  const display = quotaDisplay(state([long, other]), false, NOW);

  assert.equal(display.severity, 'error');
  assert.ok(display.text.includes('Other: individual used 100%'));
  assert.match(display.text, /A very long buc…: 5h used 91%/);
});

test('unknown window durations are shown as unknown instead of a fabricated duration', () => {
  const unknown = bucket('code', 'Code', window(5, null, null));
  const display = quotaDisplay(state([unknown]), false, NOW);

  assert.equal(display.freshness, 'fresh');
  assert.equal(display.text, '$(codex-companion-logo) · ? used 5%');
});

test('stale, missing and invalid snapshots are marked without pretending freshness', () => {
  const valid = bucket('code', 'Code', window(50, 60));

  assert.equal(quotaDisplay(state([valid], NOW - 120_000), false, NOW).freshness, 'fresh');
  const aged = quotaDisplay(state([valid], NOW - 120_001), false, NOW);
  assert.equal(aged.freshness, 'stale');
  assert.ok(aged.text.includes('⚠ stale'));

  const staleFlag = quotaDisplay(state([valid], NOW, true), false, NOW);
  assert.equal(staleFlag.freshness, 'stale');
  assert.ok(staleFlag.text.includes('⚠ stale'));

  const missing = quotaDisplay(state([valid], null), false, NOW);
  assert.equal(missing.freshness, 'unavailable');
  assert.equal(missing.text, '$(codex-companion-logo) · quotas unavailable');
  assert.ok(!missing.text.includes('%'));

  assert.equal(quotaDisplay(state([valid], Number.NaN), false, NOW).freshness, 'unavailable');
  assert.equal(quotaDisplay(state([valid], NOW + 1), false, NOW).freshness, 'stale');

  const invalidReset = bucket('code', 'Code', {
    usedPercent: 50,
    windowDurationMins: 60,
    resetsAt: Number.NaN,
  });
  assert.equal(quotaDisplay(state([invalidReset]), false, NOW).freshness, 'stale');
});

test('a passed reset is refresh-needed and keeps the last used value instead of inventing 0%', () => {
  const expired = bucket('code', 'Code', {
    usedPercent: 87,
    windowDurationMins: 300,
    resetsAt: (NOW - 1_000) / 1000,
  });

  const display = quotaDisplay(state([expired]), false, NOW);
  assert.equal(display.freshness, 'refresh-needed');
  assert.equal(display.severity, 'normal');
  assert.ok(display.text.includes('5h used 87%'));
  assert.ok(display.text.includes('↻ refresh needed'));
  assert.ok(!display.text.includes('0%'));

  assert.equal(quotaDisplay(state([expired], NOW, true), false, NOW).freshness, 'refresh-needed');
});

test('credits-only snapshots round balances only in the status bar', () => {
  const credits = bucket('code', 'Code');
  credits.credits = { balance: '42.500', unlimited: false };

  const display = quotaDisplay(state([credits]), false, NOW);
  assert.equal(display.freshness, 'fresh');
  assert.equal(display.severity, 'normal');
  assert.equal(display.text, '$(codex-companion-logo) · $(credit-card) 43');
  assert.ok(!display.text.includes('%'));

  const unlimited = bucket('code', 'Code');
  unlimited.credits = { balance: null, unlimited: true };
  assert.equal(quotaDisplay(state([unlimited]), false, NOW).text, '$(codex-companion-logo) · $(credit-card) ∞');

  const alpha = bucket('alpha', 'Alpha');
  alpha.credits = { balance: '1', unlimited: false };
  const beta = bucket('beta', 'Beta');
  beta.credits = { balance: '*2.0*', unlimited: false };
  assert.equal(
    quotaDisplay(state([alpha, beta]), false, NOW).text,
    '$(codex-companion-logo) · $(credit-card) Alpha 1 · $(credit-card) Beta *2.0*',
  );
});

test('credits follow ranked windows and the window +N, with multi-bucket names shown once each', () => {
  const code = bucket('code', 'Code');
  code.primary = window(40, 300);
  code.secondary = window(90, 10080);
  code.credits = { balance: '42.500', unlimited: false };
  const review = bucket('review', 'Review');
  review.primary = window(95, 60);
  review.credits = { balance: '7', unlimited: false };

  const display = quotaDisplay(state([code, review]), false, NOW);
  assert.equal(
    display.text,
    '$(codex-companion-logo) · Review: 1h used 95% · Code: 7d used 90% · +1 · $(credit-card) Review 7 · $(credit-card) Code 43',
  );
  assert.equal(display.text.split('$(credit-card)').length - 1, 2);
});

test('credit rounding covers boundaries, signs and invalid server strings without inventing zero', () => {
  const cases: Array<[string | null | undefined, boolean, string]> = [
    ['42.500', false, '$(credit-card) 43'],
    ['42.49', false, '$(credit-card) 42'],
    ['0', false, '$(credit-card) 0'],
    ['-0', false, '$(credit-card) 0'],
    ['0.4', false, '$(credit-card) <1'],
    ['-0.4', false, '$(credit-card) >-1'],
    ['0.5', false, '$(credit-card) 1'],
    ['-0.5', false, '$(credit-card) -1'],
    ['2.5', false, '$(credit-card) 3'],
    ['-2.5', false, '$(credit-card) -3'],
    ['-12.4', false, '$(credit-card) -12'],
    [' -2.6 ', false, '$(credit-card) -3'],
    ['+7.5', false, '$(credit-card) 8'],
    ['1e3', false, '$(credit-card) 1000'],
    ['9007199254740993', false, '$(credit-card) 9007199254740993'],
    ['1e21', false, '$(credit-card) 1e21'],
    ['1e9999', false, '$(credit-card) 1e9999'],
    ['', false, '$(credit-card) ?'],
    ['   ', false, '$(credit-card) ?'],
    ['Infinity', false, '$(credit-card) Infinity'],
    ['0x10', false, '$(credit-card) 0x10'],
    ['1,234.50', false, '$(credit-card) 1,234.50'],
    ['12,5', false, '$(credit-card) 12,5'],
    ['balance unknown', false, '$(credit-card) balance u…'],
    ['123', true, '$(credit-card) ∞'],
    [null, true, '$(credit-card) ∞'],
    [null, false, 'no metered windows'],
    [undefined, false, 'no metered windows'],
  ];
  for (const [balance, unlimited, expected] of cases) {
    const candidate = bucket('code', 'Code');
    if (balance !== undefined) candidate.credits = { balance, unlimited };
    assert.equal(quotaDisplay(state([candidate]), false, NOW).text, `$(codex-companion-logo) · ${expected}`);
  }
});

test('credits-only buckets follow windowed ones and hidden credits get a card-marked counter', () => {
  const plain = bucket('plain', 'Plain');
  plain.credits = { balance: '0', unlimited: false };
  const spark = bucket('spark', 'Spark', window(10, 60));
  spark.credits = { balance: '3', unlimited: false };
  const code = bucket('code', 'CodeWithAVeryLongName', window(95, 60));
  code.credits = { balance: '5', unlimited: false };

  const display = quotaDisplay(state([plain, spark, code]), false, NOW);
  assert.equal(
    display.text,
    '$(codex-companion-logo) · CodeWithAVeryLo…: 1h used 95% · Spark: 1h used 10% · $(credit-card) CodeWithA… 5 · $(credit-card) Spark 3 · $(credit-card) +1',
  );
});

test('credits stay before stale and refresh-needed markers', () => {
  const staleBucket = bucket('code', 'Code', window(50, 60));
  staleBucket.credits = { balance: '42.500', unlimited: false };
  const stale = quotaDisplay(state([staleBucket], NOW, true), false, NOW);
  assert.equal(stale.text, '$(codex-companion-logo) · 1h used 50% · $(credit-card) 43 · ⚠ stale');

  const expired = bucket('code', 'Code', {
    usedPercent: 50,
    windowDurationMins: 60,
    resetsAt: (NOW - 1_000) / 1000,
  });
  expired.credits = { balance: '42.500', unlimited: false };
  assert.equal(
    quotaDisplay(state([expired]), false, NOW).text,
    '$(codex-companion-logo) · 1h used 50% · $(credit-card) 43 · ↻ refresh needed',
  );
});

test('the status bar rounds credits while the report keeps the exact server string', () => {
  const credits = bucket('code', 'Code');
  credits.credits = { balance: '42.500', unlimited: false };
  const snapshot = state([credits]);

  assert.equal(quotaDisplay(snapshot, false, NOW).text, '$(codex-companion-logo) · $(credit-card) 43');
  const report = quotaReport(snapshot, false, NOW);
  assert.ok(report.includes('Credits (Code): 42.500'));
  assert.ok(!report.includes('Credits (Code): 43'));
});

test('server strings are kept literal and no windows plus no credits is explicit', () => {
  const weird = bucket('weird', '**Code**', window(5, 60));
  const second = bucket('second', 'Second', window(1, 60));
  const display = quotaDisplay(state([weird, second]), false, NOW);

  assert.ok(display.text.includes('**Code**: 1h used 5%'));
  assert.equal(quotaDisplay(state([bucket('code', 'Code')]), false, NOW).text, '$(codex-companion-logo) · no metered windows');
});

test('Russian compact text uses used/исп. labels and localized freshness markers', () => {
  const valid = bucket('code', 'Code', window(95, 120));
  const fresh = quotaDisplay(state([valid]), true, NOW);
  assert.ok(fresh.text.includes('2ч исп. 95%'));
  assert.equal(fresh.severity, 'warning');

  const stale = quotaDisplay(state([valid], NOW, true), true, NOW);
  assert.ok(stale.text.includes('⚠ устарело'));

  const credits = bucket('code', 'Code');
  credits.credits = { balance: '5', unlimited: false };
  assert.ok(quotaDisplay(state([credits]), true, NOW).text.includes('$(credit-card) 5'));

  assert.equal(quotaFreshness(state([valid]), NOW), 'fresh');
});

test('stale or expired high usage does not advertise a fresh exhausted limit', () => {
  const high=bucket('code','Code',window(100,60));
  assert.equal(quotaDisplay(state([high],NOW,true),false,NOW).severity,'normal');
  const expired=bucket('code','Code',window(150,60,-1));
  assert.equal(quotaDisplay(state([expired]),false,NOW).severity,'normal');
  assert.equal(quotaDisplay(state([high]),false,NOW).severity,'error');
});

test('finite timestamps outside the Date range are not presented as valid dates', () => {
  const valid=bucket('code','Code',window(50,60));
  assert.equal(quotaFreshness(state([valid],1e100),NOW),'unavailable');
  valid.primary!.resetsAt=1e100;
  assert.equal(quotaFreshness(state([valid]),NOW),'stale');
});
