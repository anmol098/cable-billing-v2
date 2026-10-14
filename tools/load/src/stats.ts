/**
 * Timings and their summaries. Every sample is kept (a run makes at most a few hundred thousand), so
 * percentiles are exact, not estimated.
 */

/** One measured request or step. `ms` is wall time from sending to the last byte read. */
export interface Sample {
  readonly ms: number;
  readonly ok: boolean;
  /** Body bytes as received (the `content-length` when the server sent one, else decoded bytes). */
  readonly bytes?: number;
}

export interface MetricSummary {
  readonly name: string;
  readonly count: number;
  readonly errors: number;
  /** errors / count, 0 when nothing was measured. */
  readonly errorRate: number;
  /** Over successful samples only (a fast 500 must not make a slow page look fast). */
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly bytesMax: number | null;
  readonly bytesTotal: number;
  /** Error reasons (HTTP status or error code) and how often each happened. */
  readonly reasons: Readonly<Record<string, number>>;
}

/**
 * Nearest-rank percentile of an ascending array (`p` in 0…100). The smallest value with at least
 * p % of the samples at or below it: p95 of 20 samples is the 19th.
 */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (p <= 0) return sorted[0] ?? null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, rank) - 1] ?? null;
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

/** Collects samples by metric name (e.g. `mobile.sync.page`, `web.page.reports_dues`). */
export class Recorder {
  readonly #samples = new Map<string, Sample[]>();
  readonly #reasons = new Map<string, Map<string, number>>();
  readonly #counters = new Map<string, number>();

  record(name: string, sample: Sample, reason?: string): void {
    let list = this.#samples.get(name);
    if (!list) {
      list = [];
      this.#samples.set(name, list);
    }
    list.push(sample);
    if (!sample.ok) {
      let reasons = this.#reasons.get(name);
      if (!reasons) {
        reasons = new Map();
        this.#reasons.set(name, reasons);
      }
      const key = reason ?? "error";
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }

  /** A plain count (payments posted, retry_later items …), reported next to the timings. */
  count(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  /** A value measured once (the billing run's wall time): a single sample. */
  gauge(name: string, value: number, ok = true): void {
    this.record(name, { ms: value, ok });
  }

  names(): string[] {
    return [...this.#samples.keys()].sort();
  }

  counters(): Readonly<Record<string, number>> {
    return Object.fromEntries([...this.#counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  summary(name: string): MetricSummary {
    const samples = this.#samples.get(name) ?? [];
    const okTimes = samples
      .filter((sample) => sample.ok)
      .map((sample) => sample.ms)
      .sort((a, b) => a - b);
    const errors = samples.length - okTimes.length;
    const bytes = samples.flatMap((sample) => (sample.bytes === undefined ? [] : [sample.bytes]));
    const mean = okTimes.length ? okTimes.reduce((sum, ms) => sum + ms, 0) / okTimes.length : null;
    return {
      name,
      count: samples.length,
      errors,
      errorRate: samples.length ? errors / samples.length : 0,
      p50: round(percentile(okTimes, 50)),
      p90: round(percentile(okTimes, 90)),
      p95: round(percentile(okTimes, 95)),
      p99: round(percentile(okTimes, 99)),
      max: round(okTimes.at(-1) ?? null),
      mean: round(mean),
      bytesMax: bytes.length ? Math.max(...bytes) : null,
      bytesTotal: bytes.reduce((sum, value) => sum + value, 0),
      reasons: Object.fromEntries(this.#reasons.get(name) ?? []),
    };
  }

  summaries(): MetricSummary[] {
    return this.names().map((name) => this.summary(name));
  }
}
