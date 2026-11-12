import { useEffect, useMemo, useState } from 'react';
import { isFacilioApiConfigured } from '../lib/facilioApi';
import { fetchModuleFields } from '../lib/moduleFields';
import type { ModuleField } from '../lib/moduleFields';
import { labelledType, LABEL_MODULE } from '../lib/types';
import type { LabelledType, Unit } from '../lib/types';

const TEXT_TYPES = new Set(['STRING', 'BIG_STRING', 'LARGE_TEXT']);
/** Names for the record fields the app knows, used when the org's own field list can't be read. */
const KNOWN: Record<string, string> = { name: 'Name', deskCode: 'Desk Code', qrVal: 'QR Value', description: 'Description', code_space: 'Code' };
/** The suffix ENEC's custom fields carry for each module (`stall_number_parkingstall`, `reservation_type_desks`). */
const CUSTOM_SUFFIX = /_(parkingstall|desks|space)$/;

/** A field's name as a person reads it: the org's label when known, else its API name tidied up. */
export function fieldTitle(name: string, fields?: { name: string; label: string }[]): string {
  const listed = fields?.find((f) => f.name === name)?.label;
  if (listed) return listed;
  if (KNOWN[name]) return KNOWN[name];
  // "stall_number_parkingstall" reads "Stall Number".
  const words = name.replace(CUSTOM_SUFFIX, '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_\s]+/).filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || name;
}

export interface RecordFields {
  /** The record's text fields — what a desk, stall or room can be labelled with — Name first. */
  text: { name: string; label: string }[];
  /** Picklist options by field name (a stall's Parking type and mode), to read raw option ids. */
  options: Record<string, { value: string; label: string }[]>;
  loading: boolean;
}

/**
 * The fields of a desk's, stall's or room's record, as Label on the plan and the parking register
 * need them.
 *
 * In Facilio they come from the org's own field list for the module (`desks`, `parkingstall`,
 * `space` — fetchModuleFields), so a text field the org adds is offered the moment it exists.
 * Without that list (the local tier, a read that failed, or `read` false — a caller that has no use
 * for it yet) they come from the floor's own records: the known fields plus any custom field of the
 * module the records carry text in.
 */
export function useRecordFields(kind: LabelledType, units: Unit[], read = true): RecordFields {
  const [meta, setMeta] = useState<ModuleField[] | null | 'loading'>(isFacilioApiConfigured && read ? 'loading' : null);
  useEffect(() => {
    // Once read, a list is kept when the caller stops needing it; it is the same list next time.
    if (!isFacilioApiConfigured || !read) return;
    let live = true;
    setMeta('loading');
    void fetchModuleFields(LABEL_MODULE[kind]).then((f) => {
      if (live) setMeta(f);
    });
    return () => {
      live = false;
    };
  }, [kind, read]);

  return useMemo(() => {
    const nameFirst = (a: { name: string; label: string }, b: { name: string; label: string }) => (a.name === 'name' ? -1 : b.name === 'name' ? 1 : a.label.localeCompare(b.label));
    if (meta === 'loading') return { text: [{ name: 'name', label: 'Name' }], options: {}, loading: true };
    if (meta) {
      const text = meta.filter((f) => TEXT_TYPES.has(f.dataType)).map((f) => ({ name: f.name, label: f.name === 'name' ? 'Name' : f.label }));
      if (!text.some((f) => f.name === 'name')) text.unshift({ name: 'name', label: 'Name' });
      text.sort(nameFirst);
      const options: RecordFields['options'] = {};
      for (const f of meta) if (f.options) options[f.name] = f.options;
      return { text, options, loading: false };
    }
    const names = new Set<string>(['name']);
    for (const u of units) {
      if (labelledType(u.type) !== kind || !u.record) continue;
      // A stall number is all digits and is still text; a time (epoch ms, 13 digits) is not.
      for (const [k, v] of Object.entries(u.record)) if (KNOWN[k] || (CUSTOM_SUFFIX.test(k) && !/^\d{10,}$/.test(v))) names.add(k);
    }
    const text = [...names].map((name) => ({ name, label: fieldTitle(name) }));
    text.sort(nameFirst);
    return { text, options: {}, loading: false };
  }, [meta, units, kind]);
}
