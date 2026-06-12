// providerRegistry — the swap point for LLM providers.
//
// Providers register here (the extension loader registers any
// extensions/ai/providers/*.js). Agents resolve their provider through
// `default()`, so which model/vendor the system uses is config, not code:
// set AI_PROVIDER=openai (etc.) to switch.

const providers = new Map(); // id -> LLMProvider instance
let firstRegisteredId = null;

export const providerRegistry = {
  // Register a provider instance. Its id comes from the static `id`.
  register(provider, source = '<unknown>') {
    const id = provider?.id;
    if (!id || id === 'abstract') {
      throw new Error(`Provider from ${source} must set a non-abstract static id`);
    }
    if (typeof provider.complete !== 'function') {
      throw new Error(`Provider '${id}' from ${source} must implement complete()`);
    }
    providers.set(id, provider);
    if (!firstRegisteredId) firstRegisteredId = id;
    return id;
  },

  has(id) { return providers.has(id); },

  get(id) {
    const p = providers.get(id);
    if (!p) {
      throw new Error(`Unknown LLM provider '${id}'. Registered: ${this.list().join(', ') || '(none)'}`);
    }
    return p;
  },

  list() { return [...providers.keys()]; },

  // The provider to use when an Agent didn't pin one:
  //   - AI_PROVIDER env if set (must be registered);
  //   - otherwise the first registered provider.
  default() {
    const want = process.env.AI_PROVIDER;
    if (want) return this.get(want); // throws with a helpful message if unknown
    if (!firstRegisteredId) {
      throw new Error('No LLM providers registered — cannot resolve a default provider');
    }
    return providers.get(firstRegisteredId);
  },

  // Test/reload only.
  _reset() { providers.clear(); firstRegisteredId = null; },
};
