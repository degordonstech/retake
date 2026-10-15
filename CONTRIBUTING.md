# Contributing

Retake is private for now. These notes are for anyone working on it.

## Before you start

- Read [docs/architecture.md](docs/architecture.md) for how the pieces fit, and [docs/development.md](docs/development.md) for running and testing.
- Test against a copy of a project with its own settings folder (see Development). Never point a test at someone's real projects or at the running desktop app.

## Making a change

1. Keep the preview and both exporters in agreement. Anything that changes how a frame looks or times needs the same change in `web/src/engine`, `retake/render.py` and, for text, `retake/captions.py`.
2. Check the result the way a user would: open it in the editor, play it, export it, and look at the frames.
3. Run `npx tsc -b` and `npx vite build` in `web/`, and make sure `python -c "import retake.app"` passes.

## Writing

- Interface text names things by what people recognise and do: "Fast export", "Blur", "Just edit". No internal names, no jargon.
- Error messages say what went wrong and what to do next.
- No emojis in the interface or the docs.
- Documentation describes how things work now. It isn't a log of changes.

## Commits

One change per commit, with a message that says what the change does for the person using Retake, followed by why if it isn't obvious.

## Code from elsewhere

Learning from other editors is welcome. Copying their code isn't: write it yourself. Libraries used as dependencies must have licences that allow it, pinned to exact versions published at least two weeks earlier.
