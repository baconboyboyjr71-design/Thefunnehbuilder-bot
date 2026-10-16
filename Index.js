'use strict';
/**
 * MrFunnehBuilder - 24/7 "make the server feel alive" bot (Render / GitHub ready)
 * - Can chage on first line on config
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
const HOST = 'AUTUMNATED.joinmc.world';
const CFG = {
  port: 25565,
  username: process.env.MC_USERNAME || 'MrFunnehBuilder',
  version: process.env.MC_VERSION || '1.21.11',
  auth: process.env.MC_AUTH || 'offline', 
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
