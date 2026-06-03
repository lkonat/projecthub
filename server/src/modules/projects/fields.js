// Validate + coerce incoming field values against a type's field definitions.
// Throws ValidationError on bad input. Returns a plain object with only the
// declared keys present (unknown keys are stripped).

import { ValidationError } from '../../utils/errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function coerce(field, raw) {
  // Treat undefined/null/'' as "not provided"
  if (raw === undefined || raw === null || raw === '') return undefined;

  switch (field.type) {
    case 'text':
    case 'textarea': {
      const s = String(raw).trim();
      return s === '' ? undefined : s;
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        throw new ValidationError(`Field '${field.key}' must be a number`);
      }
      return n;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true'  || raw === 1 || raw === '1' || raw === 'on') return true;
      if (raw === 'false' || raw === 0 || raw === '0' || raw === 'off') return false;
      throw new ValidationError(`Field '${field.key}' must be a boolean`);
    }
    case 'date': {
      const s = String(raw).trim();
      if (!DATE_RE.test(s)) {
        throw new ValidationError(`Field '${field.key}' must be a date in YYYY-MM-DD format`);
      }
      const d = new Date(s + 'T00:00:00Z');
      if (Number.isNaN(d.getTime())) {
        throw new ValidationError(`Field '${field.key}' is not a valid date`);
      }
      return s;
    }
    case 'select': {
      const s = String(raw);
      if (!field.options.includes(s)) {
        throw new ValidationError(
          `Field '${field.key}' must be one of: ${field.options.join(', ')}`
        );
      }
      return s;
    }
    default:
      throw new ValidationError(`Field '${field.key}' has unknown type '${field.type}'`);
  }
}

export function validateAndCoerce(fieldDefs, rawValues = {}) {
  const out = {};
  const missing = [];
  for (const def of fieldDefs) {
    const value = coerce(def, rawValues?.[def.key]);
    if (value === undefined) {
      if (def.required) missing.push(def.key);
      continue;
    }
    out[def.key] = value;
  }
  if (missing.length > 0) {
    throw new ValidationError(
      `Missing required fields for this type: ${missing.join(', ')}`,
      { missing }
    );
  }
  return out;
}
