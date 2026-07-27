// Gateway Protocol QR schemas share the established PNG data-URL contract.
import { Type } from "typebox";

export const QR_PNG_DATA_URL_MAX_LENGTH = 16_384;

export const QrPngDataUrlSchema = Type.String({
  maxLength: QR_PNG_DATA_URL_MAX_LENGTH,
  pattern: "^data:image/png;base64,",
});
