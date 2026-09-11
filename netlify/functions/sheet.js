/**
 * Proxies browser requests to the Google Apps Script webhook (Excel DB).
 * Set in Netlify → Site settings → Environment variables:
 *   SHEET_WEBHOOK_URL = https://script.google.com/macros/s/.../exec
 *   SHEET_WEBHOOK_SECRET = (optional, same as Apps Script WEBHOOK_SECRET)
 */

const ALLOWED_MODES = new Set(["export", "patch", "full"]);

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "POST only" }, cors);
  }

  const webhookUrl = process.env.SHEET_WEBHOOK_URL || "";
  if (!webhookUrl) {
    return json(500, {
      ok: false,
      error: "SHEET_WEBHOOK_URL is not set in Netlify environment variables",
    }, cors);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" }, cors);
  }

  const mode = String(body.mode || "export").toLowerCase();
  if (!ALLOWED_MODES.has(mode)) {
    return json(400, { ok: false, error: "mode must be export|patch|full" }, cors);
  }

  const payload = {
    mode,
    secret: process.env.SHEET_WEBHOOK_SECRET || body.secret || undefined,
    patch: body.patch,
    matId: body.patch?.matId || body.matId,
    values: mode === "full" ? body.values : undefined,
    tab: body.tab || "orientation camera ap",
  };

  // Append mode on URL too — helps if an old Apps Script ignores JSON body.mode.
  const targetUrl =
    mode === "export" || mode === "patch"
      ? `${webhookUrl}${webhookUrl.includes("?") ? "&" : "?"}mode=${encodeURIComponent(mode)}`
      : webhookUrl;

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json(502, {
        ok: false,
        error: "Apps Script returned non-JSON. Redeploy the script as Anyone + New version.",
        preview: text.slice(0, 200),
      }, cors);
    }
    if (data && data.ok === false && /Missing values/i.test(String(data.error || ""))) {
      data.hint =
        data.hint ||
        "Apps Script deploy is still the OLD version. In Apps Script: Deploy → Manage deployments → pencil → Version: New version → Deploy. Then open /exec in a browser — message must mention mode=export.";
    }
    return json(response.ok ? 200 : 502, data, cors);
  } catch (error) {
    return json(502, { ok: false, error: String(error.message || error) }, cors);
  }
};

function json(statusCode, data, headers) {
  return {
    statusCode,
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}
