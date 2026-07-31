// Telegram inbound text entities own Markdown attribution and block boundaries.

type TelegramMarkdownEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
};

type TelegramMarkdownBoundary = {
  open: string;
  close: string;
  start: number;
  end: number;
  length: number;
  priority: number;
  index: number;
};

const TELEGRAM_ENTITY_MARKDOWN_PRIORITY: Record<string, number> = {
  blockquote: 0,
  expandable_blockquote: 0,
  bold: 10,
  italic: 20,
  underline: 30,
  strikethrough: 40,
  spoiler: 50,
  text_link: 60,
  code: 70,
  pre: 80,
};

const TELEGRAM_SPLITTABLE_INLINE_ENTITY_TYPES = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
]);

function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function markdownInlineCodeDelimiters(content: string): [string, string] {
  const delimiter = "`".repeat(longestBacktickRun(content) + 1);
  if (content.startsWith(" ") || content.endsWith(" ")) {
    return [`${delimiter} `, ` ${delimiter}`];
  }
  return [delimiter, delimiter];
}

function markdownPreAffixes(entity: TelegramMarkdownEntity, content: string): [string, string] {
  const language = entity.language?.replace(/[\s`]+/g, "").trim();
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  const opener = language ? `${fence}${language}\n` : `${fence}\n`;
  const closer = content.endsWith("\n") ? fence : `\n${fence}`;
  return [opener, closer];
}

function markdownAffixesForTelegramEntity(
  entity: TelegramMarkdownEntity,
  content: string,
): [string, string] | null {
  switch (entity.type) {
    case "blockquote":
    case "expandable_blockquote":
      return ["> ", ""];
    case "bold":
      return ["**", "**"];
    case "italic":
      return ["_", "_"];
    case "underline":
      return ["__", "__"];
    case "strikethrough":
      return ["~~", "~~"];
    case "spoiler":
      return ["||", "||"];
    case "code":
      return markdownInlineCodeDelimiters(content);
    case "pre":
      return markdownPreAffixes(entity, content);
    case "text_link":
      return entity.url ? ["[", `](${entity.url})`] : null;
    default:
      return null;
  }
}

function hasValidTelegramMarkdownEntityRange(entity: TelegramMarkdownEntity, text: string) {
  return (
    Number.isInteger(entity.offset) &&
    Number.isInteger(entity.length) &&
    entity.offset >= 0 &&
    entity.length > 0 &&
    entity.offset + entity.length <= text.length
  );
}

function splitTelegramFormattingAcrossQuotes(
  text: string,
  entity: TelegramMarkdownEntity,
  quoteSplitOffsets: readonly number[],
): TelegramMarkdownEntity[] {
  if (!TELEGRAM_SPLITTABLE_INLINE_ENTITY_TYPES.has(entity.type)) {
    return [entity];
  }
  const end = entity.offset + entity.length;
  const boundaries = [
    entity.offset,
    ...quoteSplitOffsets.filter((offset) => entity.offset < offset && offset < end),
    end,
  ];
  if (boundaries.length === 2) {
    return [entity];
  }

  // Markdown inline delimiters cannot straddle quote prefixes or their line breaks.
  // Keep separator whitespace outside each reopened formatting span.
  return boundaries.slice(0, -1).flatMap((start, index) => {
    let segmentStart = start;
    let segmentEnd = boundaries[index + 1]!;
    while (index > 0 && segmentStart < segmentEnd && /\s/.test(text.charAt(segmentStart))) {
      segmentStart += 1;
    }
    while (
      index < boundaries.length - 2 &&
      segmentEnd > segmentStart &&
      /\s/.test(text.charAt(segmentEnd - 1))
    ) {
      segmentEnd -= 1;
    }
    return segmentEnd > segmentStart
      ? [{ ...entity, offset: segmentStart, length: segmentEnd - segmentStart }]
      : [];
  });
}

export function renderTelegramTextEntities(
  text: string,
  entities?: TelegramMarkdownEntity[] | null,
): string {
  if (!text || !entities?.length) {
    return text;
  }

  const quotedLineStarts = new Set<number>();
  const quoteSplitOffsets = new Set<number>();
  for (const entity of entities) {
    if (
      (entity.type !== "blockquote" && entity.type !== "expandable_blockquote") ||
      !hasValidTelegramMarkdownEntityRange(entity, text)
    ) {
      continue;
    }
    const end = entity.offset + entity.length;
    quoteSplitOffsets.add(entity.offset);
    quoteSplitOffsets.add(end);
    for (let offset = entity.offset + 1; offset < end; offset += 1) {
      if (text[offset - 1] === "\n") {
        quotedLineStarts.add(offset);
        quoteSplitOffsets.add(offset);
      }
    }
  }
  const sortedQuoteSplitOffsets = [...quoteSplitOffsets].toSorted((left, right) => left - right);
  const boundaries = new Map<number, TelegramMarkdownBoundary[]>();
  const addBoundary = (offset: number, boundary: TelegramMarkdownBoundary) => {
    boundaries.set(offset, [...(boundaries.get(offset) ?? []), boundary]);
  };
  entities.forEach((entity, index) => {
    if (!hasValidTelegramMarkdownEntityRange(entity, text)) {
      return;
    }
    for (const segment of splitTelegramFormattingAcrossQuotes(
      text,
      entity,
      sortedQuoteSplitOffsets,
    )) {
      const content = text.slice(segment.offset, segment.offset + segment.length);
      const affixes = markdownAffixesForTelegramEntity(segment, content);
      if (!affixes) {
        continue;
      }
      const end = segment.offset + segment.length;
      if (segment.type === "blockquote" || segment.type === "expandable_blockquote") {
        if (segment.offset > 0 && text[segment.offset - 1] !== "\n") {
          affixes[0] = `\n${affixes[0]}`;
        }
        if (end < text.length && text[end] !== "\n" && text[end] !== "\r") {
          affixes[1] = "\n";
        }
      }
      const boundary: TelegramMarkdownBoundary = {
        open: affixes[0],
        close: affixes[1],
        start: segment.offset,
        end,
        length: segment.length,
        priority: TELEGRAM_ENTITY_MARKDOWN_PRIORITY[segment.type] ?? 100,
        index,
      };
      addBoundary(boundary.start, boundary);
      addBoundary(boundary.end, boundary);
    }
  });

  if (boundaries.size === 0) {
    return text;
  }

  let result = "";
  for (let offset = 0; offset <= text.length; offset += 1) {
    if (quotedLineStarts.has(offset)) {
      result += "> ";
    }
    const boundary = boundaries.get(offset);
    if (boundary) {
      boundary
        .filter((entity) => entity.end === offset)
        .toSorted((a, b) => a.length - b.length || b.priority - a.priority || b.index - a.index)
        .forEach((entity) => {
          result += entity.close;
        });
      boundary
        .filter((entity) => entity.start === offset)
        .toSorted((a, b) => b.length - a.length || a.priority - b.priority || a.index - b.index)
        .forEach((entity) => {
          result += entity.open;
        });
    }
    if (offset < text.length) {
      result += text[offset];
    }
  }
  return result;
}
