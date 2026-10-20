/** Lightweight SQL rows, without constructing the mutable owner projection. */
export function v2SqlDto(row: Record<string, unknown>): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(row)) {
    const name = key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
    value[name] =
      typeof raw === 'string' && key.endsWith('_at')
        ? new Date(raw).toISOString()
        : raw instanceof Date
          ? key === 'local_date'
            ? `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-${String(raw.getDate()).padStart(2, '0')}`
            : raw.toISOString()
          : raw;
  }
  if ('rank' in value) value['rank'] = String(value['rank']);
  if ('version' in value) value['version'] = Number(value['version']);
  if ('weekStartsOn' in value) value['weekStartsOn'] = Number(value['weekStartsOn']);
  if ('defaultCaptureTarget' in value && value['defaultCaptureTarget'] !== 'ROOT')
    value['defaultCaptureTarget'] = 'RECENT_FOLDER';
  return value;
}
