/**
 * Strips HTML tags and decodes a handful of common entities, for regex-friendly text
 * search. Not a full HTML parser -- good enough for matching a known receipt template,
 * not for rendering.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Best available plain-text rendering of a message body for regex matching. */
export function bodyText(message: { text?: string; html?: string }): string {
  if (message.text && message.text.trim()) return message.text;
  if (message.html) return stripHtml(message.html);
  return '';
}

/** Parses a currency amount like "$1,234.56" or "1234.56" out of a regex match group. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** First bare email address found in a raw header value like '"Jane Doe" <jane@example.com>'. */
export function firstEmailAddress(raw: string): string | null {
  const match = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}
