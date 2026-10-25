export interface QuotaWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface QuotaBucket {
  id: string;
  name: string;
  primary: QuotaWindow | null;
  secondary: QuotaWindow | null;
  individual?: { usedPercent: number; resetsAt: number };
  credits?: { balance: string | null; unlimited: boolean };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function window(value: unknown): QuotaWindow | null {
  if (value == null) return null;
  const data = object(value);
  if (!data || !finite(data.usedPercent) || data.usedPercent < 0) throw new Error('Invalid quota percentage');
  if (data.windowDurationMins != null && (!finite(data.windowDurationMins) || data.windowDurationMins <= 0)) {
    throw new Error('Invalid quota window');
  }
  if (data.resetsAt != null && (!finite(data.resetsAt) || data.resetsAt < 0)) throw new Error('Invalid quota reset');
  return {
    usedPercent: data.usedPercent,
    windowDurationMins: data.windowDurationMins as number | null | undefined ?? null,
    resetsAt: data.resetsAt as number | null | undefined ?? null,
  };
}

/** Retain every metered bucket; the legacy view usually duplicates one of them. */
export function parseQuotas(value: unknown): QuotaBucket[] {
  const response = object(value);
  if (!response) throw new Error('Invalid quota response');
  const buckets = new Map<string, QuotaBucket>();
  const add = (raw: unknown, fallbackId: string): void => {
    const data = object(raw);
    if (!data) throw new Error('Invalid quota bucket');
    const id = typeof data.limitId === 'string' && data.limitId ? data.limitId : fallbackId;
    const bucket: QuotaBucket = {
      id,
      name: typeof data.limitName === 'string' && data.limitName ? data.limitName : id,
      primary: window(data.primary),
      secondary: window(data.secondary),
    };
    if (data.individualLimit != null) {
      const individual = object(data.individualLimit);
      if (!individual || !finite(individual.remainingPercent) || !finite(individual.resetsAt) || individual.resetsAt < 0) throw new Error('Invalid individual quota');
      bucket.individual = { usedPercent: 100 - individual.remainingPercent, resetsAt: individual.resetsAt };
    }
    const credits = object(data.credits);
    if (credits) bucket.credits = { balance: typeof credits.balance === 'string' ? credits.balance : null, unlimited: credits.unlimited === true };
    buckets.set(id, bucket);
  };
  if (response.rateLimits != null) add(response.rateLimits, 'codex');
  if (response.rateLimitsByLimitId != null) {
    const all = object(response.rateLimitsByLimitId);
    if (!all) throw new Error('Invalid quota bucket map');
    for (const [id, bucket] of Object.entries(all)) if (bucket != null) add(bucket, id);
  }
  if (buckets.size === 0) throw new Error('Quota response contains no buckets');
  return [...buckets.values()];
}
