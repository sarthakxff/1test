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
const DATA_DIR = process.env.DATA_DIR || __dirname;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MONITORING_DB  = path.join(DATA_DIR, "monitoring_base.json");
const OLD_CLIENTS_DB = path.join(DATA_DIR, "old_clients.json");
const PERMISSIONS_DB = path.join(DATA_DIR, "permissions.json");

const MAX_ACTIVE = 200;

// ── File helpers ───────────────────────────────────────────────────────────

// FIX #1: loadFile now warns loudly on JSON parse errors instead of silently
// returning {} and causing silent data loss. A corrupted file is a serious
// problem — the user needs to know about it.
function loadFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(`❌ [store] Failed to READ file ${filePath}:`, err.message);
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`❌ [store] JSON PARSE ERROR in ${filePath}:`, err.message);
    console.error(`   File content (first 200 chars): ${raw.slice(0, 200)}`);
    console.error(`   ⚠️  Returning empty object — your data file may be corrupted!`);
    console.error(`   ⚠️  Back up and inspect: ${filePath}`);
    return {};
  }
}

// FIX #2: saveFile now has error handling so a disk-full or permission error
// doesn't crash the bot with an uncaught exception.
function saveFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`❌ [store] Failed to WRITE file ${filePath}:`, err.message);
    console.error(`   ⚠️  Data was NOT saved. Check disk space and file permissions.`);
    // Re-throw so callers know the save failed and can handle it if needed
    throw err;
  }
}

// ── MONITORING BASE ────────────────────────────────────────────────────────
const monitoringBase = {
  getAll() {
    return loadFile(MONITORING_DB);
  },

  // FIX #4: getActive() and listActive() previously each called loadFile() separately
  // (double disk read). Now getActive() is the single source of truth and
  // listActive() delegates to it — one read per logical operation.
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
      username:        key,
      addedAt:         new Date().toISOString(),
      addedBy:         discordUserTag,
      addedById:       discordUserId,
      mode,
      initialStatus,
      lastChecked:     null,
      lastStatus:      initialStatus,
      checkCount:      0,
      eventDetectedAt: null,
      active:          true,
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

  list() {
    return Object.values(loadFile(MONITORING_DB));
  },

  // FIX #4: Delegates to getActive() — single disk read
  listActive() {
    return Object.values(this.getActive());
  },

  activeCount() {
    return Object.values(loadFile(MONITORING_DB)).filter((a) => a.active).length;
  },
};

// ── OLD CLIENTS ────────────────────────────────────────────────────────────
const oldClients = {
  getAll() {
    return loadFile(OLD_CLIENTS_DB);
  },

  get(username) {
    return loadFile(OLD_CLIENTS_DB)[username.toLowerCase()] || null;
  },

  // FIX #3: archive() now makes a defensive copy of the record so any fields
  // mutated by the caller after archive() is called don't affect the archived data.
  archive(record, archiveReason, resolution) {
    const all = loadFile(OLD_CLIENTS_DB);

    // Defensive copy — don't mutate the caller's object
    const snapshot = { ...record };
    const key      = snapshot.username.toLowerCase();
    const now      = Date.now();
    const timeTaken = snapshot.addedAt
      ? now - new Date(snapshot.addedAt).getTime()
      : null;

    // If an entry for this username already exists in old_clients,
    // use a timestamped key so we don't overwrite history
    const archiveKey = all[key]
      ? `${key}_${new Date(snapshot.addedAt || now).getTime()}`
      : key;

    all[archiveKey] = {
      ...snapshot,
      active:        false,
      archivedAt:    new Date().toISOString(),
      archiveReason,
      resolution,
      timeTaken,
    };

    saveFile(OLD_CLIENTS_DB, all);
    return archiveKey;
  },

  list() {
    return Object.values(loadFile(OLD_CLIENTS_DB));
  },
};

// ── PERMISSIONS ────────────────────────────────────────────────────────────
const permissions = {
  load() {
    return loadFile(PERMISSIONS_DB);
  },

  save(data) {
    saveFile(PERMISSIONS_DB, data);
  },

  isOwner(userId) {
    const data = this.load();
    return data.ownerId === userId;
  },

  setOwner(userId) {
    const data = this.load();
    data.ownerId = userId;
    this.save(data);
  },

  // FIX #5: canViewList() used to return true when no owner was set, meaning
  // ANYONE could run /monitor list before the first /monitor grant.
  // Now it returns false until an owner has been established, which forces
  // the first user to run /monitor grant to claim ownership first.
  canViewList(userId) {
    const data = this.load();
    if (!data.ownerId) {
      // No owner set yet — only inform, don't allow open access
      return false;
    }
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
    return {
      ownerId:      data.ownerId      || null,
      allowedUsers: data.allowedUsers || [],
    };
  },
};

module.exports = { monitoringBase, oldClients, permissions, MAX_ACTIVE };
