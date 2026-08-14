/* content.js — drives the Flow page one scene at a time.
 *
 * Runs in every frame. Only the frame that actually contains the prompt box
 * ever receives START_RUN; the popup picks it via window.__flowBatchProbe().
 *
 * Design rule: never stall silently. Every wait has a deadline and every
 * failure produces a sentence a non-developer can act on.
 */

(() => {
  if (window.__flowBatchLoaded) return;
  window.__flowBatchLoaded = true;

  const VERSION = "2.9.0";
  const SETTLE_MS = 1500; // an image URL must hold still this long
  const POLL_MS = 500;
  const MIN_IMAGE_PX = 400; // ignore avatars, icons, spinners
  const TYPE_VERIFY_MS = 1200; // grace period for the editor to accept text

  const run = { active: false, stop: false, paused: false, phase: null };
  let taught = {};
  let lastSubmitReport = ""; // what submitPrompt tried, for the timeout message

  /* ------------------------------------------------------------------ util */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

  class Aborted extends Error {}
  class Friendly extends Error {
    constructor(message, hint) {
      super(message);
      this.hint = hint;
    }
  }

  async function guard() {
    while (run.paused && !run.stop) await sleep(300);
    if (run.stop) throw new Aborted("stopped");
  }

  function setPhase(phase) {
    run.phase = phase;
    send({ type: "PHASE", phase });
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return (
      s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"
    );
  }

  /* Walks light DOM *and* open shadow roots — Flow nests controls in web
   * components, so a plain querySelectorAll misses the prompt box entirely. */
  function deepQuery(selector, root = document) {
    const out = [];
    const walk = (node) => {
      if (!node) return;
      try {
        out.push(...node.querySelectorAll(selector));
      } catch (_) {}
      const all = node.querySelectorAll ? node.querySelectorAll("*") : [];
      for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(root);
    return out;
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      if (node.id && /^[a-zA-Z][\w-]*$/.test(node.id)) {
        parts.unshift(`#${node.id}`);
        break;
      }
      let sel = node.tagName.toLowerCase();
      const stable = [
        "data-testid",
        "aria-label",
        "name",
        "placeholder",
        "role",
      ];
      const attr = stable.find((a) => node.getAttribute(a));
      if (attr) {
        sel += `[${attr}="${node.getAttribute(attr).replace(/["\\]/g, "\\$&")}"]`;
        parts.unshift(sel);
        break;
      }
      const sibs = node.parentElement
        ? [...node.parentElement.children].filter(
            (c) => c.tagName === node.tagName,
          )
        : [];
      if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  /* -------------------------------------------------------- finding things */

  function scorePromptBox(el) {
    const r = el.getBoundingClientRect();
    const hint = [
      el.getAttribute("placeholder"),
      el.getAttribute("aria-label"),
      el.getAttribute("data-placeholder"),
      el.getAttribute("title"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    let score = 0;
    // Flow's box says "What do you want to create?"; other builds say "prompt".
    if (
      /create|prompt|describe|imagine|generate|idea|scene|type|ask/.test(hint)
    )
      score += 60;
    // An editor library marker is far stronger evidence than any text hint —
    // Flow's box carries no placeholder or aria-label at all.
    if (richEditorRoot(el) === el) score += 70;
    if (el.getAttribute?.("role") === "textbox") score += 20;
    // Declaring contenteditable marks the editor root. Merely inheriting it
    // marks an inner node, which must never be chosen.
    if (declaresEditable(el) || el.tagName === "TEXTAREA") score += 30;
    else if (el.isContentEditable) score -= 40;
    // Composer boxes sit low in the viewport with a send control beside them.
    if (r.top > innerHeight * 0.45) score += 25;
    // The send control starts disabled, so it must be looked for regardless.
    if (sendButtonCandidates(el, { ignoreDisabled: true })[0]) score += 40;
    if (el.disabled || el.readOnly) score -= 100;
    if (el.closest('[role="dialog"][aria-hidden="true"]')) score -= 100;
    score += Math.min(20, (r.width * r.height) / 12000);
    return score;
  }

  function buttonLabel(b) {
    return [
      b.textContent,
      b.getAttribute("aria-label"),
      b.title,
      b.getAttribute("data-testid"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  /* A composer row has several buttons and only one of them submits. Taking the
   * first keyword match picked Flow's "+" add-media button, which opened the
   * asset picker instead of generating. Score them and take the best. */
  function isDisabled(b) {
    return !!b.disabled || b.getAttribute("aria-disabled") === "true";
  }

  function scoreSendButton(b, { ignoreDisabled = false } = {}) {
    const t = buttonLabel(b);
    let score = 0;
    if (/^(send|generate|submit|run|go)$/.test(t)) score += 100;
    if (/send|submit|arrow_forward|arrow_upward|arrow right|arrow up/.test(t))
      score += 60;
    if (/generate|create/.test(t)) score += 25;
    // Everything that is emphatically not the submit control. "stop" matters
    // most: while Flow is generating, the send arrow *becomes* a stop button in
    // the same place, and clicking it would cancel the image being made.
    if (
      /stop|abort|pause|add|upload|attach|media|asset|file|image|photo|plus|setting|option|tune|slider|mic|voice|model|aspect|ratio|close|cancel|delete|menu|expand|enhance|magic/.test(
        t,
      )
    ) {
      score -= 150;
    }
    if (!ignoreDisabled && isDisabled(b)) score -= 200;
    // Send controls sit at the right-hand end of the row.
    score += Math.min(15, b.getBoundingClientRect().left / 150);
    return score;
  }

  function sendButtonCandidates(el, opts) {
    let scope = el;
    for (let i = 0; i < 5 && scope; i++) {
      // Never ascend to body: at that point "nearby" is the whole page, and any
      // button anywhere becomes a candidate. Better to find nothing and ask.
      if (scope === document.body || scope === document.documentElement) break;
      const buttons = [
        ...(scope.querySelectorAll?.('button, [role="button"]') || []),
      ].filter(visible);
      const ranked = buttons
        .map((b) => ({ b, score: scoreSendButton(b, opts) }))
        .filter((x) => x.score > 0)
        .sort((a, x) => x.score - a.score);
      if (ranked.length) return ranked.map((x) => x.b);
      scope = scope.parentElement;
    }
    return [];
  }

  function nearbySendButton(el) {
    return sendButtonCandidates(el)[0] || null;
  }

  /* Flow swaps the send arrow for a stop button while an image is generating,
   * so the presence of a stop control is a reliable "still busy" signal — and
   * the reason a second prompt must not be sent yet. */
  const STOP_LABEL = /(^|\W)(stop|cancel|abort)/;

  function composerButtons(el) {
    let scope = el;
    for (let i = 0; i < 5 && scope; i++) {
      if (scope === document.body || scope === document.documentElement) break;
      const buttons = [
        ...(scope.querySelectorAll?.('button, [role="button"]') || []),
      ].filter(visible);
      if (buttons.length) return buttons;
      scope = scope.parentElement;
    }
    return [];
  }

  function composerBusy(promptBox) {
    return composerButtons(promptBox).some((b) =>
      STOP_LABEL.test(buttonLabel(b)),
    );
  }

  /* Between scenes, wait for the previous generation to finish rather than
   * charging in — otherwise the only control present is Stop. */
  async function waitForComposerIdle(promptBox, timeoutMs) {
    if (!composerBusy(promptBox)) return true;
    const started = Date.now();
    setPhase("waiting for the previous image");
    while (Date.now() - started < timeoutMs) {
      await guard();
      await sleep(1000);
      if (!composerBusy(promptBox)) {
        await sleep(600); // let the composer settle back to its idle state
        return true;
      }
    }
    return false;
  }

  /* The send control while it is still greyed out. Flow disables it until its
   * editor state holds text, which makes it the honest signal that typing
   * actually registered — DOM text alone can be a lie. */
  function sendGate(promptBox) {
    if (taught.submitSelector) {
      const el =
        deepQuery(taught.submitSelector)[0] ||
        document.querySelector(taught.submitSelector);
      if (el && visible(el)) return el;
    }
    return sendButtonCandidates(promptBox, { ignoreDisabled: true })[0] || null;
  }

  /* Flow's composer is Slate:
   *   <div role="textbox" aria-multiline="true" data-slate-editor="true"
   *        data-slate-node="value" contenteditable="true">
   * with no placeholder and no aria-label — the visible "What do you want to
   * create?" is a separate overlay element. Editors like this keep their own
   * document model and ignore the DOM, so they must be driven by events they
   * choose to handle, never by writing text in. */
  const RICH_EDITOR_SELECTOR = [
    "[data-slate-editor]",
    '[data-slate-node="value"]',
    "[data-lexical-editor]",
    ".ProseMirror",
    ".DraftEditor-root",
    ".public-DraftEditor-content",
    ".ql-editor",
    ".cm-content",
  ].join(",");

  function richEditorRoot(el) {
    if (!el?.closest) return null;
    return el.closest(RICH_EDITOR_SELECTOR);
  }

  function declaresEditable(el) {
    const v = el?.getAttribute?.("contenteditable");
    return v === "" || v === "true" || v === "plaintext-only";
  }

  /* THE important one.
   *
   * `isContentEditable` is inherited: every descendant of an editable region
   * reports true. Trusting it meant picking some inner node inside Flow's
   * editor and inserting text there. The text appears, but the editor never
   * authored those nodes, so its model desyncs — the send button never enables,
   * backspace stops working, and the next update throws and takes the app down.
   *
   * Only the element that *declares* contenteditable is the editor root, and
   * the outermost such element is the one the editor owns. */
  function editableRoot(el) {
    let root = null;
    for (
      let n = el;
      n && n !== document.body && n !== document.documentElement;
      n = n.parentElement
    ) {
      if (declaresEditable(n)) root = n;
    }
    return root;
  }

  function resolveEditable(el) {
    if (!el) return el;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el;

    // Already inside an editable region: use that region's root.
    const up = editableRoot(el);
    if (up) return up;

    // Otherwise it's a wrapper — the real field is somewhere beneath it.
    const down = el.querySelector?.(
      '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], textarea, input',
    );
    return down ? editableRoot(down) || down : el;
  }

  function findPromptBox() {
    if (taught.promptSelector) {
      const el =
        deepQuery(taught.promptSelector)[0] ||
        document.querySelector(taught.promptSelector);
      if (visible(el)) return el;
    }
    const raw = deepQuery(
      'textarea, input[type="text"], [role="textbox"],' +
        '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
    ).filter(visible);

    // Collapse every candidate to its editor root first, so an inner node can
    // never win — inserting into one corrupts the editor.
    const seen = new Set();
    const candidates = [];
    for (const el of raw) {
      const root = resolveEditable(el);
      if (root && !seen.has(root) && visible(root)) {
        seen.add(root);
        candidates.push(root);
      }
    }
    if (!candidates.length) return null;
    return candidates
      .map((el) => ({ el, score: scorePromptBox(el) }))
      .sort((a, b) => b.score - a.score)[0].el;
  }

  function findSubmitButton(promptBox) {
    if (taught.submitSelector) {
      const el =
        deepQuery(taught.submitSelector)[0] ||
        document.querySelector(taught.submitSelector);
      if (visible(el)) return el;
    }
    const near = nearbySendButton(promptBox);
    if (near && visible(near) && !near.disabled) return near;

    let scope = promptBox;
    for (let i = 0; i < 6 && scope; i++) {
      const buttons = [
        ...(scope.querySelectorAll?.('button, [role="button"]') || []),
      ].filter(
        (b) =>
          visible(b) &&
          !b.disabled &&
          b.getAttribute("aria-disabled") !== "true",
      );
      if (buttons.length && i >= 2) return buttons[buttons.length - 1];
      scope = scope.parentElement;
    }
    return null;
  }

  function resultScope() {
    if (taught.resultSelector) {
      const el =
        deepQuery(taught.resultSelector)[0] ||
        document.querySelector(taught.resultSelector);
      if (el) return el;
    }
    return document;
  }

  /* Flow labels its results exactly: <img alt="Generated image" src=".../
   * media.getMediaUrlRedirect?...">. That is a far better signal than guessing
   * from pixel size, and it excludes the avatar (alt="User profile image")
   * and the suggestion-card artwork without any heuristics at all. */
  const GENERATED_SELECTOR = 'img[alt="Generated image" i]';
  const NOT_A_RESULT = /profile|avatar|user|icon|logo|thumbnail preview/i;

  function isGenerated(img) {
    const alt = img.getAttribute("alt") || "";
    if (NOT_A_RESULT.test(alt)) return false;
    return /generated/i.test(alt);
  }

  function collectImageUrls() {
    const scope = resultScope();
    const urls = new Set();

    // Prefer the labelled results; only fall back to guessing if Flow renames
    // things in a future release.
    const labelled = deepQuery(GENERATED_SELECTOR, scope);
    if (labelled.length) {
      for (const img of labelled) {
        const src = img.currentSrc || img.src;
        if (src && !src.startsWith("data:image/svg")) urls.add(src);
      }
      return [...urls];
    }

    for (const img of deepQuery("img", scope)) {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith("data:image/svg")) continue;
      if (NOT_A_RESULT.test(img.getAttribute("alt") || "")) continue;
      const w = img.naturalWidth || img.width,
        h = img.naturalHeight || img.height;
      if (w && h && (w < MIN_IMAGE_PX || h < MIN_IMAGE_PX)) continue;
      if (/favicon|avatar|\/s\d{1,2}(-c)?\//.test(src)) continue;
      urls.add(src);
    }
    for (const el of deepQuery('[style*="background-image"]', scope)) {
      const m = getComputedStyle(el).backgroundImage.match(
        /url\(["']?(.+?)["']?\)/,
      );
      if (m && !m[1].startsWith("data:image/svg")) {
        const r = el.getBoundingClientRect();
        if (r.width >= MIN_IMAGE_PX && r.height >= MIN_IMAGE_PX) urls.add(m[1]);
      }
    }
    for (const v of deepQuery("video[poster]", scope)) urls.add(v.poster);
    return [...urls];
  }

  /* --------------------------------------------------------------- driving */

  function readBack(el) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)
      return el.value || "";
    return el.innerText || el.textContent || "";
  }

  function selectAll(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* ------------------------------------------------------- trusted input */

  /* Synthetic events carry isTrusted:false and an app may simply ignore them —
   * which is what Flow appears to do with the send button. These go through
   * chrome.debugger in the service worker, so the browser itself generates
   * them and they are indistinguishable from a real mouse and keyboard. */
  const trusted = {
    available: false,

    async enable() {
      const res = await chrome.runtime
        .sendMessage({ type: "TRUSTED_ATTACH" })
        .catch(() => null);
      trusted.available = !!res?.ok;
      if (!trusted.available && res?.error) trusted.lastError = res.error;
      return trusted.available;
    },

    async disable() {
      trusted.available = false;
      await chrome.runtime
        .sendMessage({ type: "TRUSTED_DETACH" })
        .catch(() => {});
    },

    async gesture(payload) {
      if (!trusted.available) return false;
      const res = await chrome.runtime
        .sendMessage({ type: "TRUSTED_GESTURE", ...payload })
        .catch(() => null);
      if (!res?.ok) trusted.lastError = res?.error || "no response";
      return !!res?.ok;
    },

    /* CDP wants viewport coordinates, which is exactly what
     * getBoundingClientRect reports — but the element has to be on screen. */
    async clickElement(el) {
      try {
        el.scrollIntoView?.({ block: "center", inline: "center" });
      } catch (_) {}
      await sleep(120);
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
      return trusted.gesture({ gesture: "click", x, y });
    },

    async typeInto(el, text) {
      if (!(await trusted.clickElement(el))) return false;
      await sleep(80);
      await trusted.gesture({ gesture: "selectAll" });
      // Input.insertText is the path the browser uses for paste and IME, so a
      // rich editor receives it as genuine composition.
      return trusted.gesture({ gesture: "insertText", text });
    },
  };

  function makeTransfer(text) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    return dt;
  }

  /* Slate tracks its own selection and refuses to insert when it has none.
   * It learns the selection from focus and the browser's selectionchange, so
   * this has to happen — and settle — before any insert is attempted. */
  async function focusEditor(el) {
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      try {
        el.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
          }),
        );
      } catch (_) {
        el.dispatchEvent(new Event(type, { bubbles: true }));
      }
    }
    el.focus();
    selectAll(el);
    document.dispatchEvent(new Event("selectionchange"));
    await sleep(80);
  }

  /* Events a rich editor may claim. If it claims one it calls preventDefault,
   * which dispatchEvent reports — so we learn whether it worked rather than
   * guessing. If it claims none, nothing at all happens to the DOM, which is
   * why this path cannot corrupt the editor the way writing text in did. */
  const RICH_STRATEGIES = [
    function pasteEvent(el, text) {
      const dt = makeTransfer(text);
      const ev = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      if (!ev.clipboardData) {
        try {
          Object.defineProperty(ev, "clipboardData", { value: dt });
        } catch (_) {}
      }
      el.dispatchEvent(ev);
    },

    function beforeInputPaste(el, text) {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertFromPaste",
          dataTransfer: makeTransfer(text),
          bubbles: true,
          cancelable: true,
        }),
      );
    },

    function beforeInputText(el, text) {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data: text,
          bubbles: true,
          cancelable: true,
        }),
      );
      el.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertText",
          data: text,
          bubbles: true,
        }),
      );
    },
  ];

  /* Clearing a rich editor must go through the editor too. If it ignores the
   * request nothing happens, which is the safe outcome. */
  function clearRich(el) {
    selectAll(el);
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "deleteContentBackward",
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  /* Four ways to put text into a box, tried in order. There is no single
   * technique that works across plain textareas, contenteditable divs and
   * framework editors (Lexical/ProseMirror/Quill), and picking the wrong one
   * throws "Illegal invocation" — a native setter called on the wrong element. */
  const TYPE_STRATEGIES = [
    function nativeValue(el, text) {
      // Only valid for real form controls. Anything else must not reach here.
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : null;
      if (!proto) throw new Error("not a form control");
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(el, text);
      // React dedupes by comparing against its own tracked value; without this
      // it decides nothing changed and never updates state.
      if (el._valueTracker) el._valueTracker.setValue("");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },

    // The one that produces genuine browser input events, so Lexical /
    // ProseMirror / Draft update their internal state rather than just the DOM.
    function execCommand(el, text) {
      selectAll(el);
      if (!document.execCommand("insertText", false, text))
        throw new Error("execCommand refused");
    },

    /* Some composers only wake up on a keystroke — they enable their send
     * button from a keydown/keyup handler rather than from input events. Lead
     * with one real key, insert the rest, then close with the matching keyup. */
    function keystrokeThenInsert(el, text) {
      const first = text[0];
      const key = (type) =>
        el.dispatchEvent(
          new KeyboardEvent(type, {
            key: first,
            code: "Key" + first.toUpperCase(),
            charCode: first.charCodeAt(0),
            keyCode: first.charCodeAt(0),
            which: first.charCodeAt(0),
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
      selectAll(el);
      key("keydown");
      key("keypress");
      if (!document.execCommand("insertText", false, text))
        throw new Error("execCommand refused");
      key("keyup");
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },

    // Rich editors nearly always implement a paste handler even when they
    // ignore direct DOM mutation.
    function paste(el, text) {
      selectAll(el);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      // Some engines leave clipboardData null from the constructor; only patch
      // it when that happened, or defineProperty throws on a sealed property.
      if (!ev.clipboardData) {
        try {
          Object.defineProperty(ev, "clipboardData", { value: dt });
        } catch (_) {}
      }
      el.dispatchEvent(ev);
    },

    // Ask the editor to insert, rather than inserting behind its back.
    // dataTransfer is optional for insertText — requiring it would rule this
    // strategy out anywhere DataTransfer is unavailable.
    function beforeInput(el, text) {
      selectAll(el);
      const init = {
        inputType: "insertText",
        data: text,
        bubbles: true,
        cancelable: true,
      };
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        init.dataTransfer = dt;
      } catch (_) {
        /* fine — data alone is enough for insertText */
      }
      el.dispatchEvent(new InputEvent("beforeinput", init));
      el.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertText",
          data: text,
          bubbles: true,
        }),
      );
    },

    /* There is deliberately no `el.textContent = text` strategy.
     *
     * Writing straight into a rich editor's DOM replaces the nodes its
     * reconciler is tracking; the next update finds a tree it doesn't
     * recognise and throws, which unmounts the whole app — that is the
     * "Application error: a client-side exception has occurred" crash.
     * Every strategy above asks the editor to insert the text instead. */
  ];

  /* Types, then confirms the text actually landed. Without this the runner
   * submits nothing and waits out the full timeout for an image that was never
   * requested — which is exactly how a run appears to hang. */
  /* Success is judged by Flow's own send button switching from greyed-out to
   * enabled. Checking only that the text is visible was the trap: the
   * textContent fallback sets the DOM directly, so it always "passed" while
   * Flow's editor state stayed empty and the arrow stayed dead. */
  /* Flow's crash screen replaces the entire app, so this is cheap and reliable. */
  function pageCrashed() {
    const t = (document.body?.innerText || "").slice(0, 3000);
    return /application error:|client-side exception has occurred/i.test(t);
  }

  function crashError(during) {
    const err = new Friendly(
      "The Flow page crashed.",
      `It broke while ${during}. Reload the Flow tab and start again — anything already downloaded is safe.`,
    );
    err.fatal = true;
    return err;
  }

  async function typePrompt(promptBox, text) {
    const el = resolveEditable(promptBox);
    const want = Math.min(40, text.length);
    const tried = [];
    if (pageCrashed()) throw crashError("loading, before anything was typed");

    // A managed editor gets only the event-based path. execCommand and native
    // setters would edit the DOM under it, which desyncs its model — that is
    // what left the box frozen and eventually crashed the page.
    const rich = richEditorRoot(el);
    const strategies = rich ? RICH_STRATEGIES : TYPE_STRATEGIES;

    const gate = sendGate(promptBox);
    const gateWasOff = gate ? isDisabled(gate) : false;
    const accepted = () => {
      // For a managed editor the button is the only honest signal: its model
      // may hold the text long before the DOM shows it, or vice versa.
      if (gateWasOff) return !isDisabled(gate);
      return readBack(el).trim().length >= want;
    };

    // Real keyboard input first — nothing synthetic can be rejected if the
    // browser itself is doing the typing.
    if (trusted.available) {
      try {
        if (await trusted.typeInto(el, text)) {
          const deadline = Date.now() + TYPE_VERIFY_MS + 800;
          while (Date.now() < deadline) {
            if (accepted()) return "trusted";
            await sleep(100);
          }
        }
        tried.push("trusted input: not accepted");
      } catch (err) {
        tried.push(`trusted input: ${err.message}`);
      }
    }

    for (const strategy of strategies) {
      try {
        await focusEditor(el);
        strategy(el, text);
      } catch (err) {
        tried.push(`${strategy.name}: ${err.message}`);
        continue;
      }
      // Stop the moment the page dies, and name the step that killed it rather
      // than continuing to poke at a broken app.
      if (pageCrashed())
        throw crashError(`trying to type using "${strategy.name}"`);

      const deadline = Date.now() + TYPE_VERIFY_MS;
      while (Date.now() < deadline) {
        if (accepted()) return strategy.name;
        await sleep(100);
      }
      tried.push(
        readBack(el).trim().length >= want
          ? `${strategy.name}: text shown but send stayed disabled`
          : `${strategy.name}: editor ignored it`,
      );

      // Clear the rejected attempt so the next strategy starts from empty.
      try {
        el.focus();
        if (rich) clearRich(el);
        else {
          selectAll(el);
          document.execCommand("delete");
        }
      } catch (_) {
        /* nothing safe to do; the next strategy selects all anyway */
      }
      if (pageCrashed())
        throw crashError(`clearing the box after "${strategy.name}"`);
    }

    const shown = readBack(el).trim().length >= want;
    throw new Friendly(
      shown
        ? "Flow's send button stayed greyed out."
        : "Couldn't type into Flow's prompt box.",
      (shown
        ? "The text appears in the box but Flow never registered it, so it stays greyed out — " +
          "which usually means this is not the element Flow is listening to. "
        : "") +
        'Use "Teach it by typing": click that, then type a few letters into Flow\'s prompt box ' +
        "yourself. It will learn exactly which element to use. " +
        `Tried — ${tried.join("; ")}`,
    );
  }

  function pressEnter(el, withCtrl) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
          ctrlKey: !!withCtrl,
          metaKey: !!withCtrl,
        }),
      );
    }
  }

  /* `.click()` fires exactly one event. Real buttons in React apps frequently
   * act on pointerdown or mousedown instead, so a lone click lands on nothing.
   * This reproduces the full sequence a mouse produces, at the element's own
   * coordinates, including the focus change a real press causes. */
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
      detail: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };

    const fire = (Ctor, type, extra) => {
      const init = { ...base, ...extra };
      try {
        el.dispatchEvent(new Ctor(type, init));
      } catch (_) {
        try {
          el.dispatchEvent(new MouseEvent(type, init));
        } catch (__) {
          el.dispatchEvent(new Event(type, { bubbles: true }));
        }
      }
    };
    const Pointer =
      typeof PointerEvent === "function" ? PointerEvent : MouseEvent;

    fire(Pointer, "pointerover");
    fire(MouseEvent, "mouseover");
    fire(MouseEvent, "mousemove");
    fire(Pointer, "pointerdown");
    fire(MouseEvent, "mousedown");
    try {
      el.focus();
    } catch (_) {}
    fire(Pointer, "pointerup", { buttons: 0 });
    fire(MouseEvent, "mouseup", { buttons: 0 });
    fire(MouseEvent, "click", { buttons: 0 });
    // Belt and braces: the native path too, in case the app only binds onClick.
    try {
      el.click();
    } catch (_) {}
  }

  function dismissOverlay() {
    // A wrong click can open a picker or menu that covers the composer. Close it
    // so the next attempt isn't clicking into a modal.
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      }),
    );
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  /* "Did it send?" cannot rely on the DOM alone. A managed editor empties its
   * own model on submit without necessarily changing the text we can read, but
   * the send button goes back to disabled — so watch both. */
  function makeSentCheck(promptBox) {
    const before = readBack(promptBox).trim();
    const gate = sendGate(promptBox);
    const gateWasOn = gate ? !isDisabled(gate) : false;
    return () =>
      // A stop button appearing is the clearest possible proof: Flow only shows
      // one while it is generating, which it only does once a prompt is in.
      composerBusy(promptBox) ||
      readBack(promptBox).trim() !== before ||
      (gateWasOn && gate && isDisabled(gate));
  }

  async function sentWithin(sent, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (sent()) return true;
      await sleep(200);
    }
    return false;
  }

  // Below this, a button is a guess rather than a find, and guessing is how the
  // Flow page got crashed: clicking arbitrary controls in a React app can throw
  // an exception that unmounts the whole thing.
  const CONFIDENT_SEND = 60;

  /* Order matters, and it is chosen by blast radius rather than likelihood:
   *   1. a button the user pointed at   — verified, safe
   *   2. Enter / Ctrl+Enter             — inert if wrong, and chat composers submit on it
   *   3. exactly one high-confidence button
   * Never more than one button, never a low-confidence one. */
  async function submitPrompt(promptBox) {
    const sent = makeSentCheck(promptBox);
    const tried = [];

    /* Every fallback re-checks first, and the windows are generous.
     *
     * The previous version clicked, waited three seconds, and on no
     * confirmation clicked again — then clicked the icon. Flow can take longer
     * than that to clear the box and show its stop button, so a submit that
     * had worked was followed by a second and sometimes a third, and the same
     * prompt generated two or three times. Slow confirmation is not the same
     * as failure. */
    const landed = () => sent() || composerBusy(promptBox);

    async function attempt(label, action, waitMs) {
      if (landed()) return true; // an earlier attempt arrived late
      await action();
      if (await sentWithin(landed, waitMs)) return true;
      tried.push(label);
      return false;
    }

    const taughtBtn = taught.submitSelector
      ? deepQuery(taught.submitSelector)[0] ||
        document.querySelector(taught.submitSelector)
      : null;
    if (taughtBtn && visible(taughtBtn)) {
      if (
        await attempt(
          `taught button (${buttonLabel(taughtBtn) || "unlabelled"})`,
          () => realClick(taughtBtn),
          9000,
        )
      )
        return true;
    }

    /* The button comes before Enter here. Flow's box is aria-multiline, so
     * Enter inserts a line break rather than sending — it would quietly mangle
     * the prompt. Only an enabled, high-confidence button is ever clicked. */
    const best = sendButtonCandidates(promptBox)[0];
    const score = best ? scoreSendButton(best) : -1;

    if (best && score >= CONFIDENT_SEND) {
      const label = buttonLabel(best) || "(unlabelled)";
      // A real click is the one most likely to have worked, so it gets the
      // longest grace period before anything else is tried.
      if (trusted.available) {
        if (
          await attempt(
            `${label} (real click)`,
            () => trusted.clickElement(best),
            12000,
          )
        )
          return true;
      }
      if (
        await attempt(
          `${label} (pointer sequence)`,
          () => realClick(best),
          8000,
        )
      )
        return true;

      // Some designs bind the handler to the icon rather than the button.
      const icon = best.querySelector('i, svg, span:not([style*="absolute"])');
      if (icon && visible(icon)) {
        if (await attempt("its icon", () => realClick(icon), 6000)) return true;
      }
    }

    if (promptBox.getAttribute?.("aria-multiline") !== "true") {
      if (await attempt("Enter", () => pressEnter(promptBox, false), 5000))
        return true;
    }

    if (
      await attempt(
        "Ctrl/Cmd+Enter",
        () => {
          try {
            promptBox.focus();
          } catch (_) {}
          pressEnter(promptBox, true);
        },
        5000,
      )
    )
      return true;

    if (!(best && score >= CONFIDENT_SEND)) {
      // Refuse to poke at random controls. Ask instead.
      throw new Friendly(
        "Not sure which control sends the prompt.",
        "Enter didn't submit, and no button is clearly the send control" +
          (best ? ` (best guess: “${buttonLabel(best).slice(0, 30)}”)` : "") +
          '. Click "Show me the generate button" and pick the arrow beside the prompt box — ' +
          "I'll use only that from then on.",
      );
    }

    // Unconfirmed rather than failed: some builds keep the text after sending,
    // so let the image wait be the judge — but record what was tried.
    lastSubmitReport = tried.join(", ");
    return false;
  }

  /* Messages Flow shows instead of an image. Anything matching FATAL means every
   * remaining scene would fail the same way, so the run stops rather than
   * burning the timeout sixty times over. */
  const FATAL_PATTERNS = [
    /reached your[\s\S]{0,24}quota/i,
    /come back tomorrow/i,
    /upgrade to chat more/i,
    /out of (credits|generations)/i,
    /(daily|monthly) limit/i,
    // Flow itself has fallen over; nothing will work until the tab is reloaded.
    /application error:.{0,40}client-side exception/i,
    /client-side exception has occurred/i,
  ];
  const RETRY_PATTERNS = [
    /something went wrong/i,
    /try again/i,
    /rate limit/i,
    /couldn'?t generate/i,
    /failed to generate/i,
    /blocked|violat|policy/i,
  ];

  /* Watches the page from the moment a prompt is submitted. Using insertion
   * order rather than document order matters: Flow prepends new results into a
   * grid full of older images, so "last in the DOM" is the wrong image. */
  function createWatcher() {
    const seen = new Set(collectImageUrls());
    const w = { images: [], error: null, fatal: false };

    const consider = (img) => {
      const take = () => {
        const src = img.currentSrc || img.src;
        if (!src || seen.has(src) || src.startsWith("data:image/svg")) return;
        if (NOT_A_RESULT.test(img.getAttribute("alt") || "")) return;
        // A labelled result is trusted regardless of its rendered size.
        if (!isGenerated(img)) {
          if (/favicon|avatar|\/s\d{1,2}(-c)?\//.test(src)) return;
          const wpx = img.naturalWidth || img.width,
            hpx = img.naturalHeight || img.height;
          if (wpx < MIN_IMAGE_PX || hpx < MIN_IMAGE_PX) return;
        }
        seen.add(src);
        w.images.push(src);
      };
      if (img.complete && (img.naturalWidth || 0) > 0) take();
      else img.addEventListener("load", take, { once: true });
    };

    const checkText = (text) => {
      if (w.error || !text || text.length > 400) return;
      const clean = text.replace(/\s+/g, " ").trim();
      if (FATAL_PATTERNS.some((p) => p.test(clean))) {
        w.error = clean.slice(0, 160);
        w.fatal = true;
      } else if (RETRY_PATTERNS.some((p) => p.test(clean)))
        w.error = clean.slice(0, 160);
    };

    // Results don't always arrive as <img>. Flow's media grid paints them as
    // CSS background images, which an img-only watcher never sees — that alone
    // is enough to hang a run until it times out.
    const considerBackground = (el) => {
      let bg;
      try {
        bg = getComputedStyle(el).backgroundImage;
      } catch (_) {
        return;
      }
      if (!bg || bg === "none") return;
      const m = bg.match(/url\(["']?(.+?)["']?\)/);
      if (!m || seen.has(m[1]) || m[1].startsWith("data:image/svg")) return;
      const r = el.getBoundingClientRect();
      if (r.width < MIN_IMAGE_PX || r.height < MIN_IMAGE_PX) return;
      seen.add(m[1]);
      w.images.push(m[1]);
    };

    const scan = (node) => {
      if (node.nodeType === 3) return checkText(node.textContent);
      if (node.nodeType !== 1) return;
      if (node.tagName === "IMG") consider(node);
      for (const img of node.querySelectorAll?.("img") || []) consider(img);
      considerBackground(node);
      for (const el of node.querySelectorAll?.('[style*="background-image"]') ||
        [])
        considerBackground(el);
      checkText(node.textContent);
    };

    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData") checkText(m.target.textContent);
        else if (m.type === "attributes") {
          if (m.target.tagName === "IMG") consider(m.target);
          else considerBackground(m.target);
        } else for (const n of m.addedNodes) scan(n);
      }
    });
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["src", "style", "srcset"],
    });

    // Safety net: whatever the observer misses, a plain sweep still catches.
    // Slower to notice, but it means no rendering technique can stall a run.
    const sweep = setInterval(() => {
      for (const url of collectImageUrls()) {
        if (!seen.has(url)) {
          seen.add(url);
          w.images.push(url);
        }
      }
    }, 2000);

    w.stop = () => {
      obs.disconnect();
      clearInterval(sweep);
    };
    return w;
  }

  async function waitForResult(watcher, timeoutMs) {
    const started = Date.now();
    let candidate = null,
      stableSince = 0;
    while (Date.now() - started < timeoutMs) {
      await guard();

      if (watcher.error) {
        const crashed = /client-side exception|application error/i.test(
          watcher.error,
        );
        const err = new Friendly(
          crashed ? "The Flow page crashed." : `Flow said: “${watcher.error}”`,
          crashed
            ? "Reload the Flow tab, then start again. Anything already downloaded is safe."
            : watcher.fatal
              ? 'Nothing more can be generated on this account today. Your finished images are already saved — resume tomorrow with "Only these scenes".'
              : "Flow rejected this one. It will be retried.",
        );
        err.fatal = watcher.fatal;
        throw err;
      }

      const newest = watcher.images[watcher.images.length - 1];
      if (newest) {
        if (newest === candidate) {
          if (Date.now() - stableSince >= SETTLE_MS) return newest;
        } else {
          candidate = newest;
          stableSince = Date.now();
        }
      }
      await sleep(POLL_MS);
    }
    throw new Friendly(
      `No image appeared within ${Math.round(timeoutMs / 60000)} min.`,
      (lastSubmitReport
        ? `The prompt may never have been sent — clicked: ${lastSubmitReport}. Use "Show me the generate button" and pick the arrow beside the prompt box. `
        : "") + "Otherwise check the Flow panel for an error or quota message.",
    );
  }

  /* Flow renders results from
   *   .../media.getMediaUrlRedirect?name=<id>&mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL
   * so the <img> on the page — and therefore the obvious thing to download — is
   * a thumbnail, not the full render. The parameter accepts other values, but
   * which ones are valid isn't documented, so probe rather than assume and keep
   * whichever genuinely returns more pixels. */
  const FULL_RES_CANDIDATES = [
    "MEDIA_URL_TYPE_RAW",
    "MEDIA_URL_TYPE_ORIGINAL",
    "MEDIA_URL_TYPE_FULL",
    "MEDIA_URL_TYPE_DOWNLOAD",
    "MEDIA_URL_TYPE_UNSPECIFIED",
  ];
  let provenFullResType = null; // remembered for the rest of the run

  async function measure(url) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!/^image\//.test(blob.type)) return null;
      const bmp = await createImageBitmap(blob);
      const out = { bytes: blob.size, width: bmp.width, height: bmp.height };
      bmp.close?.();
      return out;
    } catch (_) {
      return null;
    }
  }

  async function upgradeToFullRes(url) {
    if (!/mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL/.test(url))
      return { url, note: null };

    const swap = (t) =>
      url.replace(/mediaUrlType=[A-Z_]+/, `mediaUrlType=${t}`);
    const baseline = await measure(url);

    const order = provenFullResType
      ? [
          provenFullResType,
          ...FULL_RES_CANDIDATES.filter((t) => t !== provenFullResType),
        ]
      : FULL_RES_CANDIDATES;

    for (const type of order) {
      const candidate = swap(type);
      const got = await measure(candidate);
      if (!got) continue;
      // Accept only a genuine improvement; some endpoints quietly return the
      // same thumbnail for an unknown type.
      if (
        !baseline ||
        got.width > baseline.width * 1.2 ||
        got.bytes > baseline.bytes * 1.5
      ) {
        provenFullResType = type;
        return {
          url: candidate,
          note: `${got.width}x${got.height} via ${type}`,
        };
      }
    }
    return {
      url,
      note: baseline
        ? `thumbnail only, ${baseline.width}x${baseline.height}`
        : "thumbnail only",
    };
  }

  async function toDownloadable(url) {
    if (/^https?:/.test(url)) return { url };
    const blob = await (await fetch(url)).blob();
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
    return { url: dataUrl, mime: blob.type };
  }

  /* ------------------------------------------------- prompt text assembly */

  /* A scene's reference list can name two different kinds of thing:
   *
   *   anchors    people, places, props — described up front, before the shot
   *   subgrades  lighting and grade notes — appended after the base style
   *
   * They share one namespace in the JSON, so both are looked up here. Treating
   * a grade note as a character would put "Sub-grade: three in the morning"
   * under "CHARACTERS IN THIS SHOT", which reads as nonsense to the model. */
  function buildPrompt(scene, spec, opts) {
    const anchorMap = spec.anchors || {};
    const gradeMap = spec.subgrades || spec.subGrades || {};
    const refs = scene.anchors || [];

    const pick = (map, name) => {
      if (map[name] !== undefined) return map[name];
      const want = String(name).trim().toLowerCase();
      const hit = Object.keys(map).find((k) => k.toLowerCase() === want);
      return hit === undefined ? undefined : map[hit];
    };

    const anchors = refs
      .map((k) => pick(anchorMap, k))
      .filter((v) => v !== undefined);
    const grades = refs
      .filter((k) => pick(anchorMap, k) === undefined)
      .map((k) => pick(gradeMap, k))
      .filter((v) => v !== undefined);

    // Some specs name the lighting look separately per shot — "subgrade":
    // "terrace" — rather than mixing it into the anchors list. Add it if it
    // isn't already covered by a ref above, so it isn't pasted in twice.
    if (scene.subgrade) {
      const named = pick(gradeMap, scene.subgrade);
      if (named !== undefined && !grades.includes(named)) grades.push(named);
    }

    const blocks = [];
    if (anchors.length && opts.includeAnchors !== false) {
      blocks.push(
        (anchors.length > 1
          ? "CHARACTERS IN THIS SHOT:\n"
          : "CHARACTER IN THIS SHOT:\n") +
          anchors.map((a) => `- ${a}`).join("\n"),
      );
    }
    blocks.push(scene.prompt);

    // The look that applies to every image, then this shot's variation on it.
    const style = [spec.style, ...grades]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (style) blocks.push(style);

    if (opts.appendFormat !== false) {
      const d = spec.defaults || {};
      const bits = [];
      const ratio = scene.aspect_ratio || d.aspect_ratio;
      const size = scene.image_size || d.image_size;
      if (ratio) bits.push(`Aspect ratio ${ratio}.`);
      if (size) bits.push(`Render at ${size}.`);
      if (bits.length) blocks.push(bits.join(" "));
    }
    return blocks.join("\n\n");
  }

  /* ------------------------------------------------------------ the runner */

  /* One generated image can be saved under several scene names — "used_in":
   * ["scene_01", "scene_62"] — when the same shot appears twice in the cut.
   * Falls back to the image's own id, which covers every spec that predates
   * this field. An empty array counts as absent rather than "save nothing". */
  function outputIdsFor(scene) {
    return scene.used_in && scene.used_in.length ? scene.used_in : [scene.id];
  }

  /* "Only these scenes" and "Retry failed" both hand back a list of names.
   * Someone thinking in scene numbers will type scene_01, not the image id
   * that produced it, so a match on either the image's own id or any of its
   * output scene names is what they mean. */
  function matchesOnly(scene, only) {
    if (!only || !only.length) return true;
    if (only.includes(scene.id)) return true;
    return outputIdsFor(scene).some((id) => only.includes(id));
  }

  let heartbeat = null;

  async function runBatch({ spec, options }) {
    const scenes = (spec.images || []).filter((s) =>
      matchesOnly(s, options.only),
    );
    // "09-namak" style specs give the folder its full name in one field.
    // Newer specs split it — "episode": 12, "internal_name": "udhaar" — so
    // the folder still reads as something a human chose rather than a number.
    const episode = spec.internal_name
      ? spec.episode
        ? `${spec.episode}-${spec.internal_name}`
        : spec.internal_name
      : spec.episode || "flow-batch";

    run.active = true;
    run.stop = false;
    run.paused = false;
    clearInterval(heartbeat);
    heartbeat = setInterval(() => send({ type: "HEARTBEAT" }), 5000);

    await send({
      type: "RUN_STARTED",
      episode,
      total: scenes.length,
      saveLog: options.saveLog !== false,
    });

    // Attach for the duration of the run only. If it fails (usually because
    // DevTools already owns the tab) the run still proceeds on synthetic
    // events — degraded, not blocked.
    if (options.trustedInput !== false) {
      setPhase("enabling real input");
      const ok = await trusted.enable();
      if (!ok) {
        await send({
          type: "NOTE",
          text: `Real input unavailable (${trusted.lastError || "unknown"}) — using synthetic events.`,
        });
      }
    }

    let index = 0;
    try {
      for (const scene of scenes) {
        await guard();
        index++;
        banner(`Flow Batch — ${index} of ${scenes.length}: ${scene.id}`);
        await send({ type: "SCENE_STARTED", sceneId: scene.id, index });

        const promptText = buildPrompt(scene, spec, options);
        let failure = null;

        for (let attempt = 1; attempt <= (options.retries || 2); attempt++) {
          let watcher = null;
          try {
            await guard();
            if (pageCrashed()) throw crashError("loading");
            const promptBox = findPromptBox();
            if (!promptBox) {
              throw new Friendly(
                "Can't find Flow's prompt box.",
                'Click "Show me the prompt box" and pick it once — I\'ll remember it.',
              );
            }

            // Flow generates one image at a time. Sending the next prompt while
            // the previous one is still running finds a Stop button where the
            // send arrow should be — which is how scene_02 used to fail.
            if (
              !(await waitForComposerIdle(
                promptBox,
                (options.timeoutSec || 240) * 1000,
              ))
            ) {
              throw new Friendly(
                "The previous image is still generating.",
                'Flow was still busy after the timeout. Raise "Give up after" in Settings if your images take longer than that.',
              );
            }

            setPhase(attempt > 1 ? `retrying (${attempt})` : "typing prompt");

            const method = await typePrompt(promptBox, promptText);
            await sleep(400);

            setPhase("submitting");
            watcher = createWatcher();
            const confirmed = await submitPrompt(promptBox);

            // "textContent" only mutates the DOM. A framework editor (Lexical,
            // ProseMirror) will show the text but submit an empty prompt, and
            // the box won't clear. Catch that here instead of waiting 4 minutes.
            if (!confirmed && method === "textContent") {
              throw new Friendly(
                "Flow displayed the prompt but didn't accept it.",
                "The prompt box is a rich-text editor that ignores inserted text. Click " +
                  '"Show me the prompt box" and pick the inner editable element inside it.',
              );
            }

            if (options.dryRun) {
              failure = null;
              await send({
                type: "SCENE_DONE",
                sceneId: scene.id,
                status: "dry-run",
                prompt: promptText,
              });
              break;
            }

            setPhase("waiting for image");
            const url = await waitForResult(
              watcher,
              (options.timeoutSec || 240) * 1000,
            );

            setPhase("fetching full size");
            const full = await upgradeToFullRes(url);

            setPhase("saving");
            const payload = await toDownloadable(full.url);

            // One generation, saved once per scene it's used in — img_01
            // used in scene_01 and scene_62 becomes two files from one image.
            const outputIds = outputIdsFor(scene);
            const filenames = [];
            for (const outId of outputIds) {
              const res = await chrome.runtime.sendMessage({
                type: "DOWNLOAD_IMAGE",
                episode,
                sceneId: outId,
                attempt: 1,
                ...payload,
              });
              if (!res || !res.ok)
                throw new Friendly(
                  "Saving the image failed.",
                  res?.error || "",
                );
              filenames.push(res.filename);
            }

            await send({
              type: "SCENE_DONE",
              sceneId: scene.id,
              status: "ok",
              url: full.url,
              filename: filenames.join(", "),
              outputs: outputIds,
              resolution: full.note,
              prompt: promptText,
            });
            failure = null;
            break;
          } catch (err) {
            if (err instanceof Aborted) throw err;
            failure = err;
            if (err.fatal) break; // retrying a quota wall just wastes time
            if (attempt < (options.retries || 2)) await sleep(2000);
          } finally {
            watcher?.stop();
          }
        }

        if (failure) {
          // An unexpected error used to log a bare message with no hint and no
          // location, which is unactionable. Always attach both.
          const unexpected = !(failure instanceof Friendly);
          await send({
            type: "SCENE_DONE",
            sceneId: scene.id,
            status: "error",
            error: String(failure.message || failure),
            hint:
              failure.hint ||
              (unexpected
                ? "Unexpected error — send this log line to whoever set this up."
                : null),
            where: unexpected
              ? String(failure.stack || "")
                  .split("\n")
                  .slice(0, 3)
                  .join(" | ")
                  .slice(0, 300)
              : null,
            phase: run.phase,
            prompt: promptText,
          });
          // Quota walls and a missing prompt box would fail identically for every
          // remaining scene. Stop the run and say why.
          const blocking =
            failure.fatal ||
            (failure instanceof Friendly &&
              /prompt box|generate button|which control sends|greyed out/i.test(
                failure.message,
              ));
          if (blocking) {
            await send({
              type: "RUN_BLOCKED",
              reason: failure.message,
              hint: failure.hint,
            });
            break;
          }
        }
        await sleep((options.gapSec || 3) * 1000);
      }
    } catch (err) {
      if (!(err instanceof Aborted)) console.error("[Flow Batch]", err);
    } finally {
      clearInterval(heartbeat);
      run.active = false;
      setPhase(null);
      banner(null);
      await trusted.disable();
      await send({ type: "RUN_FINISHED" });
    }
  }

  /* ------------------------------------------------- learn by watching you */

  /* Clicking an element only reveals where it is. Watching a real keystroke
   * reveals which element the app is actually listening to and which events it
   * cares about — which is the part that was being guessed wrong. */
  let watching = null;

  function startWatchingTyping() {
    stopTeaching();
    stopWatchingTyping();

    const seen = { events: new Set(), target: null, gateOn: false, chars: 0 };
    let settle = null;

    const gateBefore = (() => {
      const box = findPromptBox();
      return box ? sendGate(box) : null;
    })();

    const onEvent = (e) => {
      if (!e.isTrusted) return;
      if (e.type === "keydown" && (e.key || "").length !== 1) return;
      seen.events.add(e.type);
      if (e.type === "keydown") seen.chars++;

      const t = e.target;
      if (t && t.nodeType === 1) {
        // Record the editor root, never the inner node an event happened to hit.
        const root = resolveEditable(t);
        if (
          root &&
          (declaresEditable(root) ||
            root.tagName === "TEXTAREA" ||
            root.tagName === "INPUT")
        ) {
          seen.target = root;
        } else if (!seen.target) {
          seen.target = root || t;
        }
      }

      clearTimeout(settle);
      settle = setTimeout(finish, 1200);
      banner(
        `Watching… saw ${seen.chars || seen.events.size} keystroke(s). Stop typing to save.`,
      );
    };

    const finish = async () => {
      const target = seen.target;
      stopWatchingTyping();
      if (!target) {
        banner(
          "Didn't see any typing — try again and type into Flow's prompt box.",
        );
        setTimeout(() => banner(null), 3500);
        return;
      }
      seen.gateOn = gateBefore ? !isDisabled(gateBefore) : false;

      taught.promptSelector = cssPath(target);
      taught.observedEvents = [...seen.events];
      await chrome.storage.local.set({ taught });
      send({ type: "TAUGHT", key: "promptSelector" });
      banner(
        `Learned the prompt box (${taught.observedEvents.join(", ")}). Reopen Flow Batch.`,
      );
      setTimeout(() => banner(null), 4000);
    };

    for (const type of ["keydown", "beforeinput", "input", "textInput"]) {
      document.addEventListener(type, onEvent, true);
    }
    document.addEventListener("keydown", onWatchKey, true);
    watching = { onEvent, cancelSettle: () => clearTimeout(settle) };
    banner("Now type a few letters into Flow's prompt box  ·  Esc to cancel");
  }

  function onWatchKey(e) {
    if (e.key === "Escape") {
      stopWatchingTyping();
      banner(null);
    }
  }

  function stopWatchingTyping() {
    if (!watching) return;
    for (const type of ["keydown", "beforeinput", "input", "textInput"]) {
      document.removeEventListener(type, watching.onEvent, true);
    }
    document.removeEventListener("keydown", onWatchKey, true);
    watching.cancelSettle();
    watching = null;
  }

  /* ---------------------------------------------------------- teach picker */

  let teaching = null;

  const TEACH_LABEL = {
    promptSelector: "Click Flow's prompt box — the field you type into",
    submitSelector: "Click Flow's generate / send button",
    resultSelector: "Click one of the generated images",
  };

  function startTeaching(target) {
    stopTeaching();
    teaching = target;
    document.addEventListener("mouseover", onTeachHover, true);
    document.addEventListener("click", onTeachClick, true);
    document.addEventListener("keydown", onTeachKey, true);
    banner(`${TEACH_LABEL[target]}  ·  Esc to cancel`);
  }

  function stopTeaching() {
    document.removeEventListener("mouseover", onTeachHover, true);
    document.removeEventListener("click", onTeachClick, true);
    document.removeEventListener("keydown", onTeachKey, true);
    document
      .querySelectorAll(".flow-batch-hi")
      .forEach((el) => el.classList.remove("flow-batch-hi"));
    teaching = null;
    if (!run.active) banner(null);
  }

  function onTeachKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      stopTeaching();
    }
  }

  function onTeachHover(e) {
    document
      .querySelectorAll(".flow-batch-hi")
      .forEach((el) => el.classList.remove("flow-batch-hi"));
    e.target.classList.add("flow-batch-hi");
  }

  async function onTeachClick(e) {
    e.preventDefault();
    e.stopPropagation();
    let el = e.target;
    if (teaching === "promptSelector") {
      // People click the visible placeholder text, not the editable node itself.
      el =
        el.closest(
          'textarea, [contenteditable="true"], [role="textbox"], input',
        ) ||
        el.querySelector?.(
          'textarea, [contenteditable="true"], [role="textbox"]',
        ) ||
        el;
    }
    if (teaching === "submitSelector")
      el = el.closest('button, [role="button"]') || el;
    if (teaching === "resultSelector" && el.tagName === "IMG")
      el = el.closest("div") || el;

    const key = teaching;
    stopTeaching();
    taught[key] = cssPath(el);
    await chrome.storage.local.set({ taught });
    send({ type: "TAUGHT", key });
    banner("Got it — reopen Flow Batch");
    setTimeout(() => banner(null), 3000);
  }

  /* ------------------------------------------------------------ status bar */

  let bannerEl = null;
  function banner(text) {
    if (!text) {
      bannerEl?.remove();
      bannerEl = null;
      return;
    }
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.className = "flow-batch-banner";
      document.documentElement.appendChild(bannerEl);
    }
    bannerEl.textContent = text;
  }

  /* ------------------------------------------- probe (called by the popup) */

  window.__flowBatchProbe = () => {
    const box = findPromptBox();
    const submit = box ? findSubmitButton(box) : null;
    return {
      version: VERSION,
      active: run.active,
      url: location.href,
      isTop: window.top === window,
      promptBox: box ? cssPath(box) : null,
      promptHint: box
        ? box.getAttribute("placeholder") ||
          box.getAttribute("aria-label") ||
          box.getAttribute("data-placeholder") ||
          box.tagName.toLowerCase()
        : null,
      promptScore: box ? Math.round(scorePromptBox(box)) : -999,
      submit: submit
        ? (submit.getAttribute("aria-label") || submit.textContent || "button")
            .trim()
            .slice(0, 40)
        : null,
      images: collectImageUrls().length,
      taught: { ...taught },
    };
  };

  /* Full picture of what detection sees, for pasting into a bug report.
   * Deliberately reports element shape only — no page text, no image URLs. */
  // Which editor library an element belongs to, if it advertises itself.
  function editorKind(el) {
    const marks = [];
    for (let n = el, i = 0; n && i < 4; n = n.parentElement, i++) {
      const cls = typeof n.className === "string" ? n.className : "";
      if (n.hasAttribute?.("data-lexical-editor") || n.__lexicalEditor)
        marks.push("lexical");
      if (/ProseMirror/.test(cls)) marks.push("prosemirror");
      if (/DraftEditor/.test(cls)) marks.push("draft");
      if (n.hasAttribute?.("data-slate-editor")) marks.push("slate");
      if (/ql-editor|quill/.test(cls)) marks.push("quill");
      if (/cm-content|CodeMirror/.test(cls)) marks.push("codemirror");
      if (Object.keys(n).some((k) => k.startsWith("__reactProps")))
        marks.push("react");
    }
    return [...new Set(marks)].join("+") || "unknown";
  }

  // React stores handler props on the DOM node; knowing which exist tells us
  // which events the app is actually listening for.
  function reactHandlers(el) {
    for (let n = el, i = 0; n && i < 4; n = n.parentElement, i++) {
      const key = Object.keys(n).find((k) => k.startsWith("__reactProps$"));
      if (!key) continue;
      const props = n[key] || {};
      const found = Object.keys(props).filter((k) => /^on[A-Z]/.test(k));
      if (found.length) return found.join(",").slice(0, 120);
    }
    return "none found";
  }

  window.__flowBatchDiagnostics = () => {
    const candidates = deepQuery(
      'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], input[type="text"]',
    )
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          score: Math.round(scorePromptBox(el)),
          editable: !!el.isContentEditable,
          editor: editorKind(el),
          handlers: reactHandlers(el),
          hint: (
            el.getAttribute("placeholder") ||
            el.getAttribute("aria-label") ||
            el.getAttribute("data-placeholder") ||
            ""
          ).slice(0, 50),
          box: `${Math.round(r.width)}x${Math.round(r.height)} @ ${Math.round(r.left)},${Math.round(r.top)}`,
          path: cssPath(el).slice(0, 90),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    const probe = window.__flowBatchProbe();
    const box = findPromptBox();
    const gate = box ? sendGate(box) : null;

    return {
      version: VERSION,
      url: location.origin + location.pathname,
      frame: window.top === window ? "main" : "iframe",
      viewport: `${innerWidth}x${innerHeight}`,
      chosen: probe.promptBox,
      chosenEditor: box ? editorKind(resolveEditable(box)) : null,
      resolvedEditable: box ? cssPath(resolveEditable(box)).slice(0, 90) : null,
      submit: probe.submit,
      sendGate: gate
        ? {
            label: buttonLabel(gate).slice(0, 40),
            disabled: isDisabled(gate),
            path: cssPath(gate).slice(0, 90),
          }
        : null,
      imagesOnPage: collectImageUrls().length,
      taught,
      candidates,
    };
  };

  /* Isolated-world only — the page cannot see this. Exposed so the test suite
   * can exercise typing against real element shapes, and so you can poke at
   * detection from the extension's console. */
  window.__flowBatchDebug = {
    findPromptBox,
    findSubmitButton,
    typePrompt,
    readBack,
    collectImageUrls,
    scoreSendButton,
    sendButtonCandidates,
    CONFIDENT_SEND,
    resolveEditable,
    editableRoot,
    declaresEditable,
    scorePromptBox,
    richEditorRoot,
    submitPrompt,
    realClick,
    trusted,
    upgradeToFullRes,
    composerBusy,
    waitForComposerIdle,
    makeSentCheck,
  };

  /* -------------------------------------------------------------- messages */

  // The initial read is async, so a teach that lands first must not be clobbered
  // by the stale value arriving late.
  let taughtFresh = false;
  chrome.storage.local.get("taught").then((r) => {
    if (!taughtFresh) {
      taught = r.taught || {};
      taughtFresh = true;
    }
  });
  chrome.storage.onChanged.addListener((c) => {
    if (c.taught) {
      taught = c.taught.newValue || {};
      taughtFresh = true;
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case "PING":
        sendResponse({ ok: true, version: VERSION, active: run.active });
        break;
      case "START_RUN":
        if (run.active) {
          sendResponse({ ok: false, error: "already running" });
          break;
        }
        chrome.storage.local.get("taught").then((r) => {
          taught = r.taught || {};
          runBatch(msg.payload);
        });
        sendResponse({ ok: true });
        break;
      case "PAUSE_RUN":
        run.paused = !!msg.paused;
        sendResponse({ ok: true, paused: run.paused });
        break;
      case "STOP_RUN":
        run.stop = true;
        run.paused = false;
        sendResponse({ ok: true });
        break;
      case "TEACH":
        startTeaching(msg.target);
        sendResponse({ ok: true });
        break;
      case "WATCH_TYPING":
        startWatchingTyping();
        sendResponse({ ok: true });
        break;
      case "CLEAR_TAUGHT":
        taught = {};
        chrome.storage.local.set({ taught: {} });
        sendResponse({ ok: true });
        break;
      case "PROBE":
        sendResponse({ ok: true, ...window.__flowBatchProbe() });
        break;
      default:
        return false;
    }
    return true;
  });
})();
