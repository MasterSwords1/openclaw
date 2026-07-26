import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { buildAgentMainSessionKey } from "../../lib/sessions/session-key.ts";
import { pathForCustodianAgentHandoff } from "./custodian-navigation.ts";

type CustodianChatActionParams = {
  result: SystemAgentChatResult;
  context: ApplicationContext;
  isCurrent: () => boolean;
  exitSetup: () => void;
};

function finishAgentHandoff(params: CustodianChatActionParams, sessionKey?: string): void {
  if (params.result.agentDraft === "hatch" && sessionKey) {
    // Preserve the destination session while preloading the localized
    // birth-sequence opener; draft-only chat routes are intentionally invalid.
    params.context.navigate("chat", {
      pathname: pathForCustodianAgentHandoff(params.context, sessionKey),
      search: `?draft=${encodeURIComponent(t("custodian.hatchDraft"))}`,
    });
    return;
  }
  params.exitSetup();
}

async function applyAgentIdHandoff(
  params: CustodianChatActionParams,
  agentId: string,
): Promise<boolean> {
  const roster = await params.context.agents.refreshList();
  if (!params.isCurrent()) {
    return false;
  }
  const sessionKey = buildAgentMainSessionKey({
    agentId,
    mainKey: roster?.mainKey,
  });
  params.context.gateway.setSessionKey(sessionKey);
  finishAgentHandoff(params, sessionKey);
  return true;
}

export function applyCustodianChatAction(
  params: CustodianChatActionParams,
): boolean | Promise<boolean> {
  if (params.result.action === "exit") {
    params.exitSetup();
    return true;
  }
  if (params.result.action !== "open-agent") {
    return true;
  }
  if (params.result.agentId) {
    return applyAgentIdHandoff(params, params.result.agentId);
  }
  finishAgentHandoff(params, params.context.gateway.snapshot.sessionKey?.trim());
  return true;
}
