// Reads the live Lumo login (AUTH-<uid> cookie) from the user's browsers.
//
// Sources:
//   1. LUMO_TOKEN + LUMO_UID environment variables
//   2. <CLAUDE_LUMO_STATE_DIR>/login.json (default ~/.claude-lumo; manual fallback)
//   3. Firefox family (Firefox, Developer Edition, Nightly, LibreWolf, Waterfox, Zen,
//      Floorp, Mullvad Browser, ...) — every profile; cookie store is plaintext SQLite
//   4. Chromium family (Chrome + Beta/Dev/Canary, Chromium, Edge channels, Brave, Vivaldi,
//      Opera, Opera GX, Arc, ...) — every profile; encrypted SQLite, decrypted locally
//
// readAllLumoCredentials() returns EVERY candidate login (env and login.json first, then
// every browser AUTH-* cookie for lumo.proton.me, most recently used first, de-duplicated
// by token), so a stale cookie in one browser or profile never hides a valid one in
// another (#210). readLumoCredentials() returns the first candidate.
//
// Every browser file is copied to a temp dir first so no browser's lock is ever touched.
// Works on Windows, macOS and Linux. Chromium v20 (app-bound) cookies on very new Chrome
// can't be decrypted; those are skipped (logged by browser name) and the manual fallback
// covers them (see README). Token values are never logged.
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { platform } from "node:process";

// ---------- candidate cookie databases ----------

// Firefox-family roots: [dir, browser label]. Each root is either a profile dir itself
// (contains cookies.sqlite) or a "Profiles" dir whose subdirs are profiles. Firefox,
// Developer Edition and Nightly all share the Mozilla/Firefox root (separate profiles).
function firefoxRoots() {
  const ad = process.env.APPDATA, home = homedir();
  const as = join(home, "Library", "Application Support");
  const roots = [];
  if (ad) roots.push(
    [join(ad, "Mozilla", "Firefox", "Profiles"), "Firefox"],
    [join(ad, "LibreWolf", "Profiles"), "LibreWolf"],
    [join(ad, "Waterfox", "Profiles"), "Waterfox"],
    [join(ad, "zen", "Profiles"), "Zen"],
    [join(ad, "Floorp", "Profiles"), "Floorp"],
    [join(ad, "Mullvad", "MullvadBrowser", "Profiles"), "Mullvad Browser"],
    [join(ad, "Mozilla", "SeaMonkey", "Profiles"), "SeaMonkey"],
    [join(ad, "Moonchild Productions", "Pale Moon", "Profiles"), "Pale Moon"],
    ...extraProfilesDirs(ad));
  roots.push(
    // macOS
    [join(as, "Firefox", "Profiles"), "Firefox"],
    [join(as, "LibreWolf", "Profiles"), "LibreWolf"],
    [join(as, "Waterfox", "Profiles"), "Waterfox"],
    [join(as, "zen", "Profiles"), "Zen"],
    [join(as, "Floorp", "Profiles"), "Floorp"],
    ...extraProfilesDirs(as),
    // Linux (incl. Flatpak and Snap Firefox)
    [join(home, ".mozilla", "firefox"), "Firefox"],
    [join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"), "Firefox"],
    [join(home, "snap", "firefox", "common", ".mozilla", "firefox"), "Firefox"],
    [join(home, ".librewolf"), "LibreWolf"],
    [join(home, ".var", "app", "io.gitlab.librewolf-community", ".librewolf"), "LibreWolf"],
    [join(home, ".waterfox"), "Waterfox"],
    [join(home, ".zen"), "Zen"],
    [join(home, ".floorp"), "Floorp"]);
  // explicit override (path to the profile dir containing cookies.sqlite)
  if (process.env.LUMO_FIREFOX_PROFILE) roots.push([process.env.LUMO_FIREFOX_PROFILE, "Firefox"]);
  return roots;
}

// Any other Mozilla-style "<base>/<Vendor>/Profiles" or "<base>/<Vendor>/<App>/Profiles"
// dir (forks not named above). Only directory names are listed here; nothing is opened.
function extraProfilesDirs(base) {
  const subdirs = (d) => {
    try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { return []; }
  };
  const out = [];
  for (const a of subdirs(base)) {
    if (existsSync(join(base, a, "Profiles"))) out.push([join(base, a, "Profiles"), a]);
    for (const b of subdirs(join(base, a)))
      if (b !== "Profiles" && existsSync(join(base, a, b, "Profiles"))) out.push([join(base, a, b, "Profiles"), b]);
  }
  return out;
}

// Returns [{ db, browser, profile }] for every cookies.sqlite under the given roots,
// de-duplicated by path (a root can be reached both by name and by the generic scan;
// the named entry comes first, so its label wins).
function firefoxDbs(roots) {
  const out = [], seen = new Set();
  const add = (db, browser, profile) => {
    const key = resolve(db).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key); out.push({ db, browser, profile });
  };
  for (const [root, browser] of roots) {
    if (!root || !existsSync(root)) continue;
    if (existsSync(join(root, "cookies.sqlite"))) add(join(root, "cookies.sqlite"), browser, basename(root));
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch {}
    for (const e of entries)
      if (e.isDirectory() && existsSync(join(root, e.name, "cookies.sqlite")))
        add(join(root, e.name, "cookies.sqlite"), browser, e.name);
  }
  return out;
}

// Chromium-family user-data dirs: [userDataDir, browser label]. "Local State" (with the
// encryption key) sits in userDataDir; cookies in <profile>/Network/Cookies (Chromium 96+)
// or <profile>/Cookies (older), where <profile> is Default / Profile N, or userDataDir
// itself for Opera.
function chromiumRoots() {
  const dirs = [];
  const la = process.env.LOCALAPPDATA, ad = process.env.APPDATA;
  const as = join(homedir(), "Library", "Application Support");
  const cfg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  if (la) dirs.push(
    [join(la, "Google", "Chrome", "User Data"), "Chrome"],
    [join(la, "Google", "Chrome Beta", "User Data"), "Chrome Beta"],
    [join(la, "Google", "Chrome Dev", "User Data"), "Chrome Dev"],
    [join(la, "Google", "Chrome SxS", "User Data"), "Chrome Canary"],
    [join(la, "Chromium", "User Data"), "Chromium"],
    [join(la, "Microsoft", "Edge", "User Data"), "Edge"],
    [join(la, "Microsoft", "Edge Beta", "User Data"), "Edge Beta"],
    [join(la, "Microsoft", "Edge Dev", "User Data"), "Edge Dev"],
    [join(la, "Microsoft", "Edge SxS", "User Data"), "Edge Canary"],
    [join(la, "BraveSoftware", "Brave-Browser", "User Data"), "Brave"],
    [join(la, "BraveSoftware", "Brave-Browser-Beta", "User Data"), "Brave Beta"],
    [join(la, "BraveSoftware", "Brave-Browser-Nightly", "User Data"), "Brave Nightly"],
    [join(la, "Vivaldi", "User Data"), "Vivaldi"],
    [join(la, "Yandex", "YandexBrowser", "User Data"), "Yandex"],
    [join(la, "Thorium", "User Data"), "Thorium"],
    [join(la, "Opera Software", "Opera Stable"), "Opera"]);
  if (ad) dirs.push(
    [join(ad, "Opera Software", "Opera Stable"), "Opera"],
    [join(ad, "Opera Software", "Opera GX Stable"), "Opera GX"]);
  dirs.push(
    // macOS
    [join(as, "Google", "Chrome"), "Chrome"],
    [join(as, "Google", "Chrome Beta"), "Chrome Beta"],
    [join(as, "Google", "Chrome Dev"), "Chrome Dev"],
    [join(as, "Google", "Chrome Canary"), "Chrome Canary"],
    [join(as, "Chromium"), "Chromium"],
    [join(as, "Microsoft Edge"), "Edge"],
    [join(as, "Microsoft Edge Beta"), "Edge Beta"],
    [join(as, "Microsoft Edge Dev"), "Edge Dev"],
    [join(as, "BraveSoftware", "Brave-Browser"), "Brave"],
    [join(as, "Vivaldi"), "Vivaldi"],
    [join(as, "Arc", "User Data"), "Arc"],
    [join(as, "com.operasoftware.Opera"), "Opera"],
    [join(as, "com.operasoftware.OperaGX"), "Opera GX"],
    // Linux
    [join(cfg, "google-chrome"), "Chrome"],
    [join(cfg, "google-chrome-beta"), "Chrome Beta"],
    [join(cfg, "google-chrome-unstable"), "Chrome Dev"],
    [join(cfg, "chromium"), "Chromium"],
    [join(cfg, "microsoft-edge"), "Edge"],
    [join(cfg, "microsoft-edge-beta"), "Edge Beta"],
    [join(cfg, "microsoft-edge-dev"), "Edge Dev"],
    [join(cfg, "BraveSoftware", "Brave-Browser"), "Brave"],
    [join(cfg, "brave-browser"), "Brave"],
    [join(cfg, "vivaldi"), "Vivaldi"],
    [join(cfg, "opera"), "Opera"]);
  return dirs;
}

// Returns [{ dir, browser, cookies, profile }] for every Chromium cookie DB under the roots.
function chromiumDbs(roots) {
  const out = [], seen = new Set();
  const cookiesIn = (d) => [join(d, "Network", "Cookies"), join(d, "Cookies")].find((p) => existsSync(p));
  for (const [dir, browser] of roots) {
    if (!dir || !existsSync(join(dir, "Local State"))) continue;
    const profiles = [];
    const top = cookiesIn(dir); // Opera layout: the user-data dir is the profile
    if (top) profiles.push([".", top]);
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (!e.isDirectory() || !(e.name === "Default" || e.name.startsWith("Profile "))) continue;
      const c = cookiesIn(join(dir, e.name));
      if (c) profiles.push([e.name, c]);
    }
    for (const [profile, cookies] of profiles) {
      const key = resolve(cookies).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); out.push({ dir, browser, cookies, profile });
    }
  }
  return out;
}

// ---------- decryption (Chromium family) ----------

function dpapiUnprotect(b64) {
  // Windows: the AES key in Local State is itself DPAPI-encrypted; unwrap via PowerShell.
  const ps = `$b=[Convert]::FromBase64String('${b64}');` +
    `$u=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');` +
    `[Convert]::ToBase64String($u)`;
  return Buffer.from(execFileSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, encoding: "utf8" }).trim(), "base64");
}

function chromiumEncryptionKey(userDataDir) {
  // Non-Windows: returns the password bytes (marker stripped later), not an AES key.
  try {
    const local = JSON.parse(readFileSync(join(userDataDir, "Local State"), "utf8"));
    let b64 = local.os_crypt?.encrypted_key ?? "";
    if (!b64) return null;
    const raw = Buffer.from(b64, "base64");
    if (platform === "win32") {
      if (raw.subarray(0, 5).toString() !== "DPAPI") return null;
      return dpapiUnprotect(raw.subarray(5).toString("base64"));
    }
    return raw; // password bytes for PBKDF2 (see chromiumAesKey)
  } catch { /* unreadable key: Chromium unusable, fall back */ }
  return null;
}

// The AES key only changes when "Local State" does; cache it so the 401 poll (which
// re-reads every browser every few seconds) doesn't spawn PowerShell each time.
const keyCache = new Map();
function cachedAesKey(userDataDir, browser) {
  let mtime = 0;
  try { mtime = statSync(join(userDataDir, "Local State")).mtimeMs; } catch {}
  const hit = keyCache.get(userDataDir);
  if (hit && hit.mtime === mtime) return hit.key;
  const key = chromiumAesKey(userDataDir, browser);
  keyCache.set(userDataDir, { mtime, key });
  return key;
}

function chromiumAesKey(userDataDir, browser) {
  if (platform === "win32") {
    return chromiumEncryptionKey(userDataDir); // DPAPI-unwrapped raw AES-256 key
  }
  let password = null;
  if (platform === "darwin") {
    password = macSafeStoragePassword(browser); // Keychain, e.g. "Chrome Safe Storage"
  } else {
    // Linux: Local State may pin a password; otherwise the well-known default.
    const key = chromiumEncryptionKey(userDataDir);
    if (key) {
      let raw = key.toString("latin1");
      if (raw.startsWith("v10")) raw = raw.slice(3);
      password = raw;
    } else {
      password = "peanuts";
    }
  }
  return password ? deriveKey(password) : null;
}

function deriveKey(password) {
  // macOS/Linux Chromium: PBKDF2-HMAC-SHA1, salt "saltysalt", length 16.
  // Iterations differ: macOS 1003, Linux 1.
  return pbkdf2Sync(password, "saltysalt", platform === "darwin" ? 1003 : 1, 16, "sha1");
}

function macSafeStoragePassword(browser) {
  // macOS: the Chromium AES password lives in the Keychain ("Chrome Safe Storage" etc.).
  const svc = browser.startsWith("Edge") ? "Microsoft Edge Safe Storage"
    : browser.startsWith("Brave") ? "Brave Safe Storage"
    : browser.startsWith("Opera") ? "Opera Safe Storage"
    : browser === "Vivaldi" ? "Vivaldi Safe Storage"
    : browser === "Chromium" ? "Chromium Safe Storage"
    : browser === "Arc" ? "Arc Safe Storage"
    : "Chrome Safe Storage";
  try {
    return execFileSync("security", ["find-generic-password", "-w", "-s", svc],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

export function decryptCookieValue(blob, key) {
  // Chromium cookie values: "v10"/"v11" prefix + payload.
  //   Windows (v10/v11): AES-256-GCM, 12-byte nonce after the prefix, 16-byte tag at the end.
  //   macOS/Linux (v10/v11): AES-128-CBC, IV is 16 space chars.
  //   v20 (app-bound, Chrome >= 127 on Windows): not decryptable here.
  const tag = blob.subarray(0, 3).toString();
  if (tag === "v20") throw new Error("app-bound cookie (unsupported)");
  if (!tag.startsWith("v1")) return blob.toString("utf8"); // legacy plaintext
  const data = blob.subarray(3);
  if (platform === "win32") {
    const d = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    d.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([d.update(data.subarray(12, data.length - 16)), d.final()]).toString("utf8");
  }
  const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

// ---------- readers ----------

function readFromDb(cookiesPath, query, params = []) {
  // Copy the DB (and wal) so the browser's lock is never held, then query it.
  const dir = mkdtempSync(join(tmpdir(), "lumo-proxy-"));
  try {
    copyFileSync(cookiesPath, join(dir, "cookies.sqlite"));
    if (existsSync(cookiesPath + "-wal")) copyFileSync(cookiesPath + "-wal", join(dir, "cookies.sqlite-wal"));
    const con = new DatabaseSync(join(dir, "cookies.sqlite"));
    try { return con.prepare(query).all(...params); } finally { con.close(); }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

// Firefox and Chrome cookie stores are both SQLite but with different schemas:
//   Firefox: moz_cookies(name, value, host, lastAccessed: microseconds since 1970)
//   Chromium: cookies(name, encrypted_value, host_key, last_access_utc: microseconds since 1601)
const FF_SELECT = "SELECT name, value, lastAccessed FROM moz_cookies " +
  "WHERE host LIKE '%lumo.proton.me' AND name LIKE 'AUTH-%' AND value != '' " +
  "ORDER BY lastAccessed DESC";
// last_access_utc (~1.3e16) exceeds 2^53, which node:sqlite refuses to return as a
// Number, so it is divided down to milliseconds in SQL.
const CHR_SELECT = "SELECT name, encrypted_value, last_access_utc / 1000 AS last_access_ms FROM cookies " +
  "WHERE host_key LIKE '%lumo.proton.me' AND name LIKE 'AUTH-%' " +
  "ORDER BY last_access_utc DESC";
const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000; // 1601-01-01 -> 1970-01-01

function readFirefox({ db, browser, profile }) {
  const mtime = mtimeOf(db);
  return readFromDb(db, FF_SELECT).filter((r) => r.value).map((r) => ({
    uid: r.name.slice(5), token: r.value, source: db, browser, profile,
    lastAccessed: r.lastAccessed ? Number(r.lastAccessed) / 1000 : mtime,
  }));
}

function readChromium(entry, { log, keyFor }) {
  const rows = readFromDb(entry.cookies, CHR_SELECT);
  if (!rows.length) return []; // no Lumo cookie: don't touch the key store at all
  const label = `${entry.browser}${entry.profile && entry.profile !== "." ? ` (${entry.profile})` : ""}`;
  const key = keyFor(entry.dir, entry.browser);
  if (!key) { log(`creds: ${label}: Lumo cookie present but the browser key is unavailable; skipped`); return []; }
  const mtime = mtimeOf(entry.cookies);
  const out = [];
  let skipped = 0;
  for (const r of rows) {
    if (!r.encrypted_value) continue;
    try {
      const token = decryptCookieValue(Buffer.from(r.encrypted_value), key);
      if (!token) continue;
      out.push({
        uid: r.name.slice(5), token, source: entry.cookies, browser: entry.browser, profile: entry.profile,
        lastAccessed: r.last_access_ms ? Number(r.last_access_ms) - CHROMIUM_EPOCH_OFFSET_MS : mtime,
      });
    } catch { skipped++; }
  }
  if (skipped) log(`creds: ${label}: ${skipped} Lumo cookie(s) not decryptable (app-bound v20 or key mismatch); skipped`);
  return out;
}

// ---------- entry points ----------

// Every candidate Lumo login, best first: env, then login.json (explicit choices), then
// every browser AUTH-* cookie for lumo.proton.me sorted by last access (cookie timestamp,
// else the cookie DB's mtime), de-duplicated by token (first occurrence wins). Each entry
// is { uid, token, source, browser, profile?, lastAccessed? }. The returned array also
// carries `checked`: the browser labels whose cookie stores were found and read.
//
// Options (tests): `firefoxProfiles` (profile dirs to search, replaces everything else,
// kept for the original seam), `roots: { firefox: [[dir, label]], chromium: [[dir, label]] }`
// (replaces env, login.json and the real browser locations), `keyFor(dir, browser)`
// (Chromium AES key), `log(msg)` (never receives token values).
export function readAllLumoCredentials(opts = {}) {
  const log = opts.log ?? (() => {});
  const keyFor = opts.keyFor ?? cachedAesKey;
  const seam = opts.roots ?? (opts.firefoxProfiles ? { firefox: opts.firefoxProfiles.map((d) => [d, "Firefox"]) } : null);
  const explicit = [];

  if (!seam) {
    // 1. Environment
    if (process.env.LUMO_TOKEN && process.env.LUMO_UID)
      explicit.push({ uid: process.env.LUMO_UID, token: process.env.LUMO_TOKEN, source: "env", browser: "env" });

    // 2. Manual fallback: login.json in the Lumo state dir, CLAUDE_LUMO_STATE_DIR
    // or the default ~/.claude-lumo (any browser, see README) (#96)
    const stateDir = process.env.CLAUDE_LUMO_STATE_DIR
      ? resolve(process.env.CLAUDE_LUMO_STATE_DIR)
      : join(homedir(), ".claude-lumo");
    const manual = join(stateDir, "login.json");
    try {
      const j = JSON.parse(readFileSync(manual, "utf8"));
      if (j.uid && j.token) explicit.push({ uid: j.uid, token: j.token, source: manual, browser: "login.json" });
    } catch {}
  }

  const browserRows = [];
  const checked = new Set();
  // 3. Firefox family (plaintext, always works)
  for (const entry of firefoxDbs(seam ? (seam.firefox ?? []) : firefoxRoots())) {
    checked.add(entry.browser);
    try { browserRows.push(...readFirefox(entry)); }
    catch { log(`creds: ${entry.browser} (${entry.profile}): cookie store unreadable; skipped`); }
  }
  // 4. Chromium family (best effort; v20/app-bound is skipped and logged)
  for (const entry of chromiumDbs(seam ? (seam.chromium ?? []) : chromiumRoots())) {
    checked.add(entry.browser);
    try { browserRows.push(...readChromium(entry, { log, keyFor })); }
    catch { log(`creds: ${entry.browser} (${entry.profile}): cookie store unreadable; skipped`); }
  }
  browserRows.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));

  const out = [], seen = new Set();
  for (const c of [...explicit, ...browserRows]) {
    if (seen.has(c.token)) continue;
    seen.add(c.token); out.push(c);
  }
  out.checked = [...checked];
  return out;
}

// The single best login (first candidate), as { uid, token, source }, or null.
// Same options as readAllLumoCredentials.
export function readLumoCredentials(opts = {}) {
  const first = readAllLumoCredentials(opts)[0];
  return first ? { uid: first.uid, token: first.token, source: first.source } : null;
}

// A short, token-free description of where a candidate came from, for logs and errors.
export function credLabel(c) {
  if (!c) return "none";
  if (c.source === "env" || c.browser === "env") return "env";
  if (c.browser === "login.json") return "login.json";
  if (c.browser) return c.profile && c.profile !== "." ? `${c.browser} (${c.profile})` : c.browser;
  return "unknown source";
}
