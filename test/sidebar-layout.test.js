const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');

test('responsive sidebar is visible in desktop layout and retains mobile off-canvas behavior', () => {
  const desktopRule = stylesheet.match(/@media\s*\(min-width:\s*992px\)\s*\{\s*\.sidebar\.offcanvas-lg\s*\{([^}]*)\}/);
  const mobileRule = stylesheet.match(/@media\s*\(max-width:\s*991\.98px\)\s*\{[\s\S]*?\.sidebar\.offcanvas-lg\s*\{([^}]*)\}/);

  assert.ok(desktopRule, 'desktop sidebar override should exist');
  assert.match(desktopRule[1], /visibility:\s*visible;/);
  assert.match(desktopRule[1], /transform:\s*none;/);
  assert.match(desktopRule[1], /display:\s*flex;/);

  assert.ok(mobileRule, 'mobile sidebar rule should remain intact');
  assert.match(mobileRule[1], /visibility:\s*hidden;/);
  assert.match(mobileRule[1], /transform:\s*translateX/);
});
