require("dotenv").config();
const https = require("https");

function httpRequest(urlStr, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);

    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      method,
      path: url.pathname + url.search,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
}

async function postWebhook(rows) {
  const baseUrl = process.env.WEBHOOK_URL;
  const token = process.env.WEBHOOK_TOKEN;

  if (!baseUrl) throw new Error("Missing WEBHOOK_URL in .env");
  if (!token) throw new Error("Missing WEBHOOK_TOKEN in .env");

  const execUrl = new URL(baseUrl);
  execUrl.searchParams.set("token", token);

  const payload = JSON.stringify({
    token,
    rows: Array.isArray(rows) ? rows : [],
  });

  // 1) POST to /exec WITHOUT following redirects
  const postRes = await httpRequest(execUrl.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Accept": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
    body: payload,
  });

  // 2) If redirected, GET the Location (Apps Script common behavior)
  if ((postRes.status === 302 || postRes.status === 303) && postRes.headers.location) {
    const loc = postRes.headers.location;

    const getRes = await httpRequest(loc, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });

    // Must be JSON
    try {
      return JSON.parse(getRes.body);
    } catch {
      throw new Error(
        `Redirect GET returned non-JSON (status ${getRes.status}): ${getRes.body.slice(0, 250)}`
      );
    }
  }

  // 3) If not redirected, try parsing direct response
  try {
    return JSON.parse(postRes.body);
  } catch {
    throw new Error(
      `Invalid JSON (status ${postRes.status}): ${postRes.body.slice(0, 250)}`
    );
  }
}

module.exports = { postWebhook };