# User guide

## Starting a video

**New video.** On the home screen, click **New video** and choose your files, or drag them from Explorer onto the window. Videos, pictures and music are all welcome. The files stay where they are; Retake keeps a project folder for its own work in `Documents\Retake Projects`.

- With **AI first cut** off (the default), every file goes straight onto the timeline and the editor opens. Nothing is transcribed, so this takes seconds.
- With **AI first cut** on, Retake transcribes your footage and an AI editor makes a first cut before the editor opens.

**From a folder of recordings.** Choose a folder (or paste its path) that holds one recording session: screen recordings, voice tracks recorded separately, camera footage. This is the path for long tutorials. Retake opens the **Footage** step so you can check its guesses before it starts.

## The four steps

The bar at the top of a project has four steps. You can move between them freely once each is ready.

### 1. Footage

Every file is listed with what Retake thinks it is:

| Role | Meaning |
|---|---|
| Screen | A screen recording. Its picture is used; its sound only if there is no separate voice. |
| Voice | A sound-only recording of your voice, paired with a screen recording. |
| Camera | Face-cam or phone footage, picture and sound together. |
| Skip | Left out (for example, an old export sitting in the folder). |

Change any role with its menu. Retake pairs each voice with the screen recording of the closest length; reorder or re-pair them if it guessed wrong.

Then choose:

- **Just edit**: every file on the timeline as it is, ready in seconds.
- **Make my first cut**: Retake makes preview copies and thumbnails, transcribes every take, lines each voice up with its screen recording, and asks your AI editor for a first cut.

A project started with Just edit shows **Transcribe for captions** here later. It writes out every word without changing your edit.

### 2. Edit

The editor has four areas:

- **Tools** on the left: Transcript, Media, Audio, Text, Captions, Transitions, Filters.
- **Preview** in the middle, with the video shape (16:9, 9:16, 1:1, 4:5) above it.
- **Settings** on the right, for whatever is selected.
- **Timeline** at the bottom, with Text, Overlay, Video and Audio tracks.

#### Transcript

- Click a word to jump to it.
- Drag across words to select them. Press **Delete** to cut them, or **R** to bring cut words back.
- Double-click a word to correct how it is spelled. The correction is used in captions and the exported subtitle file.
- Words the AI flagged for checking are underlined in yellow; their notes are listed under **About this cut**.

#### Timeline

- Click to move the playhead; drag clips to reorder them; drag a clip's edges to trim it.
- Items on the Text, Overlay and Audio tracks move and trim the same way. They snap to cuts, the playhead and each other. Overlapping items stack into extra rows.
- Overlays and text are pinned to the moment of the recording they sit on, so cutting earlier words moves them along with their moment.
- The small marks between clips are cuts. Click one to give it a transition.
- Hold **Ctrl** and scroll to zoom the timeline.

#### Clip settings

Select a clip to see its settings, in five tabs:

- **Edit**: exact in and out points, and nudges. For a screen recording paired with a separate voice, **Picture timing** shifts the picture against the voice for the whole recording.
- **Speed**: 0.25x to 4x. The voice keeps its pitch.
- **Audio**: volume and mute.
- **Colour**: a filter plus brightness, contrast, saturation, warmth, vignette and sharpen.
- **Frame**: fit or fill the frame, blurred or plain background, zoom, the focus point, and a slow zoom across the clip (Ken Burns). **Punch in** and **Push in** are one-click starting points.

Select several clips (Ctrl or Shift and click) to change their speed, filter or sound together.

#### Text

Click a style to add text at the playhead. Select text to change its words, style, font, size, colour, position, entrance and exit. In the preview, drag text to move it and scroll over it to resize it.

**Tutorial graphics**: a title card (its own clip on the Video track), a chapter label, a lower third and a simple caption bar. Labels marked as chapters become the YouTube chapter list at export.

#### Captions

Turn captions on by choosing a look. Captions are built from the transcript, follow every cut and are burned into the export. Adjust size, height on screen, words per caption, one or two lines, capitals, text and highlight colours, and font.

#### Media and Audio

**Import** (or drag files onto the window) to add pictures, video clips and music. Then:

- Drag a picture or clip onto the Overlay track, or double-click it, to place it at the playhead. In its settings choose full screen or picture in picture, size, position, corners, opacity and entrance. Drag it in the preview to move it.
- **Music** adds a sound under the whole video, looping if it is shorter, and quieter while you talk. **+** places it at the playhead instead.
- **Sound effects**: click one to hear it, **+** to place it at the playhead.

#### Transitions and filters

- **Transitions**: pick one for the selected cut (or the cut nearest the playhead), set its length, or use it on every cut.
- **Filters**: pick a look for the selected clips (or the clip under the playhead), or use it on every clip.

### 3. Privacy

For screen recordings, Retake reads the kept footage wherever the picture changes and lists everything that looks private, each shown on its frame: emails, phone numbers, API keys and tokens, password prompts, links with long IDs, file pickers, recent-project lists, desktop icons, link previews, and any words you add in Settings under **Private words**.

- Each find has a switch. Turn it off if it doesn't need hiding.
- **Draw a blur** for anything Retake missed.
- The scan runs again by itself before export if the edit has changed.

### 4. Export

- **Shape**: YouTube (16:9), Shorts, TikTok and Reels (9:16), Square (1:1), Instagram feed (4:5).
- **Quality** and **frame rate** (by default, the rate most of your footage uses).
- **Fade in from black** and **fade out at the end**.

Then:

- **Export video**: full quality with ffmpeg. Afterwards the finished file is read back with OCR, and anything private still readable is listed.
- **Fast export**: made in the window by Retake's own engine on your graphics chip. Blurs are applied; the read-back check is not run.

Exports go to a **Retake exports** folder inside the project folder, next to a captions file (`.srt`) and a chapters list. The Export page shows the suggested title and description, ready to copy.

## Settings

- **Who makes the first cut**: Claude Code, a Claude API key, a Groq key, or the built-in rules. Keys stay on this computer.
- **Listening**: transcription accuracy (Fast, Balanced or Most accurate) and language.
- **Private words**: names, emails or anything else that must never be readable on screen.
- **Your look**: the accent, background and text colours used by labels and title cards.

## Keyboard shortcuts

| Key | Does |
|---|---|
| Space | Play or pause |
| S | Split at the playhead |
| Delete, Backspace | Delete the selection (clips, an item, or a cut's transition) |
| Ctrl Z | Undo |
| Ctrl Y, Ctrl Shift Z | Redo |
| Ctrl D | Duplicate the selected text, overlay or sound |
| Left, Right | Step one frame |
| Shift Left, Shift Right | Step one second |
| Home, End | Go to the start or the end |
| + and - | Zoom the timeline in and out |
| Escape | Clear the selection |

In the transcript: **Delete** cuts the selected words, **R** brings them back, **Escape** clears the selection.

## Where things are kept

| What | Where |
|---|---|
| Your recordings | Wherever they were. Retake never changes them. |
| A project's work (preview copies, transcripts, the edit, caches) | `.retake` inside the project folder |
| Exports | `Retake exports` inside the project folder |
| Settings, keys and the project list | `%APPDATA%\Retake` |
| The app's log | `%APPDATA%\Retake\retake.log` |

Deleting a project from the home screen only removes it from the list; its folder and files are kept.
