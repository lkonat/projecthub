import { authRepository } from './auth.repository.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { ValidationError, AppError } from '../../utils/errors.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 8;
// A light email sanity check — not RFC-perfect, just "looks like an address".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// How the system may contact the user. 'none' = don't.
const CONTACT_PREFERENCES = ['none', 'email', 'sms', 'phone'];

// Shape returned to clients — never includes the password hash.
function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name ?? null,
    email: u.email ?? null,
    phone: u.phone ?? null,
    contactPreference: u.contact_preference ?? 'none',
    createdAt: u.created_at,
  };
}

export const authService = {
  register({ username, password }) {
    username = String(username || '').trim();
    if (!USERNAME_RE.test(username)) {
      throw new ValidationError('username must be 3–32 chars: letters, digits, and _ . -');
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      throw new ValidationError(`password must be at least ${MIN_PASSWORD} characters`);
    }
    if (authRepository.findByUsername(username)) {
      throw new AppError('username already taken', 409, 'USERNAME_TAKEN');
    }

    const isFirstUser = authRepository.countUsers() === 0;
    const user = authRepository.create({ username, passwordHash: hashPassword(password) });

    // The first account adopts any projects that predate auth, so existing
    // data isn't stranded with no owner.
    if (isFirstUser) authRepository.claimOrphanProjects(user.id);

    return publicUser(user);
  },

  login({ username, password }) {
    username = String(username || '').trim();
    const user = authRepository.findByUsername(username);
    // Verify even when the user is missing would be ideal for timing, but a
    // missing user simply fails here — acceptable for this app.
    if (!user || !verifyPassword(password || '', user.password_hash)) {
      throw new AppError('invalid username or password', 401, 'INVALID_CREDENTIALS');
    }
    return publicUser(user);
  },

  get(id) {
    const user = authRepository.findById(id);
    return user ? publicUser(user) : null;
  },

  CONTACT_PREFERENCES,

  // Update the actor's own profile: name, email, phone, contact preference.
  // Only the keys present in `patch` are touched. Validates the email shape and
  // the contact method, and ensures the chosen method has the detail it needs
  // (email → an email on file; sms/phone → a phone). Returns the public user.
  updateProfile(id, patch) {
    const existing = authRepository.findById(id);
    if (!existing) throw new ValidationError('User not found');

    const next = {};
    if (patch.name !== undefined) {
      next.name = typeof patch.name === 'string' ? (patch.name.trim() || null) : null;
    }
    if (patch.email !== undefined) {
      const email = typeof patch.email === 'string' ? patch.email.trim() : '';
      if (email && !EMAIL_RE.test(email)) throw new ValidationError('email is not a valid address');
      next.email = email || null;
    }
    if (patch.phone !== undefined) {
      next.phone = typeof patch.phone === 'string' ? (patch.phone.trim() || null) : null;
    }
    if (patch.contact_preference !== undefined) {
      if (!CONTACT_PREFERENCES.includes(patch.contact_preference)) {
        throw new ValidationError(`contact_preference must be one of: ${CONTACT_PREFERENCES.join(', ')}`);
      }
      next.contact_preference = patch.contact_preference;
    }
    if (Object.keys(next).length === 0) {
      throw new ValidationError('Nothing to update');
    }

    // The chosen contact method must have the detail it needs — check against the
    // merged result so e.g. setting email + preference 'email' in one request works.
    const merged = { ...existing, ...next };
    if (merged.contact_preference === 'email' && !merged.email) {
      throw new ValidationError('Add an email address to be contacted by email');
    }
    if ((merged.contact_preference === 'sms' || merged.contact_preference === 'phone') && !merged.phone) {
      throw new ValidationError(`Add a phone number to be contacted by ${merged.contact_preference}`);
    }

    return publicUser(authRepository.updateProfile(id, next));
  },

  // Lightweight directory for assignee pickers: [{ id, username }].
  listUsers() {
    return authRepository.listAll();
  },
};
