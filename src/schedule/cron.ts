export interface CronSpec {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldRange {
  min: number;
  max: number;
}

const FIELDS: readonly FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

function parseField(raw: string, range: FieldRange): ReadonlySet<number> {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [base, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: ${part}`);
    let lo = range.min;
    let hi = range.max;
    if (base !== "*") {
      const dash = base!.indexOf("-");
      if (dash !== -1) {
        lo = Number(base!.slice(0, dash));
        hi = Number(base!.slice(dash + 1));
      } else {
        lo = Number(base);
        hi = stepRaw === undefined ? lo : range.max;
      }
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < range.min || hi > range.max || lo > hi) {
      throw new Error(`invalid cron field: ${part}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expression must have 5 fields: ${expr}`);
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parts.map((part, i) =>
    parseField(part, FIELDS[i]!),
  );
  return {
    minutes: minutes!,
    hours: hours!,
    daysOfMonth: daysOfMonth!,
    months: months!,
    daysOfWeek: daysOfWeek!,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  const dom = spec.daysOfMonth.has(date.getDate());
  const dow = spec.daysOfWeek.has(date.getDay());
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  if (spec.domRestricted) return dom;
  if (spec.dowRestricted) return dow;
  return true;
}

export function nextRun(expr: string, after: Date): Date {
  const spec = parseCron(expr);
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 366 * 4;
  for (let day = 0; day < limit; day++) {
    if (spec.months.has(cursor.getMonth() + 1) && dayMatches(spec, cursor)) {
      for (const hour of [...spec.hours].sort((a, b) => a - b)) {
        for (const minute of [...spec.minutes].sort((a, b) => a - b)) {
          const candidate = new Date(cursor.getTime());
          candidate.setHours(hour, minute, 0, 0);
          if (candidate.getTime() > after.getTime()) return candidate;
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  throw new Error(`no upcoming run within four years for cron: ${expr}`);
}