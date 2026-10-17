/**
 * Text from a target (a channel name, a file path, a source line) shown as data. React already
 * escapes markup; this also makes invisible characters visible, so a right-to-left override or a
 * zero-width space cannot reorder or hide what the reviewer reads.
 */
// C0/C1 controls except tab, bidi marks/embeddings/overrides/isolates, zero-width and BOM. Kept
// as escapes in a string: the source must not hold the characters it guards against.
const INVISIBLE = new RegExp(
  // oxlint-disable-next-line no-control-regex -- finding control characters is the point
  "[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]",
  "g",
);

export function visible(text: string): string {
  return text.replace(
    INVISIBLE,
    (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`,
  );
}

/** True when `visible` would change the text: worth a note next to it. */
export const hasInvisible = (text: string): boolean => {
  INVISIBLE.lastIndex = 0;
  const found = INVISIBLE.test(text);
  INVISIBLE.lastIndex = 0;
  return found;
};
