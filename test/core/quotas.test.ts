import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuotas } from '../../src/quotas';
import { duration, quotaText } from '../../src/formatQuotas';

test('all named quota buckets survive and newer map replaces duplicate legacy bucket', () => {
  const buckets = parseQuotas({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 1 } },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', limitName: 'Code', primary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 604740 } },
      review: { limitName: 'Review', primary: null, secondary: { usedPercent: 17, windowDurationMins: 120, resetsAt: 7200 } },
      absent: null,
    },
  });
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0]?.primary?.usedPercent, 9);
  assert.equal(quotaText(buckets, true, 0), 'Codex · Code 7д: 9% · сброс через 6д 23ч | Review 2ч: 17% · сброс через 2ч');
});

test('nullable quota fields stay unknown and absent windows remain explicit', () => {
  const buckets = parseQuotas({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null }, secondary: null } });
  assert.equal(quotaText(buckets, false, 0), 'Codex · ?: 0% · resets in ?');
  assert.equal(quotaText(parseQuotas({ rateLimits: {} }), true), 'Codex · лимиты не указаны');
  assert.deepEqual(parseQuotas({ rateLimits: { primary: { usedPercent: 101 } } })[0]?.primary, { usedPercent: 101, windowDurationMins: null, resetsAt: null });
});

test('duration and reset text derive from server duration and current time', () => {
  assert.equal(duration(90, true), '1ч 30м');
  assert.equal(duration(2880, false), '2d');
  const buckets = parseQuotas({ rateLimits: { primary: { usedPercent: 2.5, windowDurationMins: 30, resetsAt: 3600 } } });
  assert.equal(quotaText(buckets, false, 0), 'Codex · 30m: 2.5% · resets in 1h');
  assert.equal(quotaText(buckets, false, 3_599_001), 'Codex · 30m: 2.5% · resets in 1m');
  assert.equal(quotaText(buckets, false, 4_000_000), 'Codex · 30m: 2.5% · resets in 0m');
});

test('malformed quota values reject instead of displaying false percentages', () => {
  for (const value of [null, [], {}, { rateLimitsByLimitId: [] }, { rateLimits: { primary: { usedPercent: '9' } } }, { rateLimits: { primary: { usedPercent: NaN } } }, { rateLimits: { primary: { usedPercent: -1 } } }, { rateLimits: { primary: { usedPercent: 9, resetsAt: -1 } } }, { rateLimits: { primary: { usedPercent: 9, windowDurationMins: 0 } } }]) {
    assert.throws(() => parseQuotas(value));
  }
});

test('individual usage limit and credit balance accompany quota windows', () => {
  const buckets = parseQuotas({ rateLimits: {
    individualLimit: { limit: '100', used: '25', remainingPercent: 75, resetsAt: 3600 },
    credits: { hasCredits: true, unlimited: false, balance: '42.5' },
  } });
  assert.equal(quotaText(buckets, true, 0), 'Codex · codex личный: 25% · сброс через 1ч | кредиты: 43');
});
