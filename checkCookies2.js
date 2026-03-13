'use strict';
/**
 * checkCookies2.js
 * Headed browser utility — refreshes session cookies for Google, Quora and Facebook.
 * Run manually when the bot starts failing due to expired sessions.
 *
 * Fixes applied vs original:
 *  #1  Hardcoded email/password replaced with process.env values (from .env)
 *  #4  page.waitForTimeout() replaced with sleep()
 */

require('dotenv').config();

const puppeteer = require('puppeteer');
const fs        = require('fs').promises;
const { sleep } = require('./utils/puppeteer');

const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL || '';
const GOOGLE_PASS  = process.env.GOOGLE_PASS  || '';

async function loadCookies() {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
  const page    = await browser.newPage();

  // ── Google ───────────────────────────────────────────────────────────────────
  try {
    let cookies;
    try {
      cookies = JSON.parse(await fs.readFile('./google_cookies.json', 'utf8'));
      await page.setCookie(...cookies);
      await page.goto('https://www.google.com', { timeout: 90000 });
      await sleep(5000);
      cookies = await page.cookies();
      await fs.writeFile('google_cookies.json', JSON.stringify(cookies));
      console.log('Google cookies refreshed.');
    } catch {
      // No existing cookies — do a fresh login
      console.log('No Google cookies found — attempting login with env credentials.');
      await page.goto('https://accounts.google.com', { timeout: 90000 });
      await page.waitForSelector('[type="email"]');
      await page.type('[type="email"]', GOOGLE_EMAIL);
      await page.click('#identifierNext');
      await page.waitForSelector('[type="password"]', { visible: true });
      await page.type('[type="password"]', GOOGLE_PASS);
      await page.click('#passwordNext');
      await sleep(10000);
      cookies = await page.cookies();
      await fs.writeFile('google_cookies.json', JSON.stringify(cookies));
      console.log('Google login successful — cookies saved.');
    }
  } catch (err) {
    console.error('Google cookie error:', err.message);
  }

  // ── Quora ────────────────────────────────────────────────────────────────────
  try {
    let cookies;
    try {
      cookies = JSON.parse(await fs.readFile('./quora_cookies.json', 'utf8'));
      await page.setCookie(...cookies);
      await page.goto('https://www.quora.com', { waitUntil: 'networkidle2' });
      await sleep(20000);
      cookies = await page.cookies();
      await fs.writeFile('quora_cookies.json', JSON.stringify(cookies));
      console.log('Quora cookies refreshed.');
    } catch {
      console.log('No Quora cookies — opening Quora for manual SSO login.');
      await page.goto('https://www.quora.com', { waitUntil: 'networkidle2' });
      await sleep(20000); // user logs in manually in the headed browser
      cookies = await page.cookies();
      await fs.writeFile('quora_cookies.json', JSON.stringify(cookies));
      console.log('Quora cookies saved.');
    }
  } catch (err) {
    console.error('Quora cookie error:', err.message);
  }

  // ── Facebook ─────────────────────────────────────────────────────────────────
  try {
    const context = browser.defaultBrowserContext();
    context.overridePermissions('https://www.facebook.com', ['geolocation', 'notifications']);

    let cookies;
    try {
      cookies = JSON.parse(await fs.readFile('./facebook_cookies.json', 'utf8'));
      await page.setCookie(...cookies);
      await page.goto('https://www.facebook.com', { timeout: 90000 });
      await sleep(5000);
      cookies = await page.cookies();
      await fs.writeFile('facebook_cookies.json', JSON.stringify(cookies));
      console.log('Facebook cookies refreshed.');
    } catch {
      console.log('No Facebook cookies — opening Facebook for manual login.');
      await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2' });
      await sleep(20000); // user logs in manually
      cookies = await page.cookies();
      await fs.writeFile('facebook_cookies.json', JSON.stringify(cookies));
      console.log('Facebook cookies saved.');
    }
  } catch (err) {
    console.error('Facebook cookie error:', err.message);
  }

  await browser.close();
}

loadCookies().catch(err => {
  console.error('Fatal error in checkCookies2.js:', err.message);
  process.exit(1);
});
