import { CoreError } from './schema';

/** Documents written before schemaVersion was required are version 0. Version 1 is current.
 * Any other version is refused and left untouched by the caller. */
export function migrateProjectDocument(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (record.schemaVersion === 1) return input;
  if (record.schemaVersion === undefined || record.schemaVersion === 0) return { ...record, schemaVersion: 1 };
  throw new CoreError('UNSUPPORTED_VERSION', `Unsupported project schema version ${String(record.schemaVersion)}.`);
}
