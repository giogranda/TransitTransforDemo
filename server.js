const express = require("express");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --------------------
// Environment variables
// --------------------
const VAULT_ADDR = process.env.VAULT_ADDR;          // e.g. http://127.0.0.1:8200
const VAULT_TOKEN = process.env.VAULT_TOKEN;        // demo token

const TRANSIT_KEY = process.env.TRANSIT_KEY || "demo-key";

const TRANSFORM_ROLE = process.env.TRANSFORM_ROLE || "ssn-demo";
const TF_FPE = process.env.TF_FPE || "ssn_fpe";
const TF_TOK = process.env.TF_TOK || "ssn_tokenize";
const TF_MASK = process.env.TF_MASK || "ssn_mask";

// NEW: Fixed tweak for deterministic FPE when tweak_source=supplied
const SSN_TWEAK_B64 = process.env.SSN_TWEAK_B64 || "";

const DB_PATH = process.env.DB_PATH || "demo.db";

if (!VAULT_ADDR || !VAULT_TOKEN) {
  console.error("Missing VAULT_ADDR or VAULT_TOKEN env vars.");
  process.exit(1);
}

// -------------
// SQLite setup
// -------------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS transit_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    plaintext TEXT NOT NULL,
    ciphertext TEXT NOT NULL
  );
`);

const insertTransit = db.prepare(
  "INSERT INTO transit_entries (plaintext, ciphertext) VALUES (?, ?)"
);
const listTransit = db.prepare(
  "SELECT id, created_at, plaintext, ciphertext FROM transit_entries ORDER BY id DESC LIMIT ?"
);
const clearTransit = db.prepare("DELETE FROM transit_entries");

// --------------------
// Vault HTTP helper
// --------------------
async function vaultRequest(path, body) {
  const res = await fetch(`${VAULT_ADDR}/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Token": VAULT_TOKEN,
    },
    body: JSON.stringify(body ?? {}),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    const msg = json?.errors?.join("; ") || `Vault error ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

// =====================
// UI: Transit page (/)
// =====================
const transitHtml = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Vault Demo: Transit</title>
  <style>
    body{font-family:system-ui;margin:2rem;max-width:1150px}
    textarea{width:100%;padding:.75rem;margin:.5rem 0;font-size:14px}
    button{padding:.6rem 1rem;margin-right:.5rem;margin-top:.25rem}
    .muted{color:#666}
    .row{display:flex;gap:1rem;align-items:flex-start}
    .col{flex:1}
    .tabs{display:flex;gap:.5rem;margin:1rem 0;flex-wrap:wrap}
    .tab{border:1px solid #ddd;border-radius:999px;padding:.4rem .8rem;cursor:pointer}
    .tab.active{background:#111;color:#fff;border-color:#111}
    table{width:100%;border-collapse:collapse}
    th,td{border-bottom:1px solid #eee;padding:.5rem;vertical-align:top;font-size:13px}
    th{text-align:left}
    code{white-space:pre-wrap;background:#f5f5f5;padding:1rem;border-radius:10px;display:block}
    .pill{font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px}
    a{color:inherit}
  </style>
</head>
<body>
  <h1>Vault Demo — Transit Engine</h1>
  <p class="muted">
    Transit returns ciphertext blobs (<span class="pill">vault:v1:...</span>). Store ciphertext in DB; decrypt only when authorized.
    <br/>
    <a href="/transform">Go to Transform demo →</a>
  </p>

  <div class="muted">
    <div><b>Transit key:</b> <span class="pill" id="key"></span></div>
    <div><b>SQLite DB:</b> <span class="pill" id="db"></span></div>
  </div>

  <div class="row" style="margin-top:1rem">
    <div class="col">
      <h3>New Entry</h3>
      <textarea id="pt" rows="5" placeholder="Type plaintext..."></textarea>
      <button onclick="encryptStore()">Encrypt + Store</button>
      <button onclick="clearAll()">Delete All</button>
    </div>
    <div class="col">
      <h3>Result</h3>
      <code id="out">Ready.</code>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" id="tab-plain" onclick="setView('plain')">Plaintext view (demo-only)</div>
    <div class="tab" id="tab-cipher" onclick="setView('cipher')">Encrypted view (stored)</div>
  </div>

  <div id="tableWrap"></div>

<script>
  const KEY = ${JSON.stringify(TRANSIT_KEY)};
  const DB = ${JSON.stringify(DB_PATH)};
  document.getElementById("key").textContent = KEY;
  document.getElementById("db").textContent = DB;

  let currentView = "plain";

  function setView(v){
    currentView = v;
    document.getElementById("tab-plain").classList.toggle("active", v==="plain");
    document.getElementById("tab-cipher").classList.toggle("active", v==="cipher");
    loadTable();
  }

  async function post(url, payload) {
    const res = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload || {}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function get(url) {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function escapeHtml(s){
    return (s ?? "").toString()
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  async function encryptStore() {
    try {
      const plaintext = document.getElementById("pt").value;
      const data = await post("/api/transit/encrypt-store", { plaintext });
      document.getElementById("out").textContent = JSON.stringify(data, null, 2);
      document.getElementById("pt").value = "";
      await loadTable();
    } catch (e) {
      document.getElementById("out").textContent = e.message;
    }
  }

  async function clearAll(){
    try{
      const data = await post("/api/transit/delete-all", {});
      document.getElementById("out").textContent = JSON.stringify(data, null, 2);
      await loadTable();
    }catch(e){
      document.getElementById("out").textContent = e.message;
    }
  }

  async function decrypt(ciphertext){
    try{
      const data = await post("/api/transit/decrypt", { ciphertext });
      document.getElementById("out").textContent = JSON.stringify(data, null, 2);
    }catch(e){
      document.getElementById("out").textContent = e.message;
    }
  }

  async function loadTable() {
    try {
      const { entries } = await get("/api/transit/entries?limit=50");
      const rows = entries.map(e => {
        const payload = currentView === "plain" ? e.plaintext : e.ciphertext;
        const action = currentView === "cipher"
          ? \`<button onclick="decrypt('\${escapeHtml(e.ciphertext)}')">Decrypt</button>\`
          : "";
        return \`
          <tr>
            <td class="pill">\${e.id}</td>
            <td class="pill">\${escapeHtml(e.created_at)}</td>
            <td><span class="pill">\${escapeHtml(payload)}</span></td>
            <td>\${action}</td>
          </tr>\`;
      }).join("");

      const headerPayload = currentView === "plain" ? "Plaintext (demo-only)" : "Ciphertext (stored)";
      document.getElementById("tableWrap").innerHTML = \`
        <table>
          <thead>
            <tr>
              <th style="width:80px">ID</th>
              <th style="width:190px">Created</th>
              <th>\${headerPayload}</th>
              <th style="width:140px">Action</th>
            </tr>
          </thead>
          <tbody>\${rows || '<tr><td colspan="4" class="muted">No rows yet.</td></tr>'}</tbody>
        </table>\`;
    } catch (e) {
      document.getElementById("out").textContent = e.message;
    }
  }

  loadTable();
</script>
</body>
</html>
`;

// =========================
// UI: Transform page (/transform)
// =========================
const transformHtml = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Vault Demo: Transform</title>
  <style>
    body{font-family:system-ui;margin:2rem;max-width:1150px}
    input{width:100%;padding:.75rem;margin:.5rem 0;font-size:14px}
    button{padding:.6rem 1rem;margin-right:.5rem;margin-top:.25rem}
    .row{display:flex;gap:1rem;align-items:flex-start}
    .col{flex:1}
    code{white-space:pre-wrap;background:#f5f5f5;padding:1rem;border-radius:10px;display:block}
    .muted{color:#666}
    .pill{font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px}
    a{color:inherit}
    table{width:100%;border-collapse:collapse;margin-top:1rem}
    th,td{border-bottom:1px solid #eee;padding:.5rem;vertical-align:top;font-size:13px}
    th{text-align:left}
    .btn-small{padding:.35rem .6rem;font-size:12px}
  </style>
</head>
<body>
  <h1>Vault Demo — Transform Engine (SSN)</h1>
  <p class="muted">
    Transform protects data while keeping it usable: FPE (format-preserving), tokenization, and masking.
    <br/>
    <a href="/">← Back to Transit demo</a>
  </p>

  <div class="muted">
    <div><b>Role:</b> <span class="pill" id="role"></span></div>
    <div><b>Transformations:</b>
      <span class="pill" id="t1"></span>
      <span class="pill" id="t2"></span>
      <span class="pill" id="t3"></span>
    </div>
  </div>

  <div class="row" style="margin-top:1rem">
    <div class="col">
      <h3>Input SSN</h3>
      <input id="in" placeholder="123-45-6789" value="123-45-6789"/>
      <button onclick="runAll()">Run all</button>
    </div>
    <div class="col">
      <h3>Result</h3>
      <code id="out">Ready.</code>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:240px">Technique</th>
        <th>Output</th>
        <th style="width:220px">Notes</th>
        <th style="width:170px">Decode</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><b>FPE</b> (SSN → SSN)</td>
        <td><span class="pill" id="fpeOut"></span></td>
        <td class="muted">Deterministic via fixed tweak (server-side)</td>
        <td><button class="btn-small" onclick="decode('fpe')">Decode</button></td>
      </tr>
      <tr>
        <td><b>Tokenization</b> (SSN → token)</td>
        <td><span class="pill" id="tokOut"></span></td>
        <td class="muted">Decode optional by policy</td>
        <td><button class="btn-small" onclick="decode('tok')">Decode</button></td>
      </tr>
      <tr>
        <td><b>Masking</b> (SSN → redacted)</td>
        <td><span class="pill" id="maskOut"></span></td>
        <td class="muted">Not reversible</td>
        <td class="muted">N/A</td>
      </tr>
    </tbody>
  </table>

<script>
  const ROLE = ${JSON.stringify(TRANSFORM_ROLE)};
  const TF_FPE = ${JSON.stringify(TF_FPE)};
  const TF_TOK = ${JSON.stringify(TF_TOK)};
  const TF_MASK = ${JSON.stringify(TF_MASK)};

  document.getElementById("role").textContent = ROLE;
  document.getElementById("t1").textContent = TF_FPE;
  document.getElementById("t2").textContent = TF_TOK;
  document.getElementById("t3").textContent = TF_MASK;

  // Store latest outputs so we can decode them.
  // NOTE: We no longer need to store tweak in the UI because the server injects a fixed tweak for FPE.
  let last = { fpe: "", tok: "", mask: "" };

  async function post(url, payload) {
    const res = await fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload || {}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function runAll(){
    try{
      const value = document.getElementById("in").value;

      const [fpe, tok, mask] = await Promise.all([
        post("/api/transform/encode", { value, transformation: TF_FPE }),
        post("/api/transform/encode", { value, transformation: TF_TOK }),
        post("/api/transform/encode", { value, transformation: TF_MASK }),
      ]);

      last.fpe = fpe.encoded || "";
      last.tok = tok.encoded || "";
      last.mask = mask.encoded || "";

      document.getElementById("fpeOut").textContent = last.fpe;
      document.getElementById("tokOut").textContent = last.tok;
      document.getElementById("maskOut").textContent = last.mask;

      document.getElementById("out").textContent =
        JSON.stringify({ input: value, fpe, tokenization: tok, masking: mask }, null, 2);
    }catch(e){
      document.getElementById("out").textContent = e.message;
    }
  }

  async function decode(which){
    try{
      let transformation, value;

      if(which === "fpe"){
        transformation = TF_FPE;
        value = last.fpe;
        if (!value) throw new Error("Run all first to generate an FPE value.");
      }

      if(which === "tok"){
        transformation = TF_TOK;
        value = last.tok;
        if (!value) throw new Error("Run all first to generate a token.");
      }

      const data = await post("/api/transform/decode", { value, transformation });
      document.getElementById("out").textContent = JSON.stringify(data, null, 2);
    }catch(e){
      document.getElementById("out").textContent = e.message;
    }
  }
</script>
</body>
</html>
`;

// --------------------
// Page routes
// --------------------
app.get("/", (_, res) => res.type("html").send(transitHtml));
app.get("/transform", (_, res) => res.type("html").send(transformHtml));

// =====================
// Transit APIs
// =====================
app.post("/api/transit/encrypt-store", async (req, res) => {
  try {
    const plaintext = (req.body.plaintext ?? "").toString();
    if (!plaintext) return res.status(400).json({ error: "plaintext is required" });

    const b64 = Buffer.from(plaintext, "utf8").toString("base64");
    const json = await vaultRequest(`transit/encrypt/${TRANSIT_KEY}`, { plaintext: b64 });
    const ciphertext = json.data.ciphertext;

    const info = insertTransit.run(plaintext, ciphertext);

    res.json({
      engine: "transit",
      key: TRANSIT_KEY,
      id: info.lastInsertRowid,
      ciphertext,
      note: "Plaintext is stored only to support the demo plaintext table."
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/transit/entries", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || "50", 10)));
    const entries = listTransit.all(limit);
    res.json({ entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/transit/decrypt", async (req, res) => {
  try {
    const ciphertext = (req.body.ciphertext ?? "").toString();
    if (!ciphertext) return res.status(400).json({ error: "ciphertext is required" });

    const json = await vaultRequest(`transit/decrypt/${TRANSIT_KEY}`, { ciphertext });
    const plaintext = Buffer.from(json.data.plaintext, "base64").toString("utf8");

    res.json({ engine: "transit", key: TRANSIT_KEY, plaintext });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/transit/delete-all", (req, res) => {
  try {
    const info = clearTransit.run();
    res.json({ deleted_rows: info.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================
// Transform APIs
// =====================
app.post("/api/transform/encode", async (req, res) => {
  try {
    const value = (req.body.value ?? "").toString();
    const transformation = (req.body.transformation ?? "").toString();
    if (!value) return res.status(400).json({ error: "value is required" });
    if (!transformation) return res.status(400).json({ error: "transformation is required" });

    const payload = { value, transformation };

    // NEW: If this is the FPE transformation and tweak_source=supplied, we must provide a tweak.
    if (transformation === TF_FPE) {
      if (!SSN_TWEAK_B64) {
        return res.status(500).json({
          error: "Missing SSN_TWEAK_B64 env var (required for FPE when tweak_source=supplied)."
        });
      }
      payload.tweak = SSN_TWEAK_B64;
    }

    const json = await vaultRequest(`transform/encode/${TRANSFORM_ROLE}`, payload);

    res.json({
      engine: "transform",
      role: TRANSFORM_ROLE,
      transformation,
      encoded: json.data.encoded_value
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/transform/decode", async (req, res) => {
  try {
    const value = (req.body.value ?? "").toString();
    const transformation = (req.body.transformation ?? "").toString();
    if (!value) return res.status(400).json({ error: "value is required" });
    if (!transformation) return res.status(400).json({ error: "transformation is required" });

    const payload = { value, transformation };

    // NEW: For FPE decode with tweak_source=supplied, we must provide the same tweak.
    if (transformation === TF_FPE) {
      if (!SSN_TWEAK_B64) {
        return res.status(500).json({
          error: "Missing SSN_TWEAK_B64 env var (required for FPE decode when tweak_source=supplied)."
        });
      }
      payload.tweak = SSN_TWEAK_B64;
    }

    const json = await vaultRequest(`transform/decode/${TRANSFORM_ROLE}`, payload);

    res.json({
      engine: "transform",
      role: TRANSFORM_ROLE,
      transformation,
      decoded: json.data.decoded_value
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------
// Start server
// --------------------
app.listen(3000, () => console.log("Demo running on http://localhost:3000"));

