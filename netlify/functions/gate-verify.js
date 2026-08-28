// POST /.netlify/functions/gate-verify  { brand, income, age }
// This is the one place the pass/fail decision is actually made. A client
// can send whatever it wants here, same as any form submission — what it
// CANNOT do is produce a validly-signed cookie without going through this
// check, because the signing key (GATE_SECRET) only exists server-side.
//
// Honest limit: brand is checked against a real list, but income and age
// are still self-reported booleans with no verification behind them. This
// stops a devtools edit from granting access; it does not confirm anyone
// is telling the truth.
'use strict';
const { ALLOWED_BRANDS, sign, setCookieHeader } = require('./_gate-lib');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let data;
  try { data = JSON.parse(event.body || '{}'); }
  catch (e) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passed: false, error: 'bad_json' })
    };
  }

  const brand = typeof data.brand === 'string' ? data.brand : '';
  const income = data.income === true;
  const age = data.age === true;
  const eligible = ALLOWED_BRANDS.indexOf(brand) !== -1 && income && age;

  if (!eligible) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ passed: false })
    };
  }

  const token = sign({ passed: true, brand: brand, iat: Date.now() });
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': setCookieHeader(token)
    },
    body: JSON.stringify({ passed: true, brand: brand })
  };
};
