// Server-side access to the shared assignment status + execution-state enums.
//
// The canonical definitions live in client/lib/assignmentStates.mjs so the
// browser and the server share ONE source of truth. This shim is the single
// cross-boundary path (mirroring extensions/ai/lib/core.js): if the canonical
// file ever moves, only this line changes. Server code imports from here.
export * from '../../../client/lib/assignmentStates.mjs';
