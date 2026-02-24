require("dotenv").config();
const { postWebhook } = require("../src/postWebhook");

(async () => {
  try {
    const resp = await postWebhook([]);
    console.log(JSON.stringify({ ok: true, response: resp }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2));
    process.exitCode = 1;
  }
})();