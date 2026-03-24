#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const [captureId, relFilePath, portArg] = process.argv.slice(2);

if (!captureId || !relFilePath) {
  console.error("Usage: node submit-figma-capture.js <captureId> <filePath>");
  process.exit(1);
}

const endpoint = `https://mcp.figma.com/mcp/capture/${captureId}/submit`;
const absPath = path.resolve(relFilePath);

if (!fs.existsSync(absPath)) {
  console.error("File not found:", absPath);
  process.exit(1);
}

const html = fs.readFileSync(absPath, "utf8");
const port = Number(portArg || 4173);
if (!Number.isInteger(port) || port <= 0) {
  console.error("Invalid port:", portArg);
  process.exit(1);
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

(async () => {
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    console.log(`serving:${absPath}`);
    console.log(`url:http://127.0.0.1:${port}/`);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 2400 },
    });

    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    console.log("loaded:domcontent");

    await page.waitForFunction(
      () => !!(window.figma && typeof window.figma.captureForDesign === "function"),
      { timeout: 90000 }
    );
    console.log("loaded:figma-capture");

    await page.evaluate(
      ({ captureId, endpoint }) => {
        window.figma.captureForDesign({
          captureId,
          endpoint,
          selector: "body",
          delay: 1200,
        });
      },
      { captureId, endpoint }
    );

    await page.waitForTimeout(8000);
    await browser.close();
    console.log(`submitted:${captureId}`);
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
})();
