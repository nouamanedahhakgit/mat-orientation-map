/**
 * Proxies browser requests to the Google Apps Script webhook (Excel DB).
 * Env: SHEET_WEBHOOK_URL, SHEET_WEBHOOK_SECRET (optional)
 *
 * Modes: login | export | patch | full
 * Public map must login first; export/patch forward user+token.
 */

const ALLOWED_MODES = new Set(["login", "export", "patch", "full"]);

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
    return json(400, { ok: false, error: "mode must be login|export|patch|full" }, cors);
  }

  if ((mode === "export" || mode === "patch") && !body.token && !(body.user && (body.pass || body.password))) {
    return json(401, { ok: false, error: "Login required" }, cors);
  }

  if (mode === "login" && !(body.user || body.username) ) {
    return json(400, { ok: false, error: "Missing user" }, cors);
  }

  const payload = {
    mode,
    secret: process.env.SHEET_WEBHOOK_SECRET || body.secret || undefined,
    user: body.user || body.username,
    pass: body.pass || body.password,
    token: body.token,
    patch: body.patch,
    matId: body.patch?.matId || body.matId,
    values: mode === "full" ? body.values : undefined,
    tab: body.tab || "orientation camera ap",
  };

  const targetUrl =
    mode === "export" || mode === "patch" || mode === "login"
      ? `${webhookUrl}${webhookUrl.includes("?") ? "&" : "?"}mode=${encodeURIComponent(mode)}`
      : webhookUrl;

  try {
    const data = await postAppsScript(targetUrl, payload);
    if (data && data.ok === false && /Missing values/i.test(String(data.error || ""))) {
      data.hint =
        data.hint ||
        "Apps Script deploy is still the OLD version. Deploy → Manage deployments → Edit → Version: New version → Deploy (auth-history-v1).";
    }
    const status = data && data.ok === false && /login|password|session|unauthorized/i.test(String(data.error || ""))
      ? 401
      : 200;
    return json(status, data, cors);
  } catch (error) {
    return json(502, { ok: false, error: String(error.message || error) }, cors);
  }
};

async function postAppsScript(url, payload) {
  const serialized = JSON.stringify(payload);
  const first = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
    },
    body: serialized,
  });

  let text = await first.text();
  const location = first.headers.get("location");

  if ([301, 302, 303, 307, 308].includes(first.status) && location) {
    const second = await fetch(new URL(location, url).href, {
      method: "GET",
      redirect: "follow",
      headers: { Accept: "application/json" },
    });
    text = await second.text();
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      /sign in|accounts\.google/i.test(text)
        ? "Apps Script blocked the request. Redeploy with Who has access = Anyone."
        : `Apps Script returned non-JSON: ${text.slice(0, 180)}`,
    );
  }
}

function json(statusCode, data, headers) {
  return {
    statusCode,
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}
