import type { QuotaState } from './quotaMonitor';
import type { QuotaBucket, QuotaWindow } from './quotas';
import { duration } from './formatQuotas';
import { quotaFreshness, remainingQuotaPercent, type QuotaFreshness } from './quotaDisplay';

export interface QuotaSection {
  title: string;
  usedPercent: number;
  remainingPercent: number;
  resetText: string;
  paceText: string | null;
}

const BAR_CELLS = 16;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function utcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

/** Absolute local date/time with the real process UTC offset (no hardcoded zone). */
export function quotaStamp(ms: number, seconds = false): string {
  if (!Number.isFinite(ms)) return '?';
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '?';
  const head = `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return `${seconds ? `${head}:${pad2(date.getSeconds())}` : head} ${utcOffset(date)}`;
}

function isFreshForPace(state: QuotaState, now: number): boolean {
  return quotaFreshness(state, now) === 'fresh';
}

function windowLabel(kind: 'primary' | 'secondary', window: QuotaWindow, ru: boolean): string {
  const minutes = window.windowDurationMins;
  const length = minutes !== null && Number.isFinite(minutes) && minutes > 0
    ? duration(minutes, ru)
    : ru ? 'длительность неизвестна' : 'duration unknown';
  if (kind === 'primary') return ru ? `Основное окно (${length})` : `Primary (${length})`;
  return ru ? `Дополнительное окно (${length})` : `Secondary (${length})`;
}

function resetText(resetsAt: number | null, ru: boolean, now: number): string {
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt < 0) {
    return ru ? 'время сброса неизвестно' : 'reset time unknown';
  }
  const resetMs = resetsAt * 1000;
  if (!Number.isFinite(resetMs)) return ru ? 'время сброса неизвестно' : 'reset time unknown';
  const absolute = quotaStamp(resetMs, false);
  if (absolute === '?') return ru ? 'время сброса неизвестно' : 'reset time unknown';
  if (!Number.isFinite(now)) return `${ru ? 'сброс' : 'reset'} ${absolute}`;
  if (resetMs <= now) {
    return ru
      ? `сброс ${absolute} (уже прошёл; нужно обновление)`
      : `reset ${absolute} (already passed; awaiting server refresh)`;
  }
  const remaining = duration((resetMs - now) / 60_000, ru);
  return ru
    ? `сброс ${absolute} (через ${remaining})`
    : `reset ${absolute} (in ${remaining})`;
}

function paceText(state: QuotaState, window: QuotaWindow, ru: boolean, now: number): string | null {
  if (!isFreshForPace(state, now)) return null;
  const minutes = window.windowDurationMins;
  const resetsAt = window.resetsAt;
  if (minutes === null || resetsAt === null) return null;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (!Number.isFinite(resetsAt) || resetsAt < 0) return null;
  if (!Number.isFinite(window.usedPercent) || window.usedPercent < 0) return null;

  const windowMs = minutes * 60_000;
  const resetMs = resetsAt * 1000;
  if (!Number.isFinite(windowMs) || !Number.isFinite(resetMs)) return null;
  const elapsedMs = now - (resetMs - windowMs);
  if (!Number.isFinite(elapsedMs)) return null;
  if (elapsedMs < 60_000 || elapsedMs >= windowMs) return null;

  const pace = window.usedPercent / 100 / (elapsedMs / windowMs);
  const value = pace.toFixed(2).replace('.', ru ? ',' : '.');
  return ru
    ? `Примерный темп ≈ ${value}× с начала окна`
    : `Approx. pace ≈ ${value}× since start of window`;
}

function freshnessLabel(freshness: QuotaFreshness, ru: boolean): string {
  switch (freshness) {
    case 'fresh': return ru ? 'актуально' : 'fresh';
    case 'stale': return ru ? 'устарело' : 'stale';
    case 'refresh-needed': return ru ? 'нужно обновить' : 'refresh-needed';
    case 'unavailable': return ru ? 'недоступно' : 'unavailable';
  }
}

/** One section for every window actually reported by the server. */
export function quotaSections(state: QuotaState, ru: boolean, now = Date.now()): QuotaSection[] {
  const sections: QuotaSection[] = [];
  for (const bucket of state.buckets) {
    const name = bucket.name || bucket.id;
    const prefix = (label: string): string => `${name}: ${label}`;
    if (bucket.primary) {
      sections.push({
        title: prefix(windowLabel('primary', bucket.primary, ru)),
        usedPercent: bucket.primary.usedPercent,
        remainingPercent: remainingQuotaPercent(bucket.primary.usedPercent),
        resetText: resetText(bucket.primary.resetsAt, ru, now),
        paceText: paceText(state, bucket.primary, ru, now),
      });
    }
    if (bucket.secondary) {
      sections.push({
        title: prefix(windowLabel('secondary', bucket.secondary, ru)),
        usedPercent: bucket.secondary.usedPercent,
        remainingPercent: remainingQuotaPercent(bucket.secondary.usedPercent),
        resetText: resetText(bucket.secondary.resetsAt, ru, now),
        paceText: paceText(state, bucket.secondary, ru, now),
      });
    }
    if (bucket.individual) {
      sections.push({
        title: prefix(ru ? 'Индивидуальный лимит' : 'Individual limit'),
        usedPercent: bucket.individual.usedPercent,
        remainingPercent: remainingQuotaPercent(bucket.individual.usedPercent),
        resetText: resetText(bucket.individual.resetsAt, ru, now),
        paceText: null,
      });
    }
  }
  return sections;
}

function bar(usedPercent: number): string {
  const finite = Number.isFinite(usedPercent) ? usedPercent : 0;
  const bounded = Math.max(0, Math.min(100, finite));
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(bounded / 100 * BAR_CELLS)));
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)}]`;
}

function creditLines(buckets: QuotaBucket[], ru: boolean): string[] {
  const lines: string[] = [];
  for (const bucket of buckets) {
    const credits = bucket.credits;
    if (!credits || (!credits.unlimited && credits.balance === null)) continue;
    const name = ` (${bucket.name || bucket.id})`;
    const value = credits.unlimited ? (ru ? 'безлимит' : 'unlimited') : credits.balance;
    lines.push(`${ru ? 'Кредиты' : 'Credits'}${name}: ${value}`);
  }
  return lines;
}

function updatedText(state: QuotaState, ru: boolean): string {
  if (state.updatedAt === null) return ru ? 'никогда' : 'never';
  if (!Number.isFinite(state.updatedAt) || state.updatedAt < 0) return ru ? 'неизвестно' : 'unknown';
  return quotaStamp(state.updatedAt, true);
}

export function quotaReport(state: QuotaState, ru: boolean, now = Date.now()): string {
  const freshness = quotaFreshness(state, now);
  const lines: string[] = [ru ? 'Квоты Codex' : 'Codex quota'];
  lines.push(`${ru ? 'Обновлено' : 'Updated'}: ${updatedText(state, ru)}`);
  lines.push(`${ru ? 'Актуальность' : 'Freshness'}: ${freshnessLabel(freshness, ru)}`);

  if (freshness === 'stale') {
    if (state.stale) {
      lines.push(ru
        ? 'Данные устарели: показатели могут быть неактуальны, темп не оценивается.'
        : 'Stale: quota data may be outdated; pace is not estimated.');
    } else if (state.updatedAt !== null && Number.isFinite(state.updatedAt) && now - state.updatedAt > 120_000) {
      lines.push(ru
        ? 'Данные устарели: последнее успешное обновление было более 2 минут назад.'
        : 'Stale: the last successful update was more than 2 minutes ago.');
    } else {
      lines.push(ru
        ? 'Данные устарели: время сброса или обновления некорректно, темп не оценивается.'
        : 'Stale: a reset or update timestamp is invalid; pace is not estimated.');
    }
  }
  if (freshness === 'refresh-needed') {
    lines.push(ru
      ? 'Нужно обновление: время сброса прошло; показаны последние данные сервера (проценты не сброшены).'
      : 'Refresh needed: a reset time has passed; showing the last server snapshot (used values are not reset).');
  }
  if (freshness === 'unavailable') {
    if (state.updatedAt === null) {
      lines.push(ru ? 'Недоступно: данные о квотах не обновлялись.' : 'Unavailable: quota data has not been updated.');
    } else if (state.buckets.length === 0) {
      lines.push(ru
        ? 'Недоступно: метрические данные о квотах не получены.'
        : 'Unavailable: no metered quota buckets were reported.');
    } else {
      lines.push(ru ? 'Недоступно: некорректная отметка обновления.' : 'Unavailable: invalid update timestamp.');
    }
  }

  const sections = quotaSections(state, ru, now);
  if (sections.length === 0) {
    const hasCredits = creditLines(state.buckets, ru).length > 0;
    if (hasCredits) {
      lines.push(ru
        ? 'Метрические окна квот не сообщены; кредиты показаны как данные сервера.'
        : 'No metered quota windows were reported; credits are shown as reported by the server.');
    } else {
      lines.push(ru ? 'Метрические окна квот не сообщены.' : 'No metered quota windows were reported.');
    }
  }
  for (const section of sections) {
    lines.push(`${section.title} ${bar(section.usedPercent)} ${section.usedPercent}% ` +
      `${ru ? 'исп.' : 'used'} · ${section.remainingPercent}% ${ru ? 'осталось' : 'remaining'} · ${section.resetText}`);
    if (section.paceText !== null) lines.push(`  ${section.paceText}`);
  }
  lines.push(...creditLines(state.buckets, ru));
  return lines.join('\n');
}
