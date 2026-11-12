import { customGet, isFacilioApiConfigured } from './facilioApi';

/*
 * A module's field list, on its own: Settings and the print window read it, and neither should pull
 * in the whole data source (and the PDF library behind it) to do so.
 */

/** One field of a module, as its list page's filter offers it. */
export interface ModuleField {
  name: string;
  label: string;
  /** The org's data type, upper-case: STRING, ENUM, DATE_TIME, LOOKUP… */
  dataType: string;
  /** A picklist's options, so a raw option id can be read as its label. */
  options?: { value: string; label: string }[];
}

const moduleFieldReads = new Map<string, Promise<ModuleField[] | null>>();

/**
 * A module's fields — `v2/filter/advanced/fields/<module>`, the read behind its list page's filter,
 * custom fields included. Settings › Parking lists the stall's text fields from it (so a field the
 * org adds turns up without a change here), and the parking register reads picklist labels off it.
 * Read once per session; a failure is retried next time.
 */
export function fetchModuleFields(moduleName: string): Promise<ModuleField[] | null> {
  if (!isFacilioApiConfigured) return Promise.resolve(null);
  let read = moduleFieldReads.get(moduleName);
  if (!read) {
    read = Promise.resolve()
      .then(() => customGet(`v2/filter/advanced/fields/${encodeURIComponent(moduleName)}`))
      .then((body: any) => {
        const raw = body?.result?.fields ?? body?.data?.fields ?? body?.fields;
        if (!Array.isArray(raw)) return null;
        return raw
          .filter((f: any) => typeof f?.name === 'string')
          .map((f: any): ModuleField => {
            const listed = Array.isArray(f.options)
              ? f.options.map((o: any) => ({ value: String(o.value ?? o.id ?? ''), label: String(o.label ?? o.displayName ?? o.value ?? '') }))
              : f.enumMap && typeof f.enumMap === 'object'
                ? Object.entries(f.enumMap).map(([value, label]) => ({ value, label: String(label) }))
                : [];
            const options = listed.filter((o: { value: string; label: string }) => o.value !== '' && o.label !== '');
            return { name: f.name, label: String(f.displayName ?? f.name), dataType: String(f.dataType ?? '').toUpperCase(), ...(options.length ? { options } : {}) };
          });
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[fields] could not read the ${moduleName} fields`, err);
        moduleFieldReads.delete(moduleName);
        return null;
      });
    moduleFieldReads.set(moduleName, read);
  }
  return read;
}
