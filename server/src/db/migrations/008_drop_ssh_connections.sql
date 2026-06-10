-- The SSH API was removed; its storage table is no longer used. The SSH
-- functionality now lives only in extensions/shared/ssh/run.js (a stateless
-- tool that takes connection details per call — nothing persisted).
DROP TABLE IF EXISTS ssh_connections;
