// model-profiles.js - 主流模型适配档案
// 针对当前主流模型（DeepSeek / OpenAI GPT / Claude / Gemini / Qwen / GLM / Llama 等）
// 提供：上下文窗口、默认 max_tokens、推荐 temperature 范围、思考深度映射校准。
'use strict';

const PROFILES = {
  // ---- DeepSeek ----
  'deepseek-chat': { context: 64000, maxTokens: 8192, tempRange: [0.0, 1.5], provider: 'deepseek' },
  'deepseek-reasoner': { context: 64000, maxTokens: 8192, tempRange: [0.0, 1.0], provider: 'deepseek' },
  'deepseek-v3': { context: 64000, maxTokens: 8192, tempRange: [0.0, 1.5], provider: 'deepseek' },
  'deepseek-r1': { context: 64000, maxTokens: 8192, tempRange: [0.0, 1.0], provider: 'deepseek' },

  // ---- OpenAI ----
  'gpt-4o': { context: 128000, maxTokens: 16384, tempRange: [0.0, 2.0], provider: 'openai' },
  'gpt-4o-mini': { context: 128000, maxTokens: 16384, tempRange: [0.0, 2.0], provider: 'openai' },
  'gpt-4-turbo': { context: 128000, maxTokens: 4096, tempRange: [0.0, 2.0], provider: 'openai' },
  'gpt-4': { context: 8192, maxTokens: 8192, tempRange: [0.0, 2.0], provider: 'openai' },
  'gpt-3.5-turbo': { context: 16385, maxTokens: 4096, tempRange: [0.0, 2.0], provider: 'openai' },
  'o1': { context: 200000, maxTokens: 100000, tempRange: [1.0, 1.0], provider: 'openai', fixedTemp: true },
  'o1-mini': { context: 128000, maxTokens: 65536, tempRange: [1.0, 1.0], provider: 'openai', fixedTemp: true },
  'o3': { context: 200000, maxTokens: 100000, tempRange: [1.0, 1.0], provider: 'openai', fixedTemp: true },
  'o3-mini': { context: 200000, maxTokens: 100000, tempRange: [1.0, 1.0], provider: 'openai', fixedTemp: true },

  // ---- Anthropic Claude ----
  'claude-3-5-sonnet': { context: 200000, maxTokens: 8192, tempRange: [0.0, 1.0], provider: 'anthropic' },
  'claude-3-5-haiku': { context: 200000, maxTokens: 8192, tempRange: [0.0, 1.0], provider: 'anthropic' },
  'claude-3-opus': { context: 200000, maxTokens: 4096, tempRange: [0.0, 1.0], provider: 'anthropic' },
  'claude-sonnet-4': { context: 200000, maxTokens: 64000, tempRange: [0.0, 1.0], provider: 'anthropic' },

  // ---- Google Gemini ----
  'gemini-1.5-pro': { context: 1048576, maxTokens: 8192, tempRange: [0.0, 2.0], provider: 'gemini' },
  'gemini-1.5-flash': { context: 1048576, maxTokens: 8192, tempRange: [0.0, 2.0], provider: 'gemini' },
  'gemini-2.0-flash': { context: 1048576, maxTokens: 8192, tempRange: [0.0, 2.0], provider: 'gemini' },
  'gemini-2.5-pro': { context: 1048576, maxTokens: 65536, tempRange: [0.0, 2.0], provider: 'gemini' },

  // ---- Qwen (通义千问) ----
  'qwen-max': { context: 32768, maxTokens: 8192, tempRange: [0.0, 2.0], provider: 'qwen' },
  'qwen-plus': { context: 131072, maxTokens: 8192, tempRange: [0.0, 2.0], provider: 'qwen' },
  'qwen-turbo': { context: 131072, maxTokens: 8192, tempRange: [0.0, 2.0], provider: 'qwen' },
  'qwen2.5-72b-instruct': { context: 131072, maxTokens: 8192, tempRange: [0.0, 2.0], provider: 'qwen' },

  // ---- GLM (智谱) ----
  'glm-4': { context: 128000, maxTokens: 4096, tempRange: [0.0, 1.0], provider: 'zhipu' },
  'glm-4-plus': { context: 128000, maxTokens: 8192, tempRange: [0.0, 1.0], provider: 'zhipu' },
  'glm-4-air': { context: 128000, maxTokens: 8192, tempRange: [0.0, 1.0], provider: 'zhipu' },
  'glm-4-flash': { context: 128000, maxTokens: 4096, tempRange: [0.0, 1.0], provider: 'zhipu' },

  // ---- 开源本地 ----
  'llama-3.1-8b-instruct': { context: 131072, maxTokens: 8192, tempRange: [0.0, 2.0], provider: 'local' },
  'llama-3.1-70b-instruct': { context: 131072, maxTokens: 8192, tempRange: [0.0, 2.0], provider: 'local' },
  'llama-3.3-70b-instruct': { context: 131072, maxTokens: 8192, tempRange: [0.0, 2.0], provider: 'local' },
  'mistral-large': { context: 131072, maxTokens: 8192, tempRange: [0.0, 1.0], provider: 'local' },
  'mixtral-8x7b-instruct': { context: 32768, maxTokens: 8192, tempRange: [0.0, 1.0], provider: 'local' }
};

// 通过模型名模糊匹配档案（支持 "gpt-4o-2024-08-06"、"deepseek-chat:latest" 等）
function profileFor(modelId) {
  if (!modelId) return null;
  const exact = PROFILES[modelId];
  if (exact) return exact;
  // 去掉版本后缀
  const base = modelId.split(':')[0].split('@')[0].replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (PROFILES[base]) return PROFILES[base];
  // 前缀匹配（如 gpt-4o-*、claude-*）
  for (const key of Object.keys(PROFILES)) {
    if (base.startsWith(key + '-') || base.startsWith(key)) return PROFILES[key];
  }
  return null;
}

module.exports = { PROFILES, profileFor };
