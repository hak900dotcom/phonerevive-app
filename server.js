// PhoneRevive - all weeks in one site
// Each week's app lives in its own folder under weeks/ (weeks/wk2, weeks/wk3, ...).
// This file runs them all and puts a navbar on top of every page to switch weeks.
// Week 2 is at /wk2, week 3 at /wk3, and so on. The home page opens the newest week.
//
// To add a new week: copy the newest week folder (for example weeks/wk3 to weeks/wk4),
// make your changes inside it, and restart. The navbar picks it up by itself.
//
// Runs with plain Node.js. No packages to install. Start it with: node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Find the week folders (wk2, wk3, ...) and sort them by number.
const weeks = fs.readdirSync(path.join(__dirname, 'weeks'))
  .filter(name => /^wk\d+$/.test(name) && fs.existsSync(path.join(__dirname, 'weeks', name, 'server.js')))
  .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
  .map(name => ({
    name,
    label: 'Week ' + name.slice(2),
    app: require(path.join(__dirname, 'weeks', name, 'server.js')),
  }));

if (!weeks.length) {
  console.error('No week folders found. Put each week in weeks/wk2, weeks/wk3, and so on.');
  process.exit(1);
}
const newest = weeks[weeks.length - 1];

// The bar shown at the top of every page.
function navbar(current) {
  const links = weeks.map(w =>
    `<a href="/${w.name}/"${w.name === current ? ' class="on" aria-current="page"' : ''}>${w.label}</a>`).join('');
  return `<style>
.weekbar { display: flex; align-items: center; gap: 6px; background: #1d2733; padding: 8px 12px; overflow-x: auto; white-space: nowrap; font-family: Arial, Helvetica, sans-serif; }
.weekbar span { color: #aab4c0; font-size: 0.85rem; margin-right: 4px; }
.weekbar a { color: #fff; text-decoration: none; padding: 6px 12px; border-radius: 6px; font-size: 0.9rem; }
.weekbar a:hover { background: #2f3d4d; }
.weekbar a.on { background: #fff; color: #1d2733; font-weight: bold; }
</style>
<nav class="weekbar" aria-label="Choose a week"><span>Build:</span>${links}</nav>`;
}

// Adds the week (like /wk2) to the front of a link that starts with "/".
const addPrefix = (week, link) => (typeof link === 'string' && link.startsWith('/') && !link.startsWith('//')) ? `/${week}${link}` : link;

// Hands a request to one week's app. The week's app thinks it is running at "/",
// so its links, redirects and cookies get the week added to the front on the way out.
function runWeek(week, req, res, innerPath) {
  const url = new URL(req.url, 'http://localhost');
  req.url = innerPath + url.search;

  let status = 200, headers = {};
  const realWriteHead = res.writeHead.bind(res);
  const realEnd = res.end.bind(res);

  res.writeHead = (code, h = {}) => { status = code; headers = { ...h }; return res; };
  res.end = (body) => {
    if (headers.Location) headers.Location = addPrefix(week.name, headers.Location);
    if (headers['Set-Cookie']) {
      const list = [].concat(headers['Set-Cookie']);
      // Each week keeps its own cart and staff login.
      headers['Set-Cookie'] = list.map(c => c.replace(/Path=\/(;|$)/, `Path=/${week.name}$1`));
    }
    if (body && String(headers['Content-Type'] || '').startsWith('text/html')) {
      body = String(body)
        .replace(/(href|action|src)="\/(?!\/)/g, `$1="/${week.name}/`)
        .replace('<body>', '<body>\n' + navbar(week.name));
    }
    realWriteHead(status, headers);
    return realEnd(body);
  };

  week.app.emit('request', req, res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const [, first = '', ...rest] = url.pathname.split('/');

  // Home page: open the newest week.
  if (url.pathname === '/') {
    res.writeHead(302, { Location: `/${newest.name}/` });
    return res.end();
  }

  const week = weeks.find(w => w.name === first.toLowerCase());
  if (!week) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found | PhoneRevive</title></head><body style="margin:0">${navbar('')}<p style="padding:16px;font-family:Arial">Page not found. Pick a week above.</p></body></html>`);
  }

  // "/wk2" becomes "/wk2/" so the links on the page work.
  if (url.pathname === '/' + first && rest.length === 0) {
    res.writeHead(302, { Location: `/${week.name}/${url.search}` });
    return res.end();
  }

  runWeek(week, req, res, '/' + rest.join('/'));
});

server.listen(PORT, () => {
  console.log(`PhoneRevive is running at http://localhost:${PORT}`);
  console.log(`Weeks: ${weeks.map(w => `${w.label} at /${w.name}`).join(', ')}`);
});
