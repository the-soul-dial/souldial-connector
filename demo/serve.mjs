// Zero-dependency static server for the demo page (Web Serial needs a secure
// context, and http://127.0.0.1 counts as one). Serves this package read-only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8743);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const wanted = url.pathname === "/" ? "/demo/index.html" : decodeURIComponent(url.pathname);
  const file = path.resolve(root, `.${wanted}`);
  if (!file.startsWith(root + path.sep) || !types[path.extname(file)]) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(file)], "Cache-Control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Soul Dial connector demo: http://127.0.0.1:${port}/  (Chrome or Edge)`);
});
