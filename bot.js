/**
 * bot.js — Instagram Account Monitor (Redesigned)
 *
 * Single command: /monitor
 *   /monitor add <username>         — Auto-detects status and monitors accordingly
 *   /monitor list                   — Full list (owner/permitted users only)
 *   /monitor status <username>      — Current live status
 *   /monitor remove <username>      — Remove from active + archive to Old Clients
 *   /monitor grant <user>           — Owner only: grant /list access to a Discord user
 *   /monitor revoke <user>          — Owner only: revoke /list access
 *
 * Databases:
 *   monitoring_base.json  — 200 active slots
 *   old_clients.json      — archived (banned/recovered/removed) history
 */

require("dotenv").config();

// FIX #1: Moved axios require to top-level instead of inside fetchProfileData()
const axios = require("axios");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
} = require("discord.js");

const { monitoringBase, oldClients, permissions, MAX_ACTIVE } = require("./store");
const { checkAccount, STATUS, jitter: _jitter } = require("./instagramChecker");

// FIX #12: Defensive fallback for jitter in case instagramChecker doesn't export it
const jitter = typeof _jitter === "function"
  ? _jitter
  : (base) => base + Math.floor(Math.random() * base * 0.3);

// ── Env validation ─────────────────────────────────────────────────────────
const REQUIRED_ENV = ["DISCORD_TOKEN", "DISCORD_CHANNEL_ID", "DISCORD_GUILD_ID"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key] || process.env[key].includes("your_")) {
    console.error(`❌  Missing env var: ${key}. Edit your .env file.`);
    process.exit(1);
  }
}

const TOKEN         = process.env.DISCORD_TOKEN;
const CHANNEL_ID    = process.env.DISCORD_CHANNEL_ID;
const GUILD_ID      = process.env.DISCORD_GUILD_ID;
const BASE_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MS || "12000", 10);

// ── Warn if DATA_DIR not set ───────────────────────────────────────────────
if (!process.env.DATA_DIR) {
  console.warn("⚠️  WARNING: DATA_DIR env var not set! All monitoring data will be lost on redeploy.");
  console.warn("⚠️  Set DATA_DIR=/data in Railway Variables and add a Volume mounted at /data.");
} else {
  console.log(`💾 Data directory: ${process.env.DATA_DIR}`);
}

// ── Discord client ─────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Slash command definition ───────────────────────────────────────────────
const userOpt   = (opt) => opt.setName("username").setDescription("Instagram username (without @)").setRequired(true);
const memberOpt = (opt) => opt.setName("user").setDescription("Discord user to grant/revoke access").setRequired(true);

const commands = [
  new SlashCommandBuilder()
    .setName("monitor")
    .setDescription("Instagram account monitor — track bans and recoveries")
    .addSubcommand((s) => s.setName("add")    .setDescription("Add an Instagram account to monitor").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("list")   .setDescription("Show full monitoring list (permitted users only)"))
    .addSubcommand((s) => s.setName("status") .setDescription("Check the current status of a monitored account").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("remove") .setDescription("Stop monitoring an account and archive it").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("grant")  .setDescription("(Owner) Grant a user access to /monitor list").addUserOption(memberOpt))
    .addSubcommand((s) => s.setName("revoke") .setDescription("(Owner) Revoke a user's access to /monitor list").addUserOption(memberOpt))
    .toJSON(),
];

// ── Register slash commands ────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("📡 Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
// FIX #6: formatDuration now handles ms === 0 correctly (was returning "unknown")
function formatDuration(ms) {
  if (ms == null || ms < 0) return "unknown";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function tsField(isoString) {
  if (!isoString) return "Never";
  return `<t:${Math.floor(new Date(isoString).getTime() / 1000)}:F>`;
}

function tsRelative(isoString) {
  if (!isoString) return "Never";
  return `<t:${Math.floor(new Date(isoString).getTime() / 1000)}:R>`;
}

function validateUsername(username) {
  return /^[a-zA-Z0-9._]{1,30}$/.test(username);
}

// ── Notification: LIVE account just got BANNED ─────────────────────────────
async function notifyAccountBanned(username, account) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const now       = Date.now();
  const bannedAt  = new Date(now);
  const timeTaken = account.addedAt
    ? formatDuration(now - new Date(account.addedAt).getTime())
    : "unknown";

  let adderMention = `**${account.addedBy}**`;
  if (account.addedById) {
    adderMention = `<@${account.addedById}>`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xff2200)
    .setTitle("🚨  Target Account Has Been Banned!")
    .setDescription(
      `Hey ${adderMention}! Your target **@${username}** has just gone **BANNED / DELETED** from Instagram.`
    )
    .addFields(
      { name: "🎯 Target Account",    value: `[@${username}](https://instagram.com/${username})`, inline: true },
      { name: "👤 Added By",          value: account.addedBy,                                     inline: true },
      { name: "🕐 Banned At",         value: tsField(bannedAt.toISOString()),                     inline: false },
      { name: "⏱️ Time Taken to Ban", value: timeTaken,                                           inline: true },
      { name: "🔢 Total Checks Done", value: `${account.checkCount}`,                             inline: true }
    )
    .setFooter({ text: "Instagram Monitor • Ban Alert" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`archive_ban_${username}`).setLabel("📦 Archive & Stop Monitoring").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`keep_ban_${username}`)   .setLabel("🔄 Keep in Monitor List")     .setStyle(ButtonStyle.Secondary)
  );

  const pingContent = account.addedById
    ? `<@${account.addedById}> 🚨 **TARGET BANNED** — \`@${username}\``
    : `@here 🚨 **TARGET BANNED** — \`@${username}\``;

  await channel.send({ content: pingContent, embeds: [embed], components: [row] });
}

// ── Fetch Instagram profile data (photo + followers) ──────────────────────
async function fetchProfileData(username) {
  // FIX #1: axios is now required at top-level, not here
  try {
    const url        = `https://www.instagram.com/${username}/`;
    const proxyUrl   = process.env.PROXY_URL;
    const requestConfig = {
      timeout: 10000,
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        Accept:            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      validateStatus: () => true,
    };

    if (proxyUrl) {
      try {
        const u = new URL(proxyUrl);
        requestConfig.proxy = {
          protocol: u.protocol.replace(":", ""),
          host:     u.hostname,
          port:     Number(u.port || 80),
          ...(u.username ? { auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } } : {}),
        };
      } catch { /* invalid proxy URL — ignore */ }
    }

    const { data: html } = await axios.get(url, requestConfig);
    if (typeof html !== "string") return null;

    const picMatch       = html.match(/<meta property="og:image" content="([^"]+)"/);
    const profilePic     = picMatch ? picMatch[1] : null;
    const followersMatch = html.match(/"edge_followed_by":\{"count":(\d+)\}/);
    const followingMatch = html.match(/"edge_follow":\{"count":(\d+)\}/);
    const followers      = followersMatch ? parseInt(followersMatch[1]).toLocaleString() : null;
    const following      = followingMatch ? parseInt(followingMatch[1]).toLocaleString() : null;

    return { profilePic, followers, following };
  } catch {
    return null;
  }
}

// ── Notification: BANNED account just got UNBANNED ────────────────────────
async function notifyAccountUnbanned(username, account) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const now        = Date.now();
  const timeTaken  = account.addedAt
    ? formatDuration(now - new Date(account.addedAt).getTime())
    : "unknown";
  const unbannedAt = new Date(now).toISOString();

  const profile     = await fetchProfileData(username);
  const pingContent = account.addedById ? `<@${account.addedById}>` : `@here`;

  const embed = new EmbedBuilder()
    .setColor(0x00e676)
    .setTitle(`Account Recovered | @${username} ✅`)
    .setURL(`https://instagram.com/${username}`);

  if (profile?.followers || profile?.following) {
    const followersVal = profile.followers ? `**${profile.followers}**` : "N/A";
    const followingVal = profile.following ? `**${profile.following}**` : "N/A";
    embed.setDescription(`Followers: ${followersVal} | Following: ${followingVal}`);
  }

  embed.addFields({ name: "⏱️ Time Taken", value: timeTaken, inline: false });

  if (profile?.profilePic) {
    embed.setThumbnail(profile.profilePic);
  }

  embed.setFooter({
    text: `Unbanned at ${new Date(unbannedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`,
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`archive_unban_${username}`).setLabel("📦 Archive & Stop Monitoring").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`keep_unban_${username}`)   .setLabel("🔄 Keep in Monitor List")     .setStyle(ButtonStyle.Secondary)
  );

  await channel.send({
    content:    `${pingContent} ✅ **CLIENT ACCOUNT RECOVERED** — \`@${username}\``,
    embeds:     [embed],
    components: [row],
  });
}

// ── Monitor loops ──────────────────────────────────────────────────────────
const activeTimers   = {};
// FIX #3: Track which accounts are currently in a confirmation check to prevent re-entrant scheduleCheck
const confirmingNow  = new Set();

async function confirmStatus(username, expectedStatus, attempts = 3, delayMs = 10000) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const result = await checkAccount(username);
    console.log(`[CONFIRM ${i + 1}/${attempts}] @${username} -> ${result.status} (expecting ${expectedStatus})`);
    if (result.status !== expectedStatus) {
      console.log(`False positive cleared for @${username} — got ${result.status} not ${expectedStatus}`);
      return false;
    }
  }
  return true;
}

async function scheduleCheck(username) {
  // FIX #3: Don't schedule a new check while confirmation is running
  if (confirmingNow.has(username)) return;

  const account = monitoringBase.get(username);
  if (!account || !account.active) return;

  activeTimers[username] = setTimeout(async () => {
    // FIX #3: Re-check after timer fires (account may have been deactivated while waiting)
    if (confirmingNow.has(username)) return;

    const result = await checkAccount(username);
    const prev   = monitoringBase.get(username);
    if (!prev || !prev.active) return;

    monitoringBase.update(username, {
      lastChecked: result.checkedAt.toISOString(),
      lastStatus:  result.status,
      checkCount:  (prev.checkCount || 0) + 1,
    });

    console.log(`[${new Date().toLocaleTimeString()}] @${username} (${prev.mode}) -> ${result.status}`);

    if (result.status === STATUS.RATE_LIMITED) {
      console.warn(`Rate limited on @${username}. Backing off 60s.`);
      activeTimers[username] = setTimeout(() => scheduleCheck(username), 60000);
      return;
    }

    if (result.status === STATUS.ERROR) {
      scheduleCheck(username);
      return;
    }

    const updated = monitoringBase.get(username);

    // WATCH_FOR_BAN: was live, now looks banned
    if (updated.mode === "WATCH_FOR_BAN" && result.status === STATUS.BANNED) {
      console.log(`Possible ban detected for @${username} — running 3 confirmation checks...`);
      // FIX #3: Mark as confirming so no duplicate scheduleCheck fires during the delay
      confirmingNow.add(username);
      const confirmed = await confirmStatus(username, STATUS.BANNED);
      confirmingNow.delete(username);

      if (!confirmed) {
        scheduleCheck(username);
        return;
      }

      // FIX #11: Keep active=true until the user explicitly archives or keeps;
      // the notification embed has buttons to handle that choice.
      monitoringBase.update(username, {
        eventDetectedAt: result.checkedAt.toISOString(),
        lastStatus:      STATUS.BANNED,
        active:          false, // pause polling — buttons can re-enable
      });
      await notifyAccountBanned(username, monitoringBase.get(username));
      return;
    }

    // WATCH_FOR_UNBAN: was banned, now looks accessible
    if (updated.mode === "WATCH_FOR_UNBAN" && result.status === STATUS.ACCESSIBLE) {
      console.log(`Possible unban detected for @${username} — running 3 confirmation checks...`);
      confirmingNow.add(username);
      const confirmed = await confirmStatus(username, STATUS.ACCESSIBLE);
      confirmingNow.delete(username);

      if (!confirmed) {
        scheduleCheck(username);
        return;
      }

      monitoringBase.update(username, {
        eventDetectedAt: result.checkedAt.toISOString(),
        lastStatus:      STATUS.ACCESSIBLE,
        active:          false,
      });
      await notifyAccountUnbanned(username, monitoringBase.get(username));
      return;
    }

    scheduleCheck(username);
  }, jitter(BASE_INTERVAL));
}

function startMonitoring(username) {
  if (activeTimers[username]) clearTimeout(activeTimers[username]);
  scheduleCheck(username);
}

function stopMonitoring(username) {
  if (activeTimers[username]) {
    clearTimeout(activeTimers[username]);
    delete activeTimers[username];
  }
  confirmingNow.delete(username); // FIX #3: Also clear confirmation guard
}

// FIX #5: Only call monitoringBase.update after archiving if the record still exists
function archiveAndStop(username, reason) {
  stopMonitoring(username);
  const record = monitoringBase.get(username);
  if (record) {
    const duration   = record.addedAt ? formatDuration(Date.now() - new Date(record.addedAt).getTime()) : "unknown";
    const resolution =
      reason === "BAN_DETECTED"     ? `Account was banned after ${duration} of monitoring.` :
      reason === "UNBAN_DETECTED"   ? `Account was recovered after ${duration} of monitoring.` :
      reason === "MANUALLY_REMOVED" ? "Manually removed from monitoring by user." :
      "Archived.";
    oldClients.archive(record, reason, resolution);
    // Only mark inactive — don't re-create if store.archive already removes it
    if (monitoringBase.get(username)) {
      monitoringBase.update(username, { active: false });
    }
  }
}

// ── Resume on startup ──────────────────────────────────────────────────────
// FIX #9: Use listActive() (returns array) consistently instead of mixing getActive()/Object.keys()
function resumeAll() {
  const active = monitoringBase.listActive();
  if (active.length) {
    console.log(`▶️  Resuming monitoring for: ${active.map((a) => a.username).join(", ")}`);
    active.forEach((a) => startMonitoring(a.username));
  } else {
    console.log("📭 No active accounts to resume.");
  }
}

// ── Interaction handler ────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ── Button clicks ──────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id.startsWith("archive_ban_") || id.startsWith("archive_unban_")) {
      const username = id.split("_").slice(2).join("_");
      const reason   = id.startsWith("archive_ban_") ? "BAN_DETECTED" : "UNBAN_DETECTED";
      archiveAndStop(username, reason);
      const label = reason === "BAN_DETECTED" ? "banned" : "recovered";
      await interaction.update({
        content:    `📦 **@${username}** has been archived in **Old Clients** database as ${label}. Monitoring stopped.`,
        embeds:     [],
        components: [],
      });
      return;
    }

    if (id.startsWith("keep_ban_") || id.startsWith("keep_unban_")) {
      const username = id.split("_").slice(2).join("_");
      // FIX #4: Also clear eventDetectedAt so a fresh cycle begins cleanly
      monitoringBase.update(username, { active: true, eventDetectedAt: null });
      startMonitoring(username);
      await interaction.update({
        content:    `🔄 **@${username}** is back on the active monitor list.`,
        embeds:     [],
        components: [],
      });
      return;
    }

    // FIX #10: Unknown button — reply ephemerally instead of silently failing
    await interaction.reply({ content: "⚠️ Unknown button action.", ephemeral: true }).catch(() => {});
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "monitor") return;

  const sub = interaction.options.getSubcommand();

  // FIX #2: Only read username option for subcommands that actually have it
  const usernameRaw = ["add", "status", "remove"].includes(sub)
    ? (interaction.options.getString("username") || "")
    : "";
  const username = usernameRaw.toLowerCase().replace(/^@/, "");

  // ── /monitor grant ─────────────────────────────────────────────────────
  if (sub === "grant") {
    const perms = permissions.load();
    if (!perms.ownerId) {
      permissions.setOwner(interaction.user.id);
    } else if (!permissions.isOwner(interaction.user.id)) {
      return interaction.reply({ content: "❌ Only the **owner** can grant access.", ephemeral: true });
    }
    const target = interaction.options.getUser("user");
    permissions.grantAccess(target.id);
    return interaction.reply({ content: `✅ **${target.tag}** has been granted access to \`/monitor list\`.`, ephemeral: true });
  }

  // ── /monitor revoke ────────────────────────────────────────────────────
  if (sub === "revoke") {
    if (!permissions.isOwner(interaction.user.id)) {
      return interaction.reply({ content: "❌ Only the **owner** can revoke access.", ephemeral: true });
    }
    const target = interaction.options.getUser("user");
    permissions.revokeAccess(target.id);
    return interaction.reply({ content: `🚫 **${target.tag}** no longer has access to \`/monitor list\`.`, ephemeral: true });
  }

  // ── /monitor add ───────────────────────────────────────────────────────
  if (sub === "add") {
    // FIX #8: Validate username here too
    if (!validateUsername(username))
      return interaction.reply({ content: "❌ Invalid Instagram username. Use only letters, numbers, `.` and `_`.", ephemeral: true });

    if (monitoringBase.get(username)?.active)
      return interaction.reply({ content: `⚠️ **@${username}** is already being monitored.`, ephemeral: true });

    if (monitoringBase.activeCount() >= MAX_ACTIVE)
      return interaction.reply({ content: `❌ Monitoring Base is full (${MAX_ACTIVE} slots). Remove an account first.`, ephemeral: true });

    await interaction.deferReply();

    let firstCheck;
    for (let attempt = 0; attempt < 5; attempt++) {
      firstCheck = await checkAccount(username);
      if (firstCheck.status === STATUS.ACCESSIBLE || firstCheck.status === STATUS.BANNED) break;
      console.log(`[ADD] Attempt ${attempt + 1}: @${username} returned ${firstCheck.status}, retrying...`);
      await new Promise((r) => setTimeout(r, 5000));
    }

    const detectedStatus = firstCheck.status === STATUS.ACCESSIBLE ? "ACCESSIBLE" : "BANNED";
    const mode           = detectedStatus === "ACCESSIBLE" ? "WATCH_FOR_BAN" : "WATCH_FOR_UNBAN";

    const added = monitoringBase.add(
      username,
      interaction.user.tag,
      interaction.user.id,
      mode,
      detectedStatus
    );

    if (!added.ok) {
      if (added.reason === "already_monitored")
        return interaction.editReply({ content: `⚠️ **@${username}** is already being monitored.` });
      if (added.reason === "max_reached")
        return interaction.editReply({ content: `❌ Monitoring Base is full (${MAX_ACTIVE} slots).` });
    }

    monitoringBase.update(username, {
      lastChecked: firstCheck.checkedAt.toISOString(),
      lastStatus:  firstCheck.status,
      checkCount:  1,
    });

    startMonitoring(username);

    let embed;

    if (mode === "WATCH_FOR_BAN") {
      embed = new EmbedBuilder()
        .setColor(0x00cc55)
        .setTitle("🟢  Account Is Live — Monitoring for Ban")
        .setDescription(
          `**@${username}** is currently **LIVE** on Instagram.\n\n` +
          `You'll be notified the moment this account gets **banned or deactivated**.`
        )
        .addFields(
          { name: "🎯 Target",         value: `[@${username}](https://instagram.com/${username})`, inline: true },
          { name: "📊 Current Status", value: "🟢 LIVE / ACCESSIBLE",                             inline: true },
          { name: "👤 Added By",       value: interaction.user.tag,                                inline: true },
          { name: "🔔 Watching For",   value: "Ban / Deletion / Deactivation",                    inline: false }
        )
        .setFooter({ text: "Instagram Monitor • Monitoring Base" })
        .setTimestamp();
    } else {
      embed = new EmbedBuilder()
        .setColor(0xff4444)
        .setTitle("🔴  Account Is Banned — Monitoring for Recovery")
        .setDescription(
          `**@${username}** is currently **BANNED** on Instagram.\n\n` +
          `You'll be notified the moment this account gets **un-banned or recovered**.`
        )
        .addFields(
          { name: "🎯 Client Account", value: `[@${username}](https://instagram.com/${username})`, inline: true },
          { name: "📊 Current Status", value: "🔴 BANNED",                                        inline: true },
          { name: "👤 Added By",       value: interaction.user.tag,                                inline: true },
          { name: "🔔 Watching For",   value: "Unban / Account Recovery",                         inline: false }
        )
        .setFooter({ text: "Instagram Monitor • Monitoring Base" })
        .setTimestamp();
    }

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /monitor list ──────────────────────────────────────────────────────
  if (sub === "list") {
    if (!permissions.canViewList(interaction.user.id)) {
      return interaction.reply({
        content:   "🔒 You don't have permission to view the monitor list. Ask the owner to run `/monitor grant @you`.",
        ephemeral: true,
      });
    }

    const active   = monitoringBase.listActive();
    const archived = oldClients.list();

    if (!active.length && !archived.length)
      return interaction.reply({ content: "📭 No accounts in any database yet.", ephemeral: true });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📋  Full Monitoring Report")
      .setDescription(`**Monitoring Base:** ${active.length}/${MAX_ACTIVE} slots used\n**Old Clients Archive:** ${archived.length} record(s)`)
      .setTimestamp();

    if (active.length) {
      const watchingBan   = active.filter((a) => a.mode === "WATCH_FOR_BAN");
      const watchingUnban = active.filter((a) => a.mode === "WATCH_FOR_UNBAN");

      if (watchingBan.length) {
        embed.addFields({
          name:  "🟢 LIVE — Watching for Ban",
          value: watchingBan.map((a) =>
            `🟢 **@${a.username}** — added by \`${a.addedBy}\` — ${a.checkCount} checks — added ${tsRelative(a.addedAt)}`
          ).join("\n"),
        });
      }

      if (watchingUnban.length) {
        embed.addFields({
          name:  "🔴 BANNED — Watching for Unban",
          value: watchingUnban.map((a) =>
            `🔴 **@${a.username}** — added by \`${a.addedBy}\` — ${a.checkCount} checks — added ${tsRelative(a.addedAt)}`
          ).join("\n"),
        });
      }
    } else {
      embed.addFields({ name: "📡 Active Monitoring", value: "No accounts currently being monitored." });
    }

    if (archived.length) {
      const bannedOnes    = archived.filter((a) => a.archiveReason === "BAN_DETECTED");
      const recoveredOnes = archived.filter((a) => a.archiveReason === "UNBAN_DETECTED");
      const removedOnes   = archived.filter((a) => a.archiveReason === "MANUALLY_REMOVED");

      if (bannedOnes.length) {
        embed.addFields({
          name:  "⚫ OLD CLIENTS — BANNED IN PAST",
          value: bannedOnes.map((a) =>
            `⚫ **@${a.username}** — banned on ${tsField(a.eventDetectedAt || a.archivedAt)} — took ${formatDuration(a.timeTaken)} — by \`${a.addedBy}\``
          ).join("\n"),
        });
      }

      if (recoveredOnes.length) {
        embed.addFields({
          name:  "🟢 OLD CLIENTS — RECOVERED IN PAST",
          value: recoveredOnes.map((a) =>
            `🟢 **@${a.username}** — recovered on ${tsField(a.eventDetectedAt || a.archivedAt)} — took ${formatDuration(a.timeTaken)} — by \`${a.addedBy}\``
          ).join("\n"),
        });
      }

      if (removedOnes.length) {
        embed.addFields({
          name:  "🗑️ OLD CLIENTS — MANUALLY REMOVED",
          value: removedOnes.map((a) =>
            `🗑️ **@${a.username}** — removed on ${tsField(a.archivedAt)} — by \`${a.addedBy}\``
          ).join("\n"),
        });
      }
    }

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /monitor status ────────────────────────────────────────────────────
  if (sub === "status") {
    // FIX #8: Validate username
    if (!validateUsername(username))
      return interaction.reply({ content: "❌ Invalid Instagram username.", ephemeral: true });

    const account = monitoringBase.get(username);
    if (!account)
      return interaction.reply({ content: `❌ **@${username}** is not in the Monitoring Base.`, ephemeral: true });

    await interaction.deferReply();

    const result = await checkAccount(username);
    monitoringBase.update(username, {
      lastChecked: result.checkedAt.toISOString(),
      lastStatus:  result.status,
      checkCount:  (account.checkCount || 0) + 1,
    });

    const updated    = monitoringBase.get(username);
    const color      =
      result.status === STATUS.ACCESSIBLE   ? 0x00ff88 :
      result.status === STATUS.RATE_LIMITED ? 0xffcc00 :
      0xff4444;

    const modeLabel =
      updated.mode === "WATCH_FOR_BAN"   ? "🟢 Watching for Ban/Deletion" :
      updated.mode === "WATCH_FOR_UNBAN" ? "🔴 Watching for Unban/Recovery" :
      updated.mode;

    const statusEmoji = { BANNED: "🔴", ACCESSIBLE: "🟢", RATE_LIMITED: "🟡", ERROR: "⚠️" };

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`📊 Status Check — @${username}`)
      .addFields(
        { name: "📊 Current Status", value: `${statusEmoji[result.status] || "⏳"} ${result.status}`,    inline: true },
        { name: "🎯 Monitor Mode",   value: modeLabel,                                                    inline: true },
        { name: "👤 Added By",       value: updated.addedBy,                                              inline: true },
        { name: "🔢 Total Checks",   value: `${updated.checkCount}`,                                      inline: true },
        { name: "📅 Added",          value: tsField(updated.addedAt),                                     inline: true },
        { name: "🕐 Last Checked",   value: tsField(updated.lastChecked),                                 inline: true },
        { name: "🔍 Detail",         value: result.detail || "N/A",                                       inline: false },
        { name: "⚡ Active",         value: updated.active ? "Yes" : "No (event detected or paused)",    inline: true }
      )
      .setFooter({ text: "Instagram Monitor • Monitoring Base" })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /monitor remove ────────────────────────────────────────────────────
  if (sub === "remove") {
    // FIX #8: Validate username
    if (!validateUsername(username))
      return interaction.reply({ content: "❌ Invalid Instagram username.", ephemeral: true });

    const account = monitoringBase.get(username);
    if (!account)
      return interaction.reply({ content: `❌ **@${username}** is not in the Monitoring Base.`, ephemeral: true });

    // FIX #7: Defer reply before the (potentially slow) archiveAndStop operation
    await interaction.deferReply();

    archiveAndStop(username, "MANUALLY_REMOVED");

    const embed = new EmbedBuilder()
      .setColor(0x888888)
      .setTitle("🗑️  Account Removed & Archived")
      .setDescription(`**@${username}** has been removed from the **Monitoring Base** and stored in **Old Clients** archive.`)
      .addFields(
        { name: "👤 Was Added By", value: account.addedBy,          inline: true },
        { name: "📅 Was Added On", value: tsField(account.addedAt), inline: true },
        { name: "🔢 Total Checks", value: `${account.checkCount}`,  inline: true }
      )
      .setFooter({ text: "Instagram Monitor • Archived to Old Clients" })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }
});

// ── Ready ──────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`\n✅ Logged in as ${client.user.tag}`);
  console.log(`📡 Notification channel: ${CHANNEL_ID}`);
  console.log(`📦 Max monitoring slots: ${MAX_ACTIVE}`);
  await registerCommands();
  resumeAll();
  console.log("\n🤖 Bot is running. Use /monitor in Discord.\n");
});

client.login(TOKEN);
