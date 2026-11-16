import {
  parseMarkdown,
  tableToAscii,
  type Content,
  type MdastTable,
  type Nodes,
  type Root,
} from "chat";

/**
 * Render Markdown as plain SMS text.
 * Formatting marks are removed. Link URLs, list markers and code stay, so no
 * information is lost.
 */
export function markdownToSms(markdown: string): string {
  return astToSms(parseMarkdown(markdown));
}

export function astToSms(ast: Root): string {
  return blocks(ast.children).trim();
}

function blocks(nodes: readonly Content[]): string {
  return nodes
    .map(block)
    .filter((text) => text !== "")
    .join("\n\n");
}

function block(node: Content): string {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return inline(node.children);
    case "code":
      return node.value;
    case "blockquote":
      return blocks(node.children);
    case "list": {
      const start = node.start ?? 1;
      return node.children
        .map((item, index) => {
          const marker = node.ordered ? `${start + index}. ` : "- ";
          const body = item.children
            .map(block)
            .filter((text) => text !== "")
            .join("\n");
          return (
            marker + body.replaceAll("\n", `\n${" ".repeat(marker.length)}`)
          );
        })
        .join("\n");
    }
    case "table":
      return tableToAscii(node as MdastTable);
    case "thematicBreak":
      return "";
    case "html":
      return node.value;
    default:
      return "children" in node
        ? inline(node.children as readonly Nodes[])
        : "value" in node && typeof node.value === "string"
          ? node.value
          : "";
  }
}

function inline(nodes: readonly Nodes[]): string {
  return nodes.map(span).join("");
}

function span(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "html":
      return node.value;
    case "break":
      return "\n";
    case "link": {
      const text = inline(node.children);
      const url = node.url;
      if (!url || text === url || `mailto:${text}` === url) return text || url;
      return text ? `${text} (${url})` : url;
    }
    case "image":
      return node.alt ? `${node.alt} (${node.url})` : node.url;
    default:
      return "children" in node
        ? inline(node.children as readonly Nodes[])
        : "value" in node && typeof node.value === "string"
          ? node.value
          : "";
  }
}
