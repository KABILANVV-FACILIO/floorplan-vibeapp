/**
 * How people and departments are NAMED on the plan, in its labels and on paper.
 *
 * The org's records carry codes in their names. Employees read "251850 - Johar Ali Ali Asghar"
 * (the employee number, a dash, then the name, often with doubled spaces or a stray tab), and many
 * departments read "10000264-Investment Executive Program" (a cost-centre code glued to the front).
 * Printed as-is, the code is all a label has room for: "251850 - Johar Ali Al…" under a desk, the
 * department never reached, and chip initials taken from "251850" and "-" — "2-".
 *
 * These split each name into what a person reads (the name) and what a lookup needs (the code).
 * The code is not thrown away: the Seating list prints it in its own column, and search still
 * matches the raw record.
 */

/** "251850 - Name", "00250001 - Name", "22250606 - Name": a number of 3+ digits, then a dash. */
const PERSON_CODE = /^\s*(\d{3,})\s*-\s*/;
/** "10000264-Name": a code of 5+ digits glued to the name by a dash. */
const DEPARTMENT_CODE = /^\s*(\d{5,})\s*-\s*/;

function tidy(s: string): string {
  // Tabs and runs of spaces collapse; a trailing dash (a blank surname: "Pappu  -") goes.
  return s.replace(/\s+/g, ' ').replace(/\s*-\s*$/, '').trim();
}

/** The employee's name without the employee number: "251850 - Johar  Ali" → "Johar Ali". */
export function personDisplayName(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = tidy(raw.replace(PERSON_CODE, ''));
  return cleaned || tidy(raw);
}

/** The employee number the name carried, if any: "251850 - Johar Ali" → "251850". */
export function personCode(raw: string | null | undefined): string | null {
  const m = raw ? PERSON_CODE.exec(raw) : null;
  return m ? m[1] : null;
}

/**
 * The employee number to show beside a person: their HRMS id when the org fills it, otherwise the
 * number their name carried ("251850 - Johar Ali" → "251850").
 */
export function employeeNumber(e: { name?: string | null; hrmsEmployeeId?: string | null } | null | undefined): string | null {
  if (!e) return null;
  return e.hrmsEmployeeId?.trim() || personCode(e.name);
}

/** The department without its cost-centre code: "10000264-Investment Executive Program" → "Investment Executive Program". */
export function departmentDisplayName(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = tidy(raw.replace(DEPARTMENT_CODE, ''));
  return cleaned || tidy(raw);
}

/** Name particles that belong with the surname: "Abdilla Al-Sharif", "Abdullah Bin Saleh". */
const PARTICLES = new Set(['al', 'el', 'bin', 'bint', 'ibn', 'abu', 'de', 'del', 'da', 'di', 'van', 'von', 'la', 'le', 'st', 'mc', 'o']);

/**
 * A name short enough for a label under a desk: the full name when it fits in `maxChars`,
 * otherwise first name + surname — "Abdulrahman Abdullah Khalaf AlAnazi" → "Abdulrahman AlAnazi".
 *
 * The surname keeps a particle in front of it ("Mohammed Al Marzooqi"), and a surname that is only
 * an initial ("Lorien Noreen M") takes the name before it too, so the short form never reads as a
 * first name and a lone letter. Still too long, it is returned as is, for the label to clip.
 */
export function shortPersonName(clean: string, maxChars: number): string {
  if (clean.length <= maxChars) return clean;
  const parts = clean.split(' ').filter(Boolean);
  if (parts.length <= 2) return clean;
  let lastStart = parts.length - 1;
  if (parts[lastStart].replace(/\./g, '').length <= 1 && lastStart - 1 > 0) lastStart -= 1;
  while (lastStart - 1 > 0 && PARTICLES.has(parts[lastStart - 1].toLowerCase().replace(/[-.]/g, ''))) lastStart -= 1;
  return [parts[0], ...parts.slice(lastStart)].join(' ');
}

/**
 * Initials for a chip, from the name and never from its code: "251850 - Johar Ali Ali Asghar" →
 * "JA". First letters of the first two words that start with a letter.
 */
export function personInitials(raw: string | null | undefined): string {
  const words = personDisplayName(raw)
    .split(' ')
    .filter((w) => /^\p{L}/u.test(w));
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/**
 * Order people by the name a person reads. The org's names start with the employee number, so
 * sorting the raw name lists people by that hidden number ("22250607 - Claire" before "251850 -
 * Johar"), which reads as no order at all once the numbers are off the screen.
 */
export function byPersonName(a: { name?: string | null }, b: { name?: string | null }): number {
  return personDisplayName(a.name).localeCompare(personDisplayName(b.name), undefined, { sensitivity: 'base' });
}

/** Order departments by the name a person reads, not by the cost-centre code in front of it. */
export function byDepartmentName(a: { name?: string | null }, b: { name?: string | null }): number {
  return departmentDisplayName(a.name).localeCompare(departmentDisplayName(b.name), undefined, { sensitivity: 'base' });
}
