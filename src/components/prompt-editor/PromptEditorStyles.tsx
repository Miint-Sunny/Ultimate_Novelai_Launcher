export function PromptEditorStyles() {
  return (
    <style>{`
      .prompt-editor-wrapper .ProseMirror {
        padding: 8px;
        font-family: "Source Sans Pro", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 16px;
        font-weight: 600;
        line-height: 22px;
        color: rgba(255, 255, 255, 0.85);
        white-space: pre-wrap;
        word-wrap: break-word;
        overflow-wrap: break-word;
        word-break: break-word;
        color: white;
        min-height: 100%;
        height: 100%;
        overflow-y: auto;
      }
      
      .prompt-editor-wrapper .ProseMirror p {
        margin: 0;
      }
      
      .prompt-editor-wrapper .ProseMirror:focus {
        outline: none;
      }
      
      .prompt-editor-wrapper .ProseMirror p.is-editor-empty:first-child::before {
        content: attr(data-placeholder);
        color: #707274;
        pointer-events: none;
        float: left;
        height: 0;
        font-size: 0.875rem;
        font-family: "Source Sans Pro", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      
      .prompt-editor-wrapper .ProseMirror.is-empty::before {
        content: attr(data-placeholder);
        color: #707274;
        pointer-events: none;
        float: left;
        height: 0;
        font-size: 0.875rem;
        font-family: "Source Sans Pro", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      
      .prompt-editor-wrapper .weight-positive {
        background-color: rgba(116, 39, 13, 1);
      }
      
      .prompt-editor-wrapper .weight-negative {
        background-color: rgba(96, 165, 250, 0.3);
      }
      
      .prompt-editor-wrapper .weight-braces {
        background-color: rgba(116, 39, 13, 0.5);
      }
      
      .prompt-editor-wrapper .weight-brackets {
        background-color: rgba(96, 165, 250, 0.15);
      }
      
      .prompt-editor-wrapper .collapsible-tag-wrapper {
        display: inline;
        vertical-align: baseline;
      }
      
      .prompt-editor-wrapper .ProseMirror-selectednode .collapsible-tag-wrapper > span {
        outline: 2px solid #fceda4;
        outline-offset: 1px;
      }
      
      @keyframes suggestionFadeIn {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .suggestion-dropdown {
        animation: suggestionFadeIn 0.15s ease-out;
      }
      
      @keyframes panelFadeIn {
        from {
          opacity: 0;
          transform: translateY(-2px) scale(0.98);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
      .tag-quick-panel {
        animation: panelFadeIn 0.12s ease-out;
      }
      
      @keyframes chineseNameExpand {
        from {
          opacity: 0;
          max-height: 0;
          margin-top: 0;
        }
        to {
          opacity: 1;
          max-height: 20px;
          margin-top: 1px;
        }
      }
      .chinese-name-fade {
        animation: chineseNameExpand 0.25s ease-out forwards;
        overflow: hidden;
      }
      @keyframes suggItemIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
      .sugg-item { animation: suggItemIn 0.18s ease-out both; }
    `}</style>
  );
}
