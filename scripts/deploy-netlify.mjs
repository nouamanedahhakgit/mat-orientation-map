import { createRequire } from "module";
import fs from "fs";
import crypto from "crypto";
import path from "path";

const require = createRequire(import.meta.url);
const { NetlifyAPI } = require("C:/Users/ndahhak/AppData/Local/npm-cache/_npx/90d26507e643fcc0/node_modules/@netlify/api");

const token = process.env.TOKEN;
const siteIds = [
  "55edfc16-e97e-47e6-8400-72fa3c843f0b",
  "063cc294-3850-4591-81c0-64e6dffe924e",
];
const src = process.env.SRC;
const fnZip = process.env.FNZIP;
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
const fnSha = sha1(fnZip);
const size = fs.statSync(fnZip).size;
console.log("fnSha", fnSha, "size", size);

for (const siteId of siteIds) {
  const deploy = await api.createSiteDeploy({
    site_id: siteId,
    body: {
      files,
      functions: { sheet: fnSha },
      draft: false,
      title: "Auth login + History",
    },
  });
  console.log("deploy", siteId, deploy.id, "required", deploy.required, "required_functions", deploy.required_functions);

  for (const filePath of deploy.required || []) {
    const local = path.join(src, filePath.replace(/^\//, ""));
    await api.uploadDeployFile({
      deploy_id: deploy.id,
      path: filePath,
      body: fs.createReadStream(local),
    });
    console.log("uploaded file", filePath);
  }

  try {
    await api.uploadDeployFunction({
      deploy_id: deploy.id,
      name: "sheet",
      runtime: "js",
      size,
      body: fs.createReadStream(fnZip),
    });
    console.log("uploaded function sheet");
  } catch (error) {
    console.error("function upload failed", error.message || error);
    throw error;
  }

  for (let i = 0; i < 45; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const d = await api.getSiteDeploy({ deploy_id: deploy.id });
    console.log("state", d.state, "funcs", (d.available_functions || []).length, d.error_message || "");
    if (d.state === "ready" || d.state === "error") break;
  }
}
