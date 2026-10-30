# Loupe

**Frame-accurate edit notes for Claude Code.** Loupe opens a pane beside the chat where you step through a render frame by frame, mark a range, and pin a note to it: "hold this word 6 frames longer", "add a soft pop when the card lands". Then one button hands every open note to Claude as a fix list. Claude reads the notes, makes the changes, and ticks each one done against the render version that has the fix.

It's made for people who make videos with Claude: HyperFrames, Remotion, ffmpeg, or anything else that writes video files. It comes in two parts that share one notes file: a pane inside Claude Code, and [a web page](#the-web-page) you run locally.

## Install

In a terminal (two commands, run one after the other):

```bash
claude plugin marketplace add anshumanofficial2002-cpu/loupe
claude plugin install loupe@loupe
```

Then start Claude Code (`claude`) in your project folder and type `/loupe`.

Or, from inside a running Claude Code session (after typing `claude`), type these at its prompt. They're Claude Code commands, so pasting them into a plain terminal gives `no such file or directory: /plugin`:

```
/plugin marketplace add anshumanofficial2002-cpu/loupe
/plugin install loupe@loupe
```

In the Claude desktop app: click **+** next to the prompt box, then **Plugins** → **Add marketplace**, enter `anshumanofficial2002-cpu/loupe`, then **Add plugin**.

### Requirements

- Claude Code with plugin hooks (mods) support.
- `ffmpeg` and `ffprobe`. Loupe looks in `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`, then on your `PATH`. On a Mac: `brew install ffmpeg`.
- macOS or Linux.

## Use it

Run `/loupe` in a session started in your project folder (or the folder above several projects).

1. **Pick a project and a render.** Loupe lists every folder (the session folder and its direct subfolders) that has videos in `exports/`, `renders/`, `out/` or `output/`. Newest render first.
2. **Find the moment.** Step with the buttons or hotkeys, or type a time in **Go to**: `12.5`, `0:12:05`, `f300`, or a range like `12.5-14`.

   | Key | Step | Key | Step |
   | --- | --- | --- | --- |
   | `a` / `d` | 1 frame back / forward | `i` / `o` | mark in / out |
   | `q` / `e` | 5 frames | `x` | clear the range |
   | `z` / `c` | 1 second | | |

3. **Write the note.** Pick a type (effect, text, cut, sound, music, colour, b-roll, other), type what should change, and save. With no range marked, the note pins to the current frame.
4. **Send open notes to Claude.** Claude gets every open note with its frames, times and type. After making a change it marks the notes done in that render version (`v6`, say), so the list doubles as a change log.

The frame picture shows in the Claude desktop app and in VS Code. In a terminal, times, ranges and notes all work, but there's no picture.

### Where notes live

Notes are plain files inside each project, so they belong to the project, not to Loupe:

- `notes/edit-notes.json`: the source of truth. Other tools can read and write it too.
- `notes/edit-notes.md`: the same notes, readable, grouped into open and done.
- `notes/.frames/`: a cache of extracted frames. Safe to delete; add it to your `.gitignore`.

### Beats (optional)

If a project has `work/scenes.json` (an array of `{ "id": "hook", "t0": 0, "t1": 3.2 }`, times in seconds), Loupe shows each beat as a button that jumps there and marks its whole range, and every note records the beat it starts in.

## The web page

`web/` is the same tool as a page in your browser, for when you want the full player: real playback with sound, a timeline with every note on it, looping a range, and drawing a box on the frame where the change should go. It reads and writes the same `notes/` files, so the page and the Claude Code pane can be open side by side.

```bash
python3 web/server.py --root ~/my-videos
```

Then open http://localhost:5410. `--root` is the folder holding your projects (default: the folder you run it from); `--port` changes the port. It needs Python 3 and `ffprobe`, nothing else to install.

- It runs on your own computer only: it listens on `127.0.0.1` and serves no file outside `--root`.
- Each note can save a snapshot of its frame, with the box drawn on it, to `notes/snaps/<id>.jpg`.
- **Copy for Claude** puts the open notes on the clipboard, for pasting into any chat.
- Press `?` on the page for every shortcut.

## For Claude

Loupe registers one tool, `edit_notes` (`mcp__loupe__edit_notes`):

- `list`: the notes for a project (the one open in the pane by default).
- `done`: tick notes done with `ids` and the `version` that has the change.
- `reopen`: reopen them.

## Development

```bash
claude plugin validate .
claude plugin test .
```

The tests drive the pane on both the desktop and terminal views against a small in-memory project, covering stepping, marking, saving a note, sending it to Claude and ticking it done.

## Licence

MIT © Anshuman Shrivastava
