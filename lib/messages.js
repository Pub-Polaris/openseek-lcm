/**
 * Translation between Harness session-log values and archive records.
 *
 * The Harness log is the source of truth; this module only *reads* it. Two
 * event shapes carry model-visible conversation and are archived verbatim:
 *
 *   - `user/message`  -> `event.data` is the message itself
 *   - `assistant/message`, `tool/result`, `system/message`, `developer/message`
 *                     -> `event.data.message` is the message
 *
 * (This mirrors the Harness's own `deriveEventMessage` projection, which the
 * plugin cannot import because `@deepseek-ai/*` packages only resolve inside the
 * application archive.)
 *
 * The message shape is `{ id, role, content: ContentBlock[], source, ... }` with
 * blocks `text | reasoning | image | file | tool-call | tool-addition |
 * tool-removal`. Unknown block types are rendered as JSON rather than dropped,
 * so a future Harness block type cannot silently vanish from the archive.
 */

import { PRIVACY_EXCLUDED_TOOL_OUTPUT, isExcludedTool, redactStructuredValue, redactText } from './privacy.js';
import { collapseWhitespace, hashContent, truncate } from './text.js';

/** Event types whose payload contains one model-visible message. */
const MESSAGE_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
  'system/message',
  'developer/message',
]);

/**
 * Message source kinds that the Harness or another plugin *injected*.
 *
 * The Harness commits every injected message as a durable `user/message`, so
 * archiving them verbatim made the plugin recall its own output and stored the
 * same runtime-context envelope dozens of times. Live counts in the reference
 * archive: 66 `runtime-context`, 34 `lcm-recall`, 21 `system-prompt`,
 * 13 `tool-registry`, 8 `subagent-settled`, 6 `skill-catalog`,
 * 5 `compact-checkpoint`, 1 `goal`, plus 54 `user-approval`.
 *
 * The list is used *only* to SKIP a message. An unknown kind is captured, which
 * is the safe direction: a future injector costs archive bytes, whereas a
 * blocklist that guessed wrong would silently lose a real turn.
 */
const INJECTED_SOURCE_KINDS = new Set([
  'lcm-recall',
  'runtime-context',
  'system-prompt',
  'agent-instructions',
  'tool-registry',
  'skill-catalog',
  'subagent-settled',
  'compact-checkpoint',
  'goal',
]);

/** Whether a message's `source.kind` marks it as injected rather than authored. */
export function isInjectedSourceKind(message) {
  const kind = message?.source?.kind;
  return typeof kind === 'string' && INJECTED_SOURCE_KINDS.has(kind);
}

/** Whether this event type contributes an archived message. */
export function isMessageEventType(type) {
  return MESSAGE_EVENT_TYPES.has(type);
}

/**
 * Extract the model-visible message from a session event.
 *
 * @param {{type: string, data?: unknown}} event
 * @returns {object|undefined} the message, when this event carries one
 */
export function messageOfEvent(event) {
  if (!event || typeof event.type !== 'string') return undefined;
  if (event.type === 'user/message') {
    return event.data && typeof event.data === 'object' ? event.data : undefined;
  }
  if (!MESSAGE_EVENT_TYPES.has(event.type)) return undefined;
  const data = event.data;
  if (!data || typeof data !== 'object') return undefined;
  const message = data.message;
  return message && typeof message === 'object' ? message : undefined;
}

/** Tool name of a `tool/result` message, taken from its source attribution. */
export function toolNameOfMessage(message) {
  if (!message || message.role !== 'tool') return undefined;
  const name = message.toolName ?? message.source?.toolName ?? message.source?.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * Render one content block as archive text.
 *
 * @param {object} block
 * @returns {string}
 */
export function blockToText(block) {
  if (!block || typeof block !== 'object') return typeof block === 'string' ? block : '';
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'reasoning':
      return typeof block.text === 'string' ? block.text : '';
    case 'tool-call': {
      const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {});
      return `[tool-call ${block.name ?? 'unknown'}] ${args}`;
    }
    case 'tool-addition':
      return `[tool-addition ${block.toolName ?? 'unknown'}]`;
    case 'tool-removal':
      return `[tool-removal ${block.toolName ?? 'unknown'}]`;
    case 'image': {
      const ref = block.attachment ?? {};
      const size = Number.isFinite(ref.bytes) ? ` ${ref.bytes}B` : '';
      const dims = Number.isFinite(ref.width) && Number.isFinite(ref.height) ? ` ${ref.width}x${ref.height}` : '';
      return `[image ${ref.mediaType ?? 'unknown'}${dims}${size}${ref.name ? ` name=${ref.name}` : ''}]`;
    }
    case 'file': {
      const ref = block.attachment ?? {};
      return `[file ${ref.name ?? 'unknown'}${Number.isFinite(ref.bytes) ? ` ${ref.bytes}B` : ''}]`;
    }
    default: {
      try {
        return JSON.stringify(block);
      } catch {
        return '[unrenderable block]';
      }
    }
  }
}

/** Concatenate every block's text for one message. */
export function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.map(blockToText).filter((text) => text.length > 0).join('\n');
}

/**
 * Build a short, deterministic per-message summary line.
 *
 * Downstream this is the leaf text of a summary node, so it must be stable for
 * the same input: a summary that changes without new content would invalidate
 * the archived signature on every pass.
 *
 * @param {object} message
 * @param {number} budget
 */
export function summarizeMessage(message, budget) {
  const text = collapseWhitespace(messageText(message));
  const role = typeof message?.role === 'string' ? message.role : 'unknown';
  if (text.length === 0) return `${role}: [no text content]`;
  return `${role}: ${truncate(text, Math.max(24, budget))}`;
}

/**
 * Normalize one message into archive columns plus externalized artifacts.
 *
 * Oversized block payloads are moved into `artifacts` and replaced in the stored
 * message by a short preview, so the searchable text stays small while the full
 * content remains recoverable through `lcm_artifact`.
 *
 * @param {object} message
 * @param {object} options
 * @param {number} options.seq log position of the carrying event
 * @param {number} options.createdAt epoch milliseconds
 * @param {ReturnType<import('./privacy.js').compilePrivacy>} options.privacy
 * @param {{largeContentThreshold: number, artifactPreviewChars: number, includeToolResults: boolean}} options.config
 * @param {string} options.sessionId
 * @param {string} [options.toolName] resolved from the paired `tool/call` event
 * @returns {{role: string, text: string, infoJson: string, artifacts: Array<object>, excluded: boolean}|undefined}
 *   `undefined` means "do not archive this message": it is harness-injected or a
 *   system message the configuration excludes
 */
export function normalizeMessage(message, options) {
  const { seq, createdAt, privacy, config, sessionId } = options;
  const role = typeof message?.role === 'string' ? message.role : 'unknown';

  // Capture-side filter. Without it the plugin archives its own `lcm-recall`
  // output and the Harness's runtime-context envelopes, and can then recall
  // them again -- the archive grows with text the model already receives.
  if (isInjectedSourceKind(message)) return undefined;
  // `capture.includeSystemMessages` was resolved from config but never read;
  // this is what makes it live rather than dead configuration.
  if (role === 'system' && !config.includeSystemMessages) return undefined;

  const content = Array.isArray(message?.content) ? message.content : [];
  const artifacts = [];

  let excluded = false;
  if (role === 'tool' && !config.includeToolResults) {
    excluded = true;
  } else if (role === 'tool') {
    // The tool name is not on the result message: it comes from the paired
    // `tool/call` event, which the store resolves by `toolCallId`.
    const toolName = options.toolName ?? toolNameOfMessage(message);
    if (toolName && isExcludedTool(toolName, privacy)) {
      excluded = true;
      artifacts.push({
        artifactId: `${message.id ?? `seq-${seq}`}:excluded`,
        blockIndex: 0,
        kind: 'excluded-tool',
        fieldName: 'content',
        preview: PRIVACY_EXCLUDED_TOOL_OUTPUT,
        content: PRIVACY_EXCLUDED_TOOL_OUTPUT,
        metadata: { toolName },
      });
    }
  }

  const storedBlocks = [];
  const textParts = [];

  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    let rendered = blockToText(block);
    if (excluded) {
      storedBlocks.push({ type: 'text', text: PRIVACY_EXCLUDED_TOOL_OUTPUT });
      textParts.push(PRIVACY_EXCLUDED_TOOL_OUTPUT);
      continue;
    }

    // Privacy redaction happens before anything is written or indexed.
    rendered = redactText(rendered, privacy);

    if (rendered.length > config.largeContentThreshold) {
      const contentHash = hashContent(rendered);
      const preview = truncate(rendered, config.artifactPreviewChars);
      const artifactId = `${message.id ?? `seq-${seq}`}:${index}`;
      artifacts.push({
        artifactId,
        blockIndex: index,
        kind: typeof block?.type === 'string' ? block.type : 'unknown',
        fieldName: block?.type === 'tool-call' ? 'arguments' : 'text',
        preview,
        content: rendered,
        metadata: {
          blockType: block?.type,
          toolName: typeof block?.name === 'string' ? block.name : undefined,
          charCount: rendered.length,
        },
        contentHash,
      });
      const placeholder = `${preview}\n[full ${rendered.length} chars externalized as artifact ${artifactId}]`;
      storedBlocks.push({ type: 'text', text: placeholder });
      textParts.push(placeholder);
      continue;
    }

    storedBlocks.push(block);
    textParts.push(rendered);
  }

  // Structured metadata is redacted too: a `filePath` argument must not survive
  // inside the JSON blob after its text form was redacted.
  const info = redactStructuredValue(
    {
      id: message?.id ?? `seq-${seq}`,
      role,
      seq,
      createdAt,
      source: message?.source,
      toolCallId: message?.toolCallId,
      isError: message?.isError === true ? true : undefined,
      content: storedBlocks,
    },
    privacy,
  );

  return {
    role,
    text: textParts.filter((part) => part.length > 0).join('\n'),
    infoJson: JSON.stringify(info),
    artifacts: artifacts.map((artifact) => ({ ...artifact, sessionId })),
    excluded,
  };
}
