import type { QuotaBucket } from './quotas';

export function duration(minutes: number, ru: boolean): string {
  minutes = Math.max(0, Math.ceil(minutes));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const mins = Math.ceil(minutes % 60);
  const parts = [days ? `${days}${ru ? 'д' : 'd'}` : '', hours ? `${hours}${ru ? 'ч' : 'h'}` : '', !days && mins ? `${mins}${ru ? 'м' : 'm'}` : ''].filter(Boolean);
  return parts.join(' ') || `0${ru ? 'м' : 'm'}`;
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
      parts.push(`${ru ? 'кредиты' : 'credits'}: ${bucket.credits.unlimited ? '∞' : bucket.credits.balance}`);
    }
  }
  return 'Codex · ' + (parts.join(' | ') || (ru ? 'лимиты не указаны' : 'no windows reported'));
}
