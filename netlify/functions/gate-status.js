// GET /.netlify/functions/gate-status
// Reads the signed cookie (if any) and reports whether it's valid. Never
// trusts anything the browser could have edited — HttpOnly means the page's
// own JS can't even read the cookie value, only send it back automatically.
'use strict';
const { COOKIE_NAME, verify, parseCookies } = require('./_gate-lib');

exports.handler = async function (event) {
  const cookies = parseCookies(event.headers && event.headers.cookie);
  const claims = verify(cookies[COOKIE_NAME]);
  const passed = !!(claims && claims.passed === true);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ passed: passed, brand: passed ? claims.brand : null })
  };
};
