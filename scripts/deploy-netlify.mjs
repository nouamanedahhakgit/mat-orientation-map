import { createRequire } from "module";
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { pathToFileURL } from "url";

const require = createRequire(import.meta.url);
const { NetlifyAPI } = require("C:/Users/ndahhak/AppData/Local/npm-cache/_npx/90d26507e643fcc0/node_modules/@netlify/api");
const { zipFunctions } = await import(pathToFileURL("C:/Users/ndahhak/AppData/Local/npm-cache/_npx/90d26507e643fcc0/node_modules/@netlify/zip-it-and-ship-it/dist/main.js").href);

let token = process.env.TOKEN;
if (!token) {
  try {
    const cfg = JSON.parse(fs.readFileSync("C:/Users/ndahhak/AppData/Roaming/netlify/Config/config.json", "utf8"));
    token = Object.values(cfg.users)[0]?.auth?.token;
  } catch (err) {
    console.error("Could not read netlify token from config:", err.message);
  }
}
const siteIds = [
  "55edfc16-e97e-47e6-8400-72fa3c843f0b",
  "063cc294-3850-4591-81c0-64e6dffe924e",
];
const src = process.env.SRC || path.resolve(".");
const distFn = path.join(src, "dist-fn");
if (!fs.existsSync(distFn)) fs.mkdirSync(distFn, { recursive: true });

console.log("Zipping Netlify functions...");
const zipped = await zipFunctions([path.join(src, "netlify/functions")], distFn);
const functions = {};
const fnShaToInfo = {};
for (const fn of zipped) {
  const buf = fs.readFileSync(fn.path);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  functions[fn.name] = sha;
  fnShaToInfo[sha] = { name: fn.name, path: fn.path, runtime: fn.runtime || "js" };
  console.log(`Function ${fn.name}: sha256=${sha}`);
}

const api = new NetlifyAPI(token);

function sha1(filePath) {
  return crypto.createHash("sha1").update(fs.readFileSync(filePath)).digest("hex");
}

const files = {
  "/index.html": sha1(path.join(src, "index.html")),
  "/app.js": sha1(path.join(src, "app.js")),
  "/styles.css": sha1(path.join(src, "styles.css")),
  "/netlify.toml": sha1(path.join(src, "netlify.toml")),
};
const shaToPath = {};
for (const [p, sha] of Object.entries(files)) {
  shaToPath[sha] = p;
}

for (const siteId of siteIds) {
  console.log("\nStarting deploy for site:", siteId);
  const deploy = await api.createSiteDeploy({
    site_id: siteId,
    siteId: siteId,
    body: {
      files,
      functions,
      draft: false,
      title: "Fix login & direct webhook CSP with live GPS & Beach horloge",
    },
  });
  console.log("deploy", siteId, deploy.id, "required files:", deploy.required?.length, "required functions:", deploy.required_functions?.length);

  for (const sha of deploy.required || []) {
    const filePath = shaToPath[sha];
    if (!filePath) {
      console.warn("Unknown sha in required:", sha);
      continue;
    }
    const local = path.join(src, filePath.replace(/^\//, ""));
    await api.uploadDeployFile({
      deploy_id: deploy.id,
      deployId: deploy.id,
      path: encodeURI(filePath.replace(/^\//, "")),
      body: () => fs.createReadStream(local),
    });
    console.log("uploaded file", filePath);
  }

  for (const reqFnSha of deploy.required_functions || []) {
    const fnInfo = fnShaToInfo[reqFnSha];
    if (!fnInfo) {
      console.warn("Unknown required function SHA:", reqFnSha);
      continue;
    }
    try {
      console.log(`Uploading function ${fnInfo.name} (${fnInfo.path})...`);
      await api.uploadDeployFunction({
        deploy_id: deploy.id,
        deployId: deploy.id,
        name: encodeURI(fnInfo.name),
        runtime: fnInfo.runtime,
        body: () => fs.createReadStream(fnInfo.path),
      });
      console.log("uploaded function", fnInfo.name);
    } catch (error) {
      console.error("function upload failed:", error.message || error);
      throw error;
    }
  }

  for (let i = 0; i < 45; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const d = await api.getSiteDeploy({ site_id: siteId, deploy_id: deploy.id });
    console.log("state:", d.state, "funcs:", (d.available_functions || []).length, d.error_message || "");
    if (d.state === "ready" || d.state === "error") break;
  }
}
