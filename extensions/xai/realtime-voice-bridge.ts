import { randomUUID } from "node:crypto";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import WebSocket from "ws";
import {
  XAI_REALTIME_BASE_RECONNECT_DELAY_MS,
  XAI_REALTIME_CONNECT_TIMEOUT_MS,
  XAI_REALTIME_DEFAULT_MODEL,
  XAI_REALTIME_MAX_PENDING_TOOL_RESULTS,
  XAI_REALTIME_MAX_PENDING_USER_MESSAGES,
  XAI_REALTIME_MAX_RECONNECT_ATTEMPTS,
  XAI_REALTIME_WS_MAX_PAYLOAD_BYTES,
  readXaiRealtimeErrorDetail,
  resolveXaiRealtimeApiKey,
  toXaiRealtimeWsUrl,
  type XaiRealtimeEvent,
} from "./realtime-voice-config.js";
import { XaiRealtimeMalformedAudioError, XaiRealtimeVoiceEvents } from "./realtime-voice-events.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";

type XaiRealtimeTerminalOutcome = "completed" | "error";

type XaiRealtimeConnectionOwner = {
  id: symbol;
  controller: AbortController;
  attemptId: symbol;
  retryAttempts: number;
  terminalOutcome?: XaiRealtimeTerminalOutcome;
  terminalNotified: boolean;
};

export class XaiRealtimeVoiceBridge extends XaiRealtimeVoiceEvents implements RealtimeVoiceBridge {
  private static readonly MAX_PENDING_AUDIO_CHUNKS = 320;
  private static readonly MAX_PENDING_AUDIO_BYTES = 1024 * 1024;
  readonly supportsToolResultContinuation = false;

  private ws: WebSocket | null = null;
  private connected = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  private terminalError: Error | null = null;
  private connectionOwner: XaiRealtimeConnectionOwner | undefined;
  private connectPromise: Promise<void> | undefined;
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private pendingToolResults: Array<{
    callId: string;
    result: unknown;
    options?: RealtimeVoiceToolResultOptions;
  }> = [];
  private pendingUserMessages: string[] = [];
  private connectionUrl = "";
  private readonly flowId = randomUUID();
  private sessionReadyFired = false;

  async connect(): Promise<void> {
    if (this.terminalError) {
      throw this.terminalError;
    }
    if (this.isConnected() && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.cancelConnectionOwner(this.connectionOwner, "connection replaced");
    this.intentionallyClosed = false;
    const owner: XaiRealtimeConnectionOwner = {
      id: Symbol("xai-realtime-connection"),
      controller: new AbortController(),
      attemptId: Symbol("xai-realtime-attempt"),
      retryAttempts: 0,
      terminalNotified: false,
    };
    this.connectionOwner = owner;
    return this.trackConnect(this.connectOwned(owner));
  }

  sendAudio(audio: Buffer): void {
    if (this.intentionallyClosed) {
      return;
    }
    if (!this.connected || !this.sessionConfigured || this.ws?.readyState !== WebSocket.OPEN) {
      this.enqueuePendingAudio(audio);
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  setMediaTimestamp(ts: number): void {
    this.latestMediaTimestamp = ts;
  }

  sendUserMessage(text: string): void {
    if (this.intentionallyClosed) {
      return;
    }
    if (!this.canSubmitInput()) {
      if (this.pendingUserMessages.length < XAI_REALTIME_MAX_PENDING_USER_MESSAGES) {
        this.pendingUserMessages.push(text);
      } else {
        this.config.onError?.(
          new Error("xAI realtime voice pending user message queue overflow during reconnect"),
        );
      }
      return;
    }
    this.sendUserMessageNow(text);
  }

  triggerGreeting(instructions?: string): void {
    if (this.isConnected() && this.ws) {
      this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the user.");
    }
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    if (this.intentionallyClosed) {
      return;
    }
    if (!this.canSubmitToolResult()) {
      if (this.pendingToolResults.length < XAI_REALTIME_MAX_PENDING_TOOL_RESULTS) {
        this.pendingToolResults.push({ callId, result, ...(options ? { options } : {}) });
      } else {
        this.config.onError?.(
          new Error("xAI realtime voice pending tool result queue overflow during reconnect"),
        );
      }
      return;
    }
    this.submitToolResultNow(callId, result, options);
  }

  close(): void {
    const owner = this.connectionOwner;
    const hadConnection = Boolean(owner || this.connectPromise || this.ws);
    this.intentionallyClosed = true;
    this.connected = false;
    this.sessionConfigured = false;
    this.resetTerminalState();
    this.cancelConnectionOwner(owner, "Bridge closed");
    if (hadConnection && owner) {
      this.notifyClose(owner, "completed");
    }
  }

  isConnected(): boolean {
    return this.connected && this.sessionConfigured;
  }

  private async connectOwned(owner: XaiRealtimeConnectionOwner): Promise<void> {
    const attemptId = Symbol("xai-realtime-attempt");
    owner.attemptId = attemptId;
    const connection = this.doConnect(owner, attemptId);
    if (owner.controller.signal.aborted) {
      return;
    }
    let resolveCancellation = () => {};
    const cancelled = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const onAbort = () => resolveCancellation();
    owner.controller.signal.addEventListener("abort", onAbort, { once: true });
    if (owner.controller.signal.aborted) {
      resolveCancellation();
    }
    try {
      await Promise.race([connection, cancelled]);
    } finally {
      owner.controller.signal.removeEventListener("abort", onAbort);
    }
  }

  private trackConnect(connection: Promise<void>): Promise<void> {
    const tracked = connection.finally(() => {
      if (this.connectPromise === tracked) {
        this.connectPromise = undefined;
      }
    });
    this.connectPromise = tracked;
    return tracked;
  }

  private cancelConnectionOwner(
    owner: XaiRealtimeConnectionOwner | undefined,
    reason: string,
  ): void {
    if (!owner) {
      return;
    }
    owner.controller.abort(new Error(`xAI realtime voice ${reason}`));
    if (this.connectionOwner === owner) {
      this.connectionOwner = undefined;
    }
    const ws = this.ws;
    if (ws) {
      this.ws = null;
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.close(1000, reason);
      }
    }
  }

  private isCurrentOwner(owner: XaiRealtimeConnectionOwner): boolean {
    return this.connectionOwner?.id === owner.id;
  }

  private isCurrentAttempt(owner: XaiRealtimeConnectionOwner, attemptId: symbol): boolean {
    return this.isCurrentOwner(owner) && owner.attemptId === attemptId;
  }

  private acceptsAttempt(
    owner: XaiRealtimeConnectionOwner,
    attemptId: symbol,
    ws?: WebSocket,
  ): boolean {
    return (
      this.isCurrentAttempt(owner, attemptId) &&
      !owner.controller.signal.aborted &&
      owner.terminalOutcome === undefined &&
      (ws === undefined || this.ws === ws)
    );
  }

  private invalidateAttempt(owner: XaiRealtimeConnectionOwner, attemptId: symbol): void {
    if (this.isCurrentAttempt(owner, attemptId)) {
      owner.attemptId = Symbol("xai-realtime-inactive-attempt");
    }
  }

  private async doConnect(owner: XaiRealtimeConnectionOwner, attemptId: symbol): Promise<void> {
    const apiKey = this.config.resolveApiKey
      ? await this.config.resolveApiKey()
      : await resolveXaiRealtimeApiKey(this.config.apiKey, this.config.cfg);
    if (!this.acceptsAttempt(owner, attemptId)) {
      return;
    }
    const model = this.config.model ?? XAI_REALTIME_DEFAULT_MODEL;
    const url = toXaiRealtimeWsUrl(
      this.config.baseUrl,
      model,
      this.config.sessionResumption === true ? (this.conversationId ?? undefined) : undefined,
    );
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      ...xaiUserAgentHeaderFor(this.config.baseUrl),
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let startupFailureClosing = false;
      let terminalFailure: Error | undefined;
      let connectTimeout: ReturnType<typeof setTimeout> | undefined;
      let onAbort = () => {};
      const cleanup = () => {
        if (connectTimeout) {
          clearTimeout(connectTimeout);
          connectTimeout = undefined;
        }
        owner.controller.signal.removeEventListener("abort", onAbort);
      };
      const settleResolve = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      const settleReject = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      onAbort = settleResolve;

      if (!this.acceptsAttempt(owner, attemptId)) {
        settleResolve();
        return;
      }

      this.connectionUrl = url;
      const proxyAgent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
      const ws = new WebSocket(url, {
        headers,
        maxPayload: XAI_REALTIME_WS_MAX_PAYLOAD_BYTES,
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });
      this.ws = ws;
      owner.controller.signal.addEventListener("abort", settleResolve, { once: true });
      connectTimeout = setTimeout(() => {
        if (
          this.acceptsAttempt(owner, attemptId, ws) &&
          !this.sessionConfigured &&
          !this.intentionallyClosed
        ) {
          startupFailureClosing = true;
          settleReject(new Error("xAI realtime voice connection timeout"));
          ws.terminate();
        }
      }, XAI_REALTIME_CONNECT_TIMEOUT_MS);

      const rejectStartup = (error: Error) => {
        if (!this.acceptsAttempt(owner, attemptId, ws)) {
          return;
        }
        startupFailureClosing = true;
        settleReject(error);
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close(1000, "startup failed");
        }
      };
      const failConnection = (error: Error) => {
        if (terminalFailure || !this.acceptsAttempt(owner, attemptId, ws)) {
          return;
        }
        terminalFailure = error;
        settleReject(error);
        this.terminalError = error;
        this.setTerminalOutcome(owner, "error");
        this.intentionallyClosed = true;
        this.connected = false;
        this.sessionConfigured = false;
        this.resetTerminalState();
        try {
          this.config.onError?.(error);
        } finally {
          if (ws.readyState !== WebSocket.CLOSED) {
            ws.close(1002, "Malformed audio payload");
          } else {
            this.invalidateAttempt(owner, attemptId);
            if (this.ws === ws) {
              this.ws = null;
            }
            if (this.connectionOwner === owner) {
              this.connectionOwner = undefined;
            }
            this.notifyClose(owner, "error");
          }
        }
      };

      ws.on("open", () => {
        if (!this.acceptsAttempt(owner, attemptId, ws)) {
          if (ws.readyState !== WebSocket.CLOSED) {
            ws.close(1000, "stale connection");
          }
          return;
        }
        // Resumed sessions replay prior items, so preserve unresolved tool calls until
        // their outputs are accepted on the replacement socket.
        this.resetRealtimeSessionState({
          preserveToolCallState:
            this.config.sessionResumption === true && this.conversationId !== null,
        });
        this.connected = true;
        this.sessionConfigured = false;
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-open",
          flowId: this.flowId,
          meta: { provider: "xai", capability: "realtime-voice" },
        });
        this.sendEvent(this.buildSessionUpdate());
      });

      ws.on("message", (data: Buffer) => {
        if (!this.acceptsAttempt(owner, attemptId, ws)) {
          return;
        }
        if (settled && !this.sessionConfigured) {
          return;
        }
        captureWsEvent({
          url,
          direction: "inbound",
          kind: "ws-frame",
          flowId: this.flowId,
          payload: data,
          meta: { provider: "xai", capability: "realtime-voice" },
        });
        try {
          const event = JSON.parse(data.toString()) as XaiRealtimeEvent;
          if (event.type === "error" && !this.sessionConfigured) {
            rejectStartup(new Error(readXaiRealtimeErrorDetail(event.error)));
            return;
          }
          this.handleEvent(event);
          if (event.type === "session.updated") {
            settleResolve();
          }
        } catch (error) {
          if (error instanceof XaiRealtimeMalformedAudioError) {
            failConnection(error);
            return;
          }
          console.error("[xai] realtime event parse failed:", error);
        }
      });

      ws.on("error", (error) => {
        if (!this.acceptsAttempt(owner, attemptId, ws)) {
          return;
        }
        captureWsEvent({
          url,
          direction: "local",
          kind: "error",
          flowId: this.flowId,
          errorText: error instanceof Error ? error.message : String(error),
          meta: { provider: "xai", capability: "realtime-voice" },
        });
        if (!this.sessionConfigured) {
          rejectStartup(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      ws.on("close", (code, reasonBuffer) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-close",
          flowId: this.flowId,
          closeCode: typeof code === "number" ? code : undefined,
          meta: {
            provider: "xai",
            capability: "realtime-voice",
            reason:
              Buffer.isBuffer(reasonBuffer) && reasonBuffer.length > 0
                ? reasonBuffer.toString("utf8")
                : undefined,
          },
        });
        if (!this.isCurrentAttempt(owner, attemptId)) {
          return;
        }
        const wasSessionConfigured = this.sessionConfigured;
        this.invalidateAttempt(owner, attemptId);
        if (this.ws === ws) {
          this.ws = null;
        }
        this.connected = false;
        this.sessionConfigured = false;
        if (terminalFailure) {
          if (this.connectionOwner === owner) {
            this.connectionOwner = undefined;
          }
          this.notifyClose(owner, "error");
          return;
        }
        if (startupFailureClosing) {
          return;
        }
        if (owner.terminalOutcome === "completed" || this.intentionallyClosed) {
          settleResolve();
          if (this.connectionOwner === owner) {
            this.connectionOwner = undefined;
          }
          this.notifyClose(owner, "completed");
          return;
        }
        if (!wasSessionConfigured && !settled) {
          settleReject(new Error("xAI realtime voice connection closed before ready"));
          return;
        }
        const reconnecting = this.trackConnect(this.attemptReconnect("websocket-close", owner));
        void reconnecting.catch((error: unknown) => {
          if (!this.isCurrentOwner(owner) || owner.terminalOutcome) {
            return;
          }
          this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
      });
    });
  }

  private async attemptReconnect(reason: string, owner: XaiRealtimeConnectionOwner): Promise<void> {
    if (!this.isCurrentOwner(owner) || this.intentionallyClosed || owner.terminalOutcome) {
      return;
    }
    const blocked = this.reconnectBlockReason();
    if (blocked) {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.blocked",
        detail: `reason=${reason} ${blocked}`,
      });
      this.enterTerminalState(owner);
      return;
    }
    if (owner.retryAttempts >= XAI_REALTIME_MAX_RECONNECT_ATTEMPTS) {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.exhausted",
        detail: `reason=${reason} attempts=${owner.retryAttempts}`,
      });
      this.enterTerminalState(owner);
      return;
    }
    owner.retryAttempts += 1;
    const attempt = owner.retryAttempts;
    const delay = XAI_REALTIME_BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1);
    this.config.onEvent?.({
      direction: "client",
      type: "session.reconnect.scheduled",
      detail: `reason=${reason} attempt=${attempt} delayMs=${delay}`,
    });
    const reconnectSignal = owner.controller.signal;
    try {
      await sleepWithAbort(delay, reconnectSignal);
    } catch (error) {
      if (!reconnectSignal.aborted) {
        throw error;
      }
      return;
    }
    if (!this.isCurrentOwner(owner) || this.intentionallyClosed || owner.terminalOutcome) {
      return;
    }
    try {
      await this.connectOwned(owner);
      if (!this.isCurrentOwner(owner) || !this.sessionConfigured || owner.terminalOutcome) {
        return;
      }
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.ready",
        detail: `reason=${reason} attempt=${attempt}`,
      });
    } catch (error) {
      if (this.terminalError || !this.isCurrentOwner(owner) || owner.terminalOutcome) {
        return;
      }
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect(reason, owner);
    }
  }

  private reconnectBlockReason(): string | undefined {
    if (this.config.sessionResumption !== true) {
      return "sessionResumption=false";
    }
    if (this.pendingToolResultAcks.size > 0) {
      // xAI has no replay-complete event, so retrying an unacknowledged output
      // could duplicate a side effect at the recovery boundary.
      return `unacknowledgedToolResults=${this.pendingToolResultAcks.size}`;
    }
    if (!this.conversationId) {
      return "missingConversationId=true";
    }
    return undefined;
  }

  protected onSessionUpdated(): void {
    this.sessionConfigured = true;
    if (this.connectionOwner) {
      this.connectionOwner.retryAttempts = 0;
    }
    const pendingAudio = this.pendingAudio.splice(0);
    this.pendingAudioBytes = 0;
    for (const chunk of pendingAudio) {
      this.sendAudio(chunk);
    }
    for (const pending of this.pendingToolResults.splice(0)) {
      this.submitToolResultNow(pending.callId, pending.result, pending.options);
    }
    for (const message of this.pendingUserMessages.splice(0)) {
      this.sendUserMessageNow(message);
    }
    if (!this.sessionReadyFired) {
      this.sessionReadyFired = true;
      this.config.onReady?.();
    }
  }

  protected sendEvent(event: unknown, detail?: string): void {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const type =
      event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
        ? (event as { type: string }).type
        : "unknown";
    this.config.onEvent?.({ direction: "client", type, ...(detail ? { detail } : {}) });
    const payload = JSON.stringify(event);
    captureWsEvent({
      url: this.connectionUrl,
      direction: "outbound",
      kind: "ws-frame",
      flowId: this.flowId,
      payload,
      meta: { provider: "xai", capability: "realtime-voice" },
    });
    ws.send(payload);
  }

  private canSubmitToolResult(): boolean {
    return this.connected && this.sessionConfigured && this.ws?.readyState === WebSocket.OPEN;
  }

  private canSubmitInput(): boolean {
    return this.connected && this.sessionConfigured && this.ws?.readyState === WebSocket.OPEN;
  }

  private enqueuePendingAudio(audio: Buffer): void {
    if (
      this.pendingAudio.length >= XaiRealtimeVoiceBridge.MAX_PENDING_AUDIO_CHUNKS ||
      this.pendingAudioBytes + audio.byteLength > XaiRealtimeVoiceBridge.MAX_PENDING_AUDIO_BYTES
    ) {
      return;
    }
    const queuedAudio = Buffer.from(audio);
    this.pendingAudio.push(queuedAudio);
    this.pendingAudioBytes += queuedAudio.byteLength;
  }

  private setTerminalOutcome(
    owner: XaiRealtimeConnectionOwner,
    outcome: XaiRealtimeTerminalOutcome,
  ): XaiRealtimeTerminalOutcome {
    owner.terminalOutcome ??= outcome;
    return owner.terminalOutcome;
  }

  private notifyClose(
    owner: XaiRealtimeConnectionOwner,
    outcome: XaiRealtimeTerminalOutcome,
  ): void {
    const terminalOutcome = this.setTerminalOutcome(owner, outcome);
    if (owner.terminalNotified) {
      return;
    }
    owner.terminalNotified = true;
    this.config.onClose?.(terminalOutcome);
  }

  private enterTerminalState(owner: XaiRealtimeConnectionOwner): void {
    if (!this.isCurrentOwner(owner)) {
      return;
    }
    this.setTerminalOutcome(owner, "error");
    this.intentionallyClosed = true;
    owner.controller.abort(new Error("xAI realtime voice session failed"));
    this.connected = false;
    this.sessionConfigured = false;
    this.resetTerminalState();
    this.connectionOwner = undefined;
    this.ws = null;
    this.notifyClose(owner, "error");
  }

  private resetTerminalState(): void {
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.pendingToolResults = [];
    this.pendingUserMessages = [];
    this.conversationId = null;
    this.resetRealtimeSessionState();
  }
}
