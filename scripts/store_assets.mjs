import { chromium } from "playwright";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs", "assets");
await mkdir(output, { recursive: true });
await copyFile(path.join(root, "test-results", "store-1280x800.png"), path.join(output, "screenshot-1280x800.png"));
await copyFile(path.join(root, "test-results", "02-desktop.png"), path.join(output, "overview.png"));
await copyFile(path.join(root, "extension", "icons", "128.png"), path.join(output, "icon-128.png"));
const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await page.goto(pathToFileURL(path.join(root, "docs", "promo.html")).href);
  await page.screenshot({ path: path.join(output, "promo-440x280.png") });
} finally { await browser.close(); }
let privacy = await readFile(path.join(root, "extension", "privacy.html"), "utf8");
const css = await readFile(path.join(root, "extension", "style.css"), "utf8");
privacy = privacy.replace('<link rel="stylesheet" href="style.css">', `<style>${css}</style>`)
  .replace('<a href="index.html">← Вернуться к серверам</a>', '<p class="hint">Твинкл: помощник голосования</p>');
await writeFile(path.join(root, "docs", "privacy.html"), privacy);
console.log("Store assets and standalone privacy page prepared.");
