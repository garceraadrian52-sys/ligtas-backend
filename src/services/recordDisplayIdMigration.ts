import { displayIdDigits, type DisplayIdModule } from './recordDisplayIds';

export type MigrationRecord = { id: string; displayId?: unknown };
export type DisplayIdAssignment = { id: string; previousDisplayId: string | null; displayId: string };
export type DisplayIdMigrationPlan = {
  module: 'reports' | 'households';
  counterBase: number;
  lastIssued: number;
  recordIds: string[];
  assignments: DisplayIdAssignment[];
  duplicateIds: { displayId: string; keptRecordId: string; reassignedRecordId: string }[];
};

function currentNumber(module: 'reports' | 'households', value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = module === 'reports'
    ? /^(?:RP-|RPT)(\d+)$/i.exec(value.trim())
    : /^HH-(\d+)$/i.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function formatId(module: 'reports' | 'households', number: number) {
  const prefix = module === 'reports' ? 'RP-' : 'HH-';
  return `${prefix}${String(number).padStart(displayIdDigits(module), '0')}`;
}

export function createDisplayIdMigrationPlan(
  module: DisplayIdModule & ('reports' | 'households'),
  records: MigrationRecord[],
  counterValue: unknown,
): DisplayIdMigrationPlan {
  const counter = counterValue === undefined || counterValue === null ? 0 : counterValue;
  if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0) {
    throw new Error(`The ${module} display ID counter is invalid; refusing to reset it.`);
  }

  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const numberOwners = new Map<number, string>();
  let maximum = counter;
  const candidateById = new Map<string, number | null>();
  for (const record of sorted) {
    const number = currentNumber(module, record.displayId);
    candidateById.set(record.id, number);
    if (number === null) continue;
    maximum = Math.max(maximum, number);
    if (!numberOwners.has(number)) numberOwners.set(number, record.id);
  }

  const assignments: DisplayIdAssignment[] = [];
  const duplicateIds: DisplayIdMigrationPlan['duplicateIds'] = [];
  let next = maximum;
  for (const record of sorted) {
    const number = candidateById.get(record.id) ?? null;
    const existingOwner = number === null ? undefined : numberOwners.get(number);
    let assignedNumber = number;
    if (number !== null && existingOwner !== record.id) {
      duplicateIds.push({ displayId: formatId(module, number), keptRecordId: existingOwner!, reassignedRecordId: record.id });
      assignedNumber = null;
    }
    if (assignedNumber === null) {
      if (next >= Number.MAX_SAFE_INTEGER) throw new Error(`The ${module} display ID counter is exhausted.`);
      next += 1;
      assignedNumber = next;
    }
    const displayId = formatId(module, assignedNumber);
    const current = typeof record.displayId === 'string' && record.displayId.trim() ? record.displayId.trim() : null;
    if (current !== displayId) assignments.push({ id: record.id, previousDisplayId: current, displayId });
  }

  return {
    module,
    counterBase: counter,
    lastIssued: next,
    recordIds: sorted.map((record) => record.id),
    assignments,
    duplicateIds,
  };
}
