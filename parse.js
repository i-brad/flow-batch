/* parse.js — turns a plain-text prompt list into the internal spec shape.
 *
 * The point of this file is that nobody should have to write JSON. The text
 * format is: optional SETTINGS / CHARACTERS / STYLES sections, then prompts
 * separated by blank lines (or --- if a prompt itself has blank lines).
 *
 *   SETTINGS
 *   name: my-images
 *   aspect ratio: 16:9
 *
 *   CHARACTERS
 *   sudha: Sudha — a 43-year-old Indian woman…
 *
 *   STYLES
 *   house: Photorealistic cinematic still, soot-darkened kitchen walls…
 *
 *   PROMPTS
 *   characters: sudha
 *   style: house
 *   Extreme macro, low warm light. A heap of coarse salt…
 *
 * Everything except the prompts themselves is optional.
 */

(function (root) {
  "use strict";

  class ParseError extends Error {}

  const norm = (s) =>
    String(s)
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

  /* Splits on --- when present (so prompts may contain blank lines), else on
   * blank lines, which is what people do naturally. */
  function splitBlocks(text) {
    const body = text.join("\n");
    const parts = /^[ \t]*-{3,}[ \t]*$/m.test(body)
      ? body.split(/^[ \t]*-{3,}[ \t]*$/m)
      : body.split(/\n[ \t]*\n/);
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  function splitSections(raw) {
    const HEAD =
      /^(characters?|anchors?|sub-?grades?|styles?|style|settings?|options?|prompts?|scenes?|images?)[ \t]*:?[ \t]*$/i;
    const out = {
      settings: [],
      characters: [],
      styles: [],
      subgrades: [],
      style: [],
      prompts: [],
    };
    let current = "prompts";
    let sawHeading = false;

    for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
      const m = line.trim().match(HEAD);
      if (m) {
        const k = m[1].toLowerCase().replace("-", "");
        // STYLE and STYLES mean different things: one look applied to every
        // image, versus a set of named looks picked per image.
        current = k.startsWith("subgrade")
          ? "subgrades"
          : k === "style"
            ? "style"
            : k.startsWith("style")
              ? "styles"
              : k.startsWith("character") || k.startsWith("anchor")
                ? "characters"
                : k.startsWith("setting") || k.startsWith("option")
                  ? "settings"
                  : "prompts";
        sawHeading = true;
        continue;
      }
      out[current].push(line);
    }
    // With no headings at all, treat the whole thing as prompts.
    if (!sawHeading) {
      out.prompts = raw.replace(/\r\n?/g, "\n").split("\n");
    }
    return out;
  }

  /* "sudha: Sudha — a 43-year-old…" → { sudha: "Sudha — a 43-year-old…" }
   *
   * A new entry starts at a single-word name followed by a colon. Everything
   * else continues the previous one, so entries can be one per line, separated
   * by blank lines, or wrapped over several lines — all of which people write.
   * The name must be one word, or a description containing a mid-sentence colon
   * ("Her hands are the point: broad, scarred") would start a bogus entry. */
  const ENTRY = /^([A-Za-z][\w-]{0,30}):\s*(.*)$/;

  function parseNamedBlocks(lines, label) {
    const map = {};
    let key = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || /^-{3,}$/.test(line)) continue;
      const m = line.match(ENTRY);
      if (m) {
        // The original spelling is kept — JSON specs use names like NIGHTWARD
        // and MEERA, and lowercasing them would break the round trip. Lookups
        // are case-insensitive, so `characters: meera` still resolves.
        key = m[1].trim();
        map[key] = m[2].trim();
      } else if (key) {
        map[key] = `${map[key]} ${line}`.trim();
      } else {
        throw new ParseError(
          `Each ${label} needs a one-word name, a colon, then the description. ` +
            `This line doesn't: “${line.slice(0, 48)}…”`,
        );
      }
    }
    for (const [k, v] of Object.entries(map)) {
      if (!v)
        throw new ParseError(
          `The ${label} “${k}” has a name but no description.`,
        );
    }
    return map;
  }

  /* Case-insensitive lookup, so a spec can use MEERA and a prompt can say
   * meera without either being wrong. */
  function resolve(map, name) {
    if (map[name] !== undefined) return map[name];
    const want = String(name).trim().toLowerCase();
    for (const k of Object.keys(map)) {
      if (k.toLowerCase() === want) return map[k];
    }
    return undefined;
  }

  function parseSettings(lines) {
    const out = {};
    for (const line of lines) {
      const m = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      const key = norm(m[1]),
        value = m[2].trim();
      if (["name", "episode", "title", "folder"].includes(key))
        out.episode = value;
      else if (["aspect_ratio", "ratio", "aspect"].includes(key))
        out.aspect_ratio = value;
      else if (["image_size", "size", "quality"].includes(key))
        out.image_size = value;
      else if (key === "model") out.model = value;
      else if (key === "style") out.style = norm(value);
    }
    return out;
  }

  const FIELD = {
    id: ["id", "scene", "name"],
    characters: ["characters", "character", "chars", "with", "anchors"],
    style: ["style", "look"],
    subgrade: ["subgrade", "sub_grade", "grade"],
    image_size: ["image_size", "size", "quality"],
    aspect_ratio: ["aspect_ratio", "ratio", "aspect"],
    used_in: ["used_in", "duplicate", "duplicates", "scenes"],
  };

  function fieldFor(key) {
    for (const [field, aliases] of Object.entries(FIELD))
      if (aliases.includes(key)) return field;
    return null;
  }

  function parsePromptBlock(block, index) {
    const meta = {};
    const body = [];
    let inBody = false;

    for (const line of block.split("\n")) {
      // A bare "scene_04:" line names the scene.
      const bare = line.trim().match(/^([a-zA-Z][\w-]{0,40}):$/);
      if (!inBody && bare && !fieldFor(norm(bare[1]))) {
        meta.id = bare[1].trim();
        continue;
      }

      const kv = line.match(/^\s*([A-Za-z][\w \t-]{0,20}?)\s*:\s*(.*)$/);
      const field = kv && !inBody ? fieldFor(norm(kv[1])) : null;
      if (field) {
        meta[field] = kv[2].trim();
        continue;
      }

      if (line.trim()) inBody = true; // once prose starts, stop looking for fields
      body.push(line);
    }

    const prompt = body
      .join("\n")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    if (!prompt)
      throw new ParseError(`Prompt ${index + 1} has no text, only settings.`);
    return { meta, prompt };
  }

  function parseText(raw) {
    if (!raw || !raw.trim())
      throw new ParseError("Nothing to read — the box is empty.");

    const sections = splitSections(raw);
    const settings = parseSettings(sections.settings);
    const anchors = parseNamedBlocks(sections.characters, "character");
    const styles = parseNamedBlocks(sections.styles, "style");
    const subgrades = parseNamedBlocks(sections.subgrades, "sub-grade");
    const globalStyle = sections.style
      .join("\n")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    const styleNames = Object.keys(styles);

    const blocks = splitBlocks(sections.prompts);
    if (!blocks.length)
      throw new ParseError(
        "No prompts found. Add at least one paragraph of prompt text.",
      );

    const usedIds = new Set();
    const images = blocks.map((block, i) => {
      const { meta, prompt } = parsePromptBlock(block, i);

      let id = meta.id || `scene_${String(i + 1).padStart(2, "0")}`;
      if (usedIds.has(id)) {
        throw new ParseError(
          `Two prompts are both named “${id}”. Names must be unique.`,
        );
      }
      usedIds.add(id);

      // Keys keep their original case here: the JSON form uses names like
      // NIGHTWARD and MEERA, and lowercasing them would break round-tripping.
      const refs = (meta.characters || "")
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const ref of refs) {
        if (
          resolve(anchors, ref) === undefined &&
          resolve(subgrades, ref) === undefined
        ) {
          const known =
            [...Object.keys(anchors), ...Object.keys(subgrades)].join(", ") ||
            "none defined yet";
          throw new ParseError(
            `Prompt “${id}” mentions “${ref}”, which isn't in CHARACTERS or SUBGRADES. Known: ${known}.`,
          );
        }
      }

      // One unnamed style applies to everything; otherwise pick by name.
      let styleKey = meta.style
        ? meta.style.trim()
        : settings.style || (styleNames.length === 1 ? styleNames[0] : null);
      if (styleKey && resolve(styles, styleKey) === undefined) {
        throw new ParseError(
          `Prompt “${id}” asks for style “${styleKey}”, which isn't in the STYLES section. Known: ${styleNames.join(", ") || "none defined yet"}.`,
        );
      }

      const image = {
        id,
        prompt: styleKey ? `${prompt} ${resolve(styles, styleKey)}` : prompt,
        anchors: refs,
      };
      if (meta.subgrade) image.subgrade = meta.subgrade;
      if (meta.image_size) image.image_size = meta.image_size;
      if (meta.aspect_ratio) image.aspect_ratio = meta.aspect_ratio;
      if (meta.used_in)
        image.used_in = meta.used_in
          .split(/[,;]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      return image;
    });

    const defaults = {};
    // model isn't used to drive Flow, but round-tripping must not silently drop it.
    if (settings.model) defaults.model = settings.model;
    if (settings.aspect_ratio) defaults.aspect_ratio = settings.aspect_ratio;
    if (settings.image_size) defaults.image_size = settings.image_size;

    const spec = {
      episode: settings.episode || "my-images",
      defaults,
      anchors,
      images,
    };
    if (globalStyle) spec.style = globalStyle;
    if (Object.keys(subgrades).length) spec.subgrades = subgrades;
    return spec;
  }

  function validateSpec(spec) {
    if (!spec || typeof spec !== "object")
      throw new ParseError("That doesn't look like a prompt list.");
    if (!Array.isArray(spec.images) || !spec.images.length)
      throw new ParseError("No prompts found.");
    // "episode": 11 is valid JSON and perfectly reasonable to write. Everything
    // downstream treats it as text — folder names, filenames — so normalise it
    // here rather than guarding at each use.
    if (spec.episode !== undefined && spec.episode !== null) {
      spec.episode = String(spec.episode);
    }
    const seen = new Set();
    const outputOwner = new Map(); // output scene id -> id of the image that claims it
    for (const im of spec.images) {
      if (!im.id || !im.prompt)
        throw new ParseError("Every prompt needs a name and some text.");
      if (seen.has(im.id))
        throw new ParseError(`Two prompts are both named “${im.id}”.`);
      seen.add(im.id);
      // A reference may name an anchor (person/place/prop) or a sub-grade
      // (lighting note). Both live in the scene's list, so both count as known.
      const known = {
        ...(spec.anchors || {}),
        ...(spec.subgrades || spec.subGrades || {}),
      };
      for (const a of im.anchors || []) {
        if (resolve(known, a) === undefined) {
          const names = Object.keys(known);
          throw new ParseError(
            `“${im.id}” refers to “${a}”, which isn't in anchors or subgrades.` +
              (names.length
                ? ` Known: ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}.`
                : ""),
          );
        }
      }
      // "subgrade" names one lighting look for this shot specifically, kept
      // separate from "anchors" so it never gets mistaken for a character.
      if (im.subgrade !== undefined) {
        const grades = spec.subgrades || spec.subGrades || {};
        if (resolve(grades, im.subgrade) === undefined) {
          const names = Object.keys(grades);
          throw new ParseError(
            `“${im.id}” asks for subgrade “${im.subgrade}”, which isn't in subgrades.` +
              (names.length ? ` Known: ${names.join(", ")}.` : ""),
          );
        }
      }
      // "used_in" lets one generated image be saved as several scene files —
      // img_01 used in scene_01 and scene_62 becomes two duplicated downloads.
      if (im.used_in !== undefined) {
        if (
          !Array.isArray(im.used_in) ||
          im.used_in.some((s) => typeof s !== "string" || !s.trim())
        ) {
          throw new ParseError(
            `“${im.id}” has a "used_in" that isn't a list of scene names.`,
          );
        }
      }
      const outputs =
        im.used_in && im.used_in.length ? im.used_in : [im.id];
      for (const out of outputs) {
        const owner = outputOwner.get(out);
        if (owner && owner !== im.id) {
          throw new ParseError(
            `Both “${owner}” and “${im.id}” are used_in “${out}” — each output scene needs exactly one source image.`,
          );
        }
        outputOwner.set(out, im.id);
      }
    }
    return spec;
  }

  function looksLikeJson(text) {
    return /^\s*\{/.test(text);
  }

  /* Accepts either format and says which one it used. */
  function parseAny(text) {
    if (looksLikeJson(text)) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new ParseError(`That JSON has a syntax error: ${err.message}`);
      }
      return { spec: validateSpec(parsed), format: "json" };
    }
    return { spec: validateSpec(parseText(text)), format: "text" };
  }

  /* Renders a spec back out as the text format, so "Change…" always opens
   * something editable rather than a wall of JSON. */
  function toText(spec) {
    const out = [];
    const d = spec.defaults || {};
    out.push("SETTINGS");
    out.push(`name: ${spec.episode || "my-images"}`);
    if (d.aspect_ratio) out.push(`aspect ratio: ${d.aspect_ratio}`);
    if (d.image_size) out.push(`image size: ${d.image_size}`);
    if (d.model) out.push(`model: ${d.model}`);

    if (spec.style) {
      out.push("", "STYLE", spec.style);
    }

    const subgrades = Object.entries(spec.subgrades || spec.subGrades || {});
    if (subgrades.length) {
      out.push("", "SUBGRADES");
      for (const [key, text] of subgrades) out.push(`${key}: ${text.trim()}`);
    }

    const anchors = Object.entries(spec.anchors || {});
    if (anchors.length) {
      out.push("", "CHARACTERS");
      for (const [key, text] of anchors) out.push(`${key}: ${text}`, "");
      out.pop();
    }

    out.push("", "PROMPTS", "");
    for (const im of spec.images) {
      out.push(`${im.id}:`);
      if ((im.anchors || []).length)
        out.push(`characters: ${im.anchors.join(", ")}`);
      if (im.subgrade) out.push(`subgrade: ${im.subgrade}`);
      if (im.image_size) out.push(`image size: ${im.image_size}`);
      if (im.aspect_ratio) out.push(`aspect ratio: ${im.aspect_ratio}`);
      if ((im.used_in || []).length)
        out.push(`used_in: ${im.used_in.join(", ")}`);
      out.push(im.prompt, "---", "");
    }
    while (["", "---"].includes(out[out.length - 1])) out.pop();
    return out.join("\n");
  }

  root.FlowBatchParse = {
    parseAny,
    parseText,
    validateSpec,
    toText,
    ParseError,
  };
})(typeof window !== "undefined" ? window : globalThis);
