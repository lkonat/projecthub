import { authService } from './auth.service.js';
import { signJwt } from '../../utils/jwt.js';
import { config } from '../../config/index.js';
import { pickFields } from '../../middleware/validate.js';

const COOKIE = 'token';

function setAuthCookie(res, user) {
  const token = signJwt({ sub: user.id, username: user.username }, config.jwtSecret, config.jwtExpiresSec);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd, // HTTPS-only in production
    maxAge: config.jwtExpiresSec * 1000,
    path: '/',
  });
}

export const authController = {
  register(req, res) {
    const { username, password } = pickFields(req.body, ['username', 'password']);
    const user = authService.register({ username, password });
    setAuthCookie(res, user);
    res.status(201).json({ data: user });
  },

  login(req, res) {
    const { username, password } = pickFields(req.body, ['username', 'password']);
    const user = authService.login({ username, password });
    setAuthCookie(res, user);
    res.json({ data: user });
  },

  logout(req, res) {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ data: { ok: true } });
  },

  // Behind requireAuth — returns the current user (or 401 if not logged in).
  me(req, res) {
    res.json({ data: authService.get(req.user.id) });
  },

  // Behind requireAuth — update the current user's own profile.
  updateMe(req, res) {
    const patch = pickFields(req.body, ['name', 'email', 'phone', 'contact_preference']);
    res.json({ data: authService.updateProfile(req.user.id, patch) });
  },

  // Behind requireAuth — directory of accounts for assignee pickers.
  listUsers(req, res) {
    res.json({ data: authService.listUsers() });
  },
};
