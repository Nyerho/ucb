const app = require('../server');

module.exports = app;
module.exports.default = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[api/index.js fallback listen] server on http://localhost:${PORT}`);
  });
}
