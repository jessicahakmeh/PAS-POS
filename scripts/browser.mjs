// Starts headless Edge for the browser scripts. Tries puppeteer's normal launch first; if Edge refuses that way
// (seen after Edge updates), starts Edge itself with a debugging port and connects to it.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

export async function launchBrowser() {
  try { return await puppeteer.launch({ executablePath: EDGE, headless: 'new' }); }
  catch (e) { console.log('  (puppeteer launch failed, starting Edge with a debugging port instead)'); }
  const port = 9222 + Math.floor(Math.random() * 500);
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'pas-edge-'))}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const close = browser.close.bind(browser);
  browser.close = async () => { await close().catch(() => {}); proc.kill(); };
  return browser;
}
