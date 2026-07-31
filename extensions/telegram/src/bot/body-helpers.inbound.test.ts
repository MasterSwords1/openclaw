import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { getTelegramTextParts, joinTelegramTextParts } from "./body-helpers.js";
import { renderTelegramTextEntities } from "./inbound-text-entities.js";

function asTelegramMessage(message: unknown): Message {
  return message as Message;
}

describe("getTelegramTextParts", () => {
  it("projects native Telegram polls into bounded, accurate inbound text", () => {
    const result = getTelegramTextParts(
      asTelegramMessage({
        poll: {
          id: "poll-1",
          question: "Ship the release?",
          options: [
            { persistent_id: "yes", text: "Yes", voter_count: 2 },
            { persistent_id: "no", text: "No", voter_count: 1 },
          ],
          total_voter_count: 3,
          is_closed: false,
          is_anonymous: false,
          type: "quiz",
          allows_multiple_answers: false,
          correct_option_ids: [0],
          description: "Read docs",
          description_entities: [
            { type: "text_link", offset: 5, length: 4, url: "https://docs.example" },
          ],
          explanation: "All checks passed.",
          explanation_entities: [{ type: "bold", offset: 0, length: 3 }],
        },
      }),
    );

    expect(result).toEqual({
      text: [
        "[Poll] Ship the release?",
        "Read [docs](https://docs.example)",
        "1. Yes — 2 votes (correct)",
        "2. No — 1 vote",
        "Total voters: 3",
        "Type: quiz",
        "Visibility: public",
        "Selection: single answer",
        "Status: open",
        "Explanation: **All** checks passed.",
      ].join("\n"),
      entities: [],
    });
  });
});

describe("joinTelegramTextParts", () => {
  it("rebases text and caption entities using Telegram UTF-16 offsets", () => {
    const result = joinTelegramTextParts(
      [
        asTelegramMessage({
          text: "😀 bold",
          entities: [{ type: "bold", offset: 3, length: 4 }],
        }),
        asTelegramMessage({
          caption: "read docs",
          caption_entities: [
            { type: "text_link", offset: 5, length: 4, url: "https://docs.example" },
          ],
        }),
      ],
      "\n",
    );

    expect(result.text).toBe("😀 bold\nread docs");
    expect(result.entities).toEqual([
      { type: "bold", offset: 3, length: 4 },
      { type: "text_link", offset: 13, length: 4, url: "https://docs.example" },
    ]);
    expect(renderTelegramTextEntities(result.text, result.entities)).toBe(
      "😀 **bold**\nread [docs](https://docs.example)",
    );
  });

  it("skips empty segments without shifting later entity offsets", () => {
    const result = joinTelegramTextParts(
      [
        asTelegramMessage({ text: "" }),
        asTelegramMessage({
          text: "bold",
          entities: [{ type: "bold", offset: 0, length: 4 }],
        }),
      ],
      "\n",
    );

    expect(result).toEqual({
      text: "bold",
      entities: [{ type: "bold", offset: 0, length: 4 }],
    });
  });
});

describe("renderTelegramTextEntities quoted blocks", () => {
  it.each(["blockquote", "expandable_blockquote"] as const)(
    "preserves multiline %s entities and nested formatting at UTF-16 offsets",
    (type) => {
      const text = "Before\n😀 quoted\nsecond link\nAfter";
      const quote = "😀 quoted\nsecond link";
      const quoteOffset = text.indexOf(quote);

      expect(
        renderTelegramTextEntities(text, [
          { type, offset: quoteOffset, length: quote.length },
          { type: "bold", offset: quoteOffset + "😀 ".length, length: "quoted".length },
          {
            type: "text_link",
            offset: quoteOffset + "😀 quoted\nsecond ".length,
            length: "link".length,
            url: "https://docs.example",
          },
        ]),
      ).toBe("Before\n> 😀 **quoted**\n> second [link](https://docs.example)\nAfter");
    },
  );

  it.each([
    { type: "bold", delimiter: "**" },
    { type: "italic", delimiter: "_" },
    { type: "underline", delimiter: "__" },
    { type: "strikethrough", delimiter: "~~" },
    { type: "spoiler", delimiter: "||" },
  ])("reopens enclosing $type on each quoted line", ({ type, delimiter }) => {
    const text = "😀 before\nquoted link\nsecond code\nafter";
    const quote = "quoted link\nsecond code";
    const quoteOffset = text.indexOf(quote);

    for (const quoteType of ["blockquote", "expandable_blockquote"] as const) {
      expect(
        renderTelegramTextEntities(text, [
          { type, offset: 0, length: text.length },
          { type: quoteType, offset: quoteOffset, length: quote.length },
          {
            type: "text_link",
            offset: quoteOffset + "quoted ".length,
            length: "link".length,
            url: "https://docs.example",
          },
          {
            type: "code",
            offset: quoteOffset + "quoted link\nsecond ".length,
            length: "code".length,
          },
        ]),
      ).toBe(
        [
          `${delimiter}😀 before${delimiter}`,
          `> ${delimiter}quoted [link](https://docs.example)${delimiter}`,
          `> ${delimiter}second \`code\`${delimiter}`,
          `${delimiter}after${delimiter}`,
        ].join("\n"),
      );
    }
  });

  it("keeps enclosing formatting outside multiple quotes and CRLF boundaries", () => {
    const text = "😀 before\r\nfirst\r\nmiddle\r\nsecond\r\nafter";
    const firstOffset = text.indexOf("first");
    const secondOffset = text.indexOf("second");

    expect(
      renderTelegramTextEntities(text, [
        { type: "bold", offset: 0, length: text.length },
        { type: "blockquote", offset: firstOffset, length: "first".length },
        { type: "expandable_blockquote", offset: secondOffset, length: "second".length },
      ]),
    ).toBe("**😀 before**\r\n> **first**\r\n**middle**\r\n> **second**\r\n**after**");
  });

  it.each(["blockquote", "expandable_blockquote"] as const)(
    "keeps surrounding whitespace outside reopened formatting for inline %s",
    (quoteType) => {
      const text = "Before quoted after";

      expect(
        renderTelegramTextEntities(text, [
          { type: "bold", offset: 0, length: text.length },
          { type: quoteType, offset: "Before ".length, length: "quoted".length },
        ]),
      ).toBe("**Before** \n> **quoted**\n **after**");
    },
  );

  it("reopens nested enclosing formatting in canonical delimiter order", () => {
    const text = "before\nquoted\nafter";

    expect(
      renderTelegramTextEntities(text, [
        { type: "bold", offset: 0, length: text.length },
        { type: "italic", offset: 0, length: text.length },
        { type: "blockquote", offset: "before\n".length, length: "quoted".length },
      ]),
    ).toBe("**_before_**\n> **_quoted_**\n**_after_**");
  });

  it("separates inline quote boundaries from adjacent ordinary text", () => {
    const text = "Before quoted after";

    expect(
      renderTelegramTextEntities(text, [
        { type: "blockquote", offset: "Before ".length, length: "quoted".length },
      ]),
    ).toBe("Before \n> quoted\n after");
  });

  it("does not absorb ordinary text following a completed quote", () => {
    const text = "quoted\nordinary";

    expect(
      renderTelegramTextEntities(text, [
        { type: "blockquote", offset: 0, length: "quoted".length },
      ]),
    ).toBe("> quoted\nordinary");
  });

  it.each([
    {
      name: "empty quoted lines",
      text: "first\n\nsecond\nordinary",
      quoted: "first\n\nsecond",
      expected: "> first\n> \n> second\nordinary",
    },
    {
      name: "Windows-style newlines",
      text: "first\r\nsecond\r\nordinary",
      quoted: "first\r\nsecond",
      expected: "> first\r\n> second\r\nordinary",
    },
  ])("contains $name without capturing the suffix", ({ text, quoted, expected }) => {
    expect(
      renderTelegramTextEntities(text, [{ type: "blockquote", offset: 0, length: quoted.length }]),
    ).toBe(expected);
  });

  it("opens outer quotes before formatting entities at the same boundary", () => {
    expect(
      renderTelegramTextEntities("quoted\nordinary", [
        { type: "bold", offset: 0, length: "quoted".length },
        { type: "blockquote", offset: 0, length: "quoted".length },
      ]),
    ).toBe("> **quoted**\nordinary");
  });
});
