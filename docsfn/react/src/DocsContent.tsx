import React from "react";
import {
  assertCompiledContentTrusted,
  compileReactContent,
  type CompiledContentArtifact,
  type CompiledContentBlock,
  type DocsCompatPreset,
} from "@docsfn/core";

export interface DocsContentProps {
  compiled?: CompiledContentArtifact;
  content?: string;
  sourcePath?: string;
  compatPreset?: DocsCompatPreset;
  allowUnsafeHtml?: boolean;
  unsafeHtmlAllowlist?: string[];
  components?: Record<string, React.ComponentType<{ children?: React.ReactNode }>>;
  pageActionsSlot?: React.ReactNode;
}

function renderCodeBlock(block: Extract<CompiledContentBlock, { type: "code" }>) {
  return (
    <pre data-docsfn-code="true">
      <code data-lang={block.lang}>{block.code}</code>
    </pre>
  );
}

function renderBlock(input: {
  block: CompiledContentBlock;
  index: number;
  components?: DocsContentProps["components"];
  activeTabs: Record<number, string>;
  setActiveTabs: React.Dispatch<React.SetStateAction<Record<number, string>>>;
}) {
  const { block } = input;
  if (block.type === "heading") {
    const headingTag = `h${Math.max(1, Math.min(6, block.level))}`;
    return React.createElement(headingTag, { id: block.slug }, block.text);
  }

  if (block.type === "paragraph") {
    return <p>{block.text}</p>;
  }

  if (block.type === "code") {
    return renderCodeBlock(block);
  }

  if (block.type === "mermaid") {
    return (
      <pre data-docsfn-mermaid="true">
        <code>{block.code}</code>
      </pre>
    );
  }

  if (block.type === "callout") {
    return (
      <aside data-docsfn-callout={block.kind}>
        <p>{block.text}</p>
      </aside>
    );
  }

  if (block.type === "tabs") {
    const fallbackTab = block.items[0] ?? block.tabs[0]?.value ?? "";
    const activeValue = input.activeTabs[input.index] ?? fallbackTab;
    const activeTab = block.tabs.find((tab) => tab.value === activeValue) ?? block.tabs[0];
    return (
      <div data-docsfn-tabs="true">
        <div role="tablist" aria-label="Tabs">
          {block.items.map((item) => (
            <button
              type="button"
              key={item}
              role="tab"
              aria-selected={item === activeValue}
              onClick={() =>
                input.setActiveTabs((current) => ({
                  ...current,
                  [input.index]: item,
                }))
              }
            >
              {item}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          {activeTab ? <pre>{activeTab.content}</pre> : null}
        </div>
      </div>
    );
  }

  const Component = input.components?.[block.name];
  if (Component) {
    return <Component>{block.body}</Component>;
  }

  return (
    <div data-docsfn-component={block.name}>
      {block.body ?? ""}
    </div>
  );
}

export function DocsContent({
  compiled,
  content,
  sourcePath,
  compatPreset = "none",
  allowUnsafeHtml = false,
  unsafeHtmlAllowlist,
  components,
  pageActionsSlot,
}: DocsContentProps) {
  const compiledContent = React.useMemo(() => {
    if (compiled) {
      assertCompiledContentTrusted({
        source: compiled.transformedSource || compiled.source || "",
        sourcePath,
        policy: {
          allowUnsafeHtml,
          allowUnsafeHtmlAllowlist: unsafeHtmlAllowlist,
        },
      });
      return compiled;
    }
    return compileReactContent({
      source: content ?? "",
      sourcePath,
      compatPreset,
      allowRawHtml: allowUnsafeHtml,
    });
  }, [
    compiled,
    content,
    sourcePath,
    compatPreset,
    allowUnsafeHtml,
    unsafeHtmlAllowlist,
  ]);

  const [activeTabs, setActiveTabs] = React.useState<Record<number, string>>({});

  return (
    <div className="docsfn-content">
      {compiledContent.blocks.map((block, index) => (
        <React.Fragment key={`${block.type}-${index}`}>
          {renderBlock({
            block,
            index,
            components,
            activeTabs,
            setActiveTabs,
          })}
        </React.Fragment>
      ))}
      {pageActionsSlot ? (
        <div data-docsfn-page-actions="true">{pageActionsSlot}</div>
      ) : null}
    </div>
  );
}
