// Shared by gate-verify.js and gate-status.js. Not itself an endpoint —
// Netlify's zero-config functions bundler only treats files that export
// a `handler` as callable, and this one deliberately doesn't.
'use strict';
const crypto = require('crypto');

const ALLOWED_BRANDS = ['Mercedes-Benz', 'BMW', 'Porsche'];
const COOKIE_NAME = 'husllyfe_gate';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 days

function secret() {
  const s = process.env.GATE_SECRET;
  if (!s) throw new Error('GATE_SECRET is not set');
  return s;
}

/** Signs {passed:true, brand, iat} into "<base64url payload>.<base64url hmac>". */
function sign(payloadObj) {
  const body = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + mac;
}

/** Verifies the HMAC and returns the decoded payload, or null if invalid/tampered. */
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const body = parts[0], mac = parts[1];
  let expected;
  try { expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url'); }
  catch (e) { return null; }
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch (e) { return null; }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i === -1) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setCookieHeader(token) {
  return COOKIE_NAME + '=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + MAX_AGE_SECONDS;
}

function clearCookieHeader() {
  return COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

module.exports = { ALLOWED_BRANDS, COOKIE_NAME, sign, verify, parseCookies, setCookieHeader, clearCookieHeader };
