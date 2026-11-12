// Run: node --test gateway/creds.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLumoCredentials } from "./creds.mjs";

// Builds a Firefox-style profile dir containing a cookies.sqlite with the given rows.
// Columns beyond the ones FF_SELECT needs (name, value, host, lastAccessed) mirror the
// real schema loosely; only the queried ones matter.
function makeFirefoxProfile(rows, { subdir = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lumo-creds-test-"));
  const profile = subdir ? (mkdirSync(join(root, subdir), { recursive: true }), join(root, subdir)) : root;
  const dbPath = join(profile, "cookies.sqlite");
  const con = new DatabaseSync(dbPath);
  try {
    con.exec(`CREATE TABLE moz_cookies (
      id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT,
      path TEXT DEFAULT '/', expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER,
      lastAccessed INTEGER, creationTime INTEGER)`);
    const ins = con.prepare("INSERT INTO moz_cookies (name, value, host, lastAccessed) VALUES (?, ?, ?, ?)");
    for (const [name, value, host, lastAccessed] of rows) ins.run(name, value, host, lastAccessed);
  } finally { con.close(); }
  return { root, dbPath };
}

const GOOD = ["AUTH-12345", "tok123", "lumo.proton.me", 2000];
const DISTRACTORS = [
  ["AUTH-99999", "older-token", "lumo.proton.me", 1000],   // older AUTH- cookie: must lose on ordering
  ["AUTH-00000", "", "lumo.proton.me", 3000],               // empty value: excluded
  ["SESSIONID", "not-auth", "lumo.proton.me", 4000],         // non-AUTH name: excluded
  ["AUTH-77777", "wrong-host", "example.com", 5000],        // other host: excluded by LIKE
];

test("Firefox fixture profile yields uid, token and the cookies.sqlite source", () => {
  const { root, dbPath } = makeFirefoxProfile([GOOD, ...DISTRACTORS]);
  try {
    const creds = readLumoCredentials({ firefoxProfiles: [root] });
    assert.deepEqual(creds, { uid: "12345", token: "tok123", source: dbPath });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("profile found in a subdirectory of the searched root is also scanned", () => {
  const { root, dbPath } = makeFirefoxProfile([GOOD], { subdir: "abc123.default-release" });
  try {
    const creds = readLumoCredentials({ firefoxProfiles: [root] });
    assert.equal(creds?.uid, "12345");
    assert.equal(creds?.source, dbPath);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a profile with no matching AUTH cookie returns null, without falling through", () => {
  // Rows that each fail exactly one WHERE clause of FF_SELECT.
  const { root } = makeFirefoxProfile([
    ["AUTH-00000", "", "lumo.proton.me", 3000],       // empty value: excluded
    ["SESSIONID", "not-auth", "lumo.proton.me", 4000], // non-AUTH name: excluded
    ["AUTH-77777", "wrong-host", "example.com", 5000], // other host: excluded by LIKE
  ]);
  try {
    assert.equal(readLumoCredentials({ firefoxProfiles: [root] }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing profile directory is skipped without throwing", () => {
  assert.equal(readLumoCredentials({ firefoxProfiles: [join(tmpdir(), "lumo-no-such-profile")] }), null);
});

// Runs fn with every browser location (HOME, USERPROFILE, APPDATA, LOCALAPPDATA,
// XDG_CONFIG_HOME) pointed into a fresh temp dir, so unseamed calls can never open a real
// browser store. Returns the temp dir's APPDATA so a test can plant fixture profiles.
function withIsolatedHome(extraEnv, fn) {
  const home = mkdtempSync(join(tmpdir(), "lumo-creds-home-"));
  const iso = {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_LUMO_STATE_DIR: join(home, ".claude-lumo"), LUMO_FIREFOX_PROFILE: undefined,
    LUMO_TOKEN: undefined, LUMO_UID: undefined, ...extraEnv,
  };
  const saved = Object.fromEntries(Object.keys(iso).map((k) => [k, process.env[k]]));
  const set = (vars) => { for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  try {
    mkdirSync(iso.APPDATA, { recursive: true });
    mkdirSync(iso.CLAUDE_LUMO_STATE_DIR, { recursive: true });
    set(iso);
    return fn({ home, appData: iso.APPDATA, stateDir: iso.CLAUDE_LUMO_STATE_DIR });
  } finally { set(saved); rmSync(home, { recursive: true, force: true }); }
}

test("without the seam, LUMO_TOKEN/LUMO_UID env vars take priority over everything", () => {
  withIsolatedHome({ LUMO_TOKEN: "envtok", LUMO_UID: "42" }, () => {
    const c = readLumoCredentials();
    assert.equal(c?.source, "env");
    assert.equal(c?.uid, "42");
    assert.ok(c?.token === "envtok", "env token returned"); // assert.ok: never prints a token
  });
});

// ---------- readAllLumoCredentials: every browser, every profile (#210) ----------

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readAllLumoCredentials, credLabel } from "./creds.mjs";

// Builds a Chromium-style user-data dir: "Local State" plus <profile>/Network/Cookies
// holding rows encrypted the way this platform's Chromium does (v10 prefix), so the
// real decrypt path runs with a key injected through keyFor.
const KEY = randomBytes(process.platform === "win32" ? 32 : 16);
function encryptV10(plain) {
  return encryptV10Bytes(Buffer.from(plain, "utf8"));
}
// Meta version >= 24: Chromium prepends SHA256(host_key) to the plaintext before encrypting.
const encryptV24 = (plain, host) => encryptV10Bytes(Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(plain, "utf8")]));
function encryptV10Bytes(plain) {
  if (process.platform === "win32") {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", KEY, nonce);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.from("v10"), nonce, body, c.getAuthTag()]);
  }
  const c = createCipheriv("aes-128-cbc", KEY, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), c.update(plain), c.final()]);
}
const chromiumTime = (msSince1970) => (msSince1970 + 11644473600000) * 1000; // µs since 1601
function makeChromiumDir(profiles, { metaVersion = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lumo-creds-chr-"));
  writeFileSync(join(dir, "Local State"), "{}");
  for (const [profile, rows] of Object.entries(profiles)) {
    mkdirSync(join(dir, profile, "Network"), { recursive: true });
    const con = new DatabaseSync(join(dir, profile, "Network", "Cookies"));
    try {
      con.exec("CREATE TABLE cookies (name TEXT, encrypted_value BLOB, host_key TEXT, last_access_utc INTEGER)");
      if (metaVersion !== null) {
        con.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
        con.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(metaVersion));
      }
      const ins = con.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?)");
      for (const [name, blob, host, ms] of rows) ins.run(name, blob, host, chromiumTime(ms));
    } finally { con.close(); }
  }
  return dir;
}
const keyFor = () => KEY;
const us = (ms) => ms * 1000; // Firefox lastAccessed is µs since 1970

test("all profiles and browsers are returned, most recently used first", () => {
  const ff = mkdtempSync(join(tmpdir(), "lumo-creds-ff-"));
  makeFirefoxProfileAt(ff, "a.default", [["AUTH-1", "ff-a", "lumo.proton.me", us(3000)]]);
  makeFirefoxProfileAt(ff, "b.dev-edition", [["AUTH-2", "ff-b", "lumo.proton.me", us(1000)]]);
  const chr = makeChromiumDir({
    Default: [["AUTH-3", encryptV10("chr-default"), ".lumo.proton.me", 4000]],
    "Profile 2": [["AUTH-4", encryptV10("chr-p2"), "lumo.proton.me", 2000]],
  });
  try {
    const all = readAllLumoCredentials({ roots: { firefox: [[ff, "Firefox"]], chromium: [[chr, "Chrome"]] }, keyFor });
    assert.deepEqual(all.map((c) => c.token), ["chr-default", "ff-a", "chr-p2", "ff-b"]);
    assert.deepEqual(all.map((c) => c.uid), ["3", "1", "4", "2"]);
    assert.deepEqual(all.map(credLabel), ["Chrome (Default)", "Firefox (a.default)", "Chrome (Profile 2)", "Firefox (b.dev-edition)"]);
    assert.deepEqual([...all.checked].sort(), ["Chrome", "Firefox"]);
  } finally { for (const d of [ff, chr]) rmSync(d, { recursive: true, force: true }); }
});

test("every AUTH-* row in one store is a candidate (no LIMIT 1), newest first", () => {
  const { root } = makeFirefoxProfile([
    ["AUTH-1", "older", "lumo.proton.me", us(1000)],
    ["AUTH-2", "newer", "lumo.proton.me", us(2000)],
  ]);
  try {
    assert.deepEqual(readAllLumoCredentials({ firefoxProfiles: [root] }).map((c) => c.token), ["newer", "older"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the same token in several profiles is returned once, at its most recent position", () => {
  const ff = mkdtempSync(join(tmpdir(), "lumo-creds-ff-"));
  makeFirefoxProfileAt(ff, "p1", [["AUTH-1", "shared", "lumo.proton.me", us(1000)]]);
  makeFirefoxProfileAt(ff, "p2", [["AUTH-1", "shared", "lumo.proton.me", us(5000)], ["AUTH-9", "other", "lumo.proton.me", us(3000)]]);
  try {
    const all = readAllLumoCredentials({ roots: { firefox: [[ff, "Firefox"]] } });
    assert.deepEqual(all.map((c) => c.token), ["shared", "other"]);
    assert.equal(all[0].profile, "p2");
  } finally { rmSync(ff, { recursive: true, force: true }); }
});

test("undecryptable (app-bound v20) Chromium cookies are skipped and logged by browser, never by value", () => {
  const chr = makeChromiumDir({
    Default: [
      ["AUTH-5", Buffer.concat([Buffer.from("v20"), randomBytes(40)]), "lumo.proton.me", 9000],
      ["AUTH-6", encryptV10("chr-ok"), "lumo.proton.me", 1000],
    ],
  });
  const logs = [];
  try {
    const all = readAllLumoCredentials({ roots: { chromium: [[chr, "Edge"]] }, keyFor, log: (m) => logs.push(m) });
    assert.deepEqual(all.map((c) => c.token), ["chr-ok"]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Edge \(Default\).*1 Lumo cookie\(s\) not decryptable/);
    assert.ok(!logs[0].includes("chr-ok"));
  } finally { rmSync(chr, { recursive: true, force: true }); }
});

test("readLumoCredentials returns the first candidate as { uid, token, source }", () => {
  const ff = mkdtempSync(join(tmpdir(), "lumo-creds-ff-"));
  makeFirefoxProfileAt(ff, "old", [["AUTH-1", "stale", "lumo.proton.me", us(9000)]]);
  const fresh = makeFirefoxProfileAt(ff, "new", [["AUTH-2", "valid", "lumo.proton.me", us(1000)]]);
  try {
    const c = readLumoCredentials({ roots: { firefox: [[ff, "Firefox"]] } });
    assert.deepEqual(Object.keys(c).sort(), ["source", "token", "uid"]);
    assert.equal(c.token, "stale"); // most recently used wins the single-login API
    assert.equal(readAllLumoCredentials({ roots: { firefox: [[ff, "Firefox"]] } })[1].source, fresh);
  } finally { rmSync(ff, { recursive: true, force: true }); }
});

test("env and login.json come first in the walk; the single pick never opens a browser store", () => {
  withIsolatedHome({ LUMO_TOKEN: "envtok", LUMO_UID: "42" }, ({ appData, stateDir }) => {
    writeFileSync(join(stateDir, "login.json"), JSON.stringify({ uid: "7", token: "manual" }));
    const ffRoot = join(appData, "Mozilla", "Firefox", "Profiles");
    makeFirefoxProfileAt(ffRoot, "good", [["AUTH-1", "browser-tok", "lumo.proton.me", us(9000)]]);
    mkdirSync(join(ffRoot, "corrupt"));
    writeFileSync(join(ffRoot, "corrupt", "cookies.sqlite"), "not a database");

    const logs = [];
    const all = readAllLumoCredentials({ log: (m) => logs.push(m) });
    assert.deepEqual(all.map(credLabel), ["env", "login.json", "Firefox (good)"]);
    assert.ok(logs.some((l) => /Firefox \(corrupt\).*unreadable/.test(l)), "the walk scans browser stores");

    // Short-circuit: env wins without any browser store being opened (no log from the corrupt one).
    const pickLogs = [];
    assert.equal(readLumoCredentials({ log: (m) => pickLogs.push(m) })?.source, "env");
    assert.deepEqual(pickLogs, []);
    delete process.env.LUMO_TOKEN;
    assert.equal(readLumoCredentials({ log: (m) => pickLogs.push(m) })?.source, join(stateDir, "login.json"));
    assert.deepEqual(pickLogs, []);
    // Without env and login.json the pick falls back to the browser scan.
    rmSync(join(stateDir, "login.json"));
    const c = readLumoCredentials({ log: (m) => pickLogs.push(m) });
    assert.match(c?.source ?? "", /good/);
    assert.ok(pickLogs.length > 0, "browser stores scanned only now");
  });
});

test("Chromium meta version >= 24: the SHA256(host) prefix is stripped from decrypted values", () => {
  const chr = makeChromiumDir({ Default: [["AUTH-8", encryptV24("chr-v24", ".lumo.proton.me"), ".lumo.proton.me", 5000]] }, { metaVersion: 24 });
  const old = makeChromiumDir({ Default: [["AUTH-9", encryptV10("chr-v23"), "lumo.proton.me", 4000]] }, { metaVersion: 23 });
  const logs = [];
  try {
    const all = readAllLumoCredentials({ roots: { chromium: [[chr, "Chrome"], [old, "Edge"]] }, keyFor, log: (m) => logs.push(m) });
    assert.equal(all.length, 2);
    assert.ok(all[0].token === "chr-v24", "v24 value decoded without the host hash");
    assert.ok(all[1].token === "chr-v23", "pre-24 value decoded unchanged");
    assert.deepEqual(logs, []);
  } finally { for (const d of [chr, old]) rmSync(d, { recursive: true, force: true }); }
});

test("a value that is not a valid header (hash prefix left in) is skipped and can never outrank a valid login", () => {
  // meta v24 store whose row lacks the hash would decode wrong; simulate the old bug with
  // a v24 row read as v23 (no meta table): the 32 hash bytes stay in and are not ASCII.
  const chr = makeChromiumDir({ Default: [["AUTH-8", encryptV24("chr-v24", "lumo.proton.me"), "lumo.proton.me", 9000]] });
  const ff = mkdtempSync(join(tmpdir(), "lumo-creds-ff-"));
  makeFirefoxProfileAt(ff, "a", [["AUTH-1", "ff-valid", "lumo.proton.me", us(1000)]]);
  const logs = [];
  try {
    const roots = { firefox: [[ff, "Firefox"]], chromium: [[chr, "Chrome"]] };
    const all = readAllLumoCredentials({ roots, keyFor, log: (m) => logs.push(m) });
    assert.deepEqual(all.map(credLabel), ["Firefox (a)"]);
    assert.ok(logs.some((l) => /Chrome \(Default\).*not a valid header value/.test(l)));
    assert.equal(readLumoCredentials({ roots, keyFor })?.source, join(ff, "a", "cookies.sqlite")); // startup pick
  } finally { for (const d of [chr, ff]) rmSync(d, { recursive: true, force: true }); }
});

// A Firefox profile named `name` inside an existing Profiles-style root; returns its cookies.sqlite.
function makeFirefoxProfileAt(root, name, rows) {
  mkdirSync(join(root, name), { recursive: true });
  const dbPath = join(root, name, "cookies.sqlite");
  const con = new DatabaseSync(dbPath);
  try {
    con.exec("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, lastAccessed INTEGER)");
    const ins = con.prepare("INSERT INTO moz_cookies (name, value, host, lastAccessed) VALUES (?, ?, ?, ?)");
    for (const r of rows) ins.run(...r);
  } finally { con.close(); }
  return dbPath;
}
