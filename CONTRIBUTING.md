# Contributing

Thanks for wanting to help. Bug reports, ideas and code are all welcome.

## Reporting a bug

Open an issue and say what you did, what you expected, and what happened instead. Screenshots help. If it's about a specific video, mention the format and where it came from (phone, OBS, Windows recorder, and so on). If the app wouldn't start, attach `%APPDATA%\Retake\retake.log`.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Suggesting a feature

Open an issue that starts with the problem, not the solution. "I can't line up two camera angles" tells me more than "add multicam".

## Sending code

1. Read [How it works](docs/architecture.md) and [Working on Retake](docs/development.md).
2. Test on a copy of a project, with its own settings folder. The development guide shows how. Never point a test at your real projects or at the app while it's open.
3. Keep the preview and both exports in agreement. If you change how a frame looks or when something happens, make the same change in `web/src/engine`, in `retake/render.py`, and for text in `retake/captions.py`.
4. Before opening a pull request, run `npx tsc -b` and `npx vite build` in `web/` and `python -c "import retake.app"` at the top level. Then try the change in the app the way a user would: play it, export it, look at the frames.
5. Keep pull requests to one change, and say what it does for someone using Retake.

## Writing for the app

- Name things by what people do or see: "Fast export", "Blur", "Just edit". Leave internal names out of the interface.
- An error says what went wrong and what to do about it.
- No emojis in the interface or the docs.
- Docs describe how things work now. They aren't a changelog.

## Other people's code

Learn from other editors as much as you like, but write your own code. Don't copy from them. New dependencies need a licence compatible with Apache 2.0, pinned to an exact version that has been out for at least two weeks.

## Licence

Retake is under the [Apache License 2.0](LICENSE). By sending a contribution, you agree that it is licensed under the same terms.
