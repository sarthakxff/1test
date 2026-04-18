/**
 * store.js
 * Two databases:
 *   1. monitoring_base.json  — active accounts being tracked right now (200 slots)
 *   2. old_clients.json      — archived accounts: completed, removed, or resolved
 *
 * Railway note: Set a Volume mounted at /data in your Railway project to persist
 * the JSON files across deploys/restarts. If DATA_DIR env var is not set,
 * falls back to the project directory (fine for local dev, NOT persistent on Railway).
 */

const fs   = require("fs");
const path = require("path");

// ── Railway persistent storage ─────────────────────────────────────────────
// On Railway: add a Volume at /data and set DATA_DIR=/data in your env vars.
// Locally: leave DATA_DIR unset — files will be stored next to bot.js as before.
const DATA_DIR = process.env.DATA_DIR || __dirname;

// Ensure the data directory exists (important on first boot with a fresh volume)
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MONITORING_DB  = path.join(DATA_DIR, "monitoring_base.json");
const OLD_CLIENTS_DB = path.join(DATA_DIR, "old_clients.json");
const PERMISSIONS_DB = path.join(DATA_DIR, "permissions.json");

const MAX_ACTIVE = 200;

// ── File helpers ───────────────────────────────────────────────────────────
function loadFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return {}; }
}
function saveFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ── MONITORING BASE ────────────────────────────────────────────────────────
const monitoringBase = {
  getAll()    { return loadFile(MONITORING_DB); },
  getActive() {
    const all = loadFile(MONITORING_DB);
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v.active));
  },
  get(username) {
    return loadFile(MONITORING_DB)[username.toLowerCase()] || null;
  },

  add(username, discordUserTag, discordUserId, mode, initialStatus) {
    const all = loadFile(MONITORING_DB);
    const key = username.toLowerCase();
    if (all[key] && all[key].active) return { ok: false, reason: "already_monitored" };
    const activeCount = Object.values(all).filter((a) => a.active).length;
    if (activeCount >= MAX_ACTIVE) return { ok: false, reason: "max_reached" };

    all[key] = {
      username: key,
      addedAt: new Date().toISOString(),
      addedBy: discordUserTag,
      addedById: discordUserId,
      mode,
      initialStatus,
      lastChecked: null,
      lastStatus: initialStatus,
      checkCount: 0,
      eventDetectedAt: null,
      active: true,
    };
    saveFile(MONITORING_DB, all);
    return { ok: true };
  },

  update(username, fields) {
    const all = loadFile(MONITORING_DB);
    const key = username.toLowerCase();
    if (!all[key]) return;
    all[key] = { ...all[key], ...fields };
    saveFile(MONITORING_DB, all);
  },

  markInactive(username) {
    this.update(username, { active: false });
  },

  list() { return Object.values(loadFile(MONITORING_DB)); },
  listActive() { return Object.values(this.getActive()); },
  activeCount() { return Object.values(loadFile(MONITORING_DB)).filter((a) => a.active).length; },
};

// ── OLD CLIENTS ────────────────────────────────────────────────────────────
const oldClients = {
  getAll()  { return loadFile(OLD_CLIENTS_DB); },
  get(username) { return loadFile(OLD_CLIENTS_DB)[username.toLowerCase()] || null; },

  archive(record, archiveReason, resolution) {
    const all = loadFile(OLD_CLIENTS_DB);
    const key = record.username.toLowerCase();
    const now = Date.now();
    const timeTaken = record.addedAt ? now - new Date(record.addedAt).getTime() : null;

    const archiveKey = all[key]
      ? `${key}_${new Date(record.addedAt).getTime()}`
      : key;

    all[archiveKey] = {
      ...record,
      active: false,
      archivedAt: new Date().toISOString(),
      archiveReason,
      resolution,
      timeTaken,
    };
    saveFile(OLD_CLIENTS_DB, all);
    return archiveKey;
  },

  list() { return Object.values(loadFile(OLD_CLIENTS_DB)); },
};

// ── PERMISSIONS ────────────────────────────────────────────────────────────
const permissions = {
  load() { return loadFile(PERMISSIONS_DB); },
  save(data) { saveFile(PERMISSIONS_DB, data); },

  isOwner(userId) {
    const data = this.load();
    return data.ownerId === userId;
  },

  setOwner(userId) {
    const data = this.load();
    data.ownerId = userId;
    this.save(data);
  },

  canViewList(userId) {
    const data = this.load();
    if (!data.ownerId) return true;
    if (data.ownerId === userId) return true;
    return Array.isArray(data.allowedUsers) && data.allowedUsers.includes(userId);
  },

  grantAccess(userId) {
    const data = this.load();
    if (!data.allowedUsers) data.allowedUsers = [];
    if (!data.allowedUsers.includes(userId)) data.allowedUsers.push(userId);
    this.save(data);
  },

  revokeAccess(userId) {
    const data = this.load();
    if (!data.allowedUsers) return;
    data.allowedUsers = data.allowedUsers.filter((id) => id !== userId);
    this.save(data);
  },

  listAllowed() {
    const data = this.load();
    return { ownerId: data.ownerId || null, allowedUsers: data.allowedUsers || [] };
  },
};

module.exports = { monitoringBase, oldClients, permissions, MAX_ACTIVE };
