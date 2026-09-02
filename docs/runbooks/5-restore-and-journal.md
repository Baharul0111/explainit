# 5. Restore a file, or the journal fails to verify

## Symptoms

- You accepted a change and want the previous version of the file back.
- An assistant changed a file outside the checkpoint (Copilot, or a paused checkpoint) and you want to undo it.
- "ExplainIT: Verify the change journal" or the Doctor reports "The change journal has been tampered with or damaged at entry N".

## Cause

**Restore points.** Before every accepted write the checkpoint saves a copy of the file (a restore point) outside the repository, under `~/.explainit/workspaces/<key>/checkpoints/`. Restoring writes that copy back to the original path after first saving a fresh restore point of the current content, so a restore can itself be undone. Rotation keeps `explainit.restorePoints.maxPerFile` points per file and `explainit.restorePoints.maxTotalMB` in total per workspace; very old points are removed.

**Journal.** Every proposed and accepted change is appended to `journal.jsonl` in the same folder. Each entry carries a hash of itself plus the previous entry's hash (a hash chain), so any edit, deletion or reordering of past entries makes verification fail at that point. A failure means one of:

- Something edited or truncated the journal file by hand or by a tool (sync clients, disk cleaners, a crash mid-write).
- The disk ran out of space or the file system returned an error while an entry was being written.
- An assistant tried to rewrite it. ExplainIT refuses assistant writes under `~/.explainit`, so this is unlikely, but it is exactly what the chain is there to reveal.

## Fix

### Restore a file

1. Open the **ExplainIT** view in the Activity Bar → **Changes and restore points**. Each accepted change shows its restore point with a **Restore this restore point** button. One click restores the file (a safety copy of the current content is saved first).
2. Or right-click a file in the Explorer → **ExplainIT: Restore a file from a restore point**, and pick the point by time. The same command runs from the Command Palette for the active file.
3. The message "Restored <file>. A safety restore point of the previous content was saved first." confirms it. If you restored the wrong point, run the command again and pick the safety point (the newest one).
4. "There are no restore points for this file yet" means no accepted change touched that file in this workspace, or the point was rotated out. Use git or your editor's local history for older versions.
5. If restore fails with a permission or disk error, the current content is left untouched; fix the underlying problem (free space, file permissions) and try again.

### The journal fails to verify

1. Run **ExplainIT: Verify the change journal**. The message names the entry number where the chain breaks.
2. Do not edit the journal. Copy `~/.explainit/workspaces/<key>/journal.jsonl` somewhere safe if you need it as evidence of what happened.
3. Run **ExplainIT: Doctor**. If "Free disk space for restore points" is a problem, free space first; a full disk is the most common innocent cause.
4. Entries before the break are still trustworthy; entries after it are not. Restore points are stored as separate files and remain usable regardless of the journal.
5. To start a clean chain, rename the damaged `journal.jsonl` (for example to `journal.damaged.jsonl`) while VS Code is closed. ExplainIT begins a new journal on the next start. Archived files named `journal.<timestamp>.archived.jsonl` are normal: they are produced by rotation and stay verifiable through the "archived tail hash" entry.
