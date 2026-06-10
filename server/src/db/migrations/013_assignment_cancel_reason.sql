-- Cancelling an assignment now requires a reason (why the work was dropped).
-- Stored here; enforced in the service when status is set to 'cancelled' and
-- cleared when the assignment is reopened or resolved. Nullable: pre-existing
-- cancelled rows simply have no recorded reason.
ALTER TABLE assignments ADD COLUMN cancel_reason TEXT;
