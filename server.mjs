import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import https from "node:https";

const root = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.join(root, ".env"));

const port = Number(process.env.PORT || 5174);
const host = process.env.HOST || "0.0.0.0";
const webhookUrl = process.env.SHEET_WEBHOOK_URL || "https://script.google.com/macros/s/AKfycby8sXiPEIWwS84rly0e5jSATF5qRgmIcvussuH0zAJRJ0SsMhrP0vcto8ATXLAv0IkrCg/exec";
const webhookSecret = process.env.SHEET_WEBHOOK_SECRET || "";

const server = http.createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/sheet" && req.method === "POST") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      const body = JSON.parse(raw);

      const mode = String(body.mode || "export").toLowerCase();
      const payload = {
        mode,
        secret: webhookSecret || body.secret || undefined,
        user: body.user || body.username,
        pass: body.pass || body.password,
        token: body.token,
        patch: body.patch,
        matId: body.patch?.matId || body.matId,
        values: mode === "full" ? body.values : undefined,
        tab: body.tab || "orientation camera ap",
      };

      const targetUrl = (mode === "export" || mode === "patch" || mode === "login")
        ? `${webhookUrl}${webhookUrl.includes("?") ? "&" : "?"}mode=${encodeURIComponent(mode)}`
        : webhookUrl;

      const data = await postAppsScript(targetUrl, payload);
      res.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
      return;
    } catch (err) {
      console.error("[api/sheet]", err.message);
      res.writeHead(500, { ...cors, "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
  }

  // Static files
  let filePath = path.join(root, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, ""));
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    };
    res.writeHead(200, {
      "Content-Type": mimes[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`MAT Orientation Public Map: http://127.0.0.1:${port}`);
});

async function postAppsScript(url, payload) {
  const serialized = JSON.stringify(payload);
  const first = await httpsJsonRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      Accept: "application/json",
    },
    body: serialized,
  });

  let status = first.status;
  let text = first.text;
  if ([301, 302, 303, 307, 308].includes(first.status) && first.location) {
    const second = await httpsJsonRequest(new URL(first.location, url).href, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    status = second.status;
    text = second.text;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 160) || `Apps Script status ${status}`);
  }
}

function httpsJsonRequest(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body == null ? null : Buffer.from(body);
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          ...headers,
          ...(payload ? { "Content-Length": payload.length } : {}),
        },
        rejectUnauthorized: false,
        timeout: 45_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadEnv(file) {
  try {
    const content = await fs.readFile(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const split = trimmed.indexOf("=");
      if (split < 1) continue;
      const key = trimmed.slice(0, split).trim();
      const value = trimmed.slice(split + 1).trim().replace(/^['"]|['"]$/g, "");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {}
}
