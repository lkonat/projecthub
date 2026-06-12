// AnthropicProvider — the default LLM provider, wrapping @anthropic-ai/sdk.
//
// Registered automatically by the extension loader (extensions/ai/providers/).
// The SDK client is created lazily on first use, so boot doesn't require a key.

import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider } from '../lib/core.js';

class AnthropicProvider extends LLMProvider {
  static id = 'anthropic';

  constructor() {
    super();
    this._client = null;
    this.defaultModel = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  }

  get capabilities() {
    return { tools: true, structured: true, streaming: true };
  }

  client() {
    if (this._client) return this._client;
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set (provider 'anthropic')");
    }
    this._client = new Anthropic(); // reads ANTHROPIC_API_KEY from the env
    return this._client;
  }

  async complete({ model, system, messages, tools, maxTokens = 8000 }) {
    const res = await this.client().messages.create({
      model: model || this.defaultModel,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      ...(system ? { system } : {}),
      ...(tools ? { tools } : {}),
      messages,
    });
    return this._normalize(res);
  }

  async generateStructured({ model, system, messages, schema, maxTokens = 8000 }) {
    const res = await this.client().messages.create({
      model: model || this.defaultModel,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema } },
      ...(system ? { system } : {}),
      messages,
    });
    const norm = this._normalize(res);
    norm.parsed = JSON.parse(norm.text || 'null');
    return norm;
  }

  async stream({ model, system, messages, maxTokens = 16000 }, onToken) {
    const stream = this.client().messages.stream({
      model: model || this.defaultModel,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      ...(system ? { system } : {}),
      messages,
    });
    if (typeof onToken === 'function') stream.on('text', onToken);
    return this._normalize(await stream.finalMessage());
  }

  _normalize(res) {
    const blocks = res.content || [];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      toolCalls: blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input })),
      stopReason: res.stop_reason,
      usage: res.usage,
      raw: res,
    };
  }

  // Native message threading for the Agent tool loop (Anthropic shape).
  appendAssistant(messages, response) {
    return messages.concat([{ role: 'assistant', content: response.raw.content }]);
  }

  appendToolResults(messages, results) {
    return messages.concat([
      {
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.toolUseId,
          content: r.content,
        })),
      },
    ]);
  }
}

export default new AnthropicProvider();
