import { createHash } from 'node:crypto';
import type { TableSchema } from '@superfunctions/db';
export function logIndexTable(table = 'watchfn_events'): string {
  if (table === 'watchfn_events') return 'watchfn_log_index';
  const name = table + '_log_index';
  return name.length <= 63 ? name : `${table.slice(0, 40)}_log_${createHash('sha256').update(table).digest('hex').slice(0, 10)}`;
}
export function getLogIndexSchema(table = 'watchfn_events'): Record<string, TableSchema> {
  const name = logIndexTable(table);
  const prefix = name.length <= 40 ? name : `${name.slice(0, 28)}_${createHash('sha256').update(name).digest('hex').slice(0, 10)}`;
  return { [name]: { modelName: name, fields: {
    id: { type: 'string', required: true, unique: true },
    eventId: { type: 'string', required: true }, field: { type: 'string', required: true },
    valueType: { type: 'string', required: true }, valueKey: { type: 'string', required: true },
  }, indexes: [
    { name: prefix + '_lookup', fields: ['field', 'valueType', 'valueKey', 'eventId'] },
    { name: prefix + '_event', fields: ['eventId'] },
  ] } };
}
