// OllamaProvider — a local LLM provider backed by an Ollama install.
//
// Talks to Ollama's native chat API (POST {OLLAMA_HOST}/api/chat) over the
// built-in fetch — no SDK, no API key, no network egress. Registered
// automatically by the extension loader. Select it with AI_PROVIDER=ollama.
//
// Config (env):
//   OLLAMA_HOST   base URL          (default http://localhost:11434)
//   OLLAMA_MODEL  default model     (default llama3.2:3b)

import { LLMProvider } from '../lib/core.js';

// Some models (e.g. qwen3) prepend chain-of-thought as <think>…</think>. Strip
// it so the agent sees only the answer; harmless when absent.
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
}

class OllamaProvider extends LLMProvider {
  static id = 'ollama';

  constructor() {
    super();
    this.baseUrl = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
    this.defaultModel = process.env.OLLAMA_MODEL || 'llama3.2:3b';
  }

  get capabilities() {
    return { tools: true, structured: true, streaming: false };
  }

  // Ollama carries the system prompt as the first message, like OpenAI.
  _withSystem(system, messages) {
    return system ? [{ role: 'system', content: system }, ...messages] : messages;
  }

  async _chat(body) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stream: false, ...body }),
      });
    } catch (err) {
      throw new Error(
        `Ollama is not reachable at ${this.baseUrl} (${err.message}). Is it running? (\`ollama serve\`)`
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama request failed (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  }

  async complete({ model, system, messages, tools, maxTokens = 8000 }) {
    const res = await this._chat({
      model: model || this.defaultModel,
      messages: this._withSystem(system, messages),
      options: { num_predict: maxTokens },
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
    const res = await this._chat({
      model: model || this.defaultModel,
      messages: this._withSystem(system, messages),
      options: { num_predict: maxTokens },
      format: schema, // Ollama structured outputs: constrain to this JSON Schema
    });
    const norm = this._normalize(res);
    norm.parsed = JSON.parse(norm.text || 'null');
    return norm;
  }

  _normalize(res) {
    const msg = res.message ?? {};
    return {
      text: stripThinking(msg.content ?? ''),
      toolCalls: (msg.tool_calls || []).map((t, i) => ({
        id: t.id || `call_${i}`,
        name: t.function?.name,
        // Ollama returns arguments as an object already (not a JSON string).
        input: typeof t.function?.arguments === 'string'
          ? JSON.parse(t.function.arguments || '{}')
          : (t.function?.arguments || {}),
      })),
      stopReason: res.done_reason ?? (res.done ? 'stop' : null),
      usage: { promptTokens: res.prompt_eval_count, completionTokens: res.eval_count },
      raw: res,
    };
  }

  // Native message threading for the Agent tool loop (Ollama shape).
  appendAssistant(messages, response) {
    return messages.concat([response.raw.message]);
  }

  appendToolResults(messages, results) {
    return messages.concat(results.map((r) => ({ role: 'tool', content: r.content })));
  }
}

export default new OllamaProvider();
