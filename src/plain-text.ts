import { parseMarkdown, type Content, type Nodes, type Root } from "chat";

type Definitions = ReadonlyMap<string, string>;

/**
 * Render Markdown as plain SMS text.
 * Formatting marks are removed. Link URLs, list markers and code stay, so no
 * information is lost.
 */
export function markdownToSms(markdown: string): string {
  return astToSms(parseMarkdown(markdown));
}

export function astToSms(ast: Root): string {
  const definitions = new Map<string, string>();
  collectDefinitions(ast, definitions);
  return blocks(ast.children, definitions, "\n\n").trim();
}

function collectDefinitions(node: Nodes, into: Map<string, string>): void {
  if (node.type === "definition") into.set(node.identifier, node.url);
  if ("children" in node)
    for (const child of node.children) collectDefinitions(child, into);
}

function blocks(
  nodes: readonly Nodes[],
  definitions: Definitions,
  separator: string,
): string {
  return nodes
    .map((node) => block(node, definitions))
    .filter((text) => text !== "")
    .join(separator);
}

function block(node: Nodes, definitions: Definitions): string {
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "tableCell":
      return inline(node.children, definitions);
    case "code":
      return node.value;
    case "blockquote":
      return blocks(node.children, definitions, "\n\n");
    case "list": {
      const start = node.start ?? 1;
      return node.children
        .map((item, index) => {
          const marker = node.ordered ? `${start + index}. ` : "- ";
          const check =
            item.checked === true
              ? "[x] "
              : item.checked === false
                ? "[ ] "
                : "";
          const body = blocks(item.children, definitions, "\n");
          const indent = `\n${" ".repeat(marker.length)}`;
          return marker + check + body.replaceAll("\n", indent);
        })
        .join("\n");
    }
    // SMS has no fixed-width font, so cells are not padded.
    case "table":
      return node.children
        .map((row) => blocks(row.children, definitions, " | "))
        .join("\n");
    case "footnoteDefinition":
      return `[${node.label ?? node.identifier}] ${blocks(node.children, definitions, "\n")}`;
    case "thematicBreak":
    case "definition":
      return "";
    default:
      return fallback(node, definitions);
  }
}

function inline(nodes: readonly Nodes[], definitions: Definitions): string {
  return nodes.map((node) => span(node, definitions)).join("");
}

function span(node: Nodes, definitions: Definitions): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "html":
      return html(node.value);
    case "break":
      return "\n";
    case "link":
      return linked(inline(node.children, definitions), node.url);
    case "linkReference":
      return linked(
        inline(node.children, definitions),
        definitions.get(node.identifier),
      );
    case "image":
      return linked(node.alt ?? "", node.url);
    case "imageReference":
      return linked(node.alt ?? "", definitions.get(node.identifier));
    case "footnoteReference":
      return `[${node.label ?? node.identifier}]`;
    default:
      return fallback(node, definitions);
  }
}

/** Unknown nodes keep their text, so nothing is silently dropped. */
function fallback(node: Nodes, definitions: Definitions): string {
  if ("children" in node) return inline(node.children as Nodes[], definitions);
  return "value" in node && typeof node.value === "string" ? node.value : "";
}

/** "text (url)", or just one of them when the other adds nothing. */
function linked(text: string, url: string | undefined): string {
  if (!url) return text;
  if (!text) return url;
  const bare = url.replace(/^(?:https?:\/\/|mailto:)/, "");
  if (text === url || text === bare) return text;
  return `${text} (${url})`;
}

/** Raw HTML has no meaning in SMS: keep line breaks, drop tags and comments. */
function html(value: string): string {
  if (/^<br\s*\/?>$/i.test(value)) return "\n";
  if (/^<!--[\s\S]*-->$/.test(value) || /^<\/?[a-z][^>]*>$/i.test(value))
    return "";
  return value;
}
