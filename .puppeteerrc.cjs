const { join } = require('path');

/**
 * On Render, the build cache persists at /opt/render/.cache
 * This ensures puppeteer always installs and finds Chrome there.
 */
module.exports = {
  cacheDirectory: '/opt/render/.cache/puppeteer',
};