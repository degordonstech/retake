# Project format

A project is a folder. Retake never changes the recordings in it; everything Retake makes goes in a `.retake` folder inside, so a project moves with its folder. Projects started with **New video** get a folder in `Documents\Retake Projects`, and their sources point at the files wherever they are.

```
<project folder>/
  your recordings...
  Retake exports/           finished videos, with .srt captions and .chapters.txt
  .retake/
    project.json            the project: sources, takes, the edit, privacy, settings
    takes/<take>.json       the transcript of a take
    takes/<take>.db.npy     the take's loudness, every 10 ms (for cuts and waveforms)
    proxy/<source>.mp4      preview copies of files the window can't play directly
    thumbs/<source>.jpg     thumbnail sprite for the timeline
    audio/<source>.wav      voice levelled for export
    privacy/detections.json what the privacy scan found
    clips/                  cached export pieces (safe to delete)
    gfx/                    rendered labels and title cards (safe to delete)
    fonts/                  fonts copied for the subtitle renderer
```

All times are in seconds.

## project.json

```jsonc
{
  "id": "prj_1a2b3c4d",
  "name": "Put your game on the Play Store",
  "created": 1791900000.0,        // Unix time
  "updated": 1791990000.0,
  "stage": "edit",                // sources | edit | privacy | done
  "quick": true,                  // started with Just edit (no transcript yet)
  "sources": [Source],
  "takes": [Take],
  "edit": Edit,
  "privacy": { "dismissed": ["<detection key>"], "manual": [ManualBlur], "allowed": [], "scanned": 1791990000.0 },
  "brain": Brain,
  "output": { "fps": 0, "quality": "high" },   // fps 0 = match the footage; quality high | standard | small
  "renders": [Render],
  "assets": [Asset]
}
```

### Source

One media file.

| Field | Meaning |
|---|---|
| `id` | `src_...` |
| `file` | File name in the project folder, or an absolute path |
| `role` | `screen`, `voice`, `camera` or `skip` |
| `duration`, `has_video`, `has_audio`, `width`, `height`, `fps`, `vcodec`, `pix_fmt`, `color_range`, `size` | From ffprobe |
| `native` | The window can play the file as it is (no preview copy needed) |
| `thumbs` | Thumbnail sprite layout: `every` (seconds between frames), `cols`, `rows`, `height`, `count` |

### Take

| Field | Meaning |
|---|---|
| `id`, `name` | `tk_...` and a display name |
| `kind` | `screen`, `camera` or `audio` |
| `voice` | Source of the sound |
| `video` | Source of the picture, or `null` for voice only |
| `duration` | Length of the voice |
| `offsets` | `[[voice_time, offset], ...]`: video time = voice time + offset, from each voice time onwards |
| `sync_score`, `ready` | How confident the sync is; whether the take is prepared |

### Edit

```jsonc
{
  "clips": [Clip],          // the main Video track, played in order
  "overlays": [Overlay],    // Text track
  "media": [MediaItem],     // Overlay track
  "audio": [AudioItem],     // Audio track
  "captions": { "on": true, "template": "pop", "scale": 1, "y": 0.78, "color": "#FFFFFF", "hi": "#3DFF8B",
                "font": "Poppins Black", "upper": true, "words": 3, "lines": 1 },
  "format": { "aspect": "16:9", "fadeIn": false, "fadeOut": false }
}
```

**Clip** (a stretch of a take):

```jsonc
{
  "id": "c_...", "take": "tk_...", "a": 12.4, "b": 19.8,   // in the take's voice time
  "speed": 1.5, "volume": 1, "mute": false,
  "filter": "warm",                                         // a filter id from looks.py
  "adjust": { "brightness": 0, "contrast": 0.1, "saturation": 0, "temperature": 0.2, "vignette": 0, "sharpen": 0 },
  "frame": { "mode": "fill", "zoom": 1, "zoomTo": 1.25, "x": 0.5, "y": 0.4, "bg": "blur" },
  "transition": { "type": "fade", "dur": 0.5 }              // into this clip from the one before
}
```

A **title card** clip: `{ "id", "kind": "title", "text", "sub", "tag", "dur", "transition"? }`.

A clip's length on the timeline is `(b - a) / speed`; a title card's is `dur`.

**Overlay** (text and graphics):

```jsonc
{
  "id": "o_...", "kind": "text",   // text | label | lower | caption
  "text": "Your text", "start": 4.2, "dur": 3,
  // styled text
  "style": "boxed", "font": "Poppins ExtraBold", "size": 64, "color": "#141414", "accent": "#FFE14D",
  "upper": null, "x": 0.5, "y": 0.2, "anim": "pop", "out": "fade",
  // labels and lower thirds
  "sub": "", "tag": "STEP 01", "chapter": true
}
```

`x` and `y` are the centre, as fractions of the frame. `size` is in pixels for a frame whose short side is 1080. `anim` is `none`, `fade`, `pop`, `up`, `left` or `type`.

**MediaItem**: `{ "id", "asset", "start", "dur", "in", "mode": "full" | "pip", "x", "y", "scale", "radius", "opacity", "anim", "volume" }`. `in` is where it starts in its file; `scale` is its width as a fraction of the frame.

**AudioItem**: `{ "id", "asset", "start", "dur", "in", "volume", "fadeIn", "fadeOut", "duck", "loop" }`.

### Brain

What the first cut produced: `chapters` (`title`, `take`, `word`), `notes` (`take`, `word`, `note`), `corrections` (`take`, `word`, `text`: how a misheard word is spelled in captions), `title`, `description`, and `source` (`claude_code`, `anthropic`, `groq`, `rules` or `none`).

### Asset

Media brought in for the Overlay and Audio tracks: `{ "id", "file" (absolute path), "name", "kind": "image" | "video" | "audio", "width", "height", "duration", "has_audio", "native", "sfx" }`.

### Render

`{ "file", "srt", "chapters", "duration", "width", "height", "fps", "created", "leaks": [{ "t", "kind", "label", "preview" }], "engine": "window" }`. `engine` is present for Fast exports, which skip the read-back check.

## takes/&lt;take&gt;.json

```jsonc
{
  "words": [{ "w": "Alright", "s": 0.78, "e": 0.98, "i": 0 }],   // word, start, end, index
  "silences": [[1.2, 1.9]],
  "peaks": [0, 12, 40],            // loudness 0..100, 50 per second, for waveforms
  "duration": 789.4,
  "quick": true                     // a placeholder from Just edit: no words yet
}
```

## privacy/detections.json

A list of finds: `{ "id", "key", "src", "kind", "label", "text", "preview", "t0", "t1", "boxes": [[t0, t1, x0, y0, x1, y1], ...] }`, with boxes in source pixels.

## App data

`%APPDATA%\Retake\settings.json` holds the settings and the project list. API keys are stored here and never sent back to the window. `retake.log` is the app's log; `sfx/` holds the generated sound effects; `webview/` is the window's browser data.
