# omp-context-editor

An [omp](https://omp.sh) extension that adds `/edit-context`: edit, delete and insert
messages of the current session and save the result as a new branch of the same
session file.

## Install

```sh
omp plugin install "git+https://github.com/nikitatsym/omp-context-editor.git"
```

## Usage

Run `/edit-context` in the interactive TUI. It lists the messages the model sees on the
current branch after the latest compaction or `/clear`, newest first. Pick a message to
edit its text, delete it (tool calls go together with their results), insert a user or
assistant message after it, or revert a staged change. Turns marked `[not sent]` can
only be deleted.

Changes stay staged until you save or discard them. `Save changes` lists them and either
keeps the messages after the last change or cuts the branch there. Changed and inserted
messages are labelled `edited`; the previous branch stays reachable through `/tree`.

## Limits

- Refuses to run while the agent is busy: a turn, queued messages, background jobs or
  compaction.
- Thinking blocks cannot be edited.
- IRC cards keep showing the old text in the transcript; the model gets the new text.
- Uses internal omp session APIs; tested against omp 18.20.2. If a required method is
  missing, the command refuses and writes nothing.

## License

MIT
