// PhoneRevive - final build
// Features 1-3: search and filters, product pages, shopping cart
// Features 4-6: checkout, repair booking, repair tracking
// Runs with plain Node.js. No packages to install. Start it with: node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// Looks for a file in the given subfolder first, then next to server.js.
// This way the app still works if the folders get flattened when uploading to GitHub.
function findFile(folder, file) {
  const inFolder = path.join(__dirname, folder, file);
  const nextToServer = path.join(__dirname, file);
  if (fs.existsSync(inFolder) || !fs.existsSync(nextToServer)) return inFolder;
  return nextToServer;
}

// ---------- CSV helpers ----------

// Files the app writes to. They can start out missing.
const SAVED_FILES = ['cart_items.csv', 'orders.csv', 'order_items.csv', 'repairs.csv', 'repair_updates.csv'];

// Reads a CSV file into a list of objects. Handles quoted values with commas.
function readCsv(file) {
  const full = findFile('data', file);
  if (!fs.existsSync(full)) {
    if (SAVED_FILES.includes(file)) return []; // created the first time the app saves to it
    console.error(`Missing data file: ${file}. Upload the data folder (with ${file} inside) next to server.js.`);
    process.exit(1);
  }
  const text = fs.readFileSync(full, 'utf8').replace(/\r/g, '');
  const rows = [];
  let row = [], value = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else value += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(value); value = ''; }
    else if (c === '\n') { row.push(value); rows.push(row); row = []; value = ''; }
    else value += c;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  const headers = rows.shift();
  return rows.filter(r => r.length > 1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  });
}

function writeCsv(file, headers, items) {
  const esc = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const lines = [headers.join(',')].concat(items.map(it => headers.map(h => esc(it[h])).join(',')));
  const full = findFile('data', file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.join('\n') + '\n');
}

// ---------- Load business data ----------

const phones = readCsv('phones.csv').map(p => ({
  ...p,
  kind: 'phone',
  storage_gb: Number(p.storage_gb),
  battery_health: Number(p.battery_health),
  price: Number(p.price),
}));

const parts = readCsv('parts.csv').map(p => ({
  ...p,
  kind: 'part',
  price: Number(p.price),
  stock: Number(p.stock),
  fits: p.fits.split('|'),
}));

const settings = {};
readCsv('settings.csv').forEach(s => { settings[s.key] = Number(s.value); });

const CART_FILE = 'cart_items.csv';
const CART_HEADERS = ['cart_id', 'item_id', 'qty', 'added_at'];
const RESERVE_MS = settings.reserve_minutes * 60 * 1000;

// Column order for saving phones.csv and parts.csv after a sale.
const PHONE_HEADERS = ['id', 'model', 'storage_gb', 'color', 'grade', 'battery_health', 'lock_status', 'imei_status', 'imei_checked_on', 'price', 'condition_notes', 'warranty_days', 'listed_on', 'status'];
const PART_HEADERS = ['sku', 'name', 'part_type', 'price', 'stock', 'fits', 'description'];

function savePhones() {
  writeCsv('phones.csv', PHONE_HEADERS, phones.map(p => ({ ...p, price: p.price.toFixed(2) })));
}

function saveParts() {
  writeCsv('parts.csv', PART_HEADERS, parts.map(p => ({ ...p, price: p.price.toFixed(2), fits: p.fits.join('|') })));
}

function findItem(id) {
  return phones.find(p => p.id === id) || parts.find(p => p.sku === id);
}

// ---------- Cart (saved in data/cart_items.csv) ----------

// Loads all cart rows and drops phones whose 15 minute hold has run out.
function loadCartRows() {
  const now = Date.now();
  const rows = readCsv(CART_FILE).map(r => ({ ...r, qty: Number(r.qty), added_at: Number(r.added_at) }));
  const kept = rows.filter(r => {
    const item = findItem(r.item_id);
    if (!item) return false;
    if (item.kind === 'phone') return now - r.added_at < RESERVE_MS;
    return true;
  });
  if (kept.length !== rows.length) writeCsv(CART_FILE, CART_HEADERS, kept);
  return kept;
}

function saveCartRows(rows) {
  writeCsv(CART_FILE, CART_HEADERS, rows);
}

// A phone is reserved if it sits in another shopper's cart.
function reservedBy(phoneId, rows) {
  const r = rows.find(x => x.item_id === phoneId);
  return r ? r.cart_id : null;
}

function cartFor(cartId) {
  const rows = loadCartRows().filter(r => r.cart_id === cartId);
  const lines = rows.map(r => {
    const item = findItem(r.item_id);
    return { row: r, item, lineTotal: item.price * r.qty };
  });
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const shipping = subtotal === 0 || subtotal >= settings.free_shipping_over ? 0 : settings.shipping_fee;
  const tax = Math.round(subtotal * settings.tax_rate * 100) / 100;
  const count = rows.reduce((s, r) => s + r.qty, 0);
  return { lines, subtotal, shipping, tax, total: subtotal + shipping + tax, count };
}

// Returns an error message, or null if the item was added.
function addToCart(cartId, itemId, qty) {
  const item = findItem(itemId);
  if (!item) return 'That item does not exist.';
  const rows = loadCartRows();
  const mine = rows.find(r => r.cart_id === cartId && r.item_id === itemId);

  if (item.kind === 'phone') {
    if (item.status !== 'available') return 'Sorry, this phone has been sold.';
    if (mine) return 'This phone is already in your cart.';
    const owner = reservedBy(itemId, rows);
    if (owner) return 'Sorry, someone else is holding this phone right now. Try again in a few minutes.';
    rows.push({ cart_id: cartId, item_id: itemId, qty: 1, added_at: Date.now() });
  } else {
    if (!(qty >= 1)) return 'Quantity must be at least 1.';
    const newQty = (mine ? mine.qty : 0) + qty;
    if (newQty > item.stock) return `Only ${item.stock} in stock.`;
    if (mine) mine.qty = newQty;
    else rows.push({ cart_id: cartId, item_id: itemId, qty, added_at: Date.now() });
  }
  saveCartRows(rows);
  return null;
}

function updateQty(cartId, itemId, qty) {
  const item = findItem(itemId);
  const rows = loadCartRows();
  const mine = rows.find(r => r.cart_id === cartId && r.item_id === itemId);
  if (!mine || !item || item.kind !== 'part' || !(qty >= 1)) return;
  mine.qty = Math.max(1, Math.min(qty, item.stock));
  saveCartRows(rows);
}

function removeFromCart(cartId, itemId) {
  saveCartRows(loadCartRows().filter(r => !(r.cart_id === cartId && r.item_id === itemId)));
}

// ---------- Checkout (saved in data/orders.csv and data/order_items.csv) ----------

const ORDER_HEADERS = ['order_id', 'cart_id', 'created_at', 'name', 'email', 'address', 'city', 'state', 'zip', 'subtotal', 'shipping', 'tax', 'total', 'card_last4', 'status'];
const ORDER_ITEM_HEADERS = ['order_id', 'item_id', 'name', 'qty', 'price'];

const itemId = item => item.kind === 'phone' ? item.id : item.sku;
const itemName = item => item.kind === 'phone'
  ? `${item.model} ${item.storage_gb}GB ${item.color} (Grade ${item.grade})`
  : item.name;

// Standard check digit test that every real card number passes.
function luhn(num) {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// Checks the checkout form. Returns { field: message } for each problem.
function checkCheckoutForm(f) {
  const errors = {};
  if (!f.name) errors.name = 'Enter your full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) errors.email = 'Enter a valid email, like name@example.com.';
  if (!f.address) errors.address = 'Enter your street address.';
  if (!f.city) errors.city = 'Enter your city.';
  if (!/^[A-Za-z]{2}$/.test(f.state)) errors.state = 'Use the 2-letter state, like WA.';
  if (!/^\d{5}$/.test(f.zip)) errors.zip = 'ZIP code must be 5 digits.';
  const card = f.card.replace(/[\s-]/g, '');
  if (!/^\d{16}$/.test(card) || !luhn(card)) errors.card = 'Card number is not valid.';
  const m = f.expiry.match(/^(\d{1,2})\s*\/\s*(\d{2})$/);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) errors.expiry = 'Use MM/YY, like 08/28.';
  else if (new Date(2000 + Number(m[2]), Number(m[1]), 1) <= new Date()) errors.expiry = 'This card has expired.';
  if (!/^\d{3}$/.test(f.cvc)) errors.cvc = 'Enter the 3 digits on the back of the card.';
  return errors;
}

// Saves the order, marks phones sold, lowers part stock, and empties the cart.
// Returns { orderId } or { error }.
function placeOrder(cartId, f, shownTotal) {
  const cart = cartFor(cartId); // this also drops phones whose hold ran out
  if (!cart.lines.length) return { error: 'Your cart is empty.' };
  if (cart.total.toFixed(2) !== shownTotal) {
    return { error: 'Your cart changed while you were checking out (a phone hold may have run out). Check the new total and try again.' };
  }
  for (const { item, row } of cart.lines) {
    if (item.kind === 'phone' && item.status !== 'available') return { error: `Sorry, the ${item.model} was just sold. Remove it from your cart to continue.` };
    if (item.kind === 'part' && row.qty > item.stock) return { error: `Only ${item.stock} left of ${item.name}. Lower the quantity in your cart.` };
  }

  const orders = readCsv('orders.csv');
  const orderId = 'PR-' + (1001 + orders.length);
  orders.push({
    order_id: orderId, cart_id: cartId, created_at: new Date().toISOString(),
    name: f.name, email: f.email, address: f.address, city: f.city, state: f.state.toUpperCase(), zip: f.zip,
    subtotal: cart.subtotal.toFixed(2), shipping: cart.shipping.toFixed(2), tax: cart.tax.toFixed(2), total: cart.total.toFixed(2),
    card_last4: f.card.replace(/\D/g, '').slice(-4), status: 'Paid',
  });
  writeCsv('orders.csv', ORDER_HEADERS, orders);

  const items = readCsv('order_items.csv');
  cart.lines.forEach(({ item, row }) => {
    items.push({ order_id: orderId, item_id: itemId(item), name: itemName(item), qty: row.qty, price: item.price.toFixed(2) });
    if (item.kind === 'phone') item.status = 'sold';
    else item.stock -= row.qty;
  });
  writeCsv('order_items.csv', ORDER_ITEM_HEADERS, items);
  savePhones();
  saveParts();
  saveCartRows(loadCartRows().filter(r => r.cart_id !== cartId));
  return { orderId };
}

// ---------- Repair booking (saved in data/repairs.csv) ----------

const REPAIR_HEADERS = ['repair_id', 'created_at', 'name', 'email', 'phone', 'model', 'problem', 'details', 'method', 'slot', 'quote', 'status'];
const UPDATE_HEADERS = ['repair_id', 'status', 'note', 'at'];
const PROBLEMS = ['Screen', 'Battery', 'Charging port', 'Camera', 'Other / not sure'];
const SLOT_TIMES = ['10:00', '12:00', '14:00', '16:00'];
const METHODS = ['Drop off', 'Mail in'];
const SHOP_ADDRESS = 'PhoneRevive Repairs, 1200 Pine St, Seattle, WA 98101';

// Every model we sell a phone or a part for.
const REPAIR_MODELS = [...new Set([...phones.map(p => p.model), ...parts.flatMap(p => p.fits)])].sort();

// Price = the part that fits this model + labor. If we have no matching part, we quote after a free check.
function repairQuote(model, problem) {
  const part = parts.find(p => p.part_type === problem && p.fits.includes(model));
  return part ? { part, total: part.price + settings.repair_labor } : null;
}

// Drop-off times for the next 6 open days (closed Sundays). A time is full once it has enough bookings.
function dropOffDays() {
  const taken = {};
  readCsv('repairs.csv').forEach(r => { if (r.slot) taken[r.slot] = (taken[r.slot] || 0) + 1; });
  const days = [];
  const d = new Date();
  while (days.length < 6) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === 0) continue;
    const day = d.toISOString().slice(0, 10);
    days.push({
      label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
      times: SLOT_TIMES.map(t => ({ slot: `${day} ${t}`, label: timeLabel(t), full: (taken[`${day} ${t}`] || 0) >= settings.bookings_per_slot })),
    });
  }
  return days;
}

const timeLabel = t => { const h = Number(t.slice(0, 2)); return `${h > 12 ? h - 12 : h} ${h >= 12 ? 'PM' : 'AM'}`; };
const slotLabel = slot => {
  const d = new Date(slot.slice(0, 10) + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' at ' + timeLabel(slot.slice(11));
};

// Checks and saves a booking. Returns { repairId } or { errors }.
function bookRepair(f) {
  const errors = {};
  if (!REPAIR_MODELS.includes(f.model) || !PROBLEMS.includes(f.problem)) errors.top = 'Pick your phone model and the problem.';
  if (!f.name) errors.name = 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) errors.email = 'Enter a valid email. You need it to track your repair.';
  if (f.phone.replace(/\D/g, '').length < 10) errors.phone = 'Enter a 10-digit phone number.';
  if (f.details.length > 500) errors.details = 'Keep this under 500 characters.';
  if (!METHODS.includes(f.method)) errors.method = 'Choose drop off or mail in.';
  if (f.method === 'Drop off') {
    const slot = dropOffDays().flatMap(d => d.times).find(t => t.slot === f.slot);
    if (!slot) errors.slot = 'Pick a drop-off time.';
    else if (slot.full) errors.slot = 'Sorry, that time just filled up. Pick another one.';
  }
  if (Object.keys(errors).length) return { errors };

  const repairs = readCsv('repairs.csv');
  const repairId = 'R-' + (1001 + repairs.length);
  const quote = repairQuote(f.model, f.problem);
  const now = new Date().toISOString();
  repairs.push({
    repair_id: repairId, created_at: now, name: f.name, email: f.email, phone: f.phone,
    model: f.model, problem: f.problem, details: f.details, method: f.method,
    slot: f.method === 'Drop off' ? f.slot : '', quote: quote ? quote.total.toFixed(2) : '', status: 'Booked',
  });
  writeCsv('repairs.csv', REPAIR_HEADERS, repairs);
  addRepairUpdate(repairId, 'Booked', '', now);
  return { repairId };
}

// ---------- Repair tracking (saved in data/repair_updates.csv) ----------

const STATUSES = ['Booked', 'Received', 'Diagnosing', 'Repairing', 'Ready', 'Completed'];

function addRepairUpdate(repairId, status, note, at = new Date().toISOString()) {
  const updates = readCsv('repair_updates.csv');
  updates.push({ repair_id: repairId, status, note, at });
  writeCsv('repair_updates.csv', UPDATE_HEADERS, updates);
}

// The repair number and the email must both match, so strangers cannot look up someone else's repair.
function findRepair(id, email) {
  return readCsv('repairs.csv').find(r =>
    r.repair_id.toUpperCase() === id.trim().toUpperCase() && r.email.toLowerCase() === email.trim().toLowerCase());
}

// Staff move a repair to its next step and can add a note for the customer.
function updateRepairStatus(repairId, status, note) {
  if (!STATUSES.includes(status)) return 'Pick a status.';
  const repairs = readCsv('repairs.csv');
  const r = repairs.find(x => x.repair_id === repairId);
  if (!r) return 'Repair not found.';
  r.status = status;
  writeCsv('repairs.csv', REPAIR_HEADERS, repairs);
  addRepairUpdate(repairId, status, note.slice(0, 300));
  return null;
}

// ---------- Search and filters ----------

// Every word the user types must match the start of some word in the item.
// "12 battery" matches "iPhone 12 / 12 Pro Battery".
function matchesKeywords(text, q) {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return terms.every(t => words.some(w => /^\d+$/.test(t) ? w === t : w.startsWith(t)));
}

function searchPhones(q, f, cartId) {
  const rows = loadCartRows();
  let list = phones.filter(p => {
    if (p.status !== 'available') return false;
    const owner = reservedBy(p.id, rows);
    if (owner && owner !== cartId) return false;
    if (p.imei_status !== 'Clean') return false;
    if (q && !matchesKeywords(`${p.model} ${p.color}`, q)) return false;
    if (f.model && p.model !== f.model) return false;
    if (f.storage && p.storage_gb < Number(f.storage)) return false;
    if (f.grade && p.grade !== f.grade) return false;
    if (f.lock === 'unlocked' && p.lock_status !== 'Unlocked') return false;
    if (f.max && p.price > Number(f.max)) return false;
    return true;
  });
  if (f.sort === 'price_asc') list.sort((a, b) => a.price - b.price);
  else if (f.sort === 'price_desc') list.sort((a, b) => b.price - a.price);
  else if (f.sort === 'battery') list.sort((a, b) => b.battery_health - a.battery_health);
  else list.sort((a, b) => b.listed_on.localeCompare(a.listed_on)); // newest first
  return list;
}

function searchParts(q, f) {
  let list = parts.filter(p => {
    if (q && !matchesKeywords(`${p.name} ${p.part_type} ${p.fits.join(' ')}`, q)) return false;
    if (f.ptype && p.part_type !== f.ptype) return false;
    if (f.fits && !p.fits.includes(f.fits)) return false;
    return true;
  });
  if (f.sort === 'price_desc') list.sort((a, b) => b.price - a.price);
  else list.sort((a, b) => a.price - b.price);
  return list;
}

// ---------- HTML ----------

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + n.toFixed(2);
const unique = arr => [...new Set(arr)].sort();

function page(title, body, cartCount, flash) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | PhoneRevive</title>
<link rel="stylesheet" href="/style.css"></head>
<body>
<header class="top"><a href="/" class="logo">PhoneRevive</a>
<a href="/cart" class="cart-link">Cart (${cartCount})</a></header>
${flash ? `<p class="flash ${flash.type}">${esc(flash.text)}</p>` : ''}
<main>${body}</main>
<nav class="bottom"><a href="/">Home</a><a href="/search">Search</a><a href="/repair">Repair</a><a href="/track">Track</a><a href="/cart">Cart (${cartCount})</a></nav>
</body></html>`;
}

function searchBox(q = '', type = 'phones') {
  return `<form action="/search" class="search">
  <input name="q" value="${esc(q)}" placeholder='Search "iPhone 13" or "12 battery"' aria-label="Search">
  <div class="tabs">
    <label><input type="radio" name="type" value="phones" ${type === 'phones' ? 'checked' : ''}> Phones</label>
    <label><input type="radio" name="type" value="parts" ${type === 'parts' ? 'checked' : ''}> Parts</label>
  </div>
  <button>Search</button></form>`;
}

function homePage() {
  const chip = (label, qs) => `<a class="chip" href="/search?${qs}">${label}</a>`;
  return `${searchBox()}
  <h2>Quick filters</h2>
  <div class="chips">
    ${chip('iPhone 14', 'q=iPhone+14')}${chip('iPhone 13', 'q=iPhone+13')}
    ${chip('128GB+', 'storage=128')}${chip('Grade A', 'grade=A')}
    ${chip('Unlocked', 'lock=unlocked')}${chip('Under $300', 'max=300')}
  </div>
  <p class="trust">Every phone tested + IMEI checked</p>
  <h2>Popular parts</h2>
  <div class="chips">
    ${['Screen', 'Battery', 'Camera', 'Charging port'].map(t => chip(t === 'Battery' ? 'Batteries' : t + 's', 'type=parts&ptype=' + encodeURIComponent(t))).join('')}
  </div>
  <div class="quote"><h2>Broken phone?</h2>
    <p>Get a price, book a drop-off time, and follow your repair online.</p>
    <a class="btn" href="/repair">Book a repair</a> <a href="/track">Track a repair</a></div>
  <p class="small"><a href="/staff">Staff login</a></p>`;
}

function select(name, label, options, current) {
  return `<label>${label}<select name="${name}"><option value="">Any</option>${options.map(([v, t]) =>
    `<option value="${esc(v)}" ${String(current) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
}

function resultsPage(q, f, cartId) {
  const type = f.type === 'parts' ? 'parts' : 'phones';
  let filters, grid, count;

  if (type === 'phones') {
    const list = searchPhones(q, f, cartId);
    count = `${list.length} phone${list.length === 1 ? '' : 's'} found`;
    filters = [
      select('model', 'Model', unique(phones.map(p => p.model)).map(m => [m, m]), f.model),
      select('storage', 'Storage', [['64', '64GB+'], ['128', '128GB+'], ['256', '256GB+']], f.storage),
      select('grade', 'Grade', [['A', 'Grade A'], ['B', 'Grade B'], ['C', 'Grade C']], f.grade),
      select('lock', 'Lock', [['unlocked', 'Unlocked only']], f.lock),
      select('max', 'Price', [['200', 'Under $200'], ['300', 'Under $300'], ['400', 'Under $400'], ['600', 'Under $600']], f.max),
      select('sort', 'Sort', [['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['battery', 'Best battery']], f.sort).replace('Any', 'Newest'),
    ].join('');
    grid = list.map(p => `<a class="card" href="/phone/${p.id}">
      <div class="photo">Photo</div>
      <strong>${esc(p.model)} ${p.storage_gb}GB</strong>
      <span>${money(p.price)} · Grade ${p.grade}</span>
      <span class="small">Battery ${p.battery_health}% ${p.lock_status === 'Unlocked' ? '✔' : '· ' + esc(p.lock_status)}</span>
    </a>`).join('');
  } else {
    const list = searchParts(q, f);
    count = `${list.length} part${list.length === 1 ? '' : 's'} found`;
    filters = [
      select('ptype', 'Part type', unique(parts.map(p => p.part_type)).map(t => [t, t]), f.ptype),
      select('fits', 'Fits', unique(parts.flatMap(p => p.fits)).map(m => [m, m]), f.fits),
      select('sort', 'Sort', [['price_desc', 'Price: high to low']], f.sort).replace('Any', 'Price: low to high'),
    ].join('');
    grid = list.map(p => `<a class="card" href="/part/${p.sku}">
      <div class="photo">Photo</div>
      <strong>${esc(p.name)}</strong>
      <span>${money(p.price)}</span>
      <span class="small">${p.stock > 0 ? p.stock + ' in stock' : 'Out of stock'}</span>
    </a>`).join('');
  }

  const empty = `<p class="empty">No ${type} found. Try removing a filter.</p>`;
  return `${searchBox(q, type)}
  <form action="/search" class="filters">
    <input type="hidden" name="q" value="${esc(q)}"><input type="hidden" name="type" value="${type}">
    ${filters}<button>Apply</button> <a href="/search?type=${type}&q=${encodeURIComponent(q)}">Clear</a>
  </form>
  <p class="count">${count}${q ? ` for "${esc(q)}"` : ''}</p>
  ${grid ? `<div class="grid">${grid}</div>` : empty}
  ${type === 'phones' ? '<p class="small">✔ = IMEI clean, unlocked</p>' : ''}`;
}

function shippingLine() {
  return `<p class="small">Shipping ${money(settings.shipping_fee)}, free over ${money(settings.free_shipping_over)}. No other fees.</p>`;
}

function phonePage(p, cartId) {
  const rows = loadCartRows();
  const owner = reservedBy(p.id, rows);
  let button;
  if (p.status !== 'available') button = '<p class="flash error">This phone has been sold.</p>';
  else if (owner === cartId) button = '<a class="btn" href="/cart">In your cart. View cart</a>';
  else if (owner) button = '<p class="flash error">Someone is holding this phone right now. Check back soon.</p>';
  else button = `<form method="post" action="/cart/add"><input type="hidden" name="id" value="${p.id}"><button class="btn">Add to Cart</button></form>`;

  return `<a href="javascript:history.back()" class="small">← Back</a>
  <div class="gallery">${['Front', 'Back', 'Left side', 'Right side'].map(s => `<div class="photo">${s}</div>`).join('')}</div>
  <p class="small">Real photos of this unit</p>
  <h1>${esc(p.model)}, ${p.storage_gb}GB, ${esc(p.color)}</h1>
  <p class="price">${money(p.price)}</p>
  <div class="badges">
    <span class="badge">Grade ${p.grade}</span>
    <span class="badge">Battery ${p.battery_health}%</span>
    <span class="badge ok">✔ IMEI clean (checked ${esc(p.imei_checked_on)})</span>
    <span class="badge">${esc(p.lock_status)}</span>
  </div>
  <h2>Condition notes</h2><p>${esc(p.condition_notes)}</p>
  <p>${p.warranty_days}-day warranty · Sold by PhoneRevive</p>
  ${button}
  ${shippingLine()}`;
}

function partPage(p) {
  const button = p.stock > 0
    ? `<form method="post" action="/cart/add" class="qty-form"><input type="hidden" name="id" value="${p.sku}">
       <label>Quantity <input type="number" name="qty" value="1" min="1" max="${p.stock}"></label>
       <button class="btn">Add to Cart</button></form>`
    : '<p class="flash error">Out of stock.</p>';
  return `<a href="javascript:history.back()" class="small">← Back</a>
  <div class="gallery"><div class="photo">Photo</div></div>
  <h1>${esc(p.name)}</h1>
  <p class="price">${money(p.price)}</p>
  <p>${p.stock > 0 ? `<strong>${p.stock}</strong> in stock` : 'Out of stock'} · SKU ${esc(p.sku)}</p>
  <p>${esc(p.description)}</p>
  <h2>Fits these models</h2><ul>${p.fits.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
  ${button}
  ${shippingLine()}`;
}

function cartPage(cart) {
  if (!cart.lines.length) return '<h1>Your cart</h1><p class="empty">Your cart is empty. <a href="/">Start shopping</a></p>';
  const lines = cart.lines.map(({ row, item, lineTotal }) => {
    const id = item.kind === 'phone' ? item.id : item.sku;
    const name = item.kind === 'phone' ? `${item.model} ${item.storage_gb}GB (${item.grade})` : item.name;
    let extra;
    if (item.kind === 'phone') {
      const minsLeft = Math.ceil((RESERVE_MS - (Date.now() - row.added_at)) / 60000);
      extra = `<span class="small reserve">Reserved for you for ${minsLeft} more min</span>`;
    } else {
      extra = `<form method="post" action="/cart/update" class="qty">
        <input type="hidden" name="id" value="${id}">
        <button name="qty" value="${row.qty - 1}" ${row.qty <= 1 ? 'disabled' : ''}>–</button>
        <span>${row.qty}</span>
        <button name="qty" value="${row.qty + 1}" ${row.qty >= item.stock ? 'disabled' : ''}>+</button></form>`;
    }
    return `<div class="line"><div><strong>${esc(name)}</strong><br>${extra}</div>
      <div class="right">${money(lineTotal)}<form method="post" action="/cart/remove"><input type="hidden" name="id" value="${id}"><button class="link">Remove ×</button></form></div></div>`;
  }).join('');
  return `<h1>Your cart</h1>${lines}
  <table class="totals">
    <tr><td>Subtotal</td><td>${money(cart.subtotal)}</td></tr>
    <tr><td>Shipping</td><td>${money(cart.shipping)}</td></tr>
    <tr><td>Tax (est.)</td><td>${money(cart.tax)}</td></tr>
    <tr class="total"><td>Estimated total</td><td>${money(cart.total)}</td></tr>
  </table>
  <a class="btn" href="/checkout">Proceed to Checkout</a>`;
}

// Form helpers. Each field shows its own error message under it.
function field(name, label, value, error, attrs = '') {
  return `<label class="field">${label}<input name="${name}" value="${esc(value || '')}" ${attrs}>
    ${error ? `<span class="err">${esc(error)}</span>` : ''}</label>`;
}

function totalsTable(t) {
  return `<tr><td>Subtotal</td><td>${money(t.subtotal)}</td></tr>
    <tr><td>Shipping</td><td>${t.shipping ? money(t.shipping) : 'Free'}</td></tr>
    <tr><td>Tax</td><td>${money(t.tax)}</td></tr>
    <tr class="total"><td>Total</td><td>${money(t.total)}</td></tr>`;
}

function checkoutPage(cart, f = {}, errors = {}, problem = '') {
  if (!cart.lines.length) return '<h1>Checkout</h1><p class="empty">Your cart is empty. <a href="/">Start shopping</a></p>';
  const rows = cart.lines.map(({ item, row, lineTotal }) =>
    `<tr><td>${esc(itemName(item))}${row.qty > 1 ? ` × ${row.qty}` : ''}</td><td>${money(lineTotal)}</td></tr>`).join('');
  const holds = cart.lines.filter(l => l.item.kind === 'phone')
    .map(l => Math.ceil((RESERVE_MS - (Date.now() - l.row.added_at)) / 60000));
  const holdNote = holds.length ? `<p class="small reserve">Your phone is held for ${Math.min(...holds)} more min. Place your order before then.</p>` : '';
  return `<h1>Checkout</h1>
  ${problem ? `<p class="flash error">${esc(problem)}</p>` : ''}
  <h2>Your order</h2>
  <table class="totals">${rows}${totalsTable(cart)}</table>
  ${holdNote}
  <form method="post" action="/checkout" class="form" novalidate>
    <input type="hidden" name="shown_total" value="${cart.total.toFixed(2)}">
    <h2>Ship to</h2>
    ${field('name', 'Full name', f.name, errors.name, 'autocomplete="name"')}
    ${field('email', 'Email', f.email, errors.email, 'type="email" autocomplete="email"')}
    ${field('address', 'Street address', f.address, errors.address, 'autocomplete="street-address"')}
    <div class="row">
      ${field('city', 'City', f.city, errors.city, 'autocomplete="address-level2"')}
      ${field('state', 'State', f.state, errors.state, 'maxlength="2" placeholder="WA"')}
      ${field('zip', 'ZIP', f.zip, errors.zip, 'inputmode="numeric" maxlength="5"')}
    </div>
    <h2>Payment</h2>
    <p class="small note">Demo store: no real money is charged. Use the test card 4242 4242 4242 4242, any future date, and any 3 digits.</p>
    ${field('card', 'Card number', '', errors.card, 'inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242"')}
    <div class="row">
      ${field('expiry', 'Expiry (MM/YY)', f.expiry, errors.expiry, 'placeholder="08/28" autocomplete="cc-exp"')}
      ${field('cvc', 'CVC', '', errors.cvc, 'inputmode="numeric" maxlength="3" autocomplete="cc-csc"')}
    </div>
    <button class="btn wide">Place order · ${money(cart.total)}</button>
  </form>
  <p><a href="/cart">← Back to cart</a></p>`;
}

function orderPage(order, items) {
  const rows = items.map(i => `<tr><td>${esc(i.name)}${Number(i.qty) > 1 ? ` × ${i.qty}` : ''}</td><td>${money(Number(i.price) * Number(i.qty))}</td></tr>`).join('');
  const t = { subtotal: Number(order.subtotal), shipping: Number(order.shipping), tax: Number(order.tax), total: Number(order.total) };
  return `<div class="success"><h1>Thank you, ${esc(order.name.split(' ')[0])}!</h1>
    <p>Your order number is <strong>${esc(order.order_id)}</strong>. Save it in case you need to contact us.</p></div>
  <h2>What you bought</h2>
  <table class="totals">${rows}${totalsTable(t)}</table>
  <h2>Shipping to</h2>
  <p>${esc(order.name)}<br>${esc(order.address)}<br>${esc(order.city)}, ${esc(order.state)} ${esc(order.zip)}</p>
  <p>Paid with card ending in ${esc(order.card_last4)}. Phones ship in 1 to 2 business days.</p>
  <a class="btn" href="/">Keep shopping</a>`;
}

function repairPage(q, f = {}, errors = {}) {
  const model = q.model || '', problem = q.problem || '';
  const pick = `<form action="/repair" class="filters">
    ${select('model', 'Your phone', REPAIR_MODELS.map(m => [m, m]), model).replace('>Any<', '>Choose<')}
    ${select('problem', 'What is wrong?', PROBLEMS.map(p => [p, p]), problem).replace('>Any<', '>Choose<')}
    <button>See price</button></form>`;
  const intro = `<h1>Book a repair</h1>
  <p>Tell us your phone and the problem. You get a price right away, then pick a time to drop it off or mail it in.</p>`;
  if (!REPAIR_MODELS.includes(model) || !PROBLEMS.includes(problem)) {
    return intro + pick + (errors.top ? `<p class="flash error">${esc(errors.top)}</p>` : '');
  }

  const quote = repairQuote(model, problem);
  const price = quote
    ? `<p class="price">${money(quote.total)}</p>
       <p class="small">${esc(quote.part.name)} ${money(quote.part.price)} + labor ${money(settings.repair_labor)}. Most repairs are done the same day.</p>
       ${quote.part.stock > 0 ? '' : '<p class="small reserve">This part is out of stock. We will order it, which adds 2 to 3 days.</p>'}`
    : `<p><strong>Free check first.</strong> We will look at your phone and email you a price before we do any work.</p>`;

  const days = dropOffDays().map(d => `<div class="day"><strong>${d.label}</strong><div class="slots">${d.times.map(t =>
    `<label class="slot${t.full ? ' full' : ''}"><input type="radio" name="slot" value="${t.slot}" ${t.full ? 'disabled' : ''} ${f.slot === t.slot ? 'checked' : ''}> ${t.full ? 'Full' : t.label}</label>`).join('')}</div></div>`).join('');

  return `${intro}${pick}
  <div class="quote"><h2>${esc(problem)} repair for ${esc(model)}</h2>${price}</div>
  <form method="post" action="/repair" class="form" novalidate>
    <input type="hidden" name="model" value="${esc(model)}"><input type="hidden" name="problem" value="${esc(problem)}">
    <h2>Your details</h2>
    ${field('name', 'Name', f.name, errors.name, 'autocomplete="name"')}
    ${field('email', 'Email', f.email, errors.email, 'type="email" autocomplete="email"')}
    ${field('phone', 'Phone number', f.phone, errors.phone, 'type="tel" autocomplete="tel"')}
    <label class="field">What happened? (optional)<textarea name="details" rows="3" maxlength="500">${esc(f.details || '')}</textarea>
      ${errors.details ? `<span class="err">${esc(errors.details)}</span>` : ''}</label>
    <h2>How will you get it to us?</h2>
    <label class="choice"><input type="radio" name="method" value="Drop off" ${f.method !== 'Mail in' ? 'checked' : ''}> Drop off at our shop</label>
    <label class="choice"><input type="radio" name="method" value="Mail in" ${f.method === 'Mail in' ? 'checked' : ''}> Mail it in (no time needed)</label>
    ${errors.method ? `<span class="err">${esc(errors.method)}</span>` : ''}
    <h2>Drop-off time</h2>
    <p class="small">Only needed if you are dropping it off. Closed Sundays.</p>
    ${errors.slot ? `<span class="err">${esc(errors.slot)}</span>` : ''}
    ${days}
    <button class="btn wide">Book repair</button>
  </form>`;
}

function trackForm(id = '', email = '', error = '') {
  return `<h1>Track a repair</h1>
  <p>Enter your repair number and the email you booked with.</p>
  ${error ? `<p class="flash error">${esc(error)}</p>` : ''}
  <form action="/track" class="form">
    ${field('id', 'Repair number', id, '', 'placeholder="R-1001"')}
    ${field('email', 'Email', email, '', 'type="email"')}
    <button class="btn">Check status</button>
  </form>`;
}

const STEP_TEXT = {
  Booked: 'We have your booking.',
  Received: 'Your phone is at our shop.',
  Diagnosing: 'A tech is checking what is wrong.',
  Repairing: 'Your phone is being fixed.',
  Ready: 'Your phone is fixed.',
  Completed: 'Picked up or delivered. Thanks!',
};

function trackPage(r, updates) {
  const at = STATUSES.indexOf(r.status);
  const when = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  const steps = STATUSES.map((s, i) => {
    const u = updates.filter(x => x.status === s).pop();
    const cls = i < at ? 'done' : i === at ? 'now' : 'todo';
    return `<li class="${cls}"><strong>${s}</strong> <span class="small">${u ? when(u.at) : ''}</span>
      <div class="small">${i <= at ? STEP_TEXT[s] : ''}</div>${u && u.note ? `<div class="note">${esc(u.note)}</div>` : ''}</li>`;
  }).join('');

  let next = '';
  if (r.status === 'Booked') next = r.method === 'Drop off'
    ? `Bring your phone to ${SHOP_ADDRESS} on ${slotLabel(r.slot)}.`
    : `Pack your phone and mail it to ${SHOP_ADDRESS}. Write ${r.repair_id} on the box.`;
  if (r.status === 'Ready') next = r.method === 'Drop off'
    ? 'Come pick it up any time we are open (Mon to Sat, 10 AM to 6 PM). Pay when you pick it up.'
    : 'We will ship it back today and email you the tracking number.';

  return `<h1>Repair ${esc(r.repair_id)}</h1>
  <p>${esc(r.model)} · ${esc(r.problem)} · ${r.quote ? 'Price ' + money(Number(r.quote)) : 'Price after free check'} · ${esc(r.method)}</p>
  ${next ? `<p class="next"><strong>Next step:</strong> ${esc(next)}</p>` : ''}
  <ol class="steps">${steps}</ol>
  <p class="small">Refresh this page to see new updates. <a href="/track">Look up another repair</a></p>`;
}

function staffPage(error = '') {
  const repairs = readCsv('repairs.csv').reverse();
  const rows = repairs.map(r => {
    const nextStatus = STATUSES[Math.min(STATUSES.indexOf(r.status) + 1, STATUSES.length - 1)];
    return `<div class="line staff"><div><strong>${esc(r.repair_id)}</strong> ${esc(r.name)}<br>
      <span class="small">${esc(r.model)} · ${esc(r.problem)} · ${esc(r.method)}${r.slot ? ' · ' + slotLabel(r.slot) : ''}</span><br>
      Now: <strong>${esc(r.status)}</strong></div>
      <form method="post" action="/staff/update" class="form">
        <input type="hidden" name="id" value="${esc(r.repair_id)}">
        <select name="status">${STATUSES.map(s => `<option ${s === nextStatus ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <input name="note" placeholder="Note for the customer (optional)" maxlength="300">
        <button>Update</button></form></div>`;
  }).join('');
  return `<h1>Staff: repairs</h1>
  ${error ? `<p class="flash error">${esc(error)}</p>` : ''}
  <p class="small">Move a repair to its next step. The customer sees the change and your note on the tracking page.</p>
  ${rows || '<p class="empty">No repairs yet.</p>'}
  <form method="post" action="/staff/logout"><button class="link">Log out</button></form>`;
}

function staffLogin(error = '') {
  return `<h1>Staff login</h1>
  ${error ? `<p class="flash error">${esc(error)}</p>` : ''}
  <form method="post" action="/staff/login" class="form">
    ${field('pin', 'Staff PIN', '', '', 'type="password" inputmode="numeric"')}
    <button class="btn">Log in</button></form>`;
}

// ---------- Server ----------

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(new URLSearchParams(body)));
  });
}

function getCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

function redirect(res, to, headers = {}) {
  res.writeHead(303, { Location: to, ...headers });
  res.end();
}

// Staff who logged in with the PIN. Kept in memory, so a restart logs everyone out.
const staffTokens = new Set();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const cookies = getCookies(req);

  // Each visitor gets a cart id in a cookie. No sign-up needed.
  let cartId = cookies.cart;
  const setCookie = [];
  if (!cartId || !/^[a-f0-9]{16}$/.test(cartId)) {
    cartId = crypto.randomBytes(8).toString('hex');
    setCookie.push(`cart=${cartId}; Path=/; HttpOnly; SameSite=Lax`);
  }
  // One-time messages ("Added to cart") are passed in a short cookie.
  let flash = null;
  if (cookies.flash) {
    const [type, ...text] = cookies.flash.split('|');
    flash = { type, text: text.join('|') };
    setCookie.push('flash=; Path=/; Max-Age=0');
  }
  const flashCookie = (type, text) => `flash=${encodeURIComponent(type + '|' + text)}; Path=/`;
  const headers = setCookie.length ? { 'Set-Cookie': setCookie } : {};

  try {
    if (req.method === 'GET' && url.pathname === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end(fs.readFileSync(findFile('public', 'style.css')));
    }

    const count = () => cartFor(cartId).count;
    let m;

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, page('Home', homePage(), count(), flash), headers);
    }

    if (req.method === 'GET' && url.pathname === '/search') {
      const f = Object.fromEntries(url.searchParams);
      const q = (f.q || '').trim();
      return send(res, 200, page('Search', resultsPage(q, f, cartId), count(), flash), headers);
    }

    if (req.method === 'GET' && (m = url.pathname.match(/^\/phone\/([\w-]+)$/))) {
      const p = phones.find(x => x.id === m[1]);
      if (!p) return send(res, 404, page('Not found', '<p>Phone not found.</p>', count()), headers);
      return send(res, 200, page(p.model, phonePage(p, cartId), count(), flash), headers);
    }

    if (req.method === 'GET' && (m = url.pathname.match(/^\/part\/([\w-]+)$/))) {
      const p = parts.find(x => x.sku === m[1]);
      if (!p) return send(res, 404, page('Not found', '<p>Part not found.</p>', count()), headers);
      return send(res, 200, page(p.name, partPage(p), count(), flash), headers);
    }

    if (req.method === 'GET' && url.pathname === '/cart') {
      const cart = cartFor(cartId);
      return send(res, 200, page('Cart', cartPage(cart), cart.count, flash), headers);
    }

    // ----- Feature 4: checkout -----

    if (req.method === 'GET' && url.pathname === '/checkout') {
      const cart = cartFor(cartId);
      return send(res, 200, page('Checkout', checkoutPage(cart, {}, {}, flash && flash.type === 'error' ? flash.text : ''), cart.count), headers);
    }

    if (req.method === 'POST' && url.pathname === '/checkout') {
      const body = await readBody(req);
      const f = {};
      ['name', 'email', 'address', 'city', 'state', 'zip', 'card', 'expiry', 'cvc'].forEach(k => { f[k] = (body.get(k) || '').trim(); });
      const errors = checkCheckoutForm(f);
      if (Object.keys(errors).length) {
        const cart = cartFor(cartId);
        return send(res, 200, page('Checkout', checkoutPage(cart, f, errors, 'Please fix the boxes marked in red.'), cart.count), headers);
      }
      const result = placeOrder(cartId, f, body.get('shown_total'));
      if (result.error) {
        const cart = cartFor(cartId);
        return send(res, 200, page('Checkout', checkoutPage(cart, f, {}, result.error), cart.count), headers);
      }
      return redirect(res, '/order/' + result.orderId, headers);
    }

    if (req.method === 'GET' && (m = url.pathname.match(/^\/order\/(PR-\d+)$/))) {
      // Only the shopper who placed the order can see it.
      const order = readCsv('orders.csv').find(o => o.order_id === m[1] && o.cart_id === cartId);
      if (!order) return send(res, 404, page('Not found', '<p>Order not found.</p>', count()), headers);
      const items = readCsv('order_items.csv').filter(i => i.order_id === order.order_id);
      return send(res, 200, page('Order ' + order.order_id, orderPage(order, items), count()), headers);
    }

    // ----- Feature 5: repair booking -----

    if (req.method === 'GET' && url.pathname === '/repair') {
      return send(res, 200, page('Book a repair', repairPage(Object.fromEntries(url.searchParams)), count(), flash), headers);
    }

    if (req.method === 'POST' && url.pathname === '/repair') {
      const body = await readBody(req);
      const f = {};
      ['model', 'problem', 'name', 'email', 'phone', 'details', 'method', 'slot'].forEach(k => { f[k] = (body.get(k) || '').trim(); });
      const result = bookRepair(f);
      if (result.errors) {
        return send(res, 200, page('Book a repair', repairPage(f, f, result.errors), count(), { type: 'error', text: 'Please fix the parts marked in red.' }), headers);
      }
      setCookie.push(flashCookie('ok', `Repair booked! Your repair number is ${result.repairId}. Save it to check on your repair.`));
      return redirect(res, `/track?id=${result.repairId}&email=${encodeURIComponent(f.email)}`, { 'Set-Cookie': setCookie });
    }

    // ----- Feature 6: repair tracking -----

    if (req.method === 'GET' && url.pathname === '/track') {
      const id = url.searchParams.get('id') || '', email = url.searchParams.get('email') || '';
      if (!id && !email) return send(res, 200, page('Track a repair', trackForm(), count(), flash), headers);
      const r = findRepair(id, email);
      if (!r) return send(res, 200, page('Track a repair', trackForm(id, email, 'We could not find a repair with that number and email. Check both and try again.'), count()), headers);
      const updates = readCsv('repair_updates.csv').filter(u => u.repair_id === r.repair_id);
      return send(res, 200, page('Repair ' + r.repair_id, trackPage(r, updates), count(), flash), headers);
    }

    const isStaff = staffTokens.has(cookies.staff);

    if (req.method === 'GET' && url.pathname === '/staff') {
      return send(res, 200, page('Staff', isStaff ? staffPage() : staffLogin(), count(), flash), headers);
    }

    if (req.method === 'POST' && url.pathname === '/staff/login') {
      const body = await readBody(req);
      if (Number(body.get('pin')) !== settings.staff_pin || !body.get('pin')) {
        return send(res, 200, page('Staff', staffLogin('Wrong PIN.'), count()), headers);
      }
      const token = crypto.randomBytes(16).toString('hex');
      staffTokens.add(token);
      setCookie.push(`staff=${token}; Path=/; HttpOnly; SameSite=Lax`);
      return redirect(res, '/staff', { 'Set-Cookie': setCookie });
    }

    if (req.method === 'POST' && url.pathname === '/staff/update') {
      if (!isStaff) return redirect(res, '/staff', headers);
      const body = await readBody(req);
      const error = updateRepairStatus(body.get('id') || '', body.get('status') || '', (body.get('note') || '').trim());
      setCookie.push(error ? flashCookie('error', error) : flashCookie('ok', `${body.get('id')} moved to ${body.get('status')}.`));
      return redirect(res, '/staff', { 'Set-Cookie': setCookie });
    }

    if (req.method === 'POST' && url.pathname === '/staff/logout') {
      staffTokens.delete(cookies.staff);
      setCookie.push('staff=; Path=/; Max-Age=0');
      return redirect(res, '/', { 'Set-Cookie': setCookie });
    }

    if (req.method === 'POST' && url.pathname === '/cart/add') {
      const body = await readBody(req);
      const id = body.get('id');
      const error = addToCart(cartId, id, parseInt(body.get('qty') || '1', 10));
      const back = phones.some(p => p.id === id) ? `/phone/${id}` : `/part/${id}`;
      setCookie.push(error ? flashCookie('error', error) : flashCookie('ok', 'Added to cart'));
      return redirect(res, back, { 'Set-Cookie': setCookie });
    }

    if (req.method === 'POST' && url.pathname === '/cart/update') {
      const body = await readBody(req);
      updateQty(cartId, body.get('id'), parseInt(body.get('qty'), 10));
      return redirect(res, '/cart', headers);
    }

    if (req.method === 'POST' && url.pathname === '/cart/remove') {
      const body = await readBody(req);
      removeFromCart(cartId, body.get('id'));
      setCookie.push(flashCookie('ok', 'Item removed'));
      return redirect(res, '/cart', { 'Set-Cookie': setCookie });
    }

    send(res, 404, page('Not found', '<p>Page not found. <a href="/">Go home</a></p>', count()), headers);
  } catch (err) {
    console.error(err);
    send(res, 500, '<p>Something went wrong. Check the terminal for details.</p>');
  }
});

// The main server.js (one folder up) loads this week and adds the week navbar.
// Running this file on its own (node server.js in this folder) still works too.
module.exports = server;

if (require.main === module) server.listen(PORT, () => {
  console.log(`PhoneRevive is running at http://localhost:${PORT}`);
  console.log(`Loaded ${phones.length} phones and ${parts.length} parts from the data folder.`);
});
