// Auth middleware: reads the JWT from the httpOnly `token` cookie, verifies
// it, and attaches { id, username } to req.user. Rejects with 401 otherwise.

import { verifyJwt } from '../utils/jwt.js';
import { config } from '../config/index.js';
import { AppError } from '../utils/errors.js';

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie).token;
  if (!token) {
    return next(new AppError('Authentication required', 401, 'UNAUTHENTICATED'));
  }
  try {
    const payload = verifyJwt(token, config.jwtSecret);
    req.user = { id: payload.sub, username: payload.username };
    next();
  } catch {
    return next(new AppError('Invalid or expired session', 401, 'UNAUTHENTICATED'));
  }
}
