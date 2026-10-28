const FOOTNOTE_REF_REGEX = /\[\^(?:[a-z-]+-)?(\d+)\^\]/g;
const FOOTNOTE_DEF_REGEX = /\[\^((?:deduplication-)?\d+)\^\]: ⚠ \d+% possible duplicate - [^\n]+(\n|$)/g;

export function nextFootnoteIndex(content: string): number {
  const indexes = [...content.matchAll(FOOTNOTE_REF_REGEX)].map((match) => Number(match[1]));
  return indexes.length ? Math.max(...indexes) + 1 : 1;
}

export function createFootnoteRef(prefix: string, index: number): string {
  return `[^${prefix}-${index}^]`;
}

export function stripFootnoteRef(content: string, footnoteRef: string): string {
  return content.replaceAll(footnoteRef, "");
}

export function removeCautionMessages(content: string): string {
  const cautionRegex = />[!CAUTION]\n> This issue may be a duplicate of the following issues:\n((> - \[[^\]]+\]\([^)]+\)\n)+)/g;
  return content.replace(cautionRegex, "");
}

export function stripDuplicateFootnotes(content: string): string {
  const footnotes = content.match(FOOTNOTE_DEF_REGEX);
  let contentWithoutFootnotes = content.replace(FOOTNOTE_DEF_REGEX, "");
  if (footnotes) {
    footnotes.forEach((footnote) => {
      const footnoteRef = footnote.match(/\[\^((?:deduplication-)?\d+)\^\]/)?.[0];
      if (!footnoteRef) {
        return;
      }
      contentWithoutFootnotes = stripFootnoteRef(contentWithoutFootnotes, footnoteRef);
    });
  }
  return removeCautionMessages(contentWithoutFootnotes);
}
