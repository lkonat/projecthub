import { agentsRepository } from './agents.repository.js';
import { agentRegistry } from '../../ai/index.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

// Shape a raw row for API/consumers: parse the stored JSON schema, expose
// `enabled` as a boolean, and flag whether the code agent is callable now.
function present(row) {
  if (!row) return row;
  let inputSchema = null;
  try { inputSchema = row.input_schema ? JSON.parse(row.input_schema) : null; }
  catch { inputSchema = null; }
  return {
    id: row.id,
    slug: row.slug,                // the unique name (machine identifier)
    title: row.title,              // human-friendly display label
    description: row.description,
    inputSchema,
    event: row.event,
    enabled: !!row.enabled,
    status: row.status,            // 'active' | 'missing'
    assignable: row.status === 'active' && !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const agentsService = {
  // Project the in-memory registry into the `agents` table. Idempotent: safe to
  // run on every boot. Inserts new agents, refreshes metadata on existing ones,
  // and marks rows whose code disappeared as 'missing' (never deletes).
  syncFromRegistry() {
    const described = agentRegistry.describe(); // [{ name, title, description, inputSchema, event }]
    for (const a of described) {
      agentsRepository.upsertBySlug({
        slug: a.name,                         // unique name → slug (the FK-stable key)
        title: a.title || a.name,             // display label, defaulting to the name
        description: a.description || null,
        inputSchema: a.inputSchema ? JSON.stringify(a.inputSchema) : null,
        event: a.event || null,
      });
    }
    const activeSlugs = described.map((a) => a.name);
    const nowMissing = agentsRepository.markMissingExcept(activeSlugs);
    console.log(
      `[agents] synced ${described.length} agent(s) into the database` +
      (nowMissing ? `  —  ${nowMissing} marked missing` : '')
    );
    return { synced: described.length, missing: nowMissing };
  },

  list() {
    return agentsRepository.list().map(present);
  },

  listAssignable() {
    return agentsRepository.listAssignable().map(present);
  },

  get(id) {
    const row = agentsRepository.findById(id);
    if (!row) throw new NotFoundError('Agent');
    return present(row);
  },

  getBySlug(slug) {
    const row = agentsRepository.findBySlug(slug);
    if (!row) throw new NotFoundError('Agent');
    return present(row);
  },

  // Validate that `id` is an agent that may be assigned right now. Used by the
  // assignments service when assignee_type === 'agent'. Returns the raw row.
  assignableOrThrow(id) {
    if (!Number.isInteger(id)) {
      throw new ValidationError('assignee_agent_id must be an integer for an agent assignee');
    }
    const row = agentsRepository.findById(id);
    if (!row) throw new ValidationError(`No agent with id ${id}`);
    if (row.status !== 'active') {
      throw new ValidationError(`Agent '${row.slug}' is not currently available (its code is missing)`);
    }
    if (!row.enabled) {
      throw new ValidationError(`Agent '${row.slug}' is disabled`);
    }
    return row;
  },
};
