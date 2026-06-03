import { ValidationError } from '../utils/errors.js';

export function requireFields(obj, fields) {
  const missing = fields.filter((f) => {
    const v = obj?.[f];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
  if (missing.length) {
    throw new ValidationError(`Missing required fields: ${missing.join(', ')}`, { missing });
  }
}

export function parseId(value, name = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`Invalid ${name}`);
  }
  return n;
}

export function pickFields(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
  }
  return out;
}
