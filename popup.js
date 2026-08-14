/* popup.js — readiness checks, plain-language status, run control. */

const $ = (s) => document.querySelector(s);
const FLOW_ANY = "https://labs.google/fx/*";
const FLOW_TOOL = "https://labs.google/fx/tools/flow";
const STALE_MS = 45000; // no heartbeat for this long = the run died with its tab

let spec = null;
let specFormat = "text"; // which shape `spec` was last loaded as — see applySpec()
let ready = { status: "checking", frameId: 0, probe: null };
let lastState = null;

/* --------------------------------------------------------------- tab access */

async function flowTab() {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (active && /^https:\/\/labs\.google\/fx\//.test(active.url || ""))
    return active;
  const [any] = await chrome.tabs.query({ url: FLOW_ANY });
  return any || null;
}

// Asks every frame whether it can see a prompt box, and keeps the best answer.
// executeScript defaults to the isolated world, the same one content.js lives in.
async function probeAllFrames(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (window.__flowBatchProbe ? window.__flowBatchProbe() : null),
    });
  } catch (_) {
    return null;
  }
  const hits = results
    .filter((r) => r.result)
    .map((r) => ({ frameId: r.frameId, ...r.result }));
  if (!hits.length) return null;
  const withBox = hits.filter((h) => h.promptBox);
  if (!withBox.length)
    return { ...hits[0], frameId: hits[0].frameId, promptBox: null };
  return withBox.sort((a, b) => b.promptScore - a.promptScore)[0];
}

async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ["content.css"],
    });
  } catch (_) {
    /* some frames are cross-origin and will refuse; that's fine */
  }
}

async function checkReadiness() {
  const tab = await flowTab();
  if (!tab) return (ready = { status: "no-tab" });

  let probe = await probeAllFrames(tab.id);
  if (!probe) {
    await ensureInjected(tab.id);
    probe = await probeAllFrames(tab.id);
  }
  if (!probe) return (ready = { status: "no-script", tabId: tab.id });
  if (!probe.promptBox)
    return (ready = {
      status: "no-box",
      tabId: tab.id,
      frameId: probe.frameId,
      probe,
    });
  return (ready = {
    status: "ready",
    tabId: tab.id,
    frameId: probe.frameId,
    probe,
  });
}

async function toTarget(message) {
  if (!ready.tabId) throw new Error("Open Flow first.");
  return chrome.tabs.sendMessage(ready.tabId, message, {
    frameId: ready.frameId ?? 0,
  });
}

async function broadcast(message) {
  if (!ready.tabId) throw new Error("Open Flow first.");
  return chrome.tabs.sendMessage(ready.tabId, message).catch(() => {});
}

/* ------------------------------------------------------------ spec handling */

// Mirrors outputIdsFor()/matchesOnly() in content.js — one generated image
// can be saved as several scene files ("used_in"), and "Only these scenes"
// should match either the image id or any of its output scene names.
function outputIdsFor(scene) {
  return scene.used_in && scene.used_in.length ? scene.used_in : [scene.id];
}
function matchesOnly(scene, only) {
  if (!only || !only.length) return true;
  if (only.includes(scene.id)) return true;
  return outputIdsFor(scene).some((id) => only.includes(id));
}

function renderSceneList() {
  const list = $("#sceneList");
  // Rebuilding wipes scroll position back to the top. On a 60-scene spec,
  // deleting one prompt from partway down the list then jumps you back to
  // #1 — which reads as the whole popup refreshing rather than one row
  // quietly disappearing.
  const prevScroll = list.scrollTop;
  list.innerHTML = "";
  list.hidden = !spec || $("#specPanel").hidden;
  if (list.hidden) return;

  spec.images.forEach((im, i) => {
    const li = document.createElement("li");

    const n = document.createElement("span");
    n.className = "n";
    n.textContent = i + 1;

    const body = document.createElement("div");
    body.className = "body";
    const sid = document.createElement("span");
    sid.className = "sid";
    sid.textContent = im.id;
    body.append(sid);
    for (const a of im.anchors || []) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = a;
      body.append(chip);
    }
    // Shown only when this image is saved as a different name (or several) —
    // no point restating "scene_01" beside an image already called scene_01.
    if (im.used_in && im.used_in.length) {
      for (const out of im.used_in) {
        const chip = document.createElement("span");
        chip.className = "chip out";
        chip.textContent = `→ ${out}`;
        body.append(chip);
      }
    }
    const txt = document.createElement("span");
    txt.className = "txt";
    txt.textContent = im.prompt;
    txt.title = im.prompt;
    body.append(txt);

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.title = `Remove ${im.id}`;
    del.addEventListener("click", () => {
      spec.images.splice(i, 1);
      if (!spec.images.length) {
        spec = null;
        $("#spec").value = "";
        applySpec("");
        return;
      }
      // Round-tripping a JSON-loaded spec through the plain-text format would
      // lose anything the text format can't express — "used_in", "subgrade" —
      // even though toText() now writes both. Re-serialize as JSON instead so
      // a JSON spec never loses a field the text format hasn't caught up to.
      const text =
        specFormat === "json"
          ? JSON.stringify(spec, null, 2)
          : FlowBatchParse.toText(spec);
      // Same problem as the scene list: rewriting the whole textarea snaps its
      // scrollbar to the top, so deleting scene #45 out of 60 looks like the
      // box reloaded from scratch. Put the scroll position back afterwards.
      const box = $("#spec");
      const boxScroll = box.scrollTop;
      box.value = text;
      box.scrollTop = boxScroll;
      applySpec(text);
    });

    li.append(n, body, del);
    list.append(li);
  });

  list.scrollTop = prevScroll;
}

function applySpec(text, { persist = true } = {}) {
  if (!text.trim()) {
    spec = null;
    $("#specName").textContent = "No prompts loaded";
    $("#specMeta").textContent = "";
    $("#specError").hidden = true;
    renderSceneList();
    paint();
    return;
  }
  try {
    const { spec: parsed, format } = FlowBatchParse.parseAny(text);
    spec = parsed;
    specFormat = format;

    const anchors = Object.keys(parsed.anchors || {}).length;
    const d = parsed.defaults || {};
    const fileCount = parsed.images.reduce(
      (sum, im) => sum + outputIdsFor(im).length,
      0,
    );
    $("#specName").textContent = parsed.episode || "Untitled set";
    $("#specMeta").textContent = [
      `${parsed.images.length} prompt${parsed.images.length === 1 ? "" : "s"}`,
      // Only worth saying when duplication is actually happening — a plain
      // one image-per-scene spec would just be restating the same number.
      fileCount !== parsed.images.length
        ? `${fileCount} scene file${fileCount === 1 ? "" : "s"}`
        : null,
      anchors ? `${anchors} character${anchors === 1 ? "" : "s"}` : null,
      d.aspect_ratio || null,
      format === "json" ? "from JSON" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    $("#specError").hidden = true;
    $("#folderName").textContent = String(
      parsed.internal_name
        ? parsed.episode
          ? `${parsed.episode}-${parsed.internal_name}`
          : parsed.internal_name
        : parsed.episode || "flow-batch",
    ).replace(/[^a-zA-Z0-9._-]+/g, "_");
    if (persist) chrome.storage.local.set({ lastSpec: text });
  } catch (err) {
    spec = null;
    $("#specName").textContent = "Couldn't read that";
    $("#specMeta").textContent = "";
    $("#specError").hidden = false;
    $("#specError").textContent = String(err.message || err);
  }
  renderSceneList();
  paint();
}

/* ------------------------------------------------------------------ options */

function readOptions() {
  const only = $("#only").value.trim();
  return {
    includeAnchors: $("#includeAnchors").checked,
    appendFormat: $("#appendFormat").checked,
    gapSec: Number($("#gapSec").value) || 0,
    timeoutSec: Number($("#timeoutSec").value) || 240,
    retries: Number($("#retries").value) || 2,
    dryRun: $("#dryRun").checked,
    trustedInput: $("#trustedInput").checked,
    saveLog: $("#saveLog").checked,
    only: only ? only.split(/[,\s]+/).filter(Boolean) : null,
  };
}

function saveOptions() {
  chrome.storage.local.set({ options: readOptions() });
}

function restoreOptions(o) {
  if (!o) return;
  $("#includeAnchors").checked = o.includeAnchors !== false;
  $("#appendFormat").checked = o.appendFormat !== false;
  $("#gapSec").value = o.gapSec ?? 3;
  $("#timeoutSec").value = o.timeoutSec ?? 240;
  $("#retries").value = o.retries ?? 2;
  $("#dryRun").checked = !!o.dryRun;
  $("#trustedInput").checked = o.trustedInput !== false;
  $("#saveLog").checked = o.saveLog !== false;
  $("#only").value = (o.only || []).join(", ");
}

// Mirrors buildPrompt() in content.js so the preview is honest.
function buildPrompt(scene, s, opts) {
  const anchorMap = s.anchors || {};
  const gradeMap = s.subgrades || s.subGrades || {};
  const pick = (map, name) => {
    if (map[name] !== undefined) return map[name];
    const want = String(name).trim().toLowerCase();
    const hit = Object.keys(map).find((k) => k.toLowerCase() === want);
    return hit === undefined ? undefined : map[hit];
  };
  const refs = scene.anchors || [];
  const anchors = refs
    .map((k) => pick(anchorMap, k))
    .filter((v) => v !== undefined);
  const grades = refs
    .filter((k) => pick(anchorMap, k) === undefined)
    .map((k) => pick(gradeMap, k))
    .filter((v) => v !== undefined);

  // Some specs name the lighting look separately per shot — "subgrade":
  // "terrace" — rather than mixing it into the anchors list.
  if (scene.subgrade) {
    const named = pick(gradeMap, scene.subgrade);
    if (named !== undefined && !grades.includes(named)) grades.push(named);
  }

  const blocks = [];
  if (anchors.length && opts.includeAnchors) {
    blocks.push(
      (anchors.length > 1
        ? "CHARACTERS IN THIS SHOT:\n"
        : "CHARACTER IN THIS SHOT:\n") +
        anchors.map((a) => `- ${a}`).join("\n"),
    );
  }
  blocks.push(scene.prompt);
  const style = [s.style, ...grades]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (style) blocks.push(style);
  if (opts.appendFormat) {
    const d = s.defaults || {};
    const bits = [];
    const ratio = scene.aspect_ratio || d.aspect_ratio;
    const size = scene.image_size || d.image_size;
    if (ratio) bits.push(`Aspect ratio ${ratio}.`);
    if (size) bits.push(`Render at ${size}.`);
    if (bits.length) blocks.push(bits.join(" "));
  }
  return blocks.join("\n\n");
}

/* ------------------------------------------------------------- status card */

function card(kind, title, body, actions = []) {
  $("#card").className = "card " + kind;
  $("#cardTitle").textContent = title;
  $("#cardBody").textContent = body || "";
  const box = $("#cardActions");
  box.innerHTML = "";
  for (const a of actions) {
    const b = document.createElement("button");
    b.textContent = a.label;
    b.className = a.kind || "small";
    b.addEventListener("click", a.onClick);
    box.append(b);
  }
}

function isStale(state) {
  return state.running && state.beatAt && Date.now() - state.beatAt > STALE_MS;
}

async function forceReset() {
  const next = await chrome.runtime.sendMessage({ type: "FORCE_RESET" });
  lastState = next;
  paint();
}

function humanTime(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute left";
  if (m < 60) return `about ${m} min left`;
  return `about ${Math.floor(m / 60)}h ${m % 60}m left`;
}

/* ------------------------------------------------------------------- paint */

function paint() {
  const state = lastState || {};
  const running = state.running && !isStale(state);

  $("#progressBox").hidden = !running;
  $("#setupBox").hidden = !!running;

  /* --- status card ------------------------------------------------------ */
  if (isStale(state)) {
    card(
      "warn",
      "A previous run stopped unexpectedly",
      "The Flow tab was probably closed or reloaded mid-run. Reset to start again.",
      [{ label: "Reset", kind: "small", onClick: forceReset }],
    );
  } else if (running) {
    const label = state.paused ? "Paused" : state.phase || "Working";
    card(
      "busy",
      `${label} — ${state.current || "preparing"}`,
      state.paused
        ? "Nothing is being sent while paused."
        : "Leave this Flow tab visible. Closing it stops the run. " +
            "Chrome's “being debugged” banner is expected and clears when the run ends.",
    );
  } else if (state.blocked) {
    // Quota wall, page crash, and "can't find the button" each need a different
    // next step — offering the same buttons for all three helps nobody.
    const reason = state.blocked.reason || "";
    const crashed = /crashed|client-side exception/i.test(reason);
    const quota =
      !crashed && /quota|tomorrow|upgrade|credits|limit/i.test(reason);
    const sendIssue = /which control sends|generate button/i.test(reason);
    const boxIssue = /greyed out|type into/i.test(reason);

    let actions;
    if (crashed) {
      actions = [
        {
          label: "Reload Flow tab",
          onClick: async () => {
            const tab = await flowTab();
            if (tab) {
              await chrome.tabs.reload(tab.id);
              await forceReset();
              setTimeout(refresh, 2500);
            }
          },
        },
      ];
    } else if (quota) {
      actions = [{ label: "Dismiss", onClick: forceReset }];
    } else if (sendIssue) {
      actions = [
        {
          label: "Show me the generate button",
          onClick: () => teach("submitSelector"),
        },
      ];
    } else if (boxIssue) {
      actions = [
        {
          label: "Teach it by typing",
          onClick: async () => {
            await broadcast({ type: "WATCH_TYPING" });
            window.close();
          },
        },
      ];
    } else {
      actions = [
        {
          label: "Show me the prompt box",
          onClick: () => teach("promptSelector"),
        },
        { label: "Re-check", onClick: refresh },
      ];
    }
    card(
      "bad",
      quota ? "Flow stopped the run" : reason,
      state.blocked.hint || "",
      actions,
    );
  } else if (ready.status === "checking") {
    card("", "Checking the page…", "");
  } else if (ready.status === "no-tab") {
    card(
      "bad",
      "No Flow tab open",
      "Flow Batch works on labs.google/fx/tools/flow. Open Flow and sign in.",
      [
        {
          label: "Open Flow",
          kind: "small",
          onClick: () => chrome.tabs.create({ url: FLOW_TOOL }),
        },
      ],
    );
  } else if (ready.status === "no-script") {
    card(
      "warn",
      "Reload the Flow tab",
      "The extension was updated after this tab was opened, so it can't reach the page yet.",
      [
        {
          label: "Reload tab",
          kind: "small",
          onClick: async () => {
            const tab = await flowTab();
            if (tab) {
              await chrome.tabs.reload(tab.id);
              setTimeout(refresh, 2500);
            }
          },
        },
      ],
    );
  } else if (ready.status === "no-box") {
    card(
      "warn",
      "Can't find Flow's prompt box",
      "Open your Flow project so the prompt field is on screen, then re-check. If it still fails, point at it once.",
      [
        {
          label: "Show me the prompt box",
          onClick: () => teach("promptSelector"),
        },
        { label: "Re-check", onClick: refresh },
      ],
    );
  } else if (state.finishedAt && (state.log || []).length) {
    const errors = state.log.filter((l) => l.status === "error").length;
    card(
      errors ? "warn" : "ready",
      errors
        ? `Finished with ${errors} failed`
        : `Finished — ${state.log.length} images saved`,
      errors
        ? 'Use "Retry failed" below to run just those again.'
        : "Saved to Downloads › FlowBatch, with a run log.",
    );
  } else {
    const hint = ready.probe?.promptHint;
    card(
      "ready",
      "Ready",
      hint
        ? `Found Flow's prompt box (“${String(hint).slice(0, 42)}”).`
        : "Found Flow's prompt box.",
    );
  }

  /* --- progress --------------------------------------------------------- */
  if (running) {
    const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
    $("#barFill").style.width = pct + "%";
    $("#progressCount").textContent = `${state.done} of ${state.total} done`;
    if (state.done > 0 && state.startedAt) {
      const per = (Date.now() - state.startedAt) / state.done;
      $("#progressEta").textContent = humanTime(
        per * (state.total - state.done),
      );
    } else {
      $("#progressEta").textContent = "";
    }
    $("#pause").textContent = state.paused ? "Resume" : "Pause";
  }

  /* --- start buttons ---------------------------------------------------- */
  const canStart = !!spec && ready.status === "ready" && !running;
  $("#start").disabled = !canStart;
  $("#testOne").disabled = !canStart;
  if (spec) {
    const only = readOptions().only;
    const chosen = only ? spec.images.filter((i) => matchesOnly(i, only)) : spec.images;
    const n = chosen.length;
    const files = chosen.reduce((sum, im) => sum + outputIdsFor(im).length, 0);
    $("#start").textContent =
      files !== n
        ? `Start ${n} image${n === 1 ? "" : "s"} (${files} files)`
        : `Start all ${n} image${n === 1 ? "" : "s"}`;
  }

  /* --- results ---------------------------------------------------------- */
  const log = state.log || [];
  $("#resultsBox").hidden = !log.length;
  const failed = log.filter((l) => l.status === "error");
  $("#retryFailed").hidden = !failed.length || running;

  const list = $("#log");
  list.innerHTML = "";
  for (const entry of [...log].reverse()) {
    const li = document.createElement("li");
    li.className = entry.status;
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent =
      entry.status === "ok" ? "✓" : entry.status === "error" ? "✕" : "·";
    const id = document.createElement("span");
    id.className = "id";
    id.textContent = entry.sceneId;
    const msg = document.createElement("span");
    msg.className = "msg";
    // Resolution matters more than the filename: a silently-saved thumbnail
    // would otherwise look identical to a full-size render.
    msg.textContent =
      entry.error || entry.resolution || entry.filename || entry.status;
    if (/thumbnail only/i.test(entry.resolution || ""))
      li.classList.add("warn");
    msg.title = [entry.error, entry.hint, entry.resolution, entry.filename]
      .filter(Boolean)
      .join(" — ");
    li.append(tick, id, msg);
    list.append(li);
  }
}

/* ----------------------------------------------------------------- actions */

async function refresh() {
  ready = { status: "checking" };
  paint();
  await checkReadiness();
  const p = ready.probe;
  $("#probeOut").textContent = p
    ? `prompt box: ${p.promptBox || "not found"}\n` +
      `placeholder: ${p.promptHint || "—"}\n` +
      `generate:   ${p.submit || "not found (will press Enter)"}\n` +
      `frame:      ${p.isTop ? "main page" : p.url}\n` +
      `images now: ${p.images}\n` +
      `taught:     ${Object.keys(p.taught || {}).join(", ") || "nothing"}`
    : "Could not reach the page.";
  paint();
}

async function teach(target) {
  try {
    await broadcast({ type: "TEACH", target });
    window.close(); // the popup must close so the next click lands on the page
  } catch (err) {
    card("bad", "Couldn't start picking", String(err.message || err));
  }
}

async function startRun(overrideOnly) {
  if (!spec) return;
  const options = readOptions();
  if (overrideOnly) options.only = overrideOnly;
  try {
    const res = await toTarget({
      type: "START_RUN",
      payload: { spec, options },
    });
    if (!res?.ok)
      card(
        "bad",
        "Could not start",
        res?.error || "No response from the page.",
      );
  } catch (err) {
    card("bad", "Could not start", String(err.message || err));
  }
}

/* ------------------------------------------------------------------ wiring */

$("#reload").addEventListener("click", refresh);
$("#changeSpec").addEventListener("click", () => {
  const p = $("#specPanel");
  p.hidden = !p.hidden;
  $("#changeSpec").textContent = p.hidden ? "Change…" : "Done";
  renderSceneList();
});
$("#pickFile").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  $("#spec").value = text;
  applySpec(text);
});

// Re-parsing on every keystroke fights the typist; settle first.
let typingTimer = null;
$("#spec").addEventListener("input", (e) => {
  clearTimeout(typingTimer);
  const value = e.target.value;
  typingTimer = setTimeout(() => applySpec(value), 350);
});

const dropBox = $("#spec");
for (const type of ["dragenter", "dragover"]) {
  dropBox.addEventListener(type, (e) => {
    e.preventDefault();
    dropBox.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  dropBox.addEventListener(type, () => dropBox.classList.remove("dragging"));
}
dropBox.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const text = await file.text();
  dropBox.value = text;
  applySpec(text);
});

for (const id of [
  "includeAnchors",
  "appendFormat",
  "gapSec",
  "timeoutSec",
  "retries",
  "dryRun",
  "trustedInput",
  "saveLog",
  "only",
]) {
  $("#" + id).addEventListener("change", () => {
    saveOptions();
    paint();
  });
}

function closePreview() {
  $("#previewWrap").hidden = true;
  $("#preview").textContent = "Preview the first prompt";
}

$("#preview").addEventListener("click", () => {
  if (!spec) return;
  if (!$("#previewWrap").hidden) return closePreview();
  const opts = readOptions();
  const scene =
    (opts.only && spec.images.find((i) => matchesOnly(i, opts.only))) ||
    spec.images[0];
  $("#previewOut").textContent =
    `[${scene.id}]\n\n` + buildPrompt(scene, spec, opts);
  $("#previewWrap").hidden = false;
  $("#preview").textContent = "Hide preview";
});
$("#previewClose").addEventListener("click", closePreview);

$("#start").addEventListener("click", () => startRun(null));
$("#testOne").addEventListener("click", () => {
  if (!spec) return;
  startRun([spec.images[0].id]);
});
$("#retryFailed").addEventListener("click", () => {
  const failed = (lastState?.log || [])
    .filter((l) => l.status === "error")
    .map((l) => l.sceneId);
  if (failed.length) startRun(failed);
});
$("#openFolder").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "SHOW_IN_FOLDER" });
  if (!res?.ok) {
    const btn = $("#openFolder");
    btn.textContent = res?.error || "Nothing saved yet";
    setTimeout(() => {
      btn.textContent = "Open folder";
    }, 2500);
  }
});

$("#clearLog").addEventListener("click", async () => {
  lastState = await chrome.runtime.sendMessage({ type: "CLEAR_LOG" });
  paint();
});

/* Pause and Stop go to *every* frame, never just the one detection currently
 * favours. The popup re-picks the best frame each time it opens, so targeting
 * a single frame meant Stop could be sent to a frame that isn't running. */
$("#pause").addEventListener("click", async () => {
  const paused = !lastState?.paused;
  await broadcast({ type: "PAUSE_RUN", paused });
  lastState = await chrome.runtime.sendMessage({
    type: "PATCH_STATE",
    patch: { paused },
  });
  paint();
});

$("#stop").addEventListener("click", async () => {
  const btn = $("#stop");
  btn.disabled = true;
  btn.textContent = "Stopping…";
  await broadcast({ type: "STOP_RUN" });

  // If nothing acknowledges — frame gone, page navigated, script wedged — clear
  // the state anyway. Stop must never be a button that does nothing.
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const s = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (!s.running) break;
  }
  const s = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (s.running) await forceReset();

  btn.disabled = false;
  btn.textContent = "Stop";
  paint();
});

for (const btn of document.querySelectorAll("[data-teach]")) {
  btn.addEventListener("click", () => teach(btn.dataset.teach));
}

// The most reliable teacher is a real keystroke — it reveals which element the
// app listens to, which clicking alone cannot.
$("#watchTyping").addEventListener("click", async () => {
  try {
    await broadcast({ type: "WATCH_TYPING" });
    window.close();
  } catch (err) {
    card("bad", "Couldn't start watching", String(err.message || err));
  }
});
// I can't load a signed-in Flow URL from outside the browser, so the extension
// reports what it sees from inside the session instead.
$("#copyDiag").addEventListener("click", async () => {
  const btn = $("#copyDiag");
  try {
    const tab = await flowTab();
    if (!tab) throw new Error("Open a Flow tab first.");
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () =>
        window.__flowBatchDiagnostics ? window.__flowBatchDiagnostics() : null,
    });
    const frames = results.filter((r) => r.result).map((r) => r.result);
    const failures = (lastState?.log || [])
      .filter((l) => l.status === "error")
      .map((l) => ({ scene: l.sceneId, error: l.error }));
    const text =
      "```json\n" +
      JSON.stringify({ frames, recentFailures: failures.slice(-8) }, null, 2) +
      "\n```";
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied — paste it into chat";
    setTimeout(() => {
      btn.textContent = "Copy diagnostics";
    }, 2500);
  } catch (err) {
    btn.textContent = String(err.message || err);
    setTimeout(() => {
      btn.textContent = "Copy diagnostics";
    }, 2500);
  }
});

$("#clearTaught").addEventListener("click", async () => {
  await chrome.storage.local.set({ taught: {} });
  await broadcast({ type: "CLEAR_TAUGHT" });
  refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATE_CHANGED") {
    lastState = msg.state;
    paint();
  }
});

(async function init() {
  const { lastSpec, options } = await chrome.storage.local.get([
    "lastSpec",
    "options",
  ]);
  restoreOptions(options);
  lastState = await chrome.runtime.sendMessage({ type: "GET_STATE" });

  if (lastSpec) {
    $("#spec").value = lastSpec;
    applySpec(lastSpec, { persist: false });
  } else {
    // Nothing ships with the extension any more — the panel opens so the first
    // thing you see is where to put your own prompts.
    $("#specPanel").hidden = false;
    $("#changeSpec").textContent = "Done";
    applySpec("");
  }

  await refresh();
  setInterval(paint, 1000); // keeps the ETA and stale check live
  setInterval(() => {
    if (!lastState?.running) refresh();
  }, 5000);
})();
