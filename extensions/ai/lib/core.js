// Stable local re-export of the core AI framework (server/src/ai).
//
// Provider and agent files in extensions/ import their base classes from here
// instead of reaching into the server's internals directly — so the one
// cross-boundary path lives in this single shim. If the core moves, only this
// file changes.
export * from '../../../server/src/ai/index.js';
