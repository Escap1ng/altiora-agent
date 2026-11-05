export interface Truncated {
  text: string;
  truncated: boolean;
}

export function truncateText(text: string, maxChars: number): Truncated {
  if (text.length <= maxChars) return { text, truncated: false };
  const omitted = text.length - maxChars;
  return { text: `${text.slice(0, maxChars)}\n[truncated ${omitted} chars]`, truncated: true };
}
