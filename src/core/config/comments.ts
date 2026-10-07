/**
 * What each line of `config.yml` is for.
 *
 * The help lives here rather than in the file, and is stamped onto the file when
 * it is first written — and onto a key that appears later, when a setting is
 * added. That is the only place it can live: every surface rewrites the config
 * (`/mode`, `/tools`, `/effort`, `/model`, `milo setup`, the browser's Settings
 * screen), so a comment the file itself carried would be gone at the first one.
 * Kept a table instead, so a new setting gets its line by adding one entry, and
 * the prose never drifts from the code that writes it.
 *
 * A path is dotted, per key: `sessions.maxSessions`. An entry for a section
 * explains the section; entries for its keys sit under it in the file.
 */
export const CONFIG_NOTES: Record<string, string> = {
  provider: 'Which provider this install talks to: a key of `providers` below.',
  model: 'The model the surfaces open on. `/model` changes it and writes it here.',
  providers: 'One entry per provider: base URL, wire format, and any extra headers.',
  maxTokens:
    'Output ceiling per request. Left out, each wire uses its own default — 4096 on the Anthropic one.',
  reasoningEffort: 'How hard the model thinks: low, medium or high. Every request carries it.',
  systemPrompt: 'Prepended to every conversation. Left out, the built-in persona is used.',
  maxSteps: 'How many steps one turn may take before it stops.',

  memory: 'What Milo keeps between conversations, and how recall finds it.',
  'memory.derive': 'Read each finished turn for facts worth keeping. Costs one model call per turn.',
  'memory.embedding':
    'Recall by meaning, off unless this is set. Needs an engine: one on this machine, or a keyed one.',

  sessions: 'How a conversation is kept, compacted and pruned.',
  'sessions.compactAt': "Fold the oldest turns once a request passes this share of the model's window.",
  'sessions.keepTurns': 'Turns kept verbatim when compacting; older ones are summarized.',
  'sessions.maxSessions': 'How many sessions stay on disk. 0 keeps every one.',
  'sessions.compaction': 'Whether a long conversation is folded at all.',
  'sessions.contextWindow': 'The window in tokens, for a model the public catalog gets wrong or misses.',

  history: 'The log: one JSONL per day, and how far back recall reads it.',
  'history.windowDays': 'How far back recall reaches. 0 keeps every day.',

  traces: 'The execution log: every model request, classifier, tool and turn with its latency. No content.',
  'traces.enabled': 'false turns the execution log off; nothing else in Milo changes.',

  display: 'How much of a turn the surfaces show. One setting for every surface.',
  'display.tools': 'full, name or off — how much of each tool call is shown.',
  'display.thinking': "on or off — whether the model's reasoning is shown. Display only.",

  gateways: 'The chat surfaces. The browser chat is served by `milo serve` and lives under `web`.',
  web: 'The browser chat: whether it is served, and where it listens.',
  google: 'Google (Gmail and Drive): off unless asked for. Connect with `milo google connect`.',
  media: 'Optional model choices for incoming images, audio transcription, and documents.',
  'media.audio': 'Groq Whisper model for audio transcription. Requires GROQ_API_KEY.',
  'media.vision': 'Optional model id for images. Milo checks provider metadata when available; unknown models need an explicit choice here.',
  'media.document': 'Optional document model id; absent, the main chat model is used.',
  'google.enabled':
    'Whether Milo may read your mail and files. The grant itself is a secret and lives in auth.json.',
  'web.enabled': 'false is `milo serve --no-web` written down.',
  'web.host': 'Loopback by default. Anything else is reachable from the network.',
  'web.port': 'Where it listens. `--web-port` overrides it for one run.',

  permissions: 'What may run without asking.',
  'permissions.mode': 'ask, auto or yolo. One value for every surface.',
  'permissions.allow': 'Tools never asked about. Beats the rules, so it is a blanket yes.',
  'permissions.deny': 'Tools refused outright. Outranked only by yolo.',
  'permissions.jevTimeoutMs': 'Superseded by classifier.timeoutMs; kept so an older file still loads.',

  classifier: 'The decision model an auto-mode review is asked of: the hosted jev, OpenAI Decisions, OpenRouter, a local Ollaya, or your own.',
  'classifier.backend': 'commandcode (hosted, on the chat provider), openai (the Decisions API), openrouter (the same wire, through OpenRouter), ollaya (local, TypeSafe-compatible), or custom.',
  'classifier.model': 'The model to ask, e.g. typesafe/jev, gpt-6-luna, winnow:e4b, laya. Absent, the backend default.',
  'classifier.url': 'An endpoint of your own. Absent, the backend default: Ollaya on 127.0.0.1:11435, or the OpenAI or OpenRouter API.',
  'classifier.keyEnv': 'Which environment variable holds the key. Absent, OPENAI_API_KEY or OPENROUTER_API_KEY, matching the backend.',
  'classifier.timeoutMs': 'Abort a review after this long, then fail closed to asking.',

  browser: 'The Chromium Milo drives for its browser tools. Off until it is turned on.',
  'browser.enabled': 'Off means the three browser tools are not in the catalog at all.',
  'browser.headless': 'false opens a window, which is how a sign-in is done once by hand.',

  search: 'The provider behind web_search. Absent, the tool is not registered.',
}
