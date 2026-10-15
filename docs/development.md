# Development

## Setup

```powershell
pip install -r requirements.txt
cd web
npm install
```

You also need ffmpeg and ffprobe on the PATH (a full build with libass), and for the AI first cut either Claude Code, an Anthropic key, a Groq key, or nothing (the built-in rules).

## Running

Two ways:

- **Backend and built interface together**: `cd web; npm run build`, then `python -m retake --no-window --port 8790` and open `http://127.0.0.1:8790/`. The backend serves `web/dist` from disk, so after `npm run build` a page refresh is enough. Python changes need a backend restart.
- **Live reload**: run the backend as above on port 8765, then `cd web; npm run dev` and open `http://localhost:5173/`. Vite forwards `/api`, `/media` and `/fonts` to the backend.

`python -m retake` with no flags opens the desktop window.

## Testing without touching real projects

Settings and the project list live in `%APPDATA%\Retake`, and projects are folders on disk, so a test backend pointed at real data will change real projects. For anything that saves:

- Give the test backend its own settings folder and projects folder:

  ```powershell
  $env:APPDATA = "C:\temp\retake-test\appdata"
  $env:RETAKE_PROJECTS = "C:\temp\retake-test\projects"
  python -m retake --no-window --port 8790
  ```

- Work on a copy of a project. Hard links cost no disk space (same drive only): copy `.retake/project.json` and give it a new `id`, hard-link everything else.
- Use a port other than 8765, which the desktop app uses.

## Checks

```powershell
cd web
npx tsc -b          # type check
npx vite build      # production build into web/dist
```

```powershell
python -c "import retake.app"   # the backend imports cleanly
```

The interface is checked by driving it with Chrome (puppeteer-core): open a project, use each tool, and compare screenshots. Fast exports are checked by decoding the result with ffprobe and ffmpeg: frame count, audio length, loudness with `-af ebur128`, and frame comparison against the ffmpeg export of the same edit.

## Conventions

- Write for the person using the app: name things by what they do ("Fast export", not "WebCodecs render"). No jargon in the interface.
- Comments say why, not what.
- Keep the preview and both exporters in agreement. A change to how something looks or times belongs in all three places: `web/src/engine`, `retake/render.py` and, for text and captions, `retake/captions.py`.
- Looks (caption templates, text styles, filters, transitions) are defined once in `retake/looks.py` and served to the window.
- Bump `RENDER_VERSION` in `render.py` when clip rendering changes, so cached pieces are made again.
- ffmpeg 9 removed `-filter_complex_script`; use `-/filter_complex <file>`.
- Pin new npm packages to exact versions published at least two weeks earlier.
- Don't copy code from other editors. Learning from how they work is fine; their code stays theirs.

## Adding things

- **A caption template or text style**: add an entry to `CAPTIONS` or `TEXT_STYLES` in `retake/looks.py`. The window and both exporters pick it up. Modes are listed at the top of that section.
- **A transition**: add it to `TRANSITIONS` in `looks.py` (with the ffmpeg `xfade` name for the ffmpeg export) and to `TRANSITION_IDS` and the mix shader in `web/src/engine/gl.ts`.
- **A filter**: add it to `FILTERS` in `looks.py` as adjustment values.
- **A font**: put the file in `retake/assets/fonts`, add it to `FONTS` in `looks.py`, and add an `@font-face` to `web/src/styles.css`. Include its licence.
- **A sound effect**: add a synthesis function and an entry to `SOUNDS` in `retake/sfx.py`.
- **A job**: write a runner in `retake/jobs.py`, add it to `RUNNERS`, and start it from the window with `start("<kind>")`.
