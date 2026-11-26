const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const viewPath = path.join(__dirname, '..', 'views', 'error.ejs');

test('shared service-unavailable view renders the user route fallback when no title is supplied', async () => {
  const html = await ejs.renderFile(viewPath, {
    message: 'This service is temporarily unavailable.'
  });

  assert.match(html, /<title>Service temporarily unavailable<\/title>/);
  assert.match(html, /<h1[^>]*>Please try again shortly<\/h1>/);
  assert.match(html, /This service is temporarily unavailable\./);
  assert.match(html, /href="\/auth\/login"/);
});

test('shared service-unavailable view renders admin messaging and escapes supplied HTML', async () => {
  const html = await ejs.renderFile(viewPath, {
    title: 'Temporarily unavailable',
    message: 'Unavailable <script>alert(1)</script>'
  });

  assert.match(html, /<title>Temporarily unavailable<\/title>/);
  assert.match(html, /Unavailable &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /Unavailable <script>alert\(1\)<\/script>/);
});
