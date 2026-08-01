import type { ImageGenerationProvider } from "./types.js";

export function resolveImageGenerationMaxInputImages(params: {
  provider: Pick<ImageGenerationProvider, "capabilities">;
  model?: string;
  mode?: "generate" | "edit";
}): number | undefined {
  const mode = params.mode ?? "edit";
  const model = params.model?.trim();
  const caps =
    mode === "edit" ? params.provider.capabilities.edit : params.provider.capabilities.generate;
  let prefixLimit: number | undefined;
  let prefixLength = -1;
  if (model) {
    const maxInputImagesByModelPrefix = caps.maxInputImagesByModelPrefix;
    if (maxInputImagesByModelPrefix) {
      for (const [prefix, limit] of Object.entries(maxInputImagesByModelPrefix)) {
        if (prefix.length > prefixLength && model.startsWith(prefix)) {
          prefixLimit = limit;
          prefixLength = prefix.length;
        }
      }
    }
  }
  const defaultMaxInputImages = mode === "generate" ? 0 : undefined;
  return (
    (model ? caps.maxInputImagesByModel?.[model] : undefined) ??
    prefixLimit ??
    caps.maxInputImages ??
    defaultMaxInputImages
  );
}
