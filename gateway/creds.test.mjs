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

test("without the seam, LUMO_TOKEN/LUMO_UID env vars take priority over everything", () => {
  // Only exercises the env branch; never touches real browser profiles.
  const saved = { LUMO_TOKEN: process.env.LUMO_TOKEN, LUMO_UID: process.env.LUMO_UID };
  try {
    process.env.LUMO_TOKEN = "envtok";
    process.env.LUMO_UID = "42";
    assert.deepEqual(readLumoCredentials(), { uid: "42", token: "envtok", source: "env" });
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// ---------- readAllLumoCredentials: every browser, every profile (#210) ----------

import { createCipheriv, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readAllLumoCredentials, credLabel } from "./creds.mjs";

// Builds a Chromium-style user-data dir: "Local State" plus <profile>/Network/Cookies
// holding rows encrypted the way this platform's Chromium does (v10 prefix), so the
// real decrypt path runs with a key injected through keyFor.
const KEY = randomBytes(process.platform === "win32" ? 32 : 16);
function encryptV10(plain) {
  if (process.platform === "win32") {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", KEY, nonce);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return Buffer.concat([Buffer.from("v10"), nonce, body, c.getAuthTag()]);
  }
  const c = createCipheriv("aes-128-cbc", KEY, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), c.update(plain, "utf8"), c.final()]);
}
const chromiumTime = (msSince1970) => (msSince1970 + 11644473600000) * 1000; // µs since 1601
function makeChromiumDir(profiles) {
  const dir = mkdtempSync(join(tmpdir(), "lumo-creds-chr-"));
  writeFileSync(join(dir, "Local State"), "{}");
  for (const [profile, rows] of Object.entries(profiles)) {
    mkdirSync(join(dir, profile, "Network"), { recursive: true });
    const con = new DatabaseSync(join(dir, profile, "Network", "Cookies"));
    try {
      con.exec("CREATE TABLE cookies (name TEXT, encrypted_value BLOB, host_key TEXT, last_access_utc INTEGER)");
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

test("env and login.json come first, before any browser cookie", () => {
  const state = mkdtempSync(join(tmpdir(), "lumo-creds-state-"));
  writeFileSync(join(state, "login.json"), JSON.stringify({ uid: "7", token: "manual" }));
  const saved = { LUMO_TOKEN: process.env.LUMO_TOKEN, LUMO_UID: process.env.LUMO_UID, CLAUDE_LUMO_STATE_DIR: process.env.CLAUDE_LUMO_STATE_DIR };
  try {
    Object.assign(process.env, { LUMO_TOKEN: "envtok", LUMO_UID: "42", CLAUDE_LUMO_STATE_DIR: state });
    const all = readAllLumoCredentials();
    assert.deepEqual(all.slice(0, 2).map((c) => c.token), ["envtok", "manual"]);
    assert.deepEqual(all.slice(0, 2).map(credLabel), ["env", "login.json"]);
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(state, { recursive: true, force: true });
  }
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
