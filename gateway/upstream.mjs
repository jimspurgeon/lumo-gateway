// Upstream request seam for the Lumo proxy (audit §3, task 5a).
// Extracted verbatim from proxy.mjs so it can be tested without listening on
// a port, hitting the network, or touching the Firefox credential database:
// every dependency (fetch, credentials, logging, sleep, timeouts) is injected
// through createUpstream().
import { credLabel, isUsableLogin, readAllLumoCredentials, readLumoCredentials } from "./creds.mjs";

// Waits for the first byte of the upstream response before anything is
// streamed to the client (default 240s, overridable via LUMO_FIRST_BYTE_MS).
export const DEFAULT_FIRST_BYTE_MS = 240000;

const jsonError = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });

// Creates the upstream(path, method, body, headers) function the proxy uses:
// - injects the Lumo login (Bearer token + x-pm-uid) from credsRef.current,
//   lazily (re-)reading credentials via readCreds() when absent;
// - retries connection errors, 429 (honouring Retry-After, max 30s), 5xx and
//   no-first-byte timeouts (2 retries, backoff);
// - on a 401, walks every candidate login from readAllCreds() (all browsers and
//   profiles, most recent first), skipping tokens already known bad in this
//   process, retrying the request with each until one is not rejected; only when
//   all are rejected does it poll the cookie stores for a rotated login (#210);
// - never logs or errors token values (only sources and counts).
export function createUpstream({
  fetchFn = fetch,
  credsRef = { current: null },
  readCreds,
  readAllCreds,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  firstByteMs = Number(process.env.LUMO_FIRST_BYTE_MS || DEFAULT_FIRST_BYTE_MS),
  upstreamBase = "https://lumo.proton.me/api/ai/v1",
} = {}) {
  const injectedAll = !!readAllCreds;
  // Callers that inject only readCreds (single login) get a one-element candidate list.
  if (!readAllCreds) readAllCreds = readCreds
    ? () => { const c = readCreds(); return c ? [c] : []; }
    : (() => {
      // Skip notices (e.g. app-bound Chrome cookies) repeat on every poll read: log each once.
      const said = new Set();
      const once = (m) => { if (!said.has(m)) { said.add(m); log(m); } };
      return () => readAllLumoCredentials({ log: once });
    })();
  // Startup/lazy pick: env or login.json short-circuit; browsers are scanned only without them.
  if (!readCreds) readCreds = injectedAll ? () => readAllCreds()[0] ?? null : () => readLumoCredentials();
  const bad = new Set(); // tokens Lumo has rejected with 401 in this process
  let lastChecked = []; // browser labels scanned by the latest candidate read
  let lastTried = 0; // candidates tried by the latest full recovery

  // Untried, not-known-bad candidates, best first (de-duplicated by token).
  const freshCandidates = () => {
    const list = readAllCreds() ?? [];
    if (list.checked) lastChecked = list.checked;
    const seen = new Set();
    return list.filter((c) => c && c.token && !bad.has(c.token) && !seen.has(c.token) && seen.add(c.token));
  };

  const rotationError = () => {
    const where = lastChecked.length ? lastChecked.join(", ") : "your browsers";
    return jsonError(401, `lumo-proxy: Lumo rejected every saved login (tried ${lastTried} candidate login(s); checked: ${where}). ` +
      "Lumo probably rotated its login and the browser hasn't flushed the new cookie yet. " +
      "Reload the lumo.proton.me tab in your browser and retry.");
  };

  // Polls the cookie stores for a login not yet rejected (cookie rotation: the
  // browser's cookie DB can lag minutes behind its in-memory cookie).
  async function pollForRotation() {
    const deadline = Date.now() + Number(process.env.LUMO_AUTH_REFRESH_WAIT_MS || 180000);
    let cands = [];
    for (let i = 1; !cands.length && Date.now() < deadline; i++) {
      await sleep(Math.min(5000 * i, 15000));
      cands = freshCandidates();
    }
    log(`401 from Lumo; rotated-cookie poll ${cands.length ? `found new token (${credLabel(cands[0])})` : "timed out"}`);
    return cands;
  }

  return async function upstream(path, method, body, headers) {
    // walk: set while THIS request owns the 401 recovery (credsRef.authPoll is its
    // promise; concurrent 401s await it instead of reading the cookie stores again).
    let walk = null, joined = false, followedCurrent = false, rejoins = 0;
    const finishWalk = (winner) => {
      if (!walk) return;
      walk.resolve(winner);
      if (credsRef.authPoll === walk.promise) delete credsRef.authPoll;
      walk = null;
    };
    try {
      for (let attempt = 0; ;) {
        if (!walk && !credsRef.current) credsRef.current = readCreds();
        const creds = walk ? walk.current : credsRef.current;
        if (!creds) return jsonError(401, "lumo-proxy: no Lumo login found in any browser. Log in at lumo.proton.me in your browser.");
        let res;
        // A login already rejected, or one that cannot go in a header (a mis-decrypted
        // cookie), is never sent: it is handled exactly like a 401 from Lumo.
        const unusable = !isUsableLogin(creds);
        if (unusable || bad.has(creds.token)) {
          if (unusable) log(`login from ${credLabel(creds)} is not a valid header value; skipped`);
          res = new Response(null, { status: 401 });
        } else try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error(`no response from Lumo within ${firstByteMs / 1000}s`)), firstByteMs);
          try {
            res = await fetchFn(upstreamBase + path, { method, body, signal: ac.signal, headers: { ...headers, authorization: `Bearer ${creds.token}`, "x-pm-uid": creds.uid } });
            if (res.ok && res.body) {
              // Wait for the first body chunk under the same deadline, so a request that Lumo
              // accepted but never starts answering is retried before anything reaches the client.
              const reader = res.body.getReader();
              const first = await reader.read();
              const rest = new ReadableStream({
                start(ctrl) { if (!first.done) ctrl.enqueue(first.value); else ctrl.close(); },
                async pull(ctrl) { const { done, value } = await reader.read(); if (done) ctrl.close(); else ctrl.enqueue(value); },
                cancel(r) { reader.cancel(r); },
              });
              res = new Response(first.done ? null : rest, { status: res.status, headers: res.headers });
            }
          } finally { clearTimeout(timer); }
        } catch (e) {
          if (e instanceof TypeError && /ByteString|header/i.test(String(e.message))) {
            // Not a network failure: fetch refused the login itself. Reject it like a 401.
            // (e.message is not logged: undici can quote the offending header value.)
            log(`login from ${credLabel(creds)} could not be sent as a header; skipped`);
            res = new Response(null, { status: 401 });
          } else if (attempt < 2) { attempt++; log(`${e.name === 'AbortError' || /no response/.test(String(e.message)) ? 'no first byte' : 'connection error'}, retry ${attempt}: ${e.message}`); await sleep(1500 * attempt); continue; }
          else return jsonError(502, `lumo-proxy: connection error: ${e.message}`);
        }

        if (res.status === 401) {
          bad.add(creds.token);
          if (!walk) {
            if (joined) { await res.text().catch(() => {}); return rotationError(); }
            const cur = credsRef.current;
            if (!followedCurrent && cur && cur.token !== creds.token && !bad.has(cur.token)) {
              // This request went out with an older login while another request's walk
              // already adopted a new one: retry with that instead of rescanning.
              followedCurrent = true; await res.text().catch(() => {}); continue;
            }
            if (credsRef.authPoll) {
              // Another request is already walking the candidates: share its result.
              joined = true; await res.text().catch(() => {});
              const winner = await credsRef.authPoll;
              if (winner === undefined && rejoins++ < 1) {
                // The owner stopped on a connection error without settling on a login:
                // nothing was adopted, so recover on our own (once).
                joined = false; continue;
              }
              if (!winner || bad.has(winner.token)) return rotationError();
              credsRef.current = winner; continue;
            }
            // Become the owner of the recovery (set synchronously, before any await).
            let resolve;
            const promise = new Promise((r) => { resolve = r; });
            credsRef.authPoll = promise;
            walk = { promise, resolve, queue: null, tried: 0, polled: false, current: creds, prevUid: creds.uid };
            await res.text().catch(() => {});
            walk.queue = freshCandidates();
            log(`401 from Lumo (${credLabel(creds)}); ${walk.queue.length} other candidate login(s) to try`);
          } else {
            await res.text().catch(() => {});
            log(`401 from Lumo (${credLabel(creds)}); candidate rejected`);
          }
          let next = walk.queue.shift();
          if (!next && !walk.polled) {
            walk.polled = true;
            walk.queue = await pollForRotation();
            next = walk.queue.shift();
          }
          if (!next) {
            lastTried = walk.tried + 1;
            finishWalk(null);
            return rotationError();
          }
          walk.tried++; walk.current = next; continue;
        }

        if (walk) {
          // The candidate was accepted (or failed for a non-auth reason, which says
          // nothing against the login): adopt it and release any waiters.
          const winner = walk.current;
          if (winner !== credsRef.current) log(`401 recovered: using new token from ${credLabel(winner)} after ${walk.tried} candidate(s)`);
          // Every browser's login is tried (user decision, #210), so the adopted one may
          // belong to a different Lumo account; say so (label only, never uid or token).
          if (winner.uid !== walk.prevUid) log(`401 recovered: the login from ${credLabel(winner)} is a different Lumo account than the previous one`);
          credsRef.current = winner;
          finishWalk(winner);
        }
        if (res.status === 429 && attempt < 2) {
          attempt++;
          await res.text().catch(() => {});
          const wait = Math.min(Number(res.headers.get("retry-after")) * 1000 || 5000 * attempt, 30000);
          log(`upstream 429, retry ${attempt} in ${wait / 1000}s`); await sleep(wait); continue;
        }
        if (res.status >= 500 && attempt < 2) { attempt++; await res.text().catch(() => {}); log(`upstream ${res.status}, retry ${attempt}`); await sleep(1500 * attempt); continue; }
        return res;
      }
    } finally {
      // Any exit while still owning the walk (connection errors): release waiters with
      // "no result" so they never hang. An untested candidate is never handed out and
      // never written to credsRef.current.
      finishWalk(undefined);
    }
  };
}
