// Run: node --test gateway/upstream.test.mjs
// Tests createUpstream() with fake fetch/credentials: retry policy, 401 token
// refresh, and that no token value ever reaches errors or log lines.
import test from "node:test";
import assert from "node:assert/strict";
import { createUpstream } from "./upstream.mjs";

const TOKEN1 = "secret-token-one-aaaa", TOKEN2 = "secret-token-two-bbbb";
const cred = (token, uid = "uid-1") => ({ token, uid });

// A fetch that plays a scripted sequence of outcomes. An outcome is a Response
// or an Error (connection failure). Records every call's headers and body.
const fakeFetch = (outcomes) => {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const o = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (o instanceof Error) throw o;
    return o;
  };
  return { fn, calls };
};

const res = (status, body = "ok", headers = {}) =>
  new Response(body, { status, headers });

const setup = ({ outcomes, creds = cred(TOKEN1), freshCreds = cred(TOKEN2) } = {}) => {
  const f = fakeFetch(outcomes);
  const sleeps = [];
  const logs = [];
  let readCount = 0;
  const readCreds = () => { readCount++; return readCount === 1 ? creds : freshCreds; };
  const credsRef = { current: null };
  const upstream = createUpstream({
    fetchFn: f.fn, credsRef, readCreds, firstByteMs: 5000,
    log: (m) => logs.push(m), sleep: async (ms) => sleeps.push(ms),
  });
  return { f, sleeps, logs, credsRef, upstream, readCount };
};

test("success on the first try makes exactly one fetch call", async () => {
  const { f, upstream } = setup({ outcomes: [res(200)] });
  const r = await upstream("/chat/completions", "POST", '{"x":1}', { "content-type": "application/json" });
  assert.equal(r.status, 200);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /https:\/\/lumo\.proton\.me\/api\/ai\/v1\/chat\/completions$/);
  assert.equal(f.calls[0].opts.headers.authorization, `Bearer ${TOKEN1}`);
  assert.equal(f.calls[0].opts.headers["x-pm-uid"], "uid-1");
});

test("connection error then success: one retry with backoff, two fetches", async () => {
  const { f, upstream, sleeps, logs } = setup({ outcomes: [new Error("socket hang up"), res(200)] });
  const r = await upstream("/models", "GET", undefined, {});
  assert.equal(r.status, 200);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(sleeps, [1500]); // attempt 0 backoff
  assert.equal(logs.filter((l) => l.includes("connection error, retry 1")).length, 1);
  const authHeaders = f.calls.map((c) => c.opts.headers.authorization);
  assert.deepEqual(authHeaders, [`Bearer ${TOKEN1}`, `Bearer ${TOKEN1}`]);
});

test("401 then success: re-reads creds, rebuilds Authorization from the fresh token", async () => {
  const { f, upstream, logs, credsRef } = setup({ outcomes: [res(401), res(200)] });
  const r = await upstream("/chat/completions", "POST", "b", {});
  assert.equal(r.status, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(logs.filter((l) => l.includes("new token")).length, 1);
  assert.equal(credsRef.current.token, TOKEN2);
  assert.equal(f.calls[1].opts.headers.authorization, `Bearer ${TOKEN2}`);
  assert.equal(f.calls[1].opts.headers["x-pm-uid"], "uid-1");
  assert.notEqual(f.calls[0].opts.headers.authorization, f.calls[1].opts.headers.authorization);
});

// Runs fn with the rotation poll window set to zero, so an all-rejected walk ends at once.
const noPoll = async (fn) => {
  const saved = process.env.LUMO_AUTH_REFRESH_WAIT_MS;
  process.env.LUMO_AUTH_REFRESH_WAIT_MS = "0";
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.LUMO_AUTH_REFRESH_WAIT_MS; else process.env.LUMO_AUTH_REFRESH_WAIT_MS = saved;
  }
};

test("every candidate rejected: each tried once, then the rotation 401", () => noPoll(async () => {
  const { f, upstream } = setup({ outcomes: [res(401), res(401)] });
  const r = await upstream("/chat/completions", "POST", "b", {});
  assert.equal(r.status, 401);
  assert.equal(f.calls.length, 2); // TOKEN1, then the one other candidate (TOKEN2)
  assert.match(await r.text(), /tried 2 candidate login/);
}));

test("401 with a stale same-token re-read polls for the rotated cookie and recovers", async () => {
  // Cookie DB lags the browser: first read (startup) and second read (immediate
  // 401 re-read) both return the OLD token; only the polled third read returns TOKEN2.
  const f = fakeFetch([res(401), res(200)]);
  const sleeps = [];
  const logs = [];
  let readCount = 0;
  const readCreds = () => { readCount++; return readCount <= 2 ? cred(TOKEN1) : cred(TOKEN2); };
  const upstream = createUpstream({
    fetchFn: f.fn, credsRef: { current: null }, readCreds, firstByteMs: 5000,
    log: (m) => logs.push(m), sleep: async (ms) => sleeps.push(ms),
  });
  const r = await upstream("/chat/completions", "POST", "b", {});
  assert.equal(r.status, 200);
  assert.equal(readCount, 3);
  assert.ok(sleeps.length >= 1, "poll waits before re-reading the cookie DB");
  assert.equal(logs.filter((l) => l.includes("found new token")).length, 1);
  assert.equal(f.calls[1].opts.headers.authorization, `Bearer ${TOKEN2}`);
});

test("concurrent 401 burst shares one credential poll instead of re-reading in parallel", async () => {
  const f = fakeFetch([res(401), res(401), res(200), res(200)]);
  const sleeps = [];
  let readCount = 0;
  const gate = { resolve: null };
  const inFlight = new Promise((r) => { gate.resolve = r; });
  // Reads 1-2 (startup + first 401 re-read) return the stale token; the polled
  // read blocks until the second request has joined the in-flight poll.
  const readCreds = () => {
    readCount++;
    if (readCount <= 2) return cred(TOKEN1);
    if (readCount === 3) { queueMicrotask(gate.resolve); return cred(TOKEN2); } // poll result, shared
    return cred(TOKEN2);
  };
  const credsRef = { current: null };
  const upstream = createUpstream({
    fetchFn: f.fn, credsRef, readCreds, firstByteMs: 5000,
    log: () => {}, sleep: async (ms) => sleeps.push(ms),
  });
  const p1 = upstream("/chat/completions", "POST", "b", {});
  // Fire the second request while p1's poll is still awaiting sleep.
  const p2 = upstream("/other", "GET", null, {});
  await inFlight;
  const r1 = await p1, r2 = await p2;
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  // Request 2 piggybacked on the in-flight poll (found authPoll set), so the total
  // credential reads stayed at the single-request count: startup + re-read + one poll.
  assert.equal(readCount, 3);
});

test("401 poll gives up after the bounded window and returns the 401", async () => {
  const f = fakeFetch([res(401), res(401)]);
  const sleeps = [];
  const orig = Date.now;
  let t = 0;
  Date.now = () => t; // deterministic clock so the 3-minute cap isn't real time
  try {
    const upstream = createUpstream({
      fetchFn: f.fn, credsRef: { current: null }, readCreds: () => cred(TOKEN1),
      firstByteMs: 5000, log: () => {},
      sleep: async (ms) => { t += ms + 1; }, // each poll advances past the deadline
    });
    const r = await upstream("/chat/completions", "POST", "b", {});
    assert.equal(r.status, 401);
    const text = await r.text();
    assert.ok(!/token/i.test(text), "401 body must not leak token material");
  } finally { Date.now = orig; }
});

test("no credential file means a 401 without any fetch call", async () => {
  const f = fakeFetch([res(200)]);
  const sleeps = [];
  const upstream = createUpstream({
    fetchFn: f.fn, credsRef: { current: null }, readCreds: () => null,
    log: () => {}, sleep: async (ms) => sleeps.push(ms),
  });
  const r = await upstream("/chat/completions", "POST", "b", {});
  assert.equal(r.status, 401);
  assert.equal(f.calls.length, 0);
  const text = await r.text();
  assert.match(text, /no Lumo login found/);
});

test("no token value ever appears in error bodies or log lines", () => noPoll(async () => {
  // Exhausted retries on a connection error, and a full 401 refresh cycle.
  for (const outcomes of [[new Error("boom"), new Error("boom"), new Error("boom")], [res(401), res(401)]]) {
    const { f, upstream, logs, sleeps } = setup({ outcomes });
    const r = await upstream("/chat/completions", "POST", "b", {});
    await r.text().catch(() => {});
    const all = [JSON.stringify(logs), String(r.status)];
    for (const line of all) {
      assert.ok(!line.includes(TOKEN1), "stale token leaked");
      assert.ok(!line.includes(TOKEN2), "fresh token leaked");
    }
    assert.ok(f.calls.length >= 1);
    assert.deepEqual(sleeps.filter((s) => s < 0), []); // sanity: only non-negative backoffs
  }
}));

test("429 then success waits and retries within the attempt budget", async () => {
  const { f, upstream, sleeps, logs } = setup({ outcomes: [res(429, "rate limited"), res(200)] });
  const r = await upstream("/chat/completions", "POST", "b", {});
  assert.equal(r.status, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 5000); // default when no Retry-After
  assert.equal(logs.filter((l) => l.includes("upstream 429, retry 1")).length, 1);
});

test("5xx exhaustion returns the last response after retries", async () => {
  const { f, upstream, sleeps, logs } = setup({ outcomes: [res(503), res(503), res(503)] });
  const r = await upstream("/chat/completions", "POST", "b", {});
  assert.equal(r.status, 503);
  assert.equal(f.calls.length, 3); // initial + 2 retries
  assert.deepEqual(sleeps, [1500, 3000]);
  assert.equal(logs.filter((l) => l.includes("upstream 503, retry")).length, 2);
});

// ---------- candidate walk across browsers/profiles (#210) ----------

const TOKEN3 = "secret-token-three-cccc";
const cand = (token, browser, profile) => ({ token, uid: `uid-${browser}`, source: `/x/${browser}`, browser, profile });
// A fetch that answers 401 for the listed bad tokens and 200 otherwise.
const authFetch = (badTokens) => {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push(opts.headers.authorization.slice(7));
    return badTokens.includes(opts.headers.authorization.slice(7)) ? res(401) : res(200);
  };
  return { fn, calls };
};
const withList = (list, checked = ["Firefox", "Chrome"]) => Object.assign([...list], { checked });

test("stale newest login, valid older one in another browser: walks to it and caches it", async () => {
  const f = authFetch([TOKEN1]);
  const logs = [];
  const credsRef = { current: null };
  let reads = 0;
  const readAllCreds = () => { reads++; return withList([cand(TOKEN1, "Firefox", "a"), cand(TOKEN2, "Chrome", "Default")]); };
  const upstream = createUpstream({ fetchFn: f.fn, credsRef, readAllCreds, log: (m) => logs.push(m), sleep: async () => {} });
  const r = await upstream("/chat/completions", "POST", "b", {});
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls, [TOKEN1, TOKEN2]);
  assert.equal(credsRef.current.token, TOKEN2);
  assert.equal(reads, 2); // startup read + one candidate read on the 401
  assert.ok(logs.some((l) => l.includes("Chrome (Default)")), "logs name the winning browser/profile");
  for (const l of logs) for (const t of [TOKEN1, TOKEN2]) assert.ok(!l.includes(t), "token leaked to log");
  // Next request uses the cached winner directly.
  await upstream("/models", "GET", null, {});
  assert.deepEqual(f.calls.slice(2), [TOKEN2]);
});

test("candidates are tried in list order and known-bad tokens are never retried", async () => {
  const f = authFetch([TOKEN1, TOKEN2]);
  const credsRef = { current: null };
  const list = withList([cand(TOKEN1, "Firefox", "a"), cand(TOKEN2, "Firefox", "b"), cand(TOKEN3, "Edge", "Default")]);
  const upstream = createUpstream({ fetchFn: f.fn, credsRef, readAllCreds: () => list, sleep: async () => {} });
  assert.equal((await upstream("/a", "GET", null, {})).status, 200);
  assert.deepEqual(f.calls, [TOKEN1, TOKEN2, TOKEN3]);
});

test("once every candidate is known bad, later requests do not retry them", async () => {
  const list = withList([cand(TOKEN1, "Firefox", "a"), cand(TOKEN2, "Firefox", "b"), cand(TOKEN3, "Edge", "Default")]);
  const g = authFetch([TOKEN1, TOKEN2, TOKEN3]);
  const up = createUpstream({ fetchFn: g.fn, credsRef: { current: null }, readAllCreds: () => list, sleep: async () => {} });
  const saved = process.env.LUMO_AUTH_REFRESH_WAIT_MS;
  process.env.LUMO_AUTH_REFRESH_WAIT_MS = "0";
  try {
    const r1 = await up("/a", "GET", null, {});
    assert.equal(r1.status, 401);
    assert.deepEqual(g.calls, [TOKEN1, TOKEN2, TOKEN3]);
    const r2 = await up("/a", "GET", null, {});
    assert.equal(r2.status, 401);
    // Second request: every login is known bad, so nothing is sent to Lumo at all.
    assert.equal(g.calls.length, 3);
    const body = await r2.text();
    assert.match(body, /checked: Firefox, Chrome/);
  } finally { if (saved === undefined) delete process.env.LUMO_AUTH_REFRESH_WAIT_MS; else process.env.LUMO_AUTH_REFRESH_WAIT_MS = saved; }
});

test("all candidates rejected: polls for a rotated login, then succeeds with it", async () => {
  const f = authFetch([TOKEN1, TOKEN2]);
  let reads = 0;
  const readAllCreds = () => {
    reads++;
    const base = [cand(TOKEN1, "Firefox", "a"), cand(TOKEN2, "Chrome", "Default")];
    return withList(reads >= 4 ? [cand(TOKEN3, "Firefox", "a"), ...base] : base);
  };
  const sleeps = [];
  const credsRef = { current: null };
  const upstream = createUpstream({ fetchFn: f.fn, credsRef, readAllCreds, sleep: async (ms) => sleeps.push(ms) });
  const r = await upstream("/a", "GET", null, {});
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls, [TOKEN1, TOKEN2, TOKEN3]);
  assert.equal(sleeps.length, 2); // poll read 3 found nothing new, read 4 found TOKEN3
  assert.equal(credsRef.current.token, TOKEN3);
});

test("all candidates rejected and the poll times out: 401 naming browsers and count, no token", async () => {
  const f = authFetch([TOKEN1, TOKEN2]);
  const orig = Date.now;
  let t = 0;
  Date.now = () => t;
  try {
    const upstream = createUpstream({
      fetchFn: f.fn, credsRef: { current: null },
      readAllCreds: () => withList([cand(TOKEN1, "Firefox", "a"), cand(TOKEN2, "Chrome", "Default")], ["Firefox", "Chrome", "Edge"]),
      sleep: async (ms) => { t += ms + 1; },
    });
    const r = await upstream("/a", "GET", null, {});
    assert.equal(r.status, 401);
    const body = await r.text();
    assert.match(body, /tried 2 candidate login\(s\); checked: Firefox, Chrome, Edge/);
    assert.ok(!body.includes(TOKEN1) && !body.includes(TOKEN2));
  } finally { Date.now = orig; }
});

test("concurrent 401s share one candidate walk: cookie stores read once", async () => {
  const f = authFetch([TOKEN1]);
  let reads = 0;
  const readAllCreds = () => { reads++; return withList([cand(TOKEN1, "Firefox", "a"), cand(TOKEN2, "Chrome", "Default")]); };
  const credsRef = { current: null };
  const upstream = createUpstream({ fetchFn: f.fn, credsRef, readAllCreds, sleep: async () => {} });
  const [r1, r2, r3] = await Promise.all([upstream("/a", "GET", null, {}), upstream("/b", "GET", null, {}), upstream("/c", "GET", null, {})]);
  assert.deepEqual([r1.status, r2.status, r3.status], [200, 200, 200]);
  assert.equal(reads, 2); // startup + the single shared walk
  assert.equal(credsRef.authPoll, undefined);
});

test("owner hits connection errors mid-walk: no untested login is adopted; waiter recovers on its own", async () => {
  let t2 = 0, reads = 0;
  const calls = [];
  const fn = async (url, opts) => {
    const tok = opts.headers.authorization.slice(7);
    calls.push(tok === TOKEN1 ? "T1" : "T2");
    if (tok === TOKEN1) return res(401);
    if (++t2 <= 3) throw new Error("socket hang up"); // owner's 3 attempts with TOKEN2 all fail
    return res(200);
  };
  const credsRef = { current: null };
  const readAllCreds = () => { reads++; return withList([cand(TOKEN1, "Firefox", "a"), cand(TOKEN2, "Chrome", "Default")]); };
  const upstream = createUpstream({ fetchFn: fn, credsRef, readAllCreds, sleep: async () => {} });
  const p1 = upstream("/a", "GET", null, {});
  const p2 = upstream("/b", "GET", null, {});
  const r1 = await p1;
  assert.equal(r1.status, 502); // genuine network errors still abort the owner
  assert.ok(credsRef.current.token === TOKEN1, "the untested candidate was not written to credsRef.current");
  const r2 = await p2;
  assert.equal(r2.status, 200); // the waiter walked again itself and TOKEN2 then answered
  assert.equal(credsRef.authPoll, undefined);
  assert.ok(credsRef.current.token === TOKEN2, "adopted only after Lumo accepted it");
  assert.equal(reads, 3); // startup + owner's walk + the waiter's own walk
  // TOKEN1 is known bad, so the waiter never sent it again.
  assert.deepEqual(calls, ["T1", "T1", "T2", "T2", "T2", "T2"]);
});

test("regression: an unsendable (mis-decrypted) candidate is skipped and never adopted", async () => {
  // From the gate repro: a v24 hash-prefixed Chromium value decodes to U+FFFD garbage.
  const garbage = "��xyz";
  const list = withList([{ uid: "1", token: garbage, browser: "Edge", profile: "Default" }, { uid: "1", token: "GOOD", browser: "Firefox", profile: "a" }]);
  const seen = [];
  const logs = [];
  const fetchFn = async (url, init) => {
    const t = new Headers(init.headers).get("authorization").slice(7); // real header validation
    seen.push(t === "GOOD" ? "GOOD" : t === "STALE" ? "STALE" : "garbage");
    return new Response(t === "GOOD" ? "ok" : "no", { status: t === "GOOD" ? 200 : 401 });
  };
  const credsRef = { current: { uid: "1", token: "STALE" } };
  const up = createUpstream({ fetchFn, credsRef, readAllCreds: () => list, log: (m) => logs.push(m), sleep: async () => {} });
  const [a, b] = await Promise.all([up("/x", "POST", "{}", {}), up("/x", "POST", "{}", {})]);
  const c = await up("/x", "POST", "{}", {});
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  assert.ok(credsRef.current.token === "GOOD", "the valid login was adopted");
  assert.ok(!seen.includes("garbage"), "garbage never reached fetch");
  assert.ok(logs.some((l) => /Edge \(Default\).*not a valid header value/.test(l)));
  for (const l of logs) assert.ok(!l.includes(garbage) && !l.includes("GOOD"), "no token in logs");
});

test("a thrown header error from fetch marks that login bad and moves on (not a 502)", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const t = init.headers.authorization.slice(7);
    calls.push(t === TOKEN2 ? "T2" : t === TOKEN3 ? "T3" : "T1");
    if (t === TOKEN1) return res(401);
    if (t === TOKEN2) throw new TypeError("Cannot convert argument to a ByteString");
    return res(200);
  };
  const credsRef = { current: null };
  const up = createUpstream({ fetchFn, credsRef, sleep: async () => {},
    readAllCreds: () => withList([cand(TOKEN1, "Firefox", "a"), cand(TOKEN2, "Edge", "Default"), cand(TOKEN3, "Chrome", "Default")]) });
  assert.equal((await up("/x", "GET", null, {})).status, 200);
  assert.deepEqual(calls, ["T1", "T2", "T3"]); // no connection-error retries of T2
  assert.ok(credsRef.current.token === TOKEN3);
});

test("a request in flight with the old login when a walk finishes retries with the adopted one, no rescan", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const fn = async (url, opts) => {
    const tok = opts.headers.authorization.slice(7);
    calls.push([url.endsWith("/slow") ? "slow" : "fast", tok]);
    if (tok !== TOKEN1) return res(200);
    if (url.endsWith("/slow")) await gate;
    return res(401);
  };
  let reads = 0;
  const readAllCreds = () => { reads++; return withList([cand(TOKEN1, "Firefox", "a"), cand(TOKEN2, "Chrome", "Default")]); };
  const credsRef = { current: null };
  const upstream = createUpstream({ fetchFn: fn, credsRef, readAllCreds, sleep: async () => {} });
  const slow = upstream("/slow", "GET", null, {});
  assert.equal((await upstream("/fast", "GET", null, {})).status, 200); // walk done: TOKEN2 adopted
  release();
  assert.equal((await slow).status, 200);
  assert.equal(reads, 2); // startup + the one walk; the late 401 did not rescan
  assert.deepEqual(calls.filter(([w]) => w === "slow").map(([, t]) => t === TOKEN2), [false, true]);
});

test("adopting a login from a different account is logged by label only", async () => {
  const logs = [];
  const f = authFetch([TOKEN1]);
  const upstream = createUpstream({
    fetchFn: f.fn, credsRef: { current: null }, log: (m) => logs.push(m), sleep: async () => {},
    readAllCreds: () => withList([cand(TOKEN1, "Firefox", "a"), cand(TOKEN2, "Chrome", "Default")]),
  });
  assert.equal((await upstream("/a", "GET", null, {})).status, 200);
  const line = logs.find((l) => /different Lumo account/.test(l));
  assert.ok(line, "uid change logged");
  assert.match(line, /Chrome \(Default\)/);
  for (const v of ["uid-Chrome", "uid-Firefox", TOKEN1, TOKEN2]) assert.ok(!line.includes(v), "no uid/token in log");
  // Same account (same uid): no such line.
  const logs2 = [];
  const same = createUpstream({
    fetchFn: authFetch([TOKEN1]).fn, credsRef: { current: null }, log: (m) => logs2.push(m), sleep: async () => {},
    readAllCreds: () => withList([{ ...cand(TOKEN1, "Firefox", "a"), uid: "u" }, { ...cand(TOKEN2, "Chrome", "Default"), uid: "u" }]),
  });
  await same("/a", "GET", null, {});
  assert.ok(!logs2.some((l) => /different Lumo account/.test(l)));
});
