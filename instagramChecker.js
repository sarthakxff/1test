/**
 * instagramChecker.js
 * Safely checks if an Instagram account is accessible (unbanned)
 * WITHOUT logging in — uses only public profile endpoint.
 * Rotates user agents to reduce bot fingerprinting risk.
 * Supports HTTP proxy via PROXY_URL env variable.
 */

const axios = require("axios");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

let uaIndex = 0;
function getNextUserAgent() {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex++;
  return ua;
}

function jitter(baseMs) {
  const variance = 3000;
  return baseMs + Math.floor(Math.random() * variance * 2) - variance;
}

// ── Proxy config ────────────────────────────────────────────────────────────
function getProxyConfig() {
  const proxyUrl = process.env.PROXY_URL;
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    const config = {
      protocol: u.protocol.replace(":", ""),
      host: u.hostname,
      port: Number(u.port || 80),
    };
    if (u.username) {
      config.auth = {
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      };
    }
    return config;
  } catch (err) {
    console.error("❌ Invalid PROXY_URL format:", err.message);
    return null;
  }
}

const proxyConfig = getProxyConfig();
if (proxyConfig) {
  console.log(`🔀 Proxy enabled: ${proxyConfig.host}:${proxyConfig.port}`);
} else {
  console.warn("⚠️  No PROXY_URL set — requests will use the server's IP.");
}

const STATUS = {
  BANNED: "BANNED",
  ACCESSIBLE: "ACCESSIBLE",
  RATE_LIMITED: "RATE_LIMITED",
  ERROR: "ERROR",
};

/**
 * Check if an Instagram username is currently accessible.
 * Uses the public profile URL — no login, no credentials.
 * 
 * Detection logic (in order of reliability):
 * 1. HTTP 404       → definitely BANNED
 * 2. HTTP 429       → RATE_LIMITED
 * 3. "not available" text on page → BANNED
 * 4. Strong positive signals (username in JSON, og:title with name) → ACCESSIBLE
 * 5. Login wall / "log in to continue" → treat as ACCESSIBLE (account exists, just gated)
 * 6. Anything else ambiguous → ERROR (don't assume banned)
 */
async function checkAccount(username) {
  const url = `https://www.instagram.com/${username}/`;
  const checkedAt = new Date();

  const requestConfig = {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      "User-Agent": getNextUserAgent(),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
    validateStatus: () => true,
  };

  if (proxyConfig) {
    requestConfig.proxy = proxyConfig;
  }

  try {
    const response = await axios.get(url, requestConfig);
    const { status: httpStatus, data } = response;

    // ── 1. Clear HTTP signals ──────────────────────────────────────────────
    if (httpStatus === 429) {
      return { status: STATUS.RATE_LIMITED, checkedAt, detail: "Rate limited by Instagram (429). Backing off." };
    }

    if (httpStatus === 407) {
      return { status: STATUS.ERROR, checkedAt, detail: "Proxy authentication failed (407). Check PROXY_URL." };
    }

    if (httpStatus === 404) {
      return { status: STATUS.BANNED, checkedAt, detail: "Profile not found (HTTP 404) — account is banned/deleted." };
    }

    if (httpStatus !== 200) {
      return { status: STATUS.ERROR, checkedAt, detail: `Unexpected HTTP ${httpStatus} — skipping this check.` };
    }

    // ── 2. HTTP 200 — analyse page content ────────────────────────────────
    const html = typeof data === "string" ? data : JSON.stringify(data);

    // BANNED signals — only trust very specific phrases
    const definitelyBanned =
      html.includes("Sorry, this page isn\u2019t available.") ||  // unicode apostrophe
      html.includes("Sorry, this page isn't available.") ||        // straight apostrophe
      html.includes("The link you followed may be broken") ||
      html.includes("the page may have been removed");

    if (definitelyBanned) {
      return { status: STATUS.BANNED, checkedAt, detail: "Page shows definitive 'not available' message." };
    }

    // LOGIN WALL — Instagram is blocking the view but the account EXISTS
    // This is NOT a ban — treat as ACCESSIBLE
    const loginWall =
      html.includes("Log in to Instagram") ||
      html.includes("log_in") ||
      html.includes("loginForm") ||
      html.includes("You must be 18") ||
      html.includes("to see photos and videos") ||
      html.includes("Sign up to see");

    if (loginWall) {
      return { status: STATUS.ACCESSIBLE, checkedAt, detail: "Login wall shown — account exists and is accessible." };
    }

    // STRONG POSITIVE signals — profile data present in page
    const usernameLower = username.toLowerCase();
    const definitelyAccessible =
      html.includes(`"username":"${usernameLower}"`) ||
      html.includes(`"username": "${usernameLower}"`) ||
      html.includes(`/@${usernameLower}`) ||
      html.includes(`instagram.com/${usernameLower}`) ||
      html.includes(`"ProfilePage"`) ||
      html.includes(`"graphql"`) ||
      (html.includes(`og:title`) && html.includes(username));

    if (definitelyAccessible) {
      return { status: STATUS.ACCESSIBLE, checkedAt, detail: "Profile data found — account is accessible." };
    }

    // AMBIGUOUS — don't assume banned, treat as ERROR so we retry
    return { status: STATUS.ERROR, checkedAt, detail: "Ambiguous response — will retry next cycle." };

  } catch (err) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { status: STATUS.ERROR, checkedAt, detail: "Request timed out — will retry." };
    }
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
      return { status: STATUS.ERROR, checkedAt, detail: `Connection failed: ${err.message}` };
    }
    return { status: STATUS.ERROR, checkedAt, detail: err.message };
  }
}

module.exports = { checkAccount, STATUS, jitter };
