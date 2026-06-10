-- User profile: contact details + preferred contact method.
-- All nullable except contact_preference, which defaults to 'none' (existing
-- accounts haven't chosen one). The allowed set is validated in the service
-- (auth.service.js), not a DB CHECK, to keep it changeable without a rebuild.
ALTER TABLE users ADD COLUMN name TEXT;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN contact_preference TEXT NOT NULL DEFAULT 'none';
