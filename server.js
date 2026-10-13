// Servidor da Agenda do Barbeiro — sem dependências externas (Node 18+).
// Serve a interface (pasta public/) e a API de contas, sessões, dados e recuperação de senha.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

// Lê o arquivo .env, se existir
try {
  for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const PORT = +process.env.PORT || 3000;
const BASE = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");
// Endereço/HTTPS detectados a cada requisição (não precisa configurar BASE_URL; atrás de proxy use TRUST_PROXY=1)
const isHttps = req => process.env.BASE_URL ? BASE.startsWith("https")
  : (process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" : !!req.socket.encrypted);
const baseOf = req => process.env.BASE_URL ? BASE : `${isHttps(req) ? "https" : "http"}://${req.headers.host || "localhost:" + PORT}`;
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const PUBLIC = path.join(__dirname, "public");

// ---------- Banco (arquivo JSON, gravação atômica) ----------
let db = { users: {}, data: {}, sessions: {} };
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch {}
db.slugs = db.slugs || {};
let timer = null;
function flushDb() {
  clearTimeout(timer);
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
const persist = () => { clearTimeout(timer); timer = setTimeout(flushDb, 200); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { flushDb(); process.exit(0); });

// ---------- Utilitários ----------
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const validEmail = e => typeof e === "string" && e.length <= 120 && /^\S+@\S+\.\S+$/.test(e);
const DUMMY_SALT = crypto.randomBytes(16).toString("hex");

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

function clientIp(req) {
  if (TRUST_PROXY) return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
  return req.socket.remoteAddress;
}
function cookies(req) {
  const o = {};
  for (const p of String(req.headers.cookie || "").split(";")) { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return o;
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { reject(new Error("json")); } });
    req.on("error", reject);
  });
}
const setCookie = (token, maxAge, req) =>
  `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;

function newSession(email) {
  const now = Date.now();
  for (const [k, v] of Object.entries(db.sessions)) if (v.exp < now) delete db.sessions[k];
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[sha(token)] = { email, exp: now + 30 * 864e5 };
  persist();
  return token;
}
function authed(req) {
  const t = cookies(req).sid; if (!t) return null;
  const s = db.sessions[sha(t)];
  return s && s.exp > Date.now() && db.users[s.email] ? s.email : null;
}

// ---------- Perfis: dono e colaborador (barbeiro) ----------
function ctx(req) {
  const email = authed(req); if (!email) return null;
  const u = db.users[email];
  return { email, shop: u.shop || email, role: u.role || "owner", bid: u.bid || null };
}
// O colaborador só recebe a própria agenda; dados da barbearia e de outros barbeiros ficam de fora.
function viewFor(full, bid) {
  const me = (full.barbers || []).find(b => b.id === bid);
  return {
    _v: full._v || 0, shop: full.shop || {}, msgs: full.msgs || {}, barbers: me ? [me] : [], services: full.services || [],
    clients: (full.clients || []).map(c => ({ ...c, email: "" })), queue: full.queue || [], curB: bid, barber: me ? me.name : "",
    appts: (full.appts || []).filter(a => a.bid === bid),
    blocks: (full.blocks || []).filter(k => !k.bid || k.bid === bid),
  };
}
const objs = a => (Array.isArray(a) ? a : []).filter(x => x && typeof x === "object" && typeof x.id === "string");
// Aplica no dado completo só o que o colaborador pode alterar.
function mergeBarber(full, inc, bid) {
  const out = { ...full };
  out.appts = [...objs(full.appts).filter(a => a.bid !== bid), ...objs(inc.appts).map(a => ({ ...a, bid }))];
  out.blocks = [...objs(full.blocks).filter(k => k.bid !== bid), ...objs(inc.blocks).filter(k => k.bid === bid)];
  const clients = new Map(objs(full.clients).map(c => [c.id, c]));
  for (const c of objs(inc.clients)) clients.set(c.id, { ...(clients.get(c.id) || {}), id: c.id, name: String(c.name || "").slice(0, 40), phone: String(c.phone || "").slice(0, 20), email: String((clients.get(c.id) || {}).email || ""), bday: String(c.bday || (clients.get(c.id) || {}).bday || "").slice(0, 10) });
  out.clients = [...clients.values()];
  if (Array.isArray(inc.queue)) out.queue = objs(inc.queue);
  return out;
}
function dropSessions(email) { for (const [k, v] of Object.entries(db.sessions)) if (v.email === email) delete db.sessions[k]; }
function cleanupTeam(shop, data) {
  const ids = new Set((data.barbers || []).map(b => b.id));
  for (const [e, u] of Object.entries(db.users)) if (u.shop === shop && u.role === "barber" && !ids.has(u.bid)) { delete db.users[e]; dropSessions(e); }
}


// ---------- Agendamento online (link público) ----------
const SHOP_TZ = process.env.SHOP_TZ || "America/Sao_Paulo";
const PAY_KEYS = { pix: "Pix", dinheiro: "Dinheiro", debito: "Cartão de débito", credito: "Cartão de crédito", outro: "Outro" };
const mnT = t => +String(t).slice(0, 2) * 60 + +String(t).slice(3, 5);
const hmT = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
function shopNow() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const g = t => parts.find(x => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, min: +g("hour") * 60 + +g("minute") };
}
const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wdayOf = ds => new Date(ds + "T12:00:00Z").getUTCDay();
const absMin = (ds, m) => Math.floor(Date.parse(ds + "T00:00:00Z") / 60000) + m;
const phoneKey = p => String(p || "").replace(/\D/g, "").slice(-11);
function olCfg(d) {
  const o = d.online || {};
  return {
    on: o.on === true, pickBarber: o.pickBarber !== false,
    minHours: Math.min(72, Math.max(0, Number(o.minHours) || 0)), maxDays: Math.min(90, Math.max(1, Number(o.maxDays) || 30)),
    pays: (Array.isArray(o.pays) ? o.pays : ["dinheiro"]).filter(k => k in PAY_KEYS), pixKey: String(o.pixKey || "").slice(0, 120), note: String(o.note || "").slice(0, 300),
  };
}
function barberFree(d, b, date, start, dur, sid, now, minHours) {
  const h = (b.hours || [])[wdayOf(date)];
  if (!h || !h.on || (b.no || []).includes(sid)) return false;
  if (start < mnT(h.open) || start + dur > mnT(h.close)) return false;
  if (h.ls && h.le && start < mnT(h.le) && start + dur > mnT(h.ls)) return false;
  if (absMin(date, start) < absMin(now.date, now.min) + minHours * 60) return false;
  for (const k of d.blocks || []) if (k.date === date && (!k.bid || k.bid === b.id) && mnT(k.start) < start + dur && mnT(k.end) > start) return false;
  for (const a of d.appts || []) {
    if (a.bid !== b.id || a.date !== date || a.status === "cancelado") continue;
    const sv = (d.services || []).find(x => x.id === a.sid), ad = a.dur != null ? a.dur : (sv ? sv.dur : 30), as = mnT(a.time);
    if (as < start + dur && as + ad > start) return false;
  }
  return true;
}
function pubSlots(d, sid, bid, date, now, cfg) {
  const s = (d.services || []).find(x => x.id === sid && x.online !== false);
  if (!s || !(s.dur > 0)) return [];
  const bs = (d.barbers || []).filter(b => b.online !== false && (bid === "any" || b.id === bid) && !(b.no || []).includes(sid));
  const step = s.dur % 30 === 0 ? 30 : 15, out = new Map();
  for (const b of bs) {
    const h = (b.hours || [])[wdayOf(date)]; if (!h || !h.on) continue;
    for (let t = Math.ceil(mnT(h.open) / step) * step; t + s.dur <= mnT(h.close); t += step)
      if (barberFree(d, b, date, t, s.dur, sid, now, cfg.minHours)) { if (!out.has(t)) out.set(t, []); out.get(t).push(b.id); }
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]);
}

// ---------- Email (Resend por HTTPS; sem chave, imprime o link no console) ----------
async function sendMail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log(`\n[EMAIL NÃO CONFIGURADO — modo teste]\nPara: ${to}\nAssunto: ${subject}\n${text}\n`); return; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
    });
    if (!r.ok) console.error("Falha ao enviar email:", r.status, await r.text());
  } catch (e) { console.error("Falha ao enviar email:", e.message); }
}

// ---------- API ----------
async function api(req, res, url) {
  const ip = clientIp(req), route = url.pathname, method = req.method;

  if (method !== "GET") {
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== req.headers.host) return send(res, 403, { error: "Origem não permitida." }); } catch { return send(res, 403, { error: "Origem inválida." }); } }
    if (!String(req.headers["content-type"] || "").startsWith("application/json") && method !== "POST") return send(res, 415, { error: "Use JSON." });
  }

  let body = {};
  if (method === "POST" || method === "PUT") {
    try { body = await readBody(req); } catch (e) { return send(res, e.message === "big" ? 413 : 400, { error: "Requisição inválida." }); }
  }


  // ----- Rotas públicas do agendamento online (sem login) -----
  const pm = route.match(/^\/api\/public\/([a-z0-9]{6,24})(?:\/(avail|book))?$/);
  if (pm) {
    if (limited("pub:" + ip, 150, 60e3)) return send(res, 429, { error: "Muitas requisições. Aguarde um instante." });
    const d = db.slugs[pm[1]] && db.data[db.slugs[pm[1]]], cfg = d && olCfg(d), act = pm[2] || "";
    if (!d || !cfg.on) return send(res, 404, { error: "Agendamento online indisponível no momento." });
    if (act === "" && method === "GET") {
      const barbers = (d.barbers || []).filter(b => b.online !== false).map(b => ({ id: b.id, name: String(b.name || ""), no: b.no || [] }));
      return send(res, 200, {
        shop: { name: String((d.shop && d.shop.name) || "Barbearia"), phone: String((d.shop && d.shop.phone) || "") },
        services: (d.services || []).filter(x => x.online !== false && x.dur > 0).map(x => ({ id: x.id, name: x.name, price: x.price, dur: x.dur })),
        barbers, settings: { pick: cfg.pickBarber, pays: cfg.pays, note: cfg.note, maxDays: cfg.maxDays },
      });
    }
    if (act === "avail" && method === "GET") {
      const sid = url.searchParams.get("sid") || "", bid = cfg.pickBarber ? (url.searchParams.get("bid") || "any") : "any", now = shopNow(), days = [];
      for (let i = 0; i <= cfg.maxDays; i++) {
        const date = addDays(now.date, i), sl = pubSlots(d, sid, bid, date, now, cfg);
        if (sl.length) days.push({ d: date, s: sl.map(x => hmT(x[0])) });
      }
      return send(res, 200, { days });
    }
    if (act === "book" && method === "POST") {
      if (limited("book:" + ip, 12, 3600e3)) return send(res, 429, { error: "Muitas tentativas. Tente novamente mais tarde." });
      if (body.website) return send(res, 200, { ok: true });
      const sid = String(body.sid || ""), date = String(body.date || ""), time = String(body.time || ""), bidReq = cfg.pickBarber ? String(body.bid || "any") : "any";
      const name = String(body.name || "").trim().slice(0, 40), phone = String(body.phone || "").trim().slice(0, 20), email = String(body.email || "").trim().toLowerCase().slice(0, 120), pay = String(body.pay || "");
      const digits = phone.replace(/\D/g, ""), now = shopNow();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return send(res, 400, { error: "Escolha a data e o horário." });
      if (name.length < 2) return send(res, 400, { error: "Informe seu nome." });
      if (digits.length < 10 || digits.length > 13) return send(res, 400, { error: "Informe um telefone com DDD." });
      if (email && !validEmail(email)) return send(res, 400, { error: "E-mail inválido." });
      if (date < now.date || date > addDays(now.date, cfg.maxDays)) return send(res, 400, { error: "Essa data não está disponível." });
      if (!cfg.pays.includes(pay)) return send(res, 400, { error: "Escolha a forma de pagamento." });
      if (limited("bookp:" + digits, 6, 86400e3)) return send(res, 429, { error: "Muitos agendamentos com este telefone hoje. Fale com a barbearia." });
      d.clients = Array.isArray(d.clients) ? d.clients : []; d.appts = Array.isArray(d.appts) ? d.appts : [];
      let cl = d.clients.find(c => phoneKey(c.phone).length >= 10 && phoneKey(c.phone) === phoneKey(phone));
      if (cl && cl.blocked) return send(res, 403, { error: "Não foi possível concluir o agendamento online. Entre em contato com a barbearia." });
      if (cl && d.appts.filter(a => a.cid === cl.id && a.src === "online" && a.status === "agendado" && a.date >= now.date).length >= 3)
        return send(res, 429, { error: "Você já tem agendamentos futuros marcados. Fale com a barbearia para mais horários." });
      const sl = pubSlots(d, sid, bidReq, date, now, cfg).find(x => hmT(x[0]) === time);
      if (!sl) return send(res, 409, { error: "Esse horário acabou de ser ocupado. Escolha outro." });
      const load = id => d.appts.filter(a => a.bid === id && a.date === date && a.status !== "cancelado").length;
      const bid = bidReq === "any" ? sl[1].slice().sort((a, b) => load(a) - load(b))[0] : bidReq;
      const svcO = d.services.find(x => x.id === sid), barb = d.barbers.find(b => b.id === bid);
      if (!cl) { cl = { id: crypto.randomBytes(5).toString("hex"), name, phone, email, src: "online" }; d.clients.push(cl); }
      else if (!cl.email && email) cl.email = email;
      const appt = { id: crypto.randomBytes(5).toString("hex"), client: cl.name, cid: cl.id, bid, sid, date, time, status: "agendado", src: "online", payPref: pay, createdAt: Date.now() };
      d.appts.push(appt); d._v = (d._v || 0) + 1; persist();
      return send(res, 200, { ok: true, booking: {
        id: appt.id, date, time, service: { name: svcO.name, price: svcO.price, dur: svcO.dur }, barber: barb ? barb.name : "", pay, payName: PAY_KEYS[pay],
        pixKey: pay === "pix" ? cfg.pixKey : "", note: cfg.note, shop: { name: String((d.shop && d.shop.name) || "Barbearia"), phone: String((d.shop && d.shop.phone) || "") } } });
    }
    return send(res, 405, { error: "Método não permitido." });
  }

  // ----- Link do dono -----
  if ((route === "/api/online/slug" && method === "GET") || (route === "/api/online/slug/reset" && method === "POST")) {
    const c = ctx(req);
    if (!c) return send(res, 401, { error: "Sessão expirada." });
    if (c.role !== "owner") return send(res, 403, { error: "Apenas o dono." });
    const u = db.users[c.email];
    if (!u.slug || route.endsWith("/reset")) {
      if (u.slug) delete db.slugs[u.slug];
      let sg; do { sg = crypto.randomBytes(5).toString("hex"); } while (db.slugs[sg]);
      u.slug = sg; db.slugs[sg] = c.email; persist();
    }
    return send(res, 200, { slug: u.slug });
  }

  if (route === "/api/register" && method === "POST") {
    if (limited("reg:" + ip, 10, 3600e3)) return send(res, 429, { error: "Muitas tentativas. Tente mais tarde." });
    const email = String(body.email || "").trim().toLowerCase(), pw = String(body.password || ""), name = String(body.name || "").trim().slice(0, 30);
    if (!validEmail(email)) return send(res, 400, { error: "Digite um email válido." });
    if (pw.length < 6 || pw.length > 200) return send(res, 400, { error: "A senha precisa ter ao menos 6 caracteres." });
    if (db.users[email]) return send(res, 409, { error: "Este email já tem conta. Use “Entrar”." });
    const salt = crypto.randomBytes(16).toString("hex");
    db.users[email] = { salt, hash: hashPw(pw, salt), created: Date.now() };
    db.data[email] = { barber: name };
    return send(res, 200, { email }, { "Set-Cookie": setCookie(newSession(email), 30 * 86400, req) });
  }

  if (route === "/api/login" && method === "POST") {
    if (limited("login:" + ip, 10, 15 * 60e3)) return send(res, 429, { error: "Muitas tentativas. Aguarde alguns minutos." });
    const email = String(body.email || "").trim().toLowerCase(), pw = String(body.password || "").slice(0, 200), u = db.users[email];
    const h = hashPw(pw, u ? u.salt : DUMMY_SALT); // custo igual com ou sem conta
    if (!u || !same(h, u.hash)) return send(res, 401, { error: "Email ou senha incorretos." });
    return send(res, 200, { email, role: u.role || "owner", bid: u.bid || null }, { "Set-Cookie": setCookie(newSession(email), 30 * 86400, req) });
  }

  if (route === "/api/logout" && method === "POST") {
    const t = cookies(req).sid; if (t) { delete db.sessions[sha(t)]; persist(); }
    return send(res, 200, { ok: true }, { "Set-Cookie": setCookie("", 0, req) });
  }

  if (route === "/api/me" && method === "GET") {
    const c = ctx(req);
    return c ? send(res, 200, { email: c.email, role: c.role, bid: c.bid }) : send(res, 401, { error: "Não autenticado." });
  }

  if (route === "/api/data") {
    const c = ctx(req);
    if (!c) return send(res, 401, { error: "Sessão expirada." });
    const full = db.data[c.shop] || (db.data[c.shop] = {});
    const view = () => (c.role === "barber" ? viewFor(full, c.bid) : { ...full, _v: full._v || 0 });
    if (method === "GET") return send(res, 200, view());
    if (method === "PUT") {
      if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "Dados inválidos." });
      if (typeof body._v === "number" && body._v !== (full._v || 0)) return send(res, 409, { error: "Conflito de versão.", data: view() });
      const next = c.role === "barber" ? mergeBarber(full, body, c.bid) : { ...body };
      next._v = (full._v || 0) + 1;
      db.data[c.shop] = next;
      if (c.role !== "barber") cleanupTeam(c.shop, next);
      persist();
      return send(res, 200, { ok: true, _v: next._v });
    }
  }

  if (route === "/api/team/set" && method === "POST") {
    const c = ctx(req);
    if (!c || c.role !== "owner") return send(res, 403, { error: "Somente o dono da barbearia pode fazer isso." });
    const bid = String(body.bid || ""), email = String(body.email || "").trim().toLowerCase(), pw = String(body.password || "");
    if (!(objs((db.data[c.shop] || {}).barbers)).some(b => b.id === bid)) return send(res, 400, { error: "Barbeiro não encontrado. Tente de novo em instantes." });
    if (!validEmail(email)) return send(res, 400, { error: "Digite um email válido." });
    const cur = Object.entries(db.users).find(([, u]) => u.shop === c.shop && u.role === "barber" && u.bid === bid);
    if (db.users[email] && (!cur || cur[0] !== email)) return send(res, 409, { error: "Este email já tem conta." });
    if ((!cur && pw.length < 6) || (pw && (pw.length < 6 || pw.length > 200))) return send(res, 400, { error: "A senha precisa ter ao menos 6 caracteres." });
    if (cur && cur[0] !== email) { db.users[email] = cur[1]; delete db.users[cur[0]]; dropSessions(cur[0]); }
    const u = cur ? db.users[email] : (db.users[email] = { role: "barber", shop: c.shop, bid, created: Date.now() });
    if (pw) { u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPw(pw, u.salt); dropSessions(email); }
    persist();
    return send(res, 200, { ok: true, email });
  }

  if (route === "/api/team/revoke" && method === "POST") {
    const c = ctx(req);
    if (!c || c.role !== "owner") return send(res, 403, { error: "Somente o dono da barbearia pode fazer isso." });
    const cur = Object.entries(db.users).find(([, u]) => u.shop === c.shop && u.role === "barber" && u.bid === String(body.bid || ""));
    if (cur) { delete db.users[cur[0]]; dropSessions(cur[0]); persist(); }
    return send(res, 200, { ok: true });
  }

  if (route === "/api/forgot" && method === "POST") {
    const email = String(body.email || "").trim().toLowerCase();
    const reply = () => send(res, 200, { ok: true }); // sempre a mesma resposta: não revela se o email existe
    if (limited("forgot:" + ip, 5, 15 * 60e3)) return send(res, 429, { error: "Muitas tentativas. Aguarde alguns minutos." });
    if (!validEmail(email) || !db.users[email] || limited("forgotE:" + email, 3, 3600e3)) return reply();
    const token = crypto.randomBytes(32).toString("hex");
    db.users[email].reset = { hash: sha(token), exp: Date.now() + 3600e3 };
    persist();
    sendMail(email, "Redefinir sua senha — Agenda do barbeiro",
      `Recebemos um pedido para redefinir a senha da sua agenda.\n\nAbra o link abaixo (vale por 1 hora):\n${baseOf(req)}/?reset=${token}\n\nSe não foi você, ignore este email: a senha continua a mesma.`);
    return reply();
  }

  if (route === "/api/reset" && method === "POST") {
    if (limited("reset:" + ip, 10, 15 * 60e3)) return send(res, 429, { error: "Muitas tentativas. Aguarde alguns minutos." });
    const token = String(body.token || ""), pw = String(body.password || "");
    if (pw.length < 6 || pw.length > 200) return send(res, 400, { error: "A senha precisa ter ao menos 6 caracteres." });
    const th = sha(token);
    const email = Object.keys(db.users).find(e => db.users[e].reset && same(db.users[e].reset.hash, th) && db.users[e].reset.exp > Date.now());
    if (!email) return send(res, 400, { error: "Link inválido ou expirado. Peça um novo." });
    const u = db.users[email]; u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPw(pw, u.salt); delete u.reset;
    for (const [k, v] of Object.entries(db.sessions)) if (v.email === email) delete db.sessions[k]; // desconecta todos os aparelhos
    persist();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "Rota não encontrada." });
}

// ---------- Arquivos estáticos ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
function serve(req, res, url) {
  let p = decodeURIComponent(url.pathname); if (p === "/") p = "/index.html"; else if (p.startsWith("/agendar/")) p = "/agendar.html";
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Não encontrado"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

console.log(`Banco de dados: ${DB_FILE} — ${Object.keys(db.users).length} conta(s) carregada(s)`);
http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'");
  if (isHttps(req)) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  const url = new URL(req.url, BASE);
  if (url.pathname.startsWith("/api/")) api(req, res, url).catch(e => { console.error(e); send(res, 500, { error: "Erro no servidor." }); });
  else if (req.method === "GET" || req.method === "HEAD") serve(req, res, url);
  else { res.writeHead(405); res.end(); }
}).listen(PORT, () => console.log(`Agenda do barbeiro em ${BASE}  (porta ${PORT})`));
