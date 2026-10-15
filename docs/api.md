# Local API

The engine listens on `127.0.0.1` only (port 8765 by default). The window is its only intended client. Bodies and responses are JSON unless noted. Project routes return the full project unless noted.

## App

| Method | Path | Does |
|---|---|---|
| GET | `/api/health` | Version, whether ffmpeg is found, whether the desktop window is attached |
| POST | `/api/focus` | Bring the window to the front (used by a second launch) |
| GET | `/api/looks` | Caption templates, text styles, filters, transitions, shapes and fonts |
| GET | `/fonts/{name}` | A bundled font file |
| GET, POST | `/api/settings` | Read or change settings. Secrets come back as `*_set` flags |
| POST | `/api/settings/clear-secret` | `{ key }`: forget a stored key |
| GET | `/api/brain/status` | Whether each AI editor is ready |
| POST | `/api/pick-folder` | Open the folder dialog: `{ folder }` |
| POST | `/api/pick-files` | Open the file dialog: `{ paths }` |
| GET | `/api/sfx` | The built-in sound effects |
| GET | `/sfx/{name}.wav` | A sound effect (made on first use) |
| POST | `/api/reveal` | `{ path }`: show a file in Explorer |

## Projects

| Method | Path | Does |
|---|---|---|
| GET | `/api/projects` | The project list |
| POST | `/api/projects` | `{ folder, name? }`: open or create a project from a folder |
| POST | `/api/projects/from-files` | `{ paths, name?, mode }`: a project from files anywhere. `mode` `edit` puts them on the timeline at once; `ai` prepares them for a first cut |
| DELETE | `/api/projects/{pid}` | Remove from the list (files are kept) |
| GET | `/api/projects/{pid}` | The project |
| POST | `/api/projects/{pid}/rename` | `{ name }` |
| POST | `/api/projects/{pid}/sources/{sid}` | `{ role }` |
| POST | `/api/projects/{pid}/takes` | `{ takes: [{ id?, voice, video }] }`: reorder or re-pair takes |
| GET | `/api/projects/{pid}/takes/{tid}` | A take's transcript |
| POST | `/api/projects/{pid}/takes/{tid}/nudge` | `{ delta }`: shift the picture against the voice |
| PUT | `/api/projects/{pid}/edit` | Save the edit (clips, overlays, media, audio, captions, format) |
| GET, PUT | `/api/projects/{pid}/output` | Export settings, with the resolved size and frame rate |
| POST | `/api/projects/{pid}/corrections` | `{ take, word, text }`: spell a word differently in captions (empty text undoes it) |
| POST | `/api/projects/{pid}/captions/layout` | `{ clips, captions, format }`: where every caption word goes |
| POST | `/api/projects/{pid}/text/layout` | `{ overlays, format }`: text line widths with the real fonts |

## Jobs

| Method | Path | Does |
|---|---|---|
| POST | `/api/projects/{pid}/jobs/{kind}` | Start `prepare`, `autoedit`, `quickstart`, `scan` or `render` |
| GET | `/api/projects/{pid}/job` | The current job: status, progress, message, log, error |

## Media

| Method | Path | Does |
|---|---|---|
| GET | `/media/{pid}/proxy/{sid}.mp4` | What the window plays for a source: its preview copy, or the file itself |
| GET | `/media/{pid}/source/{sid}` | The original file |
| GET | `/media/{pid}/thumbs/{sid}.jpg` | Thumbnail sprite |
| GET | `/media/{pid}/render/{index}` | A finished export |
| GET | `/api/projects/{pid}/frame?src=&t=&w=` | One frame as JPEG |
| GET | `/api/projects/{pid}/overlay.png?kind=&text=&sub=&tag=&w=&h=` | A label, lower third or title card |

All media routes support HTTP range requests.

## Imported media

| Method | Path | Does |
|---|---|---|
| POST | `/api/projects/{pid}/assets` | `{ paths }`: add files. Returns `{ added, project }` |
| POST | `/api/projects/{pid}/assets/pick` | Open the file dialog and add the chosen files |
| DELETE | `/api/projects/{pid}/assets/{aid}` | Remove a file and its uses from the project |
| POST | `/api/projects/{pid}/sfx/{name}` | Add a built-in sound effect. Returns `{ asset, project }` |
| GET | `/media/{pid}/asset/{aid}` | The file, or its preview copy |
| GET | `/media/{pid}/asset/{aid}/thumb.jpg` | A thumbnail |
| GET | `/media/{pid}/asset/{aid}/peaks` | `{ per, peaks }`: waveform |

## Privacy

| Method | Path | Does |
|---|---|---|
| GET | `/api/projects/{pid}/privacy` | Finds, dismissed keys, drawn blurs |
| POST | `/api/projects/{pid}/privacy/dismiss` | `{ key, on }` |
| POST | `/api/projects/{pid}/privacy/manual` | `{ src, t0, t1, box }`: draw a blur |
| DELETE | `/api/projects/{pid}/privacy/manual/{mid}` | Remove a drawn blur |
| GET | `/api/projects/{pid}/blur-spans` | What to blur per source: `[start, end, x0, y0, x1, y1]` |

## Exports made in the window

| Method | Path | Does |
|---|---|---|
| POST | `/api/projects/{pid}/stream-render` | `{ aspect }`: start a file. Returns `{ token, file }` |
| PUT | `/api/projects/{pid}/stream-render/{token}?pos=` | Raw bytes written at byte position `pos` |
| POST | `/api/projects/{pid}/stream-render/{token}/done` | `{ duration, width, height, fps }`: write captions and chapters, record the export |
| POST | `/api/projects/{pid}/open-exports` | Open the exports folder |
