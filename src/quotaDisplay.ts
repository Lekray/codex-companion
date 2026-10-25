import type { QuotaState } from './quotaMonitor';
import type { QuotaBucket } from './quotas';
import { duration, roundedCreditBalance } from './formatQuotas';

export type QuotaSeverity = 'normal' | 'warning' | 'error';
export type QuotaFreshness = 'fresh' | 'stale' | 'refresh-needed' | 'unavailable';

export interface QuotaDisplay {
  text: string;
  severity: QuotaSeverity;
  freshness: QuotaFreshness;
}

const STALE_AFTER_MS = 120_000;
const MAX_COMPACT_WINDOWS = 2;
const MAX_BUCKET_LABEL = 16;
const MAX_CREDIT_LABEL = 10;

interface MeteredWindow {
  bucket: QuotaBucket;
  kind: 'primary' | 'secondary' | 'individual';
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

function meteredWindows(buckets: QuotaBucket[]): MeteredWindow[] {
  const windows: MeteredWindow[] = [];
  for (const bucket of buckets) {
    const primary = bucket.primary;
    if (primary && Number.isFinite(primary.usedPercent) && primary.usedPercent >= 0) {
      windows.push({
        bucket,
        kind: 'primary',
        usedPercent: primary.usedPercent,
        windowDurationMins: primary.windowDurationMins,
        resetsAt: primary.resetsAt,
      });
    }
    const secondary = bucket.secondary;
    if (secondary && Number.isFinite(secondary.usedPercent) && secondary.usedPercent >= 0) {
      windows.push({
        bucket,
        kind: 'secondary',
        usedPercent: secondary.usedPercent,
        windowDurationMins: secondary.windowDurationMins,
        resetsAt: secondary.resetsAt,
      });
    }
    const individual = bucket.individual;
    if (individual && Number.isFinite(individual.usedPercent) && individual.usedPercent >= 0) {
      windows.push({
        bucket,
        kind: 'individual',
        usedPercent: individual.usedPercent,
        windowDurationMins: null,
        resetsAt: individual.resetsAt,
      });
    }
  }
  return windows;
}

/** Remaining share after the server-reported used percentage, always 0..100. */
export function remainingQuotaPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, 100 - percent));
}

/**
 * Freshness of the snapshot. A passed reset needs a server refresh: the old
 * used percentage must not be presented as the current window state.
 */
export function quotaFreshness(state: QuotaState, now = Date.now()): QuotaFreshness {
  if (state.buckets.length === 0) return 'unavailable';
  if (state.updatedAt === null) return 'unavailable';
  if (!Number.isFinite(state.updatedAt) || state.updatedAt < 0 || !Number.isFinite(new Date(state.updatedAt).getTime())) return 'unavailable';
  if (!Number.isFinite(now)) return 'stale';

  const windows = meteredWindows(state.buckets);
  if (windows.some(window => window.resetsAt !== null && (
    !Number.isFinite(window.resetsAt) ||
    window.resetsAt < 0 ||
    !Number.isFinite(new Date(window.resetsAt * 1000).getTime())
  ))) return 'stale';
  if (windows.some(window => window.resetsAt !== null && window.resetsAt * 1000 <= now)) return 'refresh-needed';
  if (state.stale) return 'stale';
  if (state.updatedAt > now || now - state.updatedAt > STALE_AFTER_MS) return 'stale';
  return 'fresh';
}

function percentText(percent: number): string {
  return String(percent);
}

function shortBucketName(bucket: QuotaBucket, maxLength = MAX_BUCKET_LABEL): string {
  const raw = (bucket.name || bucket.id || '?').trim() || bucket.id || '?';
  const characters = Array.from(raw);
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join('')}…`
    : raw;
}

function windowLength(window: MeteredWindow, ru: boolean): string {
  if (window.kind === 'individual') return ru ? 'личный' : 'individual';
  const minutes = window.windowDurationMins;
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return '?';
  return duration(minutes, ru);
}

/**
 * Credits in the order of the bucket's most consumed shown window, then
 * credits-only buckets in server order. Hidden credits get their own
 * card-marked counter so it cannot be read as a window count.
 */
function creditsText(buckets: QuotaBucket[], ranked: MeteredWindow[], multipleBuckets: boolean): string | null {
  const order = new Map<QuotaBucket, number>();
  ranked.forEach((window, index) => { if (!order.has(window.bucket)) order.set(window.bucket, index); });
  const entries = buckets
    .map((bucket, index) => ({ bucket, index }))
    .filter(({ bucket }) => {
      const credits = bucket.credits;
      return credits != null && (credits.unlimited || credits.balance !== null);
    })
    .sort((left, right) =>
      (order.get(left.bucket) ?? ranked.length + left.index) - (order.get(right.bucket) ?? ranked.length + right.index))
    .map(entry => entry.bucket);
  if (entries.length === 0) return null;
  const shown = entries.slice(0, MAX_COMPACT_WINDOWS);
  const parts = shown.map(bucket => {
    const credits = bucket.credits!;
    const name = multipleBuckets ? ` ${shortBucketName(bucket, MAX_CREDIT_LABEL)}` : '';
    // Only the status bar rounds; the tooltip/report keep the exact server string.
    return `$(credit-card)${name} ${credits.unlimited ? '∞' : roundedCreditBalance(credits.balance)}`;
  });
  if (entries.length > shown.length) parts.push(`$(credit-card) +${entries.length - shown.length}`);
  return parts.join(' · ');
}

/**
 * Compact status text for the native status bar. Full bucket names and all
 * data remain in quotaPresentation's report/tooltip.
 */
export function quotaDisplay(state: QuotaState, ru: boolean, now = Date.now()): QuotaDisplay {
  const freshness = quotaFreshness(state, now);
  const windows = meteredWindows(state.buckets);

  let maximumUsed = 0;
  for (const window of windows) maximumUsed = Math.max(maximumUsed, window.usedPercent);
  const severity: QuotaSeverity = freshness !== 'fresh' ? 'normal'
    : maximumUsed >= 100 ? 'error' : maximumUsed >= 90 ? 'warning' : 'normal';

  if (freshness === 'unavailable') {
    return {
      text: `$(codex-companion-logo) · ${ru ? 'квоты недоступны' : 'quotas unavailable'}`,
      severity,
      freshness,
    };
  }

  const ranked = windows
    .map((window, index) => ({ window, index }))
    .sort((left, right) => right.window.usedPercent - left.window.usedPercent || left.index - right.index)
    .map(entry => entry.window);
  const shown = ranked.slice(0, MAX_COMPACT_WINDOWS);
  const multipleBuckets = state.buckets.length > 1;
  const parts = shown.map(window => {
    const name = multipleBuckets ? `${shortBucketName(window.bucket)}: ` : '';
    return `${name}${windowLength(window, ru)} ${ru ? 'исп.' : 'used'} ${percentText(window.usedPercent)}%`;
  });

  const omitted = ranked.length - shown.length;
  if (omitted > 0) parts.push(`+${omitted}`);

  const credits = creditsText(state.buckets, ranked, multipleBuckets);
  if (credits !== null) parts.push(credits);

  if (parts.length === 0) {
    parts.push(ru ? 'окна квот не сообщены' : 'no metered windows');
  }

  if (freshness === 'refresh-needed') parts.push(ru ? '↻ обновить' : '↻ refresh needed');
  if (freshness === 'stale') parts.push(ru ? '⚠ устарело' : '⚠ stale');

  return { text: ['$(codex-companion-logo)', ...parts].join(' · '), severity, freshness };
}
