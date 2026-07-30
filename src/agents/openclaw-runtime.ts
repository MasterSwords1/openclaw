import { type AgentEventRuntimePayload, onAgentRuntimeEvent } from "../infra/agent-events.js";
import {
  runOpenClawRuntimeTurn,
  type OpenClawRuntimeTurnInput,
  type OpenClawRuntimeTurnResult,
} from "./openclaw-runtime-turn.js";

type AgentTurnObserver = (event: AgentEventRuntimePayload) => void;

type OpenClawRuntime = {
  observeAgentTurns(observer: AgentTurnObserver): () => void;
  startTurn(input: OpenClawRuntimeTurnInput): Promise<OpenClawRuntimeTurnResult>;
};

export const openClawRuntime: OpenClawRuntime = {
  observeAgentTurns: onAgentRuntimeEvent,
  startTurn: runOpenClawRuntimeTurn,
};
