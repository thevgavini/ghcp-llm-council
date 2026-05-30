// Curated catalog of councillor-eligible models, grouped by backend.
//
// The frontend uses this to populate dropdowns in the settings drawer so
// users don't have to remember model IDs. Adding a model here is the only
// step needed — the backend dispatcher reads model IDs verbatim.
//
// Keep this list focused on models that are actually viable as a councillor
// (good reasoning + reasonable latency + supported on the listed backend).
// IDs MUST match what each backend expects:
//   - task         : passed straight to the Copilot CLI `task` tool's model field
//   - github-models: passed as the `model` field to models.github.ai chat completions

const KNOWN_MODELS = {
  task: [
    { vendor: 'Anthropic', id: 'claude-opus-4.7',     display: 'Claude Opus 4.7' },
    { vendor: 'Anthropic', id: 'claude-opus-4.6',     display: 'Claude Opus 4.6' },
    { vendor: 'Anthropic', id: 'claude-sonnet-4.6',   display: 'Claude Sonnet 4.6' },
    { vendor: 'Anthropic', id: 'claude-sonnet-4.5',   display: 'Claude Sonnet 4.5' },
    { vendor: 'Anthropic', id: 'claude-haiku-4.5',    display: 'Claude Haiku 4.5' },
    { vendor: 'OpenAI',    id: 'gpt-5.4',             display: 'GPT-5.4' },
    { vendor: 'OpenAI',    id: 'gpt-5.2',             display: 'GPT-5.2' },
    { vendor: 'OpenAI',    id: 'gpt-5.3-codex',       display: 'GPT-5.3 Codex' },
    { vendor: 'OpenAI',    id: 'gpt-5-mini',          display: 'GPT-5 mini' },
    { vendor: 'OpenAI',    id: 'gpt-4.1',             display: 'GPT-4.1' }
  ],
  'github-models': [
    { vendor: 'Meta',      id: 'meta/llama-3.3-70b-instruct',          display: 'Llama 3.3 70B' },
    { vendor: 'Meta',      id: 'meta/llama-4-scout-17b-16e-instruct',  display: 'Llama 4 Scout 17B' },
    { vendor: 'DeepSeek',  id: 'deepseek/deepseek-v3-0324',            display: 'DeepSeek V3' },
    { vendor: 'DeepSeek',  id: 'deepseek/deepseek-r1',                 display: 'DeepSeek R1' },
    { vendor: 'Mistral',   id: 'mistral-ai/mistral-medium-2505',       display: 'Mistral Medium 2505' },
    { vendor: 'Mistral',   id: 'mistral-ai/mistral-small-2503',        display: 'Mistral Small 2503' },
    { vendor: 'Mistral',   id: 'mistral-ai/codestral-2501',            display: 'Codestral 2501' },
    { vendor: 'Microsoft', id: 'microsoft/phi-4',                      display: 'Phi-4' },
    { vendor: 'Microsoft', id: 'microsoft/phi-4-multimodal-instruct',  display: 'Phi-4 Multimodal' },
    { vendor: 'Cohere',    id: 'cohere/cohere-command-a',              display: 'Cohere Command A' },
    { vendor: 'AI21 Labs', id: 'ai21-labs/ai21-jamba-1.5-large',       display: 'Jamba 1.5 Large' },
    { vendor: 'OpenAI',    id: 'openai/gpt-4.1',                       display: 'GPT-4.1 (via GitHub Models)' },
    { vendor: 'OpenAI',    id: 'openai/gpt-4o',                        display: 'GPT-4o (via GitHub Models)' },
    { vendor: 'OpenAI',    id: 'openai/gpt-4o-mini',                   display: 'GPT-4o mini (via GitHub Models)' }
  ]
};

module.exports = { KNOWN_MODELS };
