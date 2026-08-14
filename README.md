# Flow Batch

Generates a whole set of images in [Google Flow](https://labs.google/fx/tools/flow) without you
sitting there pasting prompts. Feed it a list of scenes, press start, and every finished image lands
in your Downloads folder named by scene.

---

## The "being debugged" banner

While a run is active, Chrome shows a yellow bar: _"Flow Batch is debugging this
browser"_. That is expected and it disappears the moment the run ends.

Flow ignores synthetic clicks — an ordinary scripted click carries a flag saying it wasn't a real
person, and Flow checks it. The only way to type and click in a way Flow accepts is to have Chrome
itself generate the input, which requires attaching Chrome's debugger to the tab. Flow Batch attaches
when a run starts and detaches when it finishes, stops, or fails.

You can turn this off under **Settings → Use real keyboard and mouse**, but Flow will probably refuse
to submit without it. **Chrome DevTools cannot be open on the Flow tab** while this is on — only one
debugger may attach at a time. If DevTools is open, the run says so and continues without it.

---

## Setting it up (once)

1. Unzip this folder somewhere you'll keep it — deleting it uninstalls the extension.
2. In Chrome, go to `chrome://extensions`
3. Turn on **Developer mode** (switch, top right)
4. Click **Load unpacked** and choose the `flow-batch` folder
5. Click the puzzle-piece icon in Chrome's toolbar and pin **Flow Batch**

---

## Using it

1. Open Flow and sign in, then open the project you want the images in.
2. Click the **Flow Batch** icon.
3. Look at the box at the top. It tells you what's happening:

| What it says                            | What to do                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ready**                               | You're good — it shows which prompt box it found                                                                                                   |
| **No Flow tab open**                    | Click **Open Flow**                                                                                                                                |
| **Can't find Flow's prompt box**        | Make sure the prompt field is visible on screen, click **Re-check**. Still stuck? Click **Show me the prompt box**, then click Flow's prompt field |
| **Reload the Flow tab**                 | Click **Reload tab** — the extension updated after the page was opened                                                                             |
| **A previous run stopped unexpectedly** | Click **Reset**                                                                                                                                    |

4. Click **Test with 1 image first**. Watch it type into Flow and generate. This takes a minute and
   tells you everything works.
5. Click **Start all 60 images**.

Leave the Flow tab visible while it runs — Chrome slows down background tabs, and closing the tab
stops the run.

Each run also writes one `_run-log_2026-08-01_1632.json` beside the images, named for when the run
finished. It opens with a summary — how many saved, how many failed, how many came back as
thumbnails, and a ready-made `retry` list you can paste straight into **Only these scenes**. Turn it
off under **Settings → Save a run log**.

The subfolder is named after the `name:` in your settings block, so each image set stays separate.
The popup shows the exact path with an **Open folder** link that reveals the newest saved image in
Finder or File Explorer. Chrome extensions can only write inside your Downloads folder — if you want
the files elsewhere, move them afterwards or change Chrome's download location in
`chrome://settings/downloads`.

---

## While it's running

You'll see a progress bar, which scene it's on, what it's doing right now ("typing prompt",
"waiting for image", "saving"), and a rough time remaining.

- **Pause** stops before the next image. Anything mid-flight finishes.
- **Stop** ends the run and still saves the log.
- Anything that failed shows a red ✕ with the reason. Click **Retry failed** afterwards to run just
  those again.

---

## If something goes wrong

Everything the extension can't do produces a sentence telling you what to do about it. The two you're
most likely to see:

**"Can't find Flow's prompt box"** — Flow changed its layout. Click **Show me the prompt box**; the
popup closes, a red outline follows your cursor, and you click Flow's prompt field. It remembers.
Same idea for the generate button and the results area, under **Page detection**.

**"Flow stopped the run"** — Flow's agent has a daily quota ("You've reached your Agent quota
limit"). Flow Batch watches for that message and stops immediately rather than timing out on every
remaining scene. Everything finished so far is already saved. Tomorrow, open `_run-log.json`, copy
the scene IDs that never ran into **Only these scenes**, and start again.

**"No image appeared within 4 min"** — usually Flow erroring on that particular prompt. Check the
Flow panel, then use **Retry failed**.

If a run ever seems frozen, the status box notices within 45 seconds and offers a **Reset**.

---

## Settings

Under **Settings**, all optional:

| Setting                    | Default | What it does                                                                                   |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| Add character descriptions | on      | Puts each scene's character descriptions above the prompt, so wardrobe and age stay consistent |
| Add aspect ratio and size  | on      | Writes `Aspect ratio 16:9. Render at 2K.` into the prompt                                      |
| Wait between images        | 3 s     | Increase if Flow starts throttling you                                                         |
| Give up after              | 240 s   | How long to wait for one image                                                                 |
| Tries per image            | 2       | Failures are retried, then logged and skipped                                                  |
| Only these scenes          | all     | `scene_01, thumbnail` — run just a few                                                         |
| Practice mode              | off     | Sends prompts but doesn't wait or save                                                         |

**Preview the first prompt** shows exactly what will be sent, character block and all.

---

## Using your own image sets

Click **Change…** and paste JSON, or open a `.json` file:

```json
{
  "episode": "10-something",
  "defaults": { "aspect_ratio": "16:9", "image_size": "2K" },
  "anchors": { "sudha": "Full character description…" },
  "subgrades": { "night": "SUBGRADE — a single bare bulb, everything else black." },
  "images": [
    {
      "id": "scene_01",
      "prompt": "…",
      "anchors": ["sudha"],
      "subgrade": "night",
      "image_size": "4K"
    }
  ]
}
```

Only `id` and `prompt` are required per image. `episode` becomes the folder name and filename prefix —
if you also set `internal_name`, the folder is named `episode-internal_name` (so `"episode": 12,
"internal_name": "udhaar"` saves to `FlowBatch/12-udhaar/`). `subgrade` names one entry from
`subgrades` to append to that shot's prompt; `anchors` is for characters, places and props instead.
Whatever you loaded last is remembered.

style blocks, so you're not hand-editing 60 copies of the same paragraph.

### One image, several scenes

If the same shot is reused later in the cut, generate it once and add a `used_in` list — the finished
image is duplicated into a file per scene, with no extra Flow calls:

```json
{
  "id": "img_01",
  "prompt": "Wide establishing view of the flower market before dawn…",
  "used_in": ["scene_01", "scene_62"]
}
```

That produces `scene_01.jpg` and `scene_62.jpg`, both copies of the one generated image. Leave
`used_in` out (or empty) for an image that's only ever used once — it's then saved under its own
`id`, same as before. The scene list in the popup shows each image's output names as orange chips so
you can check the mapping before starting a run, and **Only these scenes** accepts either an image's
`id` (`img_01`) or any of its output scene names (`scene_01`).

---

## Worth knowing

- **Faces will drift across 60 images.** The character descriptions keep clothing, age and build
  consistent, but text alone won't hold a face. If Flow's reference-image feature is available on
  your account, generating each character once and pinning them as references is the real fix.
- **You will probably not get all 60 in one day.** Flow's agent quota is per-account and per-day,
  and 60 images is a lot of turns. Expect to run this across several days. Flow Batch is built for
  that: it stops cleanly on the quota message and the run log tells you exactly where to resume.
- **This doesn't change your Flow plan or bypass anything.** 60 images costs 60 images' worth of
  whatever your account allows.
- **A run doesn't survive a browser restart.** Check `_run-log.json` for what failed and put those
  IDs into "Only these scenes".

---

## For developers

`node test_logic.mjs` checks prompt assembly and filenames against the real episode file.
`node test_dom.mjs` loads `content.js` into a simulated Flow page (jsdom) and checks that element
detection picks the composer over decoys, honours taught selectors, and sees through shadow DOM.
Both live one level up from this folder.

Element detection is deliberately not hardcoded — Flow ships obfuscated, per-deploy class names, so
`content.js` scores candidates by placeholder text, position, and proximity to a send button, walking
open shadow roots and every frame. The popup asks each frame via `window.__flowBatchProbe()` and runs
the batch in whichever frame scores highest.
