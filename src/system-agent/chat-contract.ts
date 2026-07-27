import type { SystemAgentChatQuestion } from "../../packages/gateway-protocol/src/index.js";
import type { SystemAgentOperation } from "./operation-types.js";

export type SystemAgentChatReplyAction = "none" | "exit" | "open-tui" | "open-setup";

/** Transport-independent result returned by the OpenClaw chat engine. */
export type SystemAgentChatReply = {
  text: string;
  action: SystemAgentChatReplyAction;
  /** Client-localized draft intent for the destination agent chat. */
  agentDraft?: "hatch";
  /** The next hosted-wizard reply contains a secret and must be masked/redacted by hosts. */
  sensitive?: boolean;
  /** The hosted wizard will consume the next message as its current step answer. */
  wizardInputPending?: boolean;
  /** Present when the host must leave chat for an interactive handoff. */
  handoff?: SystemAgentOperation;
  /** Structured choice mirroring the awaited wizard step for card-capable clients. */
  question?: SystemAgentChatQuestion;
};
