import type { QuotaBucket } from './quotas';

export function duration(minutes: number, ru: boolean): string {
  minutes = Math.max(0, Math.ceil(minutes));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const mins = Math.ceil(minutes % 60);
  const parts = [days ? `${days}${ru ? 'д' : 'd'}` : '', hours ? `${hours}${ru ? 'ч' : 'h'}` : '', !days && mins ? `${mins}${ru ? 'м' : 'm'}` : ''].filter(Boolean);
  return parts.join(' ') || `0${ru ? 'м' : 'm'}`;
}

const DECIMAL_BALANCE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_RAW_BALANCE = 10;

/**
 * Whole-number credit balance for compact text. Halves round away from zero,
 * a non-zero balance that would round to 0 is shown as <1, and a string that
 * is not a plain decimal stays literal (shortened) instead of becoming unknown or zero.
 */
export function roundedCreditBalance(balance: string | null): string {
  if (balance === null) return '?';
  const trimmed = balance.trim();
  if (trimmed === '') return '?';
  const value = DECIMAL_BALANCE.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isFinite(value)) {
    const characters = Array.from(trimmed);
    return characters.length > MAX_RAW_BALANCE
      ? `${characters.slice(0, MAX_RAW_BALANCE - 1).join('')}…`
      : trimmed;
  }
  // Beyond 2^53 rounding would print digits the server never sent.
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) return trimmed;
  if (value === 0) return '0';
  const rounded = Math.round(Math.abs(value));
  if (rounded === 0) return value > 0 ? '<1' : '>-1';
  return String(value < 0 ? -rounded : rounded);
}

export function quotaText(buckets: QuotaBucket[], ru: boolean, now = Date.now()): string {
  const parts: string[] = [];
  for (const bucket of buckets) {
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!window) continue;
      const label = window.windowDurationMins === null ? '?' : duration(window.windowDurationMins, ru);
      const reset = window.resetsAt === null ? '?' : duration(Math.max(0, Math.ceil((window.resetsAt * 1000 - now) / 60000)), ru);
      parts.push(`${buckets.length > 1 ? bucket.name + ' ' : ''}${label}: ${window.usedPercent}% · ${ru ? 'сброс через' : 'resets in'} ${reset}`);
    }
    if (bucket.individual) {
      const reset = duration(Math.max(0, Math.ceil((bucket.individual.resetsAt * 1000 - now) / 60000)), ru);
      parts.push(`${bucket.name} ${ru ? 'личный' : 'individual'}: ${bucket.individual.usedPercent}% · ${ru ? 'сброс через' : 'resets in'} ${reset}`);
    }
    if (bucket.credits && (bucket.credits.unlimited || bucket.credits.balance !== null)) {
      parts.push(`${ru ? 'кредиты' : 'credits'}: ${bucket.credits.unlimited ? '∞' : roundedCreditBalance(bucket.credits.balance)}`);
    }
  }
  return 'Codex · ' + (parts.join(' | ') || (ru ? 'лимиты не указаны' : 'no windows reported'));
}
