/** Read a message's text whether it is a plain string or a list of content blocks (J6 vision). */
import type { ContentBlock } from "./types.js";

export function messageText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");
}
