// Wayza rooms and messages read Markdown, so the converter is plain Markdown. Cards become Markdown too: a title in
// bold, fields as lines, tables as GitHub tables, and buttons as a short list of the choices (link buttons as links).
import { renderGfmTable } from "@chat-adapter/shared";
import { BaseFormatConverter, type CardChild, type CardElement, type Root, parseMarkdown, stringifyMarkdown } from "chat";

export class WayzaFormatConverter extends BaseFormatConverter {
  toAst(text: string): Root {
    return parseMarkdown(text);
  }

  fromAst(ast: Root): string {
    return stringifyMarkdown(ast).trimEnd();
  }

  // Blank lines between the parts, so each is its own Markdown block (a table right under a line of text is not a table).
  protected override cardToFallbackText(card: CardElement): string {
    const parts = [card.title ? `**${card.title}**` : "", card.subtitle || ""];
    for (const child of card.children) parts.push(this.cardChildToFallbackText(child) || "");
    return parts.filter(Boolean).join("\n\n");
  }

  protected override cardChildToFallbackText(child: CardChild): string | null {
    const c = child as any;
    if (c.type === "table") return renderGfmTable(c).join("\n");
    if (c.type === "fields") return c.children.map((f: any) => `**${f.label}:** ${f.value}`).join("  \n");
    if (c.type === "image") return c.url ? `![${c.alt || ""}](${c.url})` : null;
    if (c.type === "divider") return "---";
    if (c.type === "link" && c.url) return `[${c.label || c.url}](${c.url})`;
    if (c.type === "actions") {
      const items = (c.children || [])
        .map((a: any) => {
          if (a.type === "link-button" && a.url) return `[${a.label}](${a.url})`;
          if (a.type === "button") return a.label;
          if (a.type === "select" || a.type === "radio_select")
            return (a.options || []).map((o: any) => o.label).join(" / ");
          return null;
        })
        .filter(Boolean);
      return items.length ? items.map((i: string) => `- ${i}`).join("\n") : null;
    }
    if (c.type === "section")
      return (c.children || []).map((x: CardChild) => this.cardChildToFallbackText(x)).filter(Boolean).join("\n\n") || null;
    return super.cardChildToFallbackText(child);
  }
}
