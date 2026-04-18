/**
 * instagramChecker.js
 * Safely checks if an Instagram account is accessible (unbanned)
 * WITHOUT logging in — uses public profile + API endpoints.
 * Rotates user agents to reduce bot fingerprinting risk.
 * Supports HTTP proxy via PROXY_URL env variable.
 *
 * Strategy (most reliable first):
 *  1. Hit the public JSON endpoint  ?__a=1&__d=dis  → cleanest signal
 *  2. Fall back to scraping the HTML profile page
 *  3. If both are ambiguous → ERROR (never assume banned)
 *
 * KEY INSIGHT: Instagram almost always shows a login wall (HTTP 200 + login HTML)
 * for real accounts. A login wall = account EXISTS = ACCESSIBLE.
 * Never assume BANNED from ambiguous signals — only from explicit 404 / "not available" page.
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
 
// Always adds positive variance — never returns negative ms
function jitter(baseMs) {
  return baseMs + Math.floor(Math.random() * 3000);
}
 
// Built fresh on every call so PROXY_URL changes at runtime are picked up
function getProxyConfig() {
  const proxyUrl = process.env.PROXY_URL;
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    const config = {
      protocol: u.protocol.replace(":", ""),
      host:     u.hostname,
      port:     Number(u.port || 80),
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
 
// Log proxy status once at startup
const _initProxy = getProxyConfig();
if (_initProxy) {
  console.log(`🔀 Proxy enabled: ${_initProxy.host}:${_initProxy.port}`);
} else {
  console.warn("⚠️  No PROXY_URL set — requests will use the server's IP.");
}
 
// ── Status constants ────────────────────────────────────────────────────────
const STATUS = {
  BANNED:       "BANNED",
  ACCESSIBLE:   "ACCESSIBLE",
  RATE_LIMITED: "RATE_LIMITED",
  ERROR:        "ERROR",
};
 
// ── Shared request config builder ──────────────────────────────────────────
function buildRequestConfig(extraHeaders = {}) {
  const proxyConfig = getProxyConfig();
  const config = {
    timeout:      15000,
    maxRedirects: 5,
    headers: {
      "User-Agent":                getNextUserAgent(),
      Accept:                      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language":           "en-US,en;q=0.9",
      "Accept-Encoding":           "gzip, deflate, br",
      Connection:                  "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest":            "document",
      "Sec-Fetch-Mode":            "navigate",
      "Sec-Fetch-Site":            "none",
      "Cache-Control":             "no-cache",
      Pragma:                      "no-cache",
      ...extraHeaders,
    },
    validateStatus: () => true, // never throw on any HTTP status
  };
  if (proxyConfig) config.proxy = proxyConfig;
  return config;
}
 
// ── Banned-page phrase detector (shared between both methods) ──────────────
function isDefinitelyBannedHtml(html) {
  return (
    html.includes("Sorry, this page isn\u2019t available.") || // unicode apostrophe
    html.includes("Sorry, this page isn't available.")       || // straight apostrophe
    html.includes("The link you followed may be broken")     ||
    html.includes("the page may have been removed")
  );
}
 
// ── Login-wall detector (shared between both methods) ─────────────────────
// IMPORTANT: A login wall means the account EXISTS — Instagram just wants you to log in.
// This is NOT a ban signal. Treat as ACCESSIBLE.
function isLoginWall(html) {
  return (
    html.includes("Log in to Instagram")           ||
    html.includes("log_in")                        ||
    html.includes("loginForm")                     ||
    html.includes("You must be 18")                ||
    html.includes("to see photos and videos")      ||
    html.includes("Sign up to see")                ||
    html.includes("instagram.com/accounts/login")
  );
}
 
// ── METHOD 1: Public JSON endpoint ─────────────────────────────────────────
// Instagram exposes ?__a=1&__d=dis on profile URLs.
//   Account exists  → JSON with user data     → ACCESSIBLE
//   Account banned  → 404 or JSON error       → BANNED
//   Rate limited    → 429                     → RATE_LIMITED
//   Auth required   → 401 or login-wall HTML  → ACCESSIBLE (account exists)
async function checkViaJsonEndpoint(username) {
  const url = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
  try {
    const response = await axios.get(url, buildRequestConfig({
      Accept:               "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With":   "XMLHttpRequest",
      "X-IG-App-ID":        "936619743392459", // public Instagram web app ID
    }));
 
    const { status: httpStatus, data } = response;
 
    if (httpStatus === 429) return { status: STATUS.RATE_LIMITED, detail: "Rate limited (429) on JSON endpoint." };
    if (httpStatus === 407) {
      console.error("❌ Proxy auth failed (407). Check PROXY_URL credentials.");
      return { status: STATUS.ERROR, detail: "Proxy authentication failed (407)." };
    }
    if (httpStatus === 404) return { status: STATUS.BANNED,     detail: "JSON endpoint 404 — account banned/deleted." };
    if (httpStatus === 401) return { status: STATUS.ACCESSIBLE, detail: "Auth required (401) — account exists." };
    if (httpStatus !== 200) return { status: STATUS.ERROR,      detail: `JSON endpoint returned HTTP ${httpStatus}.` };
 
    // Try to parse as JSON
    let json = null;
    if (typeof data === "object" && data !== null) {
      json = data;
    } else if (typeof data === "string") {
      try { json = JSON.parse(data); } catch { /* not JSON */ }
    }
 
    if (json) {
      // Clear user data present → ACCESSIBLE
      if (json.graphql?.user || json.data?.user || json.user) {
        return { status: STATUS.ACCESSIBLE, detail: "User data found in JSON response." };
      }
      // Login required response → account exists → ACCESSIBLE
      if (json.require_login || json.message === "login_required") {
        return { status: STATUS.ACCESSIBLE, detail: "Login required in JSON — account exists." };
      }
      // Explicit failure → BANNED
      if (json.status === "fail" || json.message === "No user found") {
        return { status: STATUS.BANNED, detail: `JSON reports failure: ${json.message || "no user found"}` };
      }
      // Other JSON but no clear signal → ERROR
      return { status: STATUS.ERROR, detail: "JSON response had no clear user/error field." };
    }
 
    // Not JSON — got HTML on the JSON endpoint (common when Instagram serves login wall)
    const html = typeof data === "string" ? data : "";
    if (isDefinitelyBannedHtml(html)) return { status: STATUS.BANNED,     detail: "Banned-page HTML on JSON endpoint." };
    if (isLoginWall(html))            return { status: STATUS.ACCESSIBLE, detail: "Login wall HTML on JSON endpoint — account exists." };
 
    return { status: STATUS.ERROR, detail: "Non-JSON, non-login-wall response on JSON endpoint." };
 
  } catch (err) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { status: STATUS.ERROR, detail: "JSON endpoint timed out." };
    }
    return { status: STATUS.ERROR, detail: `JSON endpoint exception: ${err.message}` };
  }
}
 
// ── METHOD 2: HTML profile page fallback ───────────────────────────────────
// Only used when METHOD 1 returns ERROR (ambiguous).
async function checkViaHtmlPage(username) {
  const url = `https://www.instagram.com/${username}/`;
  try {
    const response = await axios.get(url, buildRequestConfig());
    const { status: httpStatus, data } = response;
 
    if (httpStatus === 429) return { status: STATUS.RATE_LIMITED, detail: "Rate limited (429) on HTML page." };
    if (httpStatus === 407) return { status: STATUS.ERROR,        detail: "Proxy auth failed (407)." };
    if (httpStatus === 404) return { status: STATUS.BANNED,       detail: "HTML page 404 — account banned/deleted." };
    if (httpStatus !== 200) return { status: STATUS.ERROR,        detail: `HTML page returned HTTP ${httpStatus}.` };
 
    const html = typeof data === "string" ? data : JSON.stringify(data);
 
    // Explicit banned page
    if (isDefinitelyBannedHtml(html)) {
      return { status: STATUS.BANNED, detail: "HTML page shows explicit 'not available' message." };
    }
 
    // Login wall = account EXISTS = ACCESSIBLE
    // This is the most common response Instagram gives for real accounts
    if (isLoginWall(html)) {
      return { status: STATUS.ACCESSIBLE, detail: "Login wall on HTML page — account exists and is accessible." };
    }
 
    // Profile data visible in page (rare without cookies but possible)
    const usernameLower = username.toLowerCase();
    const hasProfileData =
      html.includes(`"username":"${usernameLower}"`)               ||
      html.includes(`"username": "${usernameLower}"`)              ||
      html.includes(`"https://www.instagram.com/${usernameLower}/"`) ||
      html.includes(`"ProfilePage"`)                               ||
      html.includes(`"graphql"`)                                   ||
      (html.includes("og:title") && html.toLowerCase().includes(usernameLower));
 
    if (hasProfileData) {
      return { status: STATUS.ACCESSIBLE, detail: "Profile data found in HTML page." };
    }
 
    // Truly ambiguous — do NOT assume banned
    return { status: STATUS.ERROR, detail: "HTML page response was ambiguous — will retry next cycle." };
 
  } catch (err) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { status: STATUS.ERROR, detail: "HTML page timed out." };
    }
    return { status: STATUS.ERROR, detail: `HTML page exception: ${err.message}` };
  }
}
 
// ── MAIN EXPORT ────────────────────────────────────────────────────────────
/**
 * Check if an Instagram username is currently accessible.
 * Tries JSON endpoint first, falls back to HTML scrape if ambiguous.
 * NEVER reports BANNED from ambiguous responses — only explicit 404 / banned-page signals.
 */
async function checkAccount(username) {
  const checkedAt = new Date();
 
  // Step 1: Try the JSON endpoint (fastest and most reliable)
  const jsonResult = await checkViaJsonEndpoint(username);
  console.log(`  [JSON] @${username} → ${jsonResult.status}: ${jsonResult.detail}`);
 
  if (jsonResult.status !== STATUS.ERROR) {
    return { ...jsonResult, checkedAt };
  }
 
  // Step 2: JSON was ambiguous — fall back to HTML page
  console.log(`  [HTML] @${username} — JSON ambiguous, trying HTML fallback...`);
  const htmlResult = await checkViaHtmlPage(username);
  console.log(`  [HTML] @${username} → ${htmlResult.status}: ${htmlResult.detail}`);
 
  return { ...htmlResult, checkedAt };
}
 
module.exports = { checkAccount, STATUS, jitter };
