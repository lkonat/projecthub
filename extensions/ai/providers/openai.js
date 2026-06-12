// OpenAIProvider — a second LLM provider, wrapping the `openai` SDK.
//
// Demonstrates that the system is provider-agnostic: select it with
// AI_PROVIDER=openai (and OPENAI_API_KEY set). Registered automatically by the
// extension loader; the SDK client is created lazily on first use.
//
// This is a working mapping of the normalized request/response onto OpenAI's
// Chat Completions API, but it is not exercised in CI (no OpenAI key). Treat it
// as the template for adding further providers.

import OpenAI from 'openai';
import { LLMProvider } from '../lib/core.js';

class OpenAIProvider extends LLMProvider {
  static id = 'openai';

  constructor() {
    super();
    this._client = null;
    this.defaultModel = process.env.OPENAI_MODEL || 'gpt-4o';
  }

  get capabilities() {
    return { tools: true, structured: true, streaming: true };
  }

  client() {
    if (this._client) return this._client;
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set (provider 'openai')");
    }
    this._client = new OpenAI(); // reads OPENAI_API_KEY from the env
    return this._client;
  }

  // OpenAI carries the system prompt as the first message in the array.
  _withSystem(system, messages) {
    return system ? [{ role: 'system', content: system }, ...messages] : messages;
  }

  async complete({ model, system, messages, tools, maxTokens = 8000 }) {
    const res = await this.client().chat.completions.create({
      model: model || this.defaultModel,
      max_tokens: maxTokens,
      messages: this._withSystem(system, messages),
      ...(tools
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.input_schema },
            })),
          }
        : {}),
    });
    return this._normalize(res);
  }

  async generateStructured({ model, system, messages, schema, maxTokens = 8000 }) {
    const res = await this.client().chat.completions.create({
      model: model || this.defaultModel,
      max_tokens: maxTokens,
      messages: this._withSystem(system, messages),
      response_format: { type: 'json_schema', json_schema: { name: 'output', schema, strict: true } },
    });
    const norm = this._normalize(res);
    norm.parsed = JSON.parse(norm.text || 'null');
    return norm;
  }

  _normalize(res) {
    const choice = res.choices?.[0];
    const msg = choice?.message ?? {};
    return {
      text: msg.content ?? '',
      toolCalls: (msg.tool_calls || []).map((t) => ({
        id: t.id,
        name: t.function.name,
        input: JSON.parse(t.function.arguments || '{}'),
      })),
      stopReason: choice?.finish_reason,
      usage: res.usage,
      raw: res,
    };
  }

  // Native message threading for the Agent tool loop (OpenAI shape).
  appendAssistant(messages, response) {
    return messages.concat([response.raw.choices[0].message]);
  }

  appendToolResults(messages, results) {
    return messages.concat(
      results.map((r) => ({ role: 'tool', tool_call_id: r.toolUseId, content: r.content })),
    );
  }
}

export default new OpenAIProvider();
