import { useEffect, useMemo, useState } from 'react';
import { isFacilioApiConfigured } from '../lib/facilioApi';
import { fetchModuleFields } from '../lib/moduleFields';
import type { ModuleField } from '../lib/moduleFields';
import type { Unit } from '../lib/types';

const TEXT_TYPES = new Set(['STRING', 'BIG_STRING', 'LARGE_TEXT']);
/** Names for the stall fields the app knows, used when the org's own field list can't be read. */
const KNOWN: Record<string, string> = { name: 'Name', qrVal: 'QR Value', description: 'Description', code_space: 'Code' };

/** A field's name as a person reads it: the org's label when known, else its API name tidied up. */
export function parkingFieldTitle(name: string, fields?: { name: string; label: string }[]): string {
  const listed = fields?.find((f) => f.name === name)?.label;
  if (listed) return listed;
  if (KNOWN[name]) return KNOWN[name];
  // ENEC's custom fields are named `<field>_parkingstall` — "stall_number_parkingstall" reads "Stall Number".
  const words = name.replace(/_parkingstall$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_\s]+/).filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || name;
}

export interface ParkingFields {
  /** The stall record's text fields — what a stall can be labelled with — Name first. */
  text: { name: string; label: string }[];
  /** Picklist options by field name (Parking type, Parking mode), to read raw option ids. */
  options: Record<string, { value: string; label: string }[]>;
  loading: boolean;
}

/**
 * The parking stall record's fields, as Settings › Parking and the parking register need them.
 *
 * In Facilio they come from the org's own field list (fetchModuleFields), so a text field the org
 * adds — a short "Stall Number", say — is offered the moment it exists. Without that list (the
 * local tier, or a read that failed) they come from the floor's own stalls: the known fields plus
 * any custom `…_parkingstall` field the records carry text in.
 */
export function useParkingFields(units: Unit[]): ParkingFields {
  const [meta, setMeta] = useState<ModuleField[] | null | 'loading'>(isFacilioApiConfigured ? 'loading' : null);
  useEffect(() => {
    if (!isFacilioApiConfigured) return;
    let live = true;
    void fetchModuleFields('parkingstall').then((f) => {
      if (live) setMeta(f);
    });
    return () => {
      live = false;
    };
  }, []);

  return useMemo(() => {
    if (meta === 'loading') return { text: [{ name: 'name', label: 'Name' }], options: {}, loading: true };
    if (meta) {
      const text = meta.filter((f) => TEXT_TYPES.has(f.dataType)).map((f) => ({ name: f.name, label: f.name === 'name' ? 'Name' : f.label }));
      if (!text.some((f) => f.name === 'name')) text.unshift({ name: 'name', label: 'Name' });
      text.sort((a, b) => (a.name === 'name' ? -1 : b.name === 'name' ? 1 : a.label.localeCompare(b.label)));
      const options: ParkingFields['options'] = {};
      for (const f of meta) if (f.options) options[f.name] = f.options;
      return { text, options, loading: false };
    }
    const names = new Set<string>(['name']);
    for (const u of units) {
      if (u.type !== 'parking' || !u.record) continue;
      // A stall number is all digits and is still text; a time (epoch ms, 13 digits) is not.
      for (const [k, v] of Object.entries(u.record)) if (KNOWN[k] || (/_parkingstall$/.test(k) && !/^\d{10,}$/.test(v))) names.add(k);
    }
    const text = [...names].map((name) => ({ name, label: parkingFieldTitle(name) }));
    text.sort((a, b) => (a.name === 'name' ? -1 : b.name === 'name' ? 1 : a.label.localeCompare(b.label)));
    return { text, options: {}, loading: false };
  }, [meta, units]);
}
