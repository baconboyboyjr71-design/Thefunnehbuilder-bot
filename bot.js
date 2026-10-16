'use strict';
/**
 * MrFunnehBuilder - 24/7 "make the server feel alive" bot (Render / GitHub ready)
 * - Locked to AUTUMNATED.joinmc.world
 * - Waits out queues, auto-reconnects with backoff
 * - Wanders, looks at players, waves, greets joiners, answers mentions,
 *   occasionally chats, eats, fights mobs, flees when hurt
 * - Tiny HTTP server so Render sees a healthy web service
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

// ───────── CONFIG (env vars override) ─────────
const HOST = 'AUTUMNATED.joinmc.world'; // hard-locked
const CFG = {
  port: 25565,
  username: process.env.MC_USERNAME || 'MrFunnehBuilder',
  version: process.env.MC_VERSION || '1.21.11',
  auth: process.env.MC_AUTH || 'microsoft', // 'offline' if server is cracked
  reconnectMs: +(process.env.RECONNECT_MS || 30000),
  queueQuietMs: 20000,
  postSpawnGraceMs: 15000,
  wanderRadius: +(process.env.WANDER_RADIUS || 25),
  chatEnabled: (process.env.CHAT_ENABLED || 'true') === 'true',
  // Scheduled chat: set CHAT_TIMES="14:00,20:30" (server TZ, set TZ env var) for fixed times,
  // otherwise it picks a random time between CHAT_MIN_MINUTES and CHAT_MAX_MINUTES from the last one.
  chatTimes: (process.env.CHAT_TIMES || '').split(',').map((x) => x.trim()).filter(Boolean),
  chatMinMs: +(process.env.CHAT_MIN_MINUTES || 25) * 60000,
  chatMaxMs: +(process.env.CHAT_MAX_MINUTES || 45) * 60000,
};

const SCHEDULED_LINES = [
  'Yo bro How do I cook uranium?',
  'WHY AM I SO BAD AT BUILDING',
  "I'm under the wotah",
];
const GREETS = ['hey {p}!', 'welcome {p}!', 'yo {p}', 'o/ {p}'];
const REPLIES = ['hey!', 'sup', 'yo', 'o/', 'whats up?', 'hi there'];

const AUTH_PASS = process.env.AUTH_PASSWORD || 'fakebot11';
const REG_FLAG = path.join(__dirname, 'auth', 'registered.flag'); // exists after first /register

const QUEUE_REGEX = /\bqueue\b|position\s*(?:in|:|#)?\s*\d+|\bin line\b|you are (?:currently )?(?:number|#)\s*\d+|waiting (?:room|list)/i;
const QUEUE_DONE_REGEX = /finished waiting|your turn|(?:sending|connecting|moving|teleporting) (?:you )?to/i;

// ───────── auth cache (Render "Secret Files" live in /etc/secrets) ─────────
const AUTH_DIR = path.join(__dirname, 'auth');
fs.mkdirSync(AUTH_DIR, { recursive: true });
for (const src of ['/etc/secrets', path.join(__dirname, 'auth_seed')]) {
  try {
    for (const f of fs.readdirSync(src)) {
      const dest = path.join(AUTH_DIR, f);
      if (!fs.existsSync(dest) && /cache|\.json$/i.test(f)) fs.copyFileSync(path.join(src, f), dest);
    }
  } catch {}
}

// ───────── health server ─────────
let status = 'starting';
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ bot: CFG.username, status, uptime: Math.round(process.uptime()) }));
}).listen(process.env.PORT || 3000);

// ───────── state ─────────
let bot = null, fails = 0, reconnecting = false, watch = null;
let inQueue = false, lastQueueMsg = 0, lastSpawn = 0, alive = false, runId = 0;
let anchor = null, lastReply = 0, connectedAt = 0, nextChatAt = 0;
const greeted = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

function say(msg) { if (CFG.chatEnabled && bot && alive) bot.chat(msg); }

// ───────── connection ─────────
function connect() {
  reconnecting = false; inQueue = false; lastQueueMsg = 0; lastSpawn = 0; alive = false;
  status = 'connecting';
  log(`Connecting to ${HOST} as ${CFG.username} (${CFG.version})`);
  const b = mineflayer.createBot({
    host: HOST, port: CFG.port, username: CFG.username,
    version: CFG.version, auth: CFG.auth, profilesFolder: AUTH_DIR,
    onMsaCode: (d) => log(`MICROSOFT LOGIN NEEDED: open ${d.verification_uri} and enter ${d.user_code}`),
  });
  bot = b;
  b.loadPlugin(pathfinder);
  let ready = false;
  let authSent = null, authTimer = null;
  const sendAuth = (mode) => {
    if (bot !== b || authSent === mode) return;
    authSent = mode;
    log(`Sending /${mode}`);
    b.chat(`/${mode} ${AUTH_PASS}`);
    if (mode === 'register') { try { fs.writeFileSync(REG_FLAG, '1'); } catch {} }
  };

  b.on('login', () => { connectedAt = Date.now(); b.physicsEnabled = false; }); // no movement while in queue/lobby
  b.on('spawn', () => {
    if (bot !== b) return;
    lastSpawn = Date.now();
    if (!authTimer) authTimer = setTimeout(() => {
      if (authSent === null) sendAuth(fs.existsSync(REG_FLAG) ? 'login' : 'register');
    }, 3000);
    if (!alive) b.physicsEnabled = false;
    if (!ready) {
      ready = true;
      const m = new Movements(b);
      m.canDig = false;            // don't grief while wandering
      m.allow1by1towers = false;
      b.pathfinder.setMovements(m);
    }
    log('Spawned');
  });

  const onText = (t) => {
    if (bot !== b) return;
    // auth hints from the server (also fixes things if the flag file was lost on redeploy)
    if (/already (?:registered|have an account)|is already registered/i.test(t)) sendAuth('login');
    else if (authSent === null) {
      if (/\/login/i.test(t)) sendAuth('login');
      else if (/\/register/i.test(t)) sendAuth('register');
    }
    if (QUEUE_DONE_REGEX.test(t) && inQueue) { inQueue = false; lastSpawn = Date.now(); log('Queue done'); return; }
    if (QUEUE_REGEX.test(t)) {
      if (!inQueue) log('Queue detected, waiting');
      inQueue = true; lastQueueMsg = Date.now();
      if (alive) { alive = false; runId++; status = 'queued'; }
    }
  };
  b.on('messagestr', (m, pos) => { if (pos !== 'chat') onText(m); });
  b.on('title', (t) => onText(String(t)));
  b.on('actionBar', (j) => onText(String(j)));

  b.on('playerJoined', (p) => {
    if (!alive || p.username === CFG.username) return;
    const last = greeted.get(p.username) || 0;
    if (Date.now() - last < 10 * 60000) return;
    greeted.set(p.username, Date.now());
    setTimeout(() => say(rnd(GREETS).replace('{p}', p.username)), 2500 + Math.random() * 3000);
  });
  b.on('chat', (user, msg) => {
    if (!alive || user === CFG.username) return;
    if (msg.toLowerCase().includes(CFG.username.toLowerCase()) && Date.now() - lastReply > 20000) {
      lastReply = Date.now();
      setTimeout(() => say(rnd(REPLIES)), 1500 + Math.random() * 2000);
    }
  });

  b.on('kicked', (r) => log('Kicked:', typeof r === 'string' ? r : JSON.stringify(r)));
  b.on('error', (e) => log('Error:', e && e.message ? e.message : e));
  b.on('end', (r) => {
    if (bot !== b) return;
    log('Disconnected:', r || 'unknown');
    alive = false; runId++; status = 'disconnected';
    clearInterval(watch);
    // reset backoff if we were stable for 2+ minutes
    fails = Date.now() - connectedAt > 120000 ? 0 : Math.min(fails + 1, 4);
    if (reconnecting) return;
    reconnecting = true;
    const delay = Math.min(CFG.reconnectMs * 2 ** fails, 5 * 60000);
    log(`Reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(connect, delay);
  });

  clearInterval(watch);
  watch = setInterval(() => {
    if (bot !== b || alive || !lastSpawn) return;
    const now = Date.now();
    if (inQueue && now - lastQueueMsg > CFG.queueQuietMs) { inQueue = false; log('Queue finished'); }
    if (inQueue) { status = 'queued'; return; }
    if (now - lastSpawn > CFG.postSpawnGraceMs && now - lastQueueMsg > CFG.postSpawnGraceMs) goAlive(b);
  }, 1000);
}

function goAlive(b) {
  alive = true; status = 'online';
  b.physicsEnabled = true;
  anchor = anchor || b.entity.position.clone();
  const id = ++runId;
  log('In game, starting alive routine');
  loop(b, id);
}

// ───────── behaviours ─────────
async function loop(b, id) {
  while (alive && bot === b && runId === id) {
    try {
      if (await survive(b)) continue;
      await randomAction(b);
    } catch (e) { log('loop error:', e.message); }
    await sleep(2000 + Math.random() * 5000);
  }
  try { b.pathfinder.stop(); } catch {}
}

async function goTo(b, goal, ms = 20000) {
  const p = b.pathfinder.goto(goal);
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => { try { b.pathfinder.stop(); } catch {} rej(new Error('timeout')); }, ms); });
  try { await Promise.race([p, to]); } finally { clearTimeout(t); p.catch(() => {}); }
}

async function survive(b) {
  // eat
  if (b.food < 16) {
    const f = b.inventory.items().find((i) => b.registry.foodsByName[i.name] && !['rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato'].includes(i.name));
    if (f) { await b.equip(f, 'hand'); await b.consume(); return true; }
  }
  // mobs
  const me = b.entity.position;
  const mob = b.nearestEntity((e) => e.type === 'hostile' && !['enderman', 'zombified_piglin'].includes(e.name) && e.position.distanceTo(me) < 8);
  if (!mob) return false;
  if (b.health < 8 || mob.name === 'creeper') {
    b.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(mob, 14)), true);
    await sleep(3000);
  } else {
    const sword = b.inventory.items().find((i) => i.name.endsWith('_sword'));
    if (sword) await b.equip(sword, 'hand');
    const end = Date.now() + 8000;
    while (alive && mob.isValid && Date.now() < end && b.health >= 6) {
      b.pathfinder.setGoal(new goals.GoalFollow(mob, 2), true);
      if (b.entity.position.distanceTo(mob.position) < 3.3) {
        await b.lookAt(mob.position.offset(0, mob.height * 0.8, 0), true);
        b.attack(mob);
      }
      await sleep(550);
    }
  }
  b.pathfinder.setGoal(null);
  return true;
}

async function randomAction(b) {
  const r = Math.random();
  const nearPlayer = b.nearestEntity((e) => e.type === 'player' && e.username !== CFG.username && e.position.distanceTo(b.entity.position) < 16);

  if (nearPlayer && r < 0.35) {                       // notice a player
    await b.lookAt(nearPlayer.position.offset(0, 1.6, 0));
    if (Math.random() < 0.5) b.swingArm('right');     // wave
    if (Math.random() < 0.3) { b.setControlState('jump', true); await sleep(300); b.setControlState('jump', false); }
  } else if (r < 0.7) {                               // wander near anchor
    const a = Math.random() * Math.PI * 2, d = 4 + Math.random() * CFG.wanderRadius;
    await goTo(b, new goals.GoalNearXZ(anchor.x + Math.cos(a) * d, anchor.z + Math.sin(a) * d, 2));
  } else if (r < 0.85) {                              // look around
    await b.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.8);
  } else if (r < 0.93) {                              // sneak a bit
    b.setControlState('sneak', true); await sleep(800 + Math.random() * 1500); b.setControlState('sneak', false);
  }
}


// ───────── scheduled chat ─────────
function pickNextChat() {
  const now = Date.now();
  if (CFG.chatTimes.length) {
    const times = CFG.chatTimes.map((t) => {
      const [h, m] = t.split(':').map(Number);
      const d = new Date(); d.setHours(h || 0, m || 0, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    });
    return Math.min(...times);
  }
  return now + CFG.chatMinMs + Math.random() * (CFG.chatMaxMs - CFG.chatMinMs);
}
nextChatAt = pickNextChat();
setInterval(() => {
  const now = Date.now();
  if (now < nextChatAt) return;
  // only talk if we're actually in game and the time isn't stale (e.g. we were disconnected)
  if (alive && now - nextChatAt < 120000) {
    const line = rnd(SCHEDULED_LINES);
    log('Scheduled chat:', line);
    say(line);
  }
  nextChatAt = pickNextChat();
  log('Next scheduled chat at', new Date(nextChatAt).toISOString());
}, 15000);

process.on('unhandledRejection', (e) => log('Unhandled:', e && e.message ? e.message : e));
process.on('SIGTERM', () => { try { bot && bot.quit(); } catch {} setTimeout(() => process.exit(0), 500); });
connect();
    
