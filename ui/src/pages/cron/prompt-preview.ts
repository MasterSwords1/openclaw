import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icon } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { t } from "../../i18n/index.ts";

function stopPropagationForInteractive(event: MouseEvent) {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest("a,button,input,textarea,select,summary,[role='button'],[role='link']")) {
    event.stopPropagation();
  }
}

export function renderPromptMarkdownPreview(payloadText: string, open = false) {
  const trimmed = payloadText.trim();
  return html`
    <details class="cron-prompt-preview" data-test-id="cron-prompt-preview" ?open=${open}>
      <summary class="cron-prompt-preview__summary" data-test-id="cron-prompt-preview-summary">
        ${icon("scrollText")} <span>${t("cron.form.previewMarkdown")}</span>
      </summary>
      <div
        class="cron-payload-markdown chat-text"
        data-test-id="cron-payload-markdown"
        @click=${stopPropagationForInteractive}
      >
        ${
          trimmed
            ? unsafeHTML(toSanitizedMarkdownHtml(payloadText))
            : html`<span class="muted cron-prompt-preview__empty"
                >${t("cron.form.promptPreviewEmpty")}</span
              >`
        }
      </div>
    </details>
  `;
}
