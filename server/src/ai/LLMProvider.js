// LLMProvider — the abstraction the whole AI layer depends on.
//
// An Agent (and therefore the system) talks to THIS interface, never to a
// concrete vendor SDK. Each provider implementation (AnthropicProvider,
// OpenAIProvider, …) normalizes one SDK behind these methods, so swapping the
// model/vendor is a registry change, not a code change.
//
// Normalized request (passed to complete / generateStructured / stream):
//   { model?, system?, messages: NativeMessage[], tools?, maxTokens?, schema? }
//   - `messages` are in the provider's OWN native shape; the Agent only ever
//     builds the first user message and otherwise threads them through the
//     provider's append* helpers, so it never needs to know the wire format.
//   - `tools` are [{ name, description, input_schema }] (the Agent strips the
//     `run` function before handing them over).
//
// Normalized response (returned by complete / generateStructured / stream):
//   { text, toolCalls: [{ id, name, input }], stopReason, usage, raw, parsed? }

export class LLMProvider {
  // Registry id, e.g. 'anthropic'. Subclasses MUST override.
  static id = 'abstract';

  get id() {
    return this.constructor.id;
  }

  // What this provider supports. Agents read these to decide their path.
  get capabilities() {
    return { tools: false, structured: false, streaming: false };
  }

  // One model turn. Returns the normalized response above.
  async complete(_request) {
    throw new Error(`Provider '${this.id}' does not implement complete()`);
  }

  // Structured output: the normalized response's `parsed` holds the object
  // validated against `request.schema` (a JSON Schema).
  async generateStructured(_request) {
    throw new Error(`Provider '${this.id}' does not implement generateStructured()`);
  }

  // Streaming. Default: fall back to complete() and emit the whole text once,
  // so a non-streaming provider still satisfies callers that pass onToken.
  async stream(request, onToken) {
    const res = await this.complete(request);
    if (typeof onToken === 'function' && res.text) onToken(res.text);
    return res;
  }

  // --- Tool-loop message threading (native shape, provider-owned) ----------
  // The Agent's agentic loop calls these to append the assistant turn and the
  // tool results in the provider's own message format. Providers that support
  // tools override both; the base throws so a non-tool provider fails loudly if
  // an Agent tries to use tools with it.
  appendAssistant(_messages, _response) {
    throw new Error(`Provider '${this.id}' does not support tool use (appendAssistant)`);
  }

  appendToolResults(_messages, _results) {
    throw new Error(`Provider '${this.id}' does not support tool use (appendToolResults)`);
  }
}
