import { createRequire } from "module";
import fs from "fs";
import crypto from "crypto";
import path from "path";

const require = createRequire(import.meta.url);
const { NetlifyAPI } = require("C:/Users/ndahhak/AppData/Local/npm-cache/_npx/90d26507e643fcc0/node_modules/@netlify/api");

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
const fnZip = process.env.FNZIP || path.join(src, "sheet.zip");
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
const EXISTING_FUNCTION_SHA = "b2fa1ef342b68b7cbb9393996a4ca0e310a09172047af6dccc74251d3a8e6abb";
const fnSha = EXISTING_FUNCTION_SHA;
const shaToPath = {};
for (const [p, sha] of Object.entries(files)) {
  shaToPath[sha] = p;
}

for (const siteId of siteIds) {
  console.log("Starting deploy for site:", siteId);
  const deploy = await api.createSiteDeploy({
    site_id: siteId,
    body: {
      files,
      functions: { sheet: fnSha },
      draft: false,
      title: "Search MAT/AP/CAM, Live GPS & Adaptive Beach Horloge (Beach=12h)",
    },
  });
  console.log("deploy", siteId, deploy.id, "required:", deploy.required?.length, "required_functions:", deploy.required_functions?.length);

  for (const sha of deploy.required || []) {
    const filePath = shaToPath[sha];
    if (!filePath) {
      console.warn("Unknown sha in required:", sha);
      continue;
    }
    const local = path.join(src, filePath.replace(/^\//, ""));
    await api.uploadDeployFile({
      deploy_id: deploy.id,
      path: filePath.replace(/^\//, ""),
      body: fs.createReadStream(local),
    });
    console.log("uploaded file", filePath);
  }

  for (const reqFn of deploy.required_functions || []) {
    try {
      await api.uploadDeployFunction({
        deploy_id: deploy.id,
        name: "sheet",
        body: fs.createReadStream(fnZip),
      });
      console.log("uploaded function sheet");
    } catch (error) {
      console.error("function upload failed", error.message || error);
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
