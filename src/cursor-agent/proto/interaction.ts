// @ts-nocheck
import { parseProtoFields } from "./decoding.js";
import { parseToolCallStartedUpdate, parsePartialToolCallUpdate } from "./tool-calls.js";
import type { CursorTurnUsage, ParsedInteractionUpdate } from "./types.js";

/**
 * Parse an InteractionUpdate message
 *
 * InteractionUpdate fields:
 *   field 1: text_delta (TextDeltaUpdate)
 *   field 2: tool_call_started (ToolCallStartedUpdate)
 *   field 3: tool_call_completed (ToolCallCompletedUpdate)
 *   field 7: partial_tool_call (PartialToolCallUpdate)
 *   field 8: token_delta (TokenDeltaUpdate)
 *   field 13: heartbeat
 *   field 14: turn_ended (TurnEndedUpdate)
 */
export function parseInteractionUpdate(data: Uint8Array): ParsedInteractionUpdate {
  const fields = parseProtoFields(data);

  let text: string | null = null;
  let isComplete = false;
  let isHeartbeat = false;
  let toolCallStarted: ParsedInteractionUpdate["toolCallStarted"] = null;
  let toolCallCompleted: ParsedInteractionUpdate["toolCallCompleted"] = null;
  let partialToolCall: ParsedInteractionUpdate["partialToolCall"] = null;
  let usage: CursorTurnUsage | undefined;

  for (const field of fields) {
    // field 1 = text_delta (TextDeltaUpdate)
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const innerFields = parseProtoFields(field.value);
      for (const innerField of innerFields) {
        if (innerField.fieldNumber === 1 && innerField.wireType === 2 && innerField.value instanceof Uint8Array) {
          text = new TextDecoder().decode(innerField.value);
        }
      }
    }
    // field 2 = tool_call_started (ToolCallStartedUpdate)
    else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const parsed = parseToolCallStartedUpdate(field.value);
      if (parsed.toolCall) {
        toolCallStarted = {
          callId: parsed.callId,
          modelCallId: parsed.modelCallId,
          toolType: parsed.toolCall.toolType,
          name: parsed.toolCall.name,
          arguments: JSON.stringify(parsed.toolCall.arguments),
        };
      }
    }
    // field 3 = tool_call_completed (ToolCallCompletedUpdate)
    else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const parsed = parseToolCallStartedUpdate(field.value); // Same structure as started
      if (parsed.toolCall) {
        toolCallCompleted = {
          callId: parsed.callId,
          modelCallId: parsed.modelCallId,
          toolType: parsed.toolCall.toolType,
          name: parsed.toolCall.name,
          arguments: JSON.stringify(parsed.toolCall.arguments),
        };
      }
    }
    // field 7 = partial_tool_call (PartialToolCallUpdate)
    else if (field.fieldNumber === 7 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const parsed = parsePartialToolCallUpdate(field.value);
      partialToolCall = {
        callId: parsed.callId,
        argsTextDelta: parsed.argsTextDelta,
      };
    }
    // field 8 = token_delta (TokenDeltaUpdate)
    else if (field.fieldNumber === 8 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const tokenFields = parseProtoFields(field.value);
      for (const tField of tokenFields) {
        if (tField.fieldNumber === 1 && tField.wireType === 2 && tField.value instanceof Uint8Array) {
          text = new TextDecoder().decode(tField.value);
        }
      }
    }
    // field 14 = turn_ended (TurnEndedUpdate)
    else if (field.fieldNumber === 14) {
      isComplete = true;
      if (field.wireType === 2 && field.value instanceof Uint8Array) {
        usage = parseTurnEndedUpdate(field.value);
      }
    }
    // field 13 = heartbeat
    else if (field.fieldNumber === 13) {
      isHeartbeat = true;
    }
  }

  return { text, isComplete, isHeartbeat, usage, toolCallStarted, toolCallCompleted, partialToolCall };
}

function parseTurnEndedUpdate(data: Uint8Array): CursorTurnUsage {
  const usage: CursorTurnUsage = {};
  for (const field of parseProtoFields(data)) {
    if (field.wireType !== 0 || typeof field.value !== "number") continue;
    if (field.fieldNumber === 1) usage.inputTokens = field.value;
    else if (field.fieldNumber === 2) usage.outputTokens = field.value;
    else if (field.fieldNumber === 3) usage.cacheReadTokens = field.value;
    else if (field.fieldNumber === 4) usage.cacheWriteTokens = field.value;
  }
  return usage;
}
