import { type CSSProperties, useMemo } from "react";
import {
  type Align,
  type Block,
  parseBlocks,
  parseInline,
} from "./markdown.js";

/** Inline runs as React text nodes only; never HTML. */
function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((token, i) => {
        const key = `${i}-${token.kind}`;
        if (token.kind === "download")
          return (
            <a key={key} href={token.href} download>
              {token.text}
            </a>
          );
        if (token.kind === "strong")
          return <strong key={key}>{token.text}</strong>;
        if (token.kind === "em") return <em key={key}>{token.text}</em>;
        if (token.kind === "code") return <code key={key}>{token.text}</code>;
        return <span key={key}>{token.text}</span>;
      })}
    </>
  );
}

function cellStyle(align: Align | undefined): CSSProperties | undefined {
  return align == null ? undefined : { textAlign: align };
}

function Table({ block }: { block: Extract<Block, { kind: "table" }> }) {
  return (
    <div className="md-table">
      <table>
        <thead>
          <tr>
            {block.header.map((cell, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional cells of immutable text
              <th key={i} style={cellStyle(block.align[i])}>
                <InlineText text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows of immutable text
            <tr key={r}>
              {row.map((cell, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional cells of immutable text
                <td key={c} style={cellStyle(block.align[c])}>
                  <InlineText text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading":
      return (
        <p className={`md-heading md-h${Math.min(block.level, 4)}`}>
          <InlineText text={block.text} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional items of immutable text
        <li key={i}>
          <InlineText text={item} />
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "table":
      return <Table block={block} />;
    case "code":
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
    default:
      return (
        <p className="pre-wrap">
          <InlineText text={block.text} />
        </p>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="md">
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional blocks of immutable text
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}
