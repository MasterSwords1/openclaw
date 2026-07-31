import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext forwarded debounce batches", () => {
  it.each(["text", "caption"] as const)(
    "keeps quoted %s distinct from neighboring buffered messages",
    async (carrier) => {
      const chat = { id: 999, type: "private" as const, first_name: "Alice" };
      const sender = { id: 42, first_name: "Alice", is_bot: false };
      const quote = "quoted first\nquoted second";
      const quoteEntity = { type: "blockquote" as const, offset: 0, length: quote.length };
      const quotedContent =
        carrier === "text"
          ? { text: quote, entities: [quoteEntity] }
          : { caption: quote, caption_entities: [quoteEntity] };
      const context = await buildTelegramMessageContextForTest({
        message: {
          message_id: 2,
          chat,
          from: sender,
          text: `${quote}\nordinary caption`,
          entities: [{ type: "blockquote", offset: 0, length: quote.length }],
        },
        options: {
          inboundDebounceMessages: [
            {
              message_id: 1,
              date: 1_700_000_000,
              chat,
              from: sender,
              ...quotedContent,
            },
            {
              message_id: 2,
              date: 1_700_000_001,
              chat,
              from: sender,
              caption: "ordinary caption",
            },
          ],
        },
      });

      const expected = "> quoted first\n> quoted second\nordinary caption";
      expect(context?.ctxPayload.RawBody).toBe(expected);
      expect(context?.ctxPayload.BodyForAgent).toBe(expected);
      expect(context?.ctxPayload.CommandBody).toBe(expected);
    },
  );

  it.each(["text", "caption"] as const)(
    "reopens enclosing formatting around buffered quoted %s",
    async (carrier) => {
      const chat = { id: 999, type: "private" as const, first_name: "Alice" };
      const sender = { id: 42, first_name: "Alice", is_bot: false };
      const content = "😀 before\nquoted first\nquoted second\nafter";
      const quote = "quoted first\nquoted second";
      const entities = [
        { type: "bold" as const, offset: 0, length: content.length },
        { type: "blockquote" as const, offset: content.indexOf(quote), length: quote.length },
      ];
      const buffered =
        carrier === "text"
          ? { text: content, entities }
          : { caption: content, caption_entities: entities };
      const context = await buildTelegramMessageContextForTest({
        message: {
          message_id: 1,
          chat,
          from: sender,
          text: content,
          entities,
        },
        options: {
          inboundDebounceMessages: [
            {
              message_id: 1,
              date: 1_700_000_000,
              chat,
              from: sender,
              ...buffered,
            },
          ],
        },
      });

      const expected = "**😀 before**\n> **quoted first**\n> **quoted second**\n**after**";
      expect(context?.ctxPayload.RawBody).toBe(expected);
      expect(context?.ctxPayload.BodyForAgent).toBe(expected);
      expect(context?.ctxPayload.CommandBody).toBe(expected);
    },
  );

  it("preserves each buffered message's formatting entities in model-visible order", async () => {
    const chat = { id: 999, type: "private" as const, first_name: "Alice" };
    const sender = { id: 42, first_name: "Alice", is_bot: false };
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 2,
        chat,
        from: sender,
        text: "😀 bold\nread docs",
        entities: [
          { type: "bold", offset: 3, length: 4 },
          { type: "text_link", offset: 13, length: 4, url: "https://docs.example" },
        ],
      },
      options: {
        inboundDebounceMessages: [
          {
            message_id: 1,
            date: 1_700_000_000,
            chat,
            from: sender,
            text: "😀 bold",
            entities: [{ type: "bold", offset: 3, length: 4 }],
          },
          {
            message_id: 2,
            date: 1_700_000_001,
            chat,
            from: sender,
            text: "read docs",
            entities: [{ type: "text_link", offset: 5, length: 4, url: "https://docs.example" }],
          },
        ],
      },
    });

    expect(context?.ctxPayload.RawBody).toBe("😀 **bold**\nread [docs](https://docs.example)");
    expect(context?.ctxPayload.BodyForAgent).toBe("😀 **bold**\nread [docs](https://docs.example)");
    expect(context?.ctxPayload.CommandBody).toBe("😀 **bold**\nread [docs](https://docs.example)");
  });

  it("keeps ordinary text plain while attributing only the forwarded segment", async () => {
    const chat = { id: 999, type: "private" as const, first_name: "Alice" };
    const sender = { id: 42, first_name: "Alice", is_bot: false };
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 2,
        chat,
        from: sender,
        text: "ordinary note\nforwarded note",
        forward_origin: {
          type: "hidden_user",
          sender_user_name: "Wrong inherited origin",
          date: 400,
        },
      },
      options: {
        inboundDebounceMessages: [
          {
            message_id: 1,
            date: 1_700_000_000,
            chat,
            from: sender,
            text: "ordinary note",
          },
          {
            message_id: 2,
            date: 1_700_000_001,
            chat,
            from: sender,
            text: "forwarded note",
            forward_origin: {
              type: "hidden_user",
              sender_user_name: "Original B",
              date: 500,
            },
          },
        ],
      },
    });

    const payload = context?.ctxPayload;
    expect(payload?.Body).toMatch(
      /ordinary note\n\[Forwarded from Original B[^\]]*\]\nforwarded note/,
    );
    expect(payload?.Body).not.toContain("Wrong inherited origin");
    expect(payload?.BodyForAgent).toMatch(
      /ordinary note\n\[Forwarded from Original B[^\]]*\]\nforwarded note/,
    );
    expect(payload?.ForwardedFrom).toBeUndefined();
  });

  it("redacts a debounced forward origin denied by group context visibility", async () => {
    const chat = { id: -1007, type: "group" as const, title: "Ops" };
    const sender = { id: 1, first_name: "Allowed", is_bot: false };
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 2,
        chat,
        from: sender,
        text: "ordinary note\nprivate forwarded note",
      },
      cfg: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            contextVisibility: "allowlist",
          },
        },
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false, allowFrom: ["1"] },
        topicConfig: undefined,
      }),
      options: {
        inboundDebounceMessages: [
          {
            message_id: 1,
            date: 1_700_000_000,
            chat,
            from: sender,
            text: "ordinary note",
          },
          {
            message_id: 2,
            date: 1_700_000_001,
            chat,
            from: sender,
            text: "private forwarded note",
            forward_origin: {
              type: "user",
              sender_user: {
                id: 999,
                first_name: "Hidden",
                is_bot: false,
              },
              date: 500,
            },
          },
        ],
      },
    });

    const payload = context?.ctxPayload;
    expect(payload?.Body).toContain("ordinary note\nprivate forwarded note");
    expect(payload?.Body).not.toContain("[Forwarded from");
    expect(payload?.Body).not.toContain("Hidden");
    expect(payload?.BodyForAgent).toBe("ordinary note\nprivate forwarded note");
    expect(payload?.ForwardedFrom).toBeUndefined();
  });

  it("keeps mixed text and forwarded media segments ordered", async () => {
    const chat = { id: 999, type: "private" as const, first_name: "Alice" };
    const sender = { id: 42, first_name: "Alice", is_bot: false };
    const photo = [{ file_id: "photo-1", file_unique_id: "unique-1", width: 1, height: 1 }];
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 2,
        chat,
        from: sender,
        text: "ordinary note",
      },
      allMedia: [{ path: "/tmp/photo-1.jpg", contentType: "image/jpeg", kind: "image" }],
      options: {
        inboundDebounceMessages: [
          {
            message_id: 1,
            date: 1_700_000_000,
            chat,
            from: sender,
            text: "ordinary note",
          },
          {
            message_id: 2,
            date: 1_700_000_001,
            chat,
            from: sender,
            photo,
            forward_origin: {
              type: "hidden_user",
              sender_user_name: "Original B",
              date: 500,
            },
          },
        ],
      },
    });

    const expectedBody = /ordinary note\n\[Forwarded from Original B[^\]]*\]\n<media:image>/;
    expect(context?.ctxPayload.Body).toMatch(expectedBody);
    expect(context?.ctxPayload.BodyForAgent).toMatch(expectedBody);
    expect(context?.ctxPayload.CommandBody).toBe("ordinary note");
  });
});
