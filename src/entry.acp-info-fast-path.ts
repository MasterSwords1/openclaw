import { ACP_RUNTIME_INFO } from "./acp/runtime-info.js";
import { resolveCliContainerTarget } from "./cli/container-target.js";

export function isAcpRuntimeInfoInvocation(argv: string[]): boolean {
  const args = argv.slice(2);
  return args.length === 2 && args[0] === "acp" && args[1] === "info";
}

export function tryHandleAcpRuntimeInfoFastPath(
  argv: string[],
  deps: {
    env?: NodeJS.ProcessEnv;
    output?: (message: string) => void;
    exit?: (code?: number) => void;
  } = {},
): boolean {
  if (resolveCliContainerTarget(argv, deps.env) || !isAcpRuntimeInfoInvocation(argv)) {
    return false;
  }
  const output = deps.output ?? ((message: string) => process.stdout.write(`${message}\n`));
  const exit =
    deps.exit ??
    ((code?: number) => {
      process.exitCode = code ?? 0;
    });
  output(JSON.stringify(ACP_RUNTIME_INFO));
  exit(0);
  return true;
}
