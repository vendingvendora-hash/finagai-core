export function messageText(content) {
    if (typeof content === "string")
        return content;
    return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
//# sourceMappingURL=content.js.map