import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaReport, quotaSections } from '../../src/quotaPresentation';
import type { QuotaState } from '../../src/quotaMonitor';
import type { QuotaBucket, QuotaWindow } from '../../src/quotas';
import { duration } from '../../src/formatQuotas';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

function bucket(id: string, name: string, primary: QuotaWindow | null = null, secondary: QuotaWindow | null = null): QuotaBucket {
  return { id, name, primary, secondary };
}

function state(buckets: QuotaBucket[], updatedAt: number | null = NOW, stale = false): QuotaState {
  return { buckets, updatedAt, stale };
}

function windowAt(usedPercent: number, elapsedMs: number, windowMs: number, now = NOW): QuotaWindow {
  return {
    usedPercent,
    windowDurationMins: windowMs / 60_000,
    resetsAt: (now + (windowMs - elapsedMs)) / 1000,
  };
}

function offset(ms: number): string {
  const date = new Date(ms);
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

test('sections follow actual primary, secondary and individual slots without assuming 5h/7d', () => {
  const code = bucket('codex', 'Code');
  code.primary = windowAt(25, 60 * 60_000, 120 * 60_000);
  code.secondary = { usedPercent: 40, windowDurationMins: 30, resetsAt: (NOW + 20 * 60_000) / 1000 };
  code.individual = { usedPercent: 10, resetsAt: (NOW + 60 * 60_000) / 1000 };
  const sections = quotaSections(state([code]), false, NOW);

  assert.equal(sections.length, 3);
  assert.deepEqual(sections.map(section => section.title), [
    'Code: Primary (2h)',
    'Code: Secondary (30m)',
    'Code: Individual limit',
  ]);
  assert.equal(sections[0]?.usedPercent, 25);
  assert.equal(sections[0]?.remainingPercent, 75);
  assert.ok(sections[0]!.resetText.includes(offset(NOW + 60 * 60_000)));
  assert.match(sections[0]!.resetText, /\(in 1h\)$/);
  assert.match(sections[1]!.resetText, /\(in 20m\)$/);
  assert.match(sections[2]!.resetText, /\(in 1h\)$/);
  assert.equal(sections[2]?.paceText, null);
});

test('multiple buckets and partial windows keep names and skip absent slots', () => {
  const code = bucket('codex', 'Code', windowAt(10, 30 * 60_000, 120 * 60_000), null);
  const review = bucket('review', 'Review', null, windowAt(20, 10 * 60_000, 60 * 60_000));
  review.individual = { usedPercent: 5, resetsAt: (NOW + 15 * 60_000) / 1000 };
  const sections = quotaSections(state([code, review]), false, NOW);

  assert.deepEqual(sections.map(section => section.title), [
    'Code: Primary (2h)',
    'Review: Secondary (1h)',
    'Review: Individual limit',
  ]);
});

test('pace arithmetic is used-percent divided by elapsed fraction with one-minute boundaries', () => {
  const cases = [
    [25, 60 * 60_000, 120 * 60_000, '0.50'],
    [50, 60 * 60_000, 120 * 60_000, '1.00'],
    [50, 30 * 60_000, 120 * 60_000, '2.00'],
    [0, 60_000, 120 * 60_000, '0.00'],
  ] as const;
  for (const [used, elapsed, windowMs, expected] of cases) {
    const candidate = bucket('codex', 'Code', windowAt(used, elapsed, windowMs));
    const pace = quotaSections(state([candidate]), false, NOW)[0]?.paceText;
    assert.equal(pace, `Approx. pace ≈ ${expected}× since start of window`);
  }

  const tooEarly = bucket('codex', 'Code', windowAt(10, 59_999, 120 * 60_000));
  assert.equal(quotaSections(state([tooEarly]), false, NOW)[0]?.paceText, null);

  const exactlyOneMinute = bucket('codex', 'Code', windowAt(1, 60_000, 120 * 60_000));
  assert.equal(
    quotaSections(state([exactlyOneMinute]), false, NOW)[0]?.paceText,
    'Approx. pace ≈ 1.20× since start of window',
  );
});

test('pace is unavailable for expired or incomplete windows and stale snapshots', () => {
  const expired = bucket('codex', 'Code', {
    usedPercent: 99,
    windowDurationMins: 60,
    resetsAt: (NOW - 60_000) / 1000,
  });
  const expiredSection = quotaSections(state([expired]), false, NOW)[0]!;
  assert.match(expiredSection.resetText, /already passed; awaiting server refresh/);
  assert.equal(expiredSection.paceText, null);

  const unknown = bucket('codex', 'Code', { usedPercent: 5, windowDurationMins: null, resetsAt: null });
  const unknownSection = quotaSections(state([unknown]), false, NOW)[0]!;
  assert.equal(unknownSection.resetText, 'reset time unknown');
  assert.equal(unknownSection.paceText, null);

  const noDuration = bucket('codex', 'Code', { usedPercent: 5, windowDurationMins: null, resetsAt: (NOW + 60_000) / 1000 });
  assert.equal(quotaSections(state([noDuration]), false, NOW)[0]?.paceText, null);

  const valid = bucket('codex', 'Code', windowAt(50, 60 * 60_000, 120 * 60_000));
  assert.equal(quotaSections(state([valid], NOW, true), false, NOW)[0]?.paceText, null);
  assert.equal(quotaSections(state([valid], NOW - 120_001), false, NOW)[0]?.paceText, null);
  assert.notEqual(quotaSections(state([valid], NOW - 120_000), false, NOW)[0]?.paceText, null);
});

test('report has a localized update stamp, 16-cell bars, exact percent, reset and pace', () => {
  const code = bucket('codex', 'Code', {
    usedPercent: 37.5,
    windowDurationMins: 120,
    resetsAt: (NOW + 60 * 60_000) / 1000,
  });
  code.credits = { balance: '42.5', unlimited: false };
  const report = quotaReport(state([code]), false, NOW);

  assert.match(report, /^Codex quota\nUpdated: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2}\nFreshness: fresh/);
  assert.ok(report.includes(offset(NOW)));
  assert.ok(report.includes('Code: Primary (2h) [██████░░░░░░░░░░] 37.5% used · 62.5% remaining'));
  assert.ok(report.includes(offset(NOW + 60 * 60_000)));
  assert.match(report, /\(in 1h\)/);
  assert.ok(report.includes('Approx. pace ≈ 0.75× since start of window'));
  assert.ok(report.includes('Credits (Code): 42.5'));
  assert.ok(!report.includes('Stale:'));
});

test('bars clamp drawing to 16 cells while percentages remain exact', () => {
  const empty = bucket('codex', 'Code', { usedPercent: 0, windowDurationMins: 60, resetsAt: (NOW + 60_000) / 1000 });
  const over = bucket('review', 'Review', { usedPercent: 150, windowDurationMins: 60, resetsAt: (NOW + 60_000) / 1000 });
  over.credits = { balance: null, unlimited: true };
  const report = quotaReport(state([empty, over]), false, NOW);

  assert.ok(report.includes('[░░░░░░░░░░░░░░░░] 0%'));
  assert.ok(report.includes('[████████████████] 150%'));
  assert.ok(report.includes('Credits (Review): unlimited'));
});

test('stale, aged and unavailable snapshots are marked and suppress pace claims', () => {
  const valid = bucket('codex', 'Code', windowAt(50, 60 * 60_000, 120 * 60_000));
  const stale = quotaReport(state([valid], NOW, true), false, NOW);
  assert.match(stale, /Freshness: stale/);
  assert.match(stale, /Stale: quota data may be outdated/);
  assert.ok(!stale.includes('Approx. pace'));

  const aged = quotaReport(state([valid], NOW - 120_001), false, NOW);
  assert.match(aged, /Freshness: stale/);
  assert.match(aged, /Stale: the last successful update was more than 2 minutes ago/);
  assert.ok(!aged.includes('Approx. pace'));

  const freshBoundary = quotaReport(state([valid], NOW - 120_000), false, NOW);
  assert.match(freshBoundary, /Freshness: fresh/);
  assert.ok(freshBoundary.includes('Approx. pace ≈ 1.00×'));
  assert.ok(!freshBoundary.includes('Stale:'));

  const unavailable = quotaReport(state([], null), false, NOW);
  assert.ok(unavailable.includes('Updated: never'));
  assert.match(unavailable, /Freshness: unavailable/);
  assert.ok(unavailable.includes('Unavailable: quota data has not been updated.'));
  assert.ok(!unavailable.includes('Stale:'));

  const invalid = quotaReport(state([valid], Number.NaN), false, NOW);
  assert.ok(invalid.includes('Updated: unknown'));
  assert.match(invalid, /Freshness: unavailable/);
  assert.ok(invalid.includes('Unavailable: invalid update timestamp.'));
});

test('Russian output localizes slots, resets, pace and unlimited credits', () => {
  const code = bucket('codex', 'Code', {
    usedPercent: 50,
    windowDurationMins: 120,
    resetsAt: (NOW + 60 * 60_000) / 1000,
  });
  code.credits = { balance: null, unlimited: true };
  const report = quotaReport(state([code]), true, NOW);
  const section = quotaSections(state([code]), true, NOW)[0]!;

  assert.ok(report.startsWith('Квоты Codex\nОбновлено: '));
  assert.ok(report.includes('Актуальность: актуально'));
  assert.ok(section.title.startsWith('Code: Основное окно (2'));
  assert.ok(section.resetText.includes(offset(NOW + 60 * 60_000)));
  assert.match(section.resetText, /\(через /);
  assert.ok(report.includes(duration(60, true)));
  assert.ok(report.includes('50% исп. · 50% осталось'));
  assert.ok(report.includes('Примерный темп ≈ 1,00× с начала окна'));
  assert.ok(report.includes('Кредиты (Code): безлимит'));
});

test('refresh-needed marker keeps the last used value, shows remaining and suppresses pace', () => {
  const expired = bucket('codex', 'Code', {
    usedPercent: 87,
    windowDurationMins: 60,
    resetsAt: (NOW - 60_000) / 1000,
  });
  const report = quotaReport(state([expired]), false, NOW);
  const section = quotaSections(state([expired]), false, NOW)[0]!;

  assert.match(report, /Freshness: refresh-needed/);
  assert.ok(report.includes('Refresh needed: a reset time has passed'));
  assert.ok(report.includes(`${offset(NOW - 60_000)} (already passed; awaiting server refresh)`));
  assert.ok(report.includes('87% used · 13% remaining'));
  assert.ok(!report.includes('0% used'));
  assert.ok(!report.includes('Approx. pace'));
  assert.equal(section.paceText, null);
});

test('report keeps every bucket title and exact server credit strings', () => {
  const code = bucket('codex', 'Code', windowAt(10, 30 * 60_000, 120 * 60_000));
  code.credits = { balance: '42.50', unlimited: false };
  const review = bucket('review', 'Review', null, windowAt(20, 10 * 60_000, 60 * 60_000));
  review.credits = { balance: null, unlimited: true };
  review.individual = { usedPercent: 5, resetsAt: (NOW + 15 * 60_000) / 1000 };

  const report = quotaReport(state([code, review]), false, NOW);
  assert.ok(report.includes('Code: Primary (2h)'));
  assert.ok(report.includes('Review: Secondary (1h)'));
  assert.ok(report.includes('Review: Individual limit'));
  assert.ok(report.includes('Credits (Code): 42.50'));
  assert.ok(report.includes('Credits (Review): unlimited'));

  const single = quotaReport(state([code]), false, NOW);
  assert.ok(single.includes('Credits (Code): 42.50'));
  assert.ok(!single.includes('Credits (Code): 42.5\n'));
});

test('credits-only report does not fabricate a window', () => {
  const credits = bucket('codex', 'Code');
  credits.credits = { balance: '12.3400', unlimited: false };
  const report = quotaReport(state([credits]), false, NOW);

  assert.ok(report.includes('Freshness: fresh'));
  assert.ok(report.includes('No metered quota windows were reported; credits are shown as reported by the server.'));
  assert.ok(report.includes('Credits (Code): 12.3400'));
  assert.ok(!report.includes('%'));
  assert.ok(!report.includes('Approx. pace'));
});

test('bucket names and credit strings stay literal text in the report', () => {
  const weird = bucket('weird', '**Code**', windowAt(5, 30 * 60_000, 60 * 60_000));
  weird.credits = { balance: '*42*', unlimited: false };
  const report = quotaReport(state([weird]), false, NOW);

  assert.ok(report.includes('**Code**: Primary (1h)'));
  assert.ok(report.includes('Credits (**Code**): *42*'));
});
