# 3. The twin is not opening

## Symptoms

- You open a code file and no `<name>_explain.txt` appears beside it.
- The twin opens but only shows the header and "This file has no functions to explain."
- The twin opens with sections that say "(not explained yet ...)".
- The twin opens very slowly, or a message says the file is too big.

## Cause

One of these, in order of likelihood:

1. **Automatic opening is off.** The setting `explainit.twin.autoOpen` is `false` (toggled with "Turn automatic twin opening on/off").
2. **Unsupported file type.** Twins exist only for real code files saved on disk. Untitled buffers, files inside archives or remote virtual file systems, binary files, twin files themselves (`*_explain.txt`), plain text, markdown, JSON, YAML and similar data files get no twin. Files matched by `explainit.backfill.excludeGlobs` (for example anything under `node_modules`) are skipped by backfill but still get a twin when opened by hand.
3. **The language cannot be outlined.** ExplainIT finds functions with VS Code's own outline (DocumentSymbol) first. If no language extension provides one, it falls back to bundled tree-sitter grammars (Python, JavaScript, TypeScript, Java, Go, C, C++, Rust), then to simple heuristics, and as a last resort asks your assistant to segment the file. A language with none of these yields a header-only twin.
4. **No assistant is connected** (see runbook 1), so sections are written as "(not explained yet ...)" placeholders.
5. **Big files.** Explanations are requested in chunks of at most 20 functions, so a file with hundreds of functions takes many requests; the twin opens first and fills in as sections arrive.

## Fix

1. Run **ExplainIT: Turn automatic twin opening on/off** and check the message says it is on, or set `explainit.twin.autoOpen` to `true`. You can always open a twin by hand with **ExplainIT: Open plain-English twin** (also in the editor title bar and the right-click menu).
2. Check the file is saved on disk with a code language mode shown in the status bar. If VS Code shows "Plain Text", pick the right language with **Change Language Mode**.
3. Install the language's VS Code extension so the outline works (for example the Python or Go extension). For languages without one, ExplainIT uses the tree-sitter grammar when it has one; otherwise it asks your assistant to find the functions, which costs a small number of assistant credits.
4. If sections say "(not explained yet ...)", connect an assistant (runbook 1), then right-click a section in the twin and choose **ExplainIT: Regenerate this section**, or run **ExplainIT: Regenerate the whole twin for this file**.
5. For very large files, wait for the first sections to appear (the status message shows progress) or split the file. Use `explainit.assistant.timeoutSeconds` to allow slower assistants more time.
6. Still nothing? Run **ExplainIT: Show logs** and look for the file's name; the log says which outline method was tried and why the twin was skipped.
