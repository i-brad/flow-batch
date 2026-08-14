// background.js — download broker, run-state store, and trusted-input broker.

import * as trusted from './trusted.js';
// The content script drives the page; anything needing an extension-only API
// (chrome.downloads) is proxied through here.

const DEFAULT_STATE = {
  running: false,
  paused: false,
  blocked: null,      // { reason, hint } — a run that stopped and needs the user
  phase: null,        // 'typing prompt' | 'waiting for image' | …
  episode: null,
  total: 0,
  done: 0,
  current: null,
  currentIndex: 0,
  log: [],
  startedAt: null,
  finishedAt: null,
  beatAt: null        // last heartbeat; lets the popup spot a dead run
};

async function getState() {
  const { runState } = await chrome.storage.local.get('runState');
  return { ...DEFAULT_STATE, ...(runState || {}) };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ runState: next });
  chrome.runtime.sendMessage({ type: 'STATE_CHANGED', state: next }).catch(() => {});
  return next;
}

function sanitize(part) {
  return String(part).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

function extFromUrl(url, mime) {
  if (mime) {
    const m = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime];
    if (m) return m;
  }
  const clean = url.split('?')[0].split('#')[0];
  const match = clean.match(/\.(png|jpe?g|webp|avif)$/i);
  return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
}

async function downloadImage({ url, episode, sceneId, attempt, mime }) {
  const folder = sanitize(episode || 'flow-batch');
  const base = `${sanitize(episode || 'scene')}_${sanitize(sceneId)}`;
  const suffix = attempt && attempt > 1 ? `_v${attempt}` : '';
  const filename = `FlowBatch/${folder}/${base}${suffix}.${extFromUrl(url, mime)}`;
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  return { downloadId: id, filename };
}

/* One log per run, named by when the run finished.
 *
 * The old fixed name relied on Chrome's uniquify, which produced
 * _run-log(1).json, _run-log(2).json … — impossible to match back to a run.
 * A timestamp sorts correctly and says which run it belongs to. */
function logStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
       + `_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function downloadRunLog(episode, log) {
  const ok = log.filter((l) => l.status === 'ok');
  const failed = log.filter((l) => l.status === 'error');
  const thumbs = ok.filter((l) => /thumbnail only/i.test(l.resolution || ''));

  const body = JSON.stringify({
    episode,
    generatedAt: new Date().toISOString(),
    summary: {
      attempted: log.length,
      saved: ok.length,
      failed: failed.length,
      savedAsThumbnailOnly: thumbs.length,
      // Paste straight into "Only these scenes" to pick up where this left off.
      retry: failed.map((l) => l.sceneId).join(', ')
    },
    scenes: log
  }, null, 2);

  const url = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(body)));
  return chrome.downloads.download({
    url,
    filename: `FlowBatch/${sanitize(episode || 'flow-batch')}/_run-log_${logStamp()}.json`,
    conflictAction: 'overwrite'
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'GET_STATE':
        sendResponse(await getState());
        break;

      /* Trusted input. The content script asks for a gesture and the service
       * worker performs it through CDP, because chrome.debugger is not
       * reachable from a content script. Coordinates are viewport pixels,
       * which is what the content script measures. */
      case 'TRUSTED_ATTACH':
        try {
          const tabId = sender.tab?.id ?? msg.tabId;
          if (!tabId) throw new Error('no tab');
          await trusted.attach(tabId);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: String(err.message || err) });
        }
        break;

      case 'TRUSTED_DETACH':
        await trusted.detach();
        sendResponse({ ok: true });
        break;

      case 'TRUSTED_GESTURE':
        try {
          if (!trusted.isAttached(sender.tab?.id)) throw new Error('not attached');
          if (msg.gesture === 'click') await trusted.click(msg.x, msg.y);
          else if (msg.gesture === 'insertText') await trusted.insertText(msg.text);
          else if (msg.gesture === 'key') await trusted.key(msg.key);
          else if (msg.gesture === 'selectAll') await trusted.selectAll();
          else throw new Error('unknown gesture ' + msg.gesture);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: String(err.message || err) });
        }
        break;

      case 'PATCH_STATE':
        sendResponse(await setState(msg.patch));
        break;

      // Clears a run that died with the tab — otherwise Start stays disabled forever.
      case 'FORCE_RESET':
        await trusted.detach();
        sendResponse(await setState({
          running: false, paused: false, blocked: null, phase: null,
          current: null, beatAt: null, finishedAt: Date.now()
        }));
        break;

      // Reveals the most recent saved image in the OS file manager. Chrome
      // gives no API for the Downloads path itself, so showing a real file is
      // the only way to actually put the user in front of the folder.
      case 'SHOW_IN_FOLDER': {
        const state = await getState();
        const last = [...(state.log || [])].reverse().find((l) => l.filename);
        if (!last) { sendResponse({ ok: false, error: 'Nothing has been saved yet.' }); break; }
        const items = await chrome.downloads.search({ filenameRegex: last.filename.split('/').pop() });
        if (items.length) {
          chrome.downloads.show(items[0].id);
          sendResponse({ ok: true, path: items[0].filename });
        } else {
          chrome.downloads.showDefaultFolder();
          sendResponse({ ok: true, path: null });
        }
        break;
      }

      case 'CLEAR_LOG':
        sendResponse(await setState({
          log: [], done: 0, total: 0, current: null, currentIndex: 0,
          blocked: null, finishedAt: null, startedAt: null
        }));
        break;

      case 'HEARTBEAT':
        await setState({ beatAt: Date.now() });
        sendResponse({ ok: true });
        break;

      case 'PHASE':
        await setState({ phase: msg.phase, beatAt: Date.now() });
        sendResponse({ ok: true });
        break;

      case 'RUN_STARTED':
        await setState({
          running: true, paused: false, blocked: null, phase: 'starting',
          episode: msg.episode, total: msg.total, done: 0, saveLog: msg.saveLog !== false,
          current: null, currentIndex: 0, log: [],
          startedAt: Date.now(), finishedAt: null, beatAt: Date.now()
        });
        sendResponse({ ok: true });
        break;

      case 'SCENE_STARTED':
        await setState({ current: msg.sceneId, currentIndex: msg.index || 0, beatAt: Date.now() });
        sendResponse({ ok: true });
        break;

      case 'SCENE_DONE': {
        const state = await getState();
        await setState({
          done: state.done + 1,
          current: null,
          beatAt: Date.now(),
          log: [...state.log, {
            sceneId: msg.sceneId,
            status: msg.status,
            url: msg.url || null,
            filename: msg.filename || null,
            resolution: msg.resolution || null,
            error: msg.error || null,
            hint: msg.hint || null,
            where: msg.where || null,
            failedDuring: msg.phase || null,
            prompt: msg.prompt || null,
            at: new Date().toISOString()
          }]
        });
        sendResponse({ ok: true });
        break;
      }

      case 'RUN_BLOCKED':
        await setState({ blocked: { reason: msg.reason, hint: msg.hint } });
        sendResponse({ ok: true });
        break;

      case 'DOWNLOAD_IMAGE':
        try { sendResponse({ ok: true, ...(await downloadImage(msg)) }); }
        catch (err) { sendResponse({ ok: false, error: String(err) }); }
        break;

      case 'RUN_FINISHED': {
        const state = await getState();
        // Detach immediately so Chrome's "being debugged" banner never outlives
        // the run that needed it.
        await trusted.detach();
        await setState({ running: false, paused: false, phase: null, current: null, finishedAt: Date.now() });
        // Nothing attempted means nothing worth writing.
        if (state.log.length && state.saveLog !== false) {
          try { await downloadRunLog(state.episode, state.log); } catch (_) {}
        }
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown message ' + msg.type });
    }
  })();
  return true;
});

// A tab closing or navigating mid-run leaves `running` stuck on. Clear it so
// the popup never comes back to a permanently disabled Start button.
async function clearIfOrphaned() {
  const state = await getState();
  if (!state.running) return;
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/*' });
  if (!tabs.length) {
    await trusted.detach();
    await setState({ running: false, paused: false, phase: null, current: null });
  }
}
chrome.tabs.onRemoved.addListener(clearIfOrphaned);

/* Navigating or reloading the debugged tab destroys the content script, so the
 * run is over whether or not it said so. Let go of the debugger immediately —
 * otherwise the banner outlives the run that justified it. */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  if (trusted.attachedTab() !== tabId) return;
  await trusted.detach();
  await setState({ running: false, paused: false, phase: null, current: null });
});

/* Last line of defence: if the debugger is attached but nothing is running, or
 * a run has gone quiet, drop it. Covers a service-worker restart, which loses
 * our bookkeeping while Chrome keeps the attachment. */
const WATCHDOG_ALARM = 'flow-batch-watchdog';
chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  const state = await getState();
  const quiet = state.beatAt && Date.now() - state.beatAt > 90_000;
  if (!state.running || quiet) {
    await trusted.detach();
    await trusted.detachStale();
    if (state.running) await setState({ running: false, paused: false, phase: null, current: null });
  }
});

async function resetOnLoad() {
  await setState({ running: false, paused: false, phase: null });
  await trusted.detachStale();
}
chrome.runtime.onStartup.addListener(resetOnLoad);
chrome.runtime.onInstalled.addListener(resetOnLoad);
resetOnLoad();
