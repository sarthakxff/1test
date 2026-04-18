/**
 * instagramChecker.js
 * Safely checks if an Instagram account is accessible (unbanned)
 * WITHOUT logging in — uses only public profile endpoint.
 * Rotates user agents to reduce bot fingerprinting risk.
 */

const axios = require("axios");

// Pool of realistic browser user agents to rotate through
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

// Add random jitter (±3 seconds) to check intervals to appear more human
function jitter(baseMs) {
  const variance = 3000;
  return baseMs + Math.floor(Math.random() * variance * 2) - variance;
}

/**
 * Status codes returned by checkAccount()
 * BANNED      - profile returns 404 or private/disabled page
 * ACCESSIBLE  - profile page loaded successfully (unbanned)
 * RATE_LIMITED - Instagram returned 429 (we're being throttled)
 * ERROR       - network or unknown error
 */
const STATUS = {
  BANNED: "BANNED",
  ACCESSIBLE: "ACCESSIBLE",
  RATE_LIMITED: "RATE_LIMITED",
  ERROR: "ERROR",
};

/**
 * Check if an Instagram username is currently accessible.
 * Uses the public profile URL — no login, no credentials.
 * @param {string} username
 * @returns {{ status: string, checkedAt: Date, detail: string }}
 */
async function checkAccount(username) {
  const url = `https://www.instagram.com/${username}/`;
  const checkedAt = new Date();

  try {
    const response = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 3,
      headers: {
        "User-Agent": getNextUserAgent(),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Cache-Control": "max-age=0",
      },
      validateStatus: () => true, // Don't throw on any HTTP status
    });

    const { status: httpStatus, data } = response;

    if (httpStatus === 429) {
      return { status: STATUS.RATE_LIMITED, checkedAt, detail: "Rate limited by Instagram. Backing off." };
    }

    if (httpStatus === 404) {
      return { status: STATUS.BANNED, checkedAt, detail: "Profile not found (404)." };
    }

    if (httpStatus === 200) {
      // Instagram sometimes returns 200 even for banned/disabled accounts
      // with a page that says "Sorry, this page isn't available."
      const isSorryPage =
        data.includes("Sorry, this page isn") ||
        data.includes("isn't available") ||
        data.includes("page not available");

      if (isSorryPage) {
        return { status: STATUS.BANNED, checkedAt, detail: "Page shows 'not available' message." };
      }

      // Check for signs the profile actually loaded
      const hasProfile =
        data.includes(`"username":"${username}"`) ||
        data.includes(`/@${username}`) ||
        data.includes(`"ProfilePage"`) ||
        data.includes(`instagram.com/${username}`);

      if (hasProfile) {
        return { status: STATUS.ACCESSIBLE, checkedAt, detail: "Profile is publicly accessible." };
      }

      // Ambiguous 200 - treat as banned to avoid false positives
      return { status: STATUS.BANNED, checkedAt, detail: "Ambiguous response — treating as unavailable." };
    }

    // Any other status (403, 500, etc.)
    return { status: STATUS.BANNED, checkedAt, detail: `HTTP ${httpStatus}` };

  } catch (err) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { status: STATUS.ERROR, checkedAt, detail: "Request timed out." };
    }
    return { status: STATUS.ERROR, checkedAt, detail: err.message };
  }
}

module.exports = { checkAccount, STATUS, jitter };
