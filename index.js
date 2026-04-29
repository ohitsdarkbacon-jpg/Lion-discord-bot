require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder
} = require('discord.js');
const axios = require('axios');
const fs    = require('fs');
const https = require('https');
const http  = require('http');
const QRCode = require('qrcode');
const crypto = require('crypto');
 
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
 
// ===== FILES =====
const USERS_FILE          = './users.json';
const SLOTS_FILE          = './slots.json';
const AUCTIONS_FILE       = './auctions.json';
const PANEL_STATE_FILE    = './panel_state.json';
const PAYMENTS_FILE       = './payments.json';
const CREDITS_BACKUP_FILE = './credits_backup.json';
const PAUSE_STATE_FILE    = './pause_state.json';
// NEW: Roblox <-> Discord link storage
const LINKS_FILE          = './roblox_links.json';
 
let users      = fs.existsSync(USERS_FILE)       ? JSON.parse(fs.readFileSync(USERS_FILE))       : {};
let slots      = fs.existsSync(SLOTS_FILE)       ? JSON.parse(fs.readFileSync(SLOTS_FILE))       : [];
let auctions   = fs.existsSync(AUCTIONS_FILE)    ? JSON.parse(fs.readFileSync(AUCTIONS_FILE))    : {};
let panelState = fs.existsSync(PANEL_STATE_FILE) ? JSON.parse(fs.readFileSync(PANEL_STATE_FILE)) : {};
let payments   = fs.existsSync(PAYMENTS_FILE)    ? JSON.parse(fs.readFileSync(PAYMENTS_FILE))    : {};
let pauseState = fs.existsSync(PAUSE_STATE_FILE) ? JSON.parse(fs.readFileSync(PAUSE_STATE_FILE)) : { paused: false, pausedAt: null };
// NEW: links[robloxName] = [ { discordId, discordTag, linkedAt } ]
let links      = fs.existsSync(LINKS_FILE)       ? JSON.parse(fs.readFileSync(LINKS_FILE))       : {};
 
// ===== PROJECT CONFIG =====
// Basic:   0.5 credits = 1 hour, minimum 1 credit  (= 2 hours)
// Premium: 2 credits   = 1 hour, minimum 2 credits (= 1 hour), whole hours only
const PROJECTS = {
  1: { id: process.env.LUARMOR_PROJECT_ID_1, name: 'Basic',   creditsPerHour: 0.5, minCredits: 1, creditStep: 1, maxSlots: 12, apiKey: process.env.LUARMOR_API_KEY },
  2: { id: process.env.LUARMOR_PROJECT_ID_2, name: 'Premium', creditsPerHour: 2,   minCredits: 2, creditStep: 2, maxSlots: 6,  apiKey: process.env.LUARMOR_API_KEY },
  3: { id: process.env.LUARMOR_PROJECT_ID_3, name: 'Farmer',  creditsPerHour: 1,   minCredits: 1, creditStep: 1, maxSlots: 2,  apiKey: process.env.LUARMOR_API_KEY },
  4: { id: process.env.LUARMOR_PROJECT_ID_4, name: 'Main',    creditsPerHour: 1,   minCredits: 1, creditStep: 1, maxSlots: 2,  apiKey: process.env.LUARMOR_API_KEY },
};
 
function creditsToHours(projectNum, credits) {
  return credits / PROJECTS[projectNum].creditsPerHour;
}
 
const AUCTION_PROJECTS      = [3, 4];
const BID_SLOTS             = 2;
const AUCTION_DURATION_MINS = 5;
const AUCTION_FIXED_HOURS   = 2;
const AUCTION_COOLDOWN_MS   = AUCTION_FIXED_HOURS * 60 * 60 * 1000;
 
// Minimum bids per auction project
const AUCTION_MIN_BID = {
  3: 2,  // Farmer: minimum 2 credits
  4: 6,  // Main:   minimum 6 credits
};
 
const WEBHOOK_PORT     = parseInt(process.env.WEBHOOK_PORT || '3000');
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || `http://localhost:${WEBHOOK_PORT}`;
 
const NOWPAYMENTS_API_KEY    = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const NOWPAYMENTS_BASE       = 'https://api.nowpayments.io/v1';
 
// ===== SAVE FUNCTIONS =====
function saveUsers()      { fs.writeFileSync(USERS_FILE,       JSON.stringify(users,      null, 2)); }
function saveSlots()      { fs.writeFileSync(SLOTS_FILE,       JSON.stringify(slots,      null, 2)); }
function saveAuctions()   { fs.writeFileSync(AUCTIONS_FILE,    JSON.stringify(auctions,   null, 2)); }
function savePanelState() { fs.writeFileSync(PANEL_STATE_FILE, JSON.stringify(panelState, null, 2)); }
function savePayments()   { fs.writeFileSync(PAYMENTS_FILE,    JSON.stringify(payments,   null, 2)); }
function savePauseState() { fs.writeFileSync(PAUSE_STATE_FILE, JSON.stringify(pauseState, null, 2)); }
// NEW
function saveLinks()      { fs.writeFileSync(LINKS_FILE,       JSON.stringify(links,      null, 2)); }
 
function saveCreditsBackup() {
  const backup = {};
  for (const [userId, data] of Object.entries(users)) {
    backup[userId] = data.credits || 0;
  }
  fs.writeFileSync(CREDITS_BACKUP_FILE, JSON.stringify(backup, null, 2));
}
function loadCreditsBackup() {
  if (!fs.existsSync(CREDITS_BACKUP_FILE)) return null;
  return JSON.parse(fs.readFileSync(CREDITS_BACKUP_FILE));
}
 
// ===== LINK HELPERS =====
// Called by the Lua script via a webhook endpoint: POST /link-account { robloxName, discordName, discordId? }
function recordLink(robloxName, discordTag, discordId) {
  const robloxKey = robloxName.toLowerCase();
  if (!links[robloxKey]) links[robloxKey] = [];
 
  // Check if this discord tag is already linked
  const exists = links[robloxKey].find(l => l.discordTag === discordTag);
  if (!exists) {
    links[robloxKey].push({ discordTag, discordId: discordId || null, linkedAt: Date.now() });
    saveLinks();
    console.log(`🔗 New link: Roblox "${robloxName}" → Discord "${discordTag}"`);
  }
}
 
// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open the Lion Notifier slot panel'),
  new SlashCommandBuilder().setName('bidpanel').setDescription('Show auction status (admin)'),
  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits to a user ($1 = 1 credit)')
    .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of credits').setRequired(true)),
  new SlashCommandBuilder()
    .setName('backupcredits')
    .setDescription('(Admin) Save all user credits to a persistent backup file'),
  new SlashCommandBuilder()
    .setName('restorecredits')
    .setDescription('(Admin) Restore all user credits from the backup file'),
  new SlashCommandBuilder()
    .setName('checkcredits')
    .setDescription('(Admin) Check a user\'s current credit balance')
    .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder()
    .setName('forceendauction')
    .setDescription('(Admin) Force-end a stuck auction')
    .addStringOption(opt => opt.setName('auction_id').setDescription('e.g. auction_3_1').setRequired(true)),
  new SlashCommandBuilder()
    .setName('resetauction')
    .setDescription('(Admin) Reset an auction slot to idle (refunds all bidders)')
    .addStringOption(opt => opt.setName('auction_id').setDescription('e.g. auction_3_1').setRequired(true)),
  // PAUSE / UNPAUSE
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('(Admin) Pause the slot system — stops slot countdowns and new purchases'),
  new SlashCommandBuilder()
    .setName('unpause')
    .setDescription('(Admin) Unpause the slot system — adds paused time to all active Luarmor keys'),
  // EXPORT / IMPORT
  new SlashCommandBuilder()
    .setName('exportcredits')
    .setDescription('(Admin) Export all user credit balances as a downloadable JSON file'),
  new SlashCommandBuilder()
    .setName('importcredits')
    .setDescription('(Admin) Import credit balances from an exported JSON file')
    .addAttachmentOption(opt =>
      opt.setName('file').setDescription('The exported credits JSON file').setRequired(true)
    ),
  // NEW: /search — look up all Roblox accounts linked to a Discord tag
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('(Admin) Search all Roblox accounts linked to a Discord user')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Discord user to search').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('roblox').setDescription('Roblox username to search').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('discord_tag').setDescription('Discord tag (username) to search').setRequired(false)
    ),
].map(c => c.toJSON());
 
const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
 
async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('✅ Commands registered');
}
 
// ===== USER IDENTIFIER =====
function getUserIdentifier(userId, username) {
  return crypto.createHash('sha256').update(`${userId}:${username}`).digest('hex').slice(0, 32);
}
 
// ===== ENSURE USER =====
function ensureUser(userId) {
  if (!users[userId]) users[userId] = { credits: 0, processed: [] };
  if (!Array.isArray(users[userId].processed)) users[userId].processed = [];
}
 
// ===== PAUSE HELPERS =====
function isSystemPaused() { return !!pauseState.paused; }
 
async function pauseSystem() {
  if (pauseState.paused) return false;
  pauseState.paused   = true;
  pauseState.pausedAt = Date.now();
  savePauseState();
  console.log(`⏸️  System paused at ${new Date().toISOString()}`);
  return true;
}
 
async function unpauseSystem() {
  if (!pauseState.paused) return { success: false };
  const pausedDuration = Date.now() - pauseState.pausedAt;
  pauseState.paused   = false;
  const pausedAt      = pauseState.pausedAt;
  pauseState.pausedAt = null;
  savePauseState();
  console.log(`▶️  System unpaused — paused for ${formatTime(pausedDuration)}`);
 
  // Extend all active slots by the paused duration
  let extended = 0;
  for (const slot of slots) {
    if (slot && slot.expiry > pausedAt) {
      slot.expiry += pausedDuration;
      extended++;
      try {
        const project    = PROJECTS[slot.projectNum];
        const newExpiry  = Math.floor(slot.expiry / 1000);
        const identifier = slot.luarmorIdentifier || null;
        if (project && slot.userId && identifier) {
          await axios.patch(
            `https://api.luarmor.net/v3/projects/${project.id}/users`,
            { identifier, auth_expire: newExpiry },
            { headers: { Authorization: project.apiKey, 'Content-Type': 'application/json' } }
          ).catch(e => console.warn(`⚠️  Luarmor extend failed for ${slot.userId}: ${e.message}`));
        }
      } catch (e) {
        console.warn(`⚠️  Could not extend Luarmor key for slot ${slot.userId}:`, e.message);
      }
    }
  }
  saveSlots();
  console.log(`✅ Extended ${extended} active slot(s) by ${formatTime(pausedDuration)}`);
  return { success: true, pausedDuration, extended };
}
 
// ===== LUARMOR KEY GENERATOR =====
async function createLuarmorKey(hours, discordId, username, project) {
  const expiryUnix = Math.floor(Date.now() / 1000) + Math.floor(hours * 3600);
  const identifier = getUserIdentifier(discordId, username);
  try {
    const res = await axios.post(
      `https://api.luarmor.net/v3/projects/${project.id}/users`,
      { discord_id: discordId, identifier, auth_expire: expiryUnix, note: `${username} (${discordId})` },
      { headers: { Authorization: project.apiKey, 'Content-Type': 'application/json' } }
    );
    const findKey = obj => {
      if (typeof obj === 'string' && /^[A-Za-z0-9]{6,}$/.test(obj)) return obj;
      if (typeof obj === 'object' && obj) {
        for (const val of Object.values(obj)) { const k = findKey(val); if (k) return k; }
      }
      return null;
    };
    const key = findKey(res.data);
    if (!key) throw new Error(`No key found in response: ${JSON.stringify(res.data)}`);
    return { key, expiry: expiryUnix * 1000, identifier };
  } catch (err) {
    const errorData = err.response?.data || err.message;
    throw new Error(typeof errorData === 'string' ? errorData : JSON.stringify(errorData, null, 2));
  }
}
 
// ===== HELPERS =====
function formatTime(ms) {
  if (ms <= 0) return '0m';
  const totalMins = Math.floor(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
 
function getActiveSlots(projectNum) {
  return slots.filter(s => s?.projectNum === projectNum && s.expiry > Date.now()).length;
}
 
function isAuctionSlotOnCooldown(projectNum, slotIndex) {
  const aId     = getAuctionId(projectNum, slotIndex);
  const auction = auctions[aId];
  if (!auction || !auction.cooldownUntil) return false;
  return auction.cooldownUntil > Date.now();
}
 
// ===== QR CODE =====
async function generateQRBuffer(text) {
  return QRCode.toBuffer(text, { type: 'png', width: 200, margin: 2 });
}
 
// ===== STATUS BADGE HELPERS =====
function slotStatusBadge(active, max) {
  const pct = active / max;
  if (pct >= 1)   return '🔴';
  if (pct >= 0.7) return '🟡';
  return '🟢';
}
 
// ========================================
// ========= NOWPAYMENTS HELPERS ==========
// ========================================
 
function verifyNowPaymentsSignature(rawBody, signature) {
  if (!NOWPAYMENTS_IPN_SECRET) {
    console.warn('⚠️  NOWPAYMENTS_IPN_SECRET not set — skipping signature check (unsafe in production!)');
    return true;
  }
  if (!signature) {
    console.warn('⚠️  No x-nowpayments-sig header received');
    return false;
  }
  try {
    const parsed     = JSON.parse(rawBody);
    const sortedJson = JSON.stringify(sortObjectKeys(parsed));
    const hmac       = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET).update(sortedJson).digest('hex');
    const match      = hmac === signature;
    if (!match) console.warn(`⚠️  Signature mismatch\n  received: ${signature}\n  expected: ${hmac}`);
    return match;
  } catch (e) {
    console.error('verifyNowPaymentsSignature error:', e.message);
    return false;
  }
}
 
function sortObjectKeys(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return obj;
  return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortObjectKeys(obj[k]); return acc; }, {});
}
 
async function createNowPayment(userId, currency, usdAmount) {
  const orderId = `${userId}_${Date.now()}`;
  const res = await axios.post(
    `${NOWPAYMENTS_BASE}/payment`,
    {
      price_amount:        usdAmount,
      price_currency:      'usd',
      pay_currency:        currency,
      order_id:            orderId,
      order_description:   userId,
      ipn_callback_url:    `${WEBHOOK_BASE_URL}/nowpayments-webhook`,
      is_fixed_rate:       false,
      is_fee_paid_by_user: false,
    },
    { headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' } }
  );
  return { ...res.data, _orderId: orderId };
}
 
async function pollPaymentStatus(paymentId) {
  const res = await axios.get(
    `${NOWPAYMENTS_BASE}/payment/${paymentId}`,
    { headers: { 'x-api-key': NOWPAYMENTS_API_KEY } }
  );
  return res.data;
}
 
async function deliverCredits(paymentId, paymentStatus, actuallyPaid, payCurrency) {
  const record = payments[paymentId];
  if (!record) {
    console.warn(`⚠️  deliverCredits: no local record found for payment_id=${paymentId}`);
    return;
  }
 
  const { userId, usdAmount, payAmount } = record;
  ensureUser(userId);
 
  const dedupKey = `np_${paymentId}`;
  if (users[userId].processed.includes(dedupKey)) {
    console.log(`⏭️  Payment ${paymentId} already credited to ${userId} — skipping`);
    return;
  }
 
  let usdValue = 0;
 
  if (paymentStatus === 'finished' || paymentStatus === 'confirmed') {
    usdValue = parseFloat(usdAmount) || 0;
  } else if (paymentStatus === 'partially_paid') {
    const paid     = parseFloat(actuallyPaid) || 0;
    const expected = parseFloat(payAmount)    || 0;
    if (expected > 0) {
      usdValue = (paid / expected) * parseFloat(usdAmount);
    }
    console.log(`⚠️  Partial payment ${paymentId}: paid=${paid} / expected=${expected} → $${usdValue.toFixed(4)} USD`);
  }
 
  const credits = Math.floor(usdValue);
 
  if (credits <= 0) {
    console.log(`⚠️  Payment ${paymentId} for ${userId} resolved to 0 credits (usdValue=${usdValue.toFixed(6)}) — not crediting`);
    return;
  }
 
  users[userId].credits += credits;
  users[userId].processed.push(dedupKey);
  if (users[userId].processed.length > 200) users[userId].processed = users[userId].processed.slice(-200);
  saveUsers();
  saveCreditsBackup();
 
  record.status       = 'credited';
  record.creditedAt   = Date.now();
  record.creditsGiven = credits;
  savePayments();
 
  console.log(`💰 Credited ${credits} credits to ${userId} (payment ${paymentId}, ~$${usdValue.toFixed(2)} via ${payCurrency})`);
 
  try {
    const discordUser = await client.users.fetch(userId);
    await discordUser.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('💰 Payment Confirmed')
          .setColor(0x57F287)
          .setDescription('Your crypto payment has been verified and credits have landed in your account.')
          .addFields(
            { name: '🪙 Coin',           value: (payCurrency || 'crypto').toUpperCase(), inline: true },
            { name: '💵 USD Value',      value: `~$${usdValue.toFixed(2)}`,              inline: true },
            { name: '✅ Credits Added',  value: `**+${credits}**`,                        inline: true },
            { name: '💳 New Balance',    value: `**${users[userId].credits} credits**`,  inline: true },
          )
          .setFooter({ text: 'Credits are rounded down to the nearest dollar  •  Lion Notifier' })
          .setTimestamp()
      ]
    });
  } catch (err) {
    console.error(`❌ Could not DM user ${userId}:`, err.message);
  }
 
  updatePanelMessage().catch(() => {});
}
 
async function pollPendingPayments() {
  const pending = Object.entries(payments).filter(([, p]) => p.status === 'waiting');
  if (pending.length === 0) return;
 
  console.log(`🔄 Polling ${pending.length} pending payment(s)...`);
 
  for (const [paymentId, record] of pending) {
    if (Date.now() - record.createdAt < 2 * 60 * 1000) continue;
 
    if (Date.now() - record.createdAt > 90 * 60 * 1000) {
      payments[paymentId].status = 'expired';
      savePayments();
      console.log(`🕒 Payment ${paymentId} expired (90 min timeout)`);
      continue;
    }
 
    try {
      const data = await pollPaymentStatus(paymentId);
      console.log(`🔍 Poll ${paymentId}: status=${data.payment_status}`);
 
      const actionable = ['finished', 'confirmed', 'partially_paid'];
      if (actionable.includes(data.payment_status)) {
        await deliverCredits(paymentId, data.payment_status, data.actually_paid, data.pay_currency);
      } else if (['failed', 'refunded', 'expired'].includes(data.payment_status)) {
        payments[paymentId].status = data.payment_status;
        savePayments();
      }
    } catch (err) {
      console.error(`❌ Poll error for ${paymentId}:`, err.response?.data || err.message);
    }
 
    await new Promise(r => setTimeout(r, 600));
  }
}
 
// ===== WEBHOOK HTTP SERVER =====
function startWebhookServer() {
  const server = http.createServer((req, res) => {
    // ── NowPayments IPN ──────────────────────────────────────
    if (req.method === 'POST' && req.url.startsWith('/nowpayments-webhook')) {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
 
        const body = Buffer.concat(chunks).toString('utf8');
        processWebhookBody(body, req.headers).catch(err => {
          console.error('❌ processWebhookBody error:', err.message);
        });
      });
      return;
    }
 
    // ── NEW: Roblox account link endpoint ────────────────────
    // POST /link-account   { robloxName, discordTag, discordId? }
    if (req.method === 'POST' && req.url === '/link-account') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
          res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'bad json' }));
        }
 
        const { robloxName, discordTag, discordId } = payload || {};
        if (!robloxName || !discordTag) {
          res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'missing fields' }));
        }
 
        recordLink(String(robloxName).trim(), String(discordTag).trim(), discordId ? String(discordId).trim() : null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
 
    res.writeHead(404);
    res.end('Not found');
  });
 
  server.listen(WEBHOOK_PORT, () => {
    console.log(`🌐 Webhook server on port ${WEBHOOK_PORT}`);
    console.log(`   IPN URL → ${WEBHOOK_BASE_URL}/nowpayments-webhook`);
    console.log(`   Link URL → ${WEBHOOK_BASE_URL}/link-account`);
  });
}
 
async function processWebhookBody(body, headers) {
  if (!body || body.trim() === '') {
    console.warn('⚠️  Empty webhook body received');
    return;
  }
 
  const sig = headers['x-nowpayments-sig'];
  if (!verifyNowPaymentsSignature(body, sig)) return;
 
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    console.warn('⚠️  Webhook body is not valid JSON:', body.slice(0, 300));
    return;
  }
 
  const { payment_id, payment_status, actually_paid, pay_currency, order_id, pay_amount, price_amount } = payload;
 
  console.log(`📩 IPN received: payment_id=${payment_id} status=${payment_status} order_id=${order_id}`);
 
  if (!payment_id) {
    console.warn('⚠️  IPN payload missing payment_id — cannot process');
    return;
  }
 
  if (!payments[payment_id]) {
    const userId = order_id ? order_id.split('_')[0] : null;
    if (userId) {
      console.log(`🔧 Reconstructing missing record for payment ${payment_id} (userId=${userId})`);
      payments[payment_id] = {
        userId,
        usdAmount:  price_amount  || 0,
        currency:   pay_currency  || '',
        payAmount:  pay_amount    || 0,
        payAddress: payload.pay_address || '',
        status:     'waiting',
        createdAt:  Date.now(),
        recovered:  true,
      };
      savePayments();
    } else {
      console.warn(`⚠️  Cannot resolve userId for payment ${payment_id} — no local record and no order_id`);
      return;
    }
  }
 
  const actionable = ['finished', 'confirmed', 'partially_paid'];
  if (!actionable.includes(payment_status)) {
    console.log(`   ↪ Status "${payment_status}" not actionable — ignoring`);
    return;
  }
 
  await deliverCredits(payment_id, payment_status, actually_paid, pay_currency);
}
 
// ===== PANEL EMBED =====
function generatePanelEmbed() {
  const basicActive   = getActiveSlots(1);
  const premiumActive = getActiveSlots(2);
  const paused = isSystemPaused();
 
  const embed = new EmbedBuilder()
    .setTitle('🦁 Lion Notifier — Slot Panel')
    .setColor(paused ? 0xED4245 : 0xF5C542)
    .setDescription(
      (paused
        ? '> ⏸️  **System is currently paused.** Purchases & slot countdowns are frozen.\n> Crypto payments continue processing normally.\n\n'
        : '') +
      '**$1 = 1 Credit** — All payments are processed automatically via crypto.'
    )
    .addFields(
      {
        name: '🔵 Basic Plan',
        value: [
          `> 💰 **0.5 credits = 1 hour** (1 credit = 2 hours)`,
          `> ⏱️  Minimum purchase: **1 credit (2h)** — whole hours only`,
          `> 🎰 Slots: **${basicActive}/${PROJECTS[1].maxSlots}** ${slotStatusBadge(basicActive, PROJECTS[1].maxSlots)}`,
          `> ${basicActive >= PROJECTS[1].maxSlots ? '🔴 **Full** — check back soon' : '🟢 **Available**'}`,
        ].join('\n'),
        inline: true
      },
      {
        name: '🟣 Premium Plan',
        value: [
          `> 💰 **2 credits = 1 hour**`,
          `> ⏱️  Minimum purchase: **2 credits (1h)** — whole hours only`,
          `> 🎰 Slots: **${premiumActive}/${PROJECTS[2].maxSlots}** ${slotStatusBadge(premiumActive, PROJECTS[2].maxSlots)}`,
          `> ${premiumActive >= PROJECTS[2].maxSlots ? '🔴 **Full** — check back soon' : '🟢 **Available**'}`,
        ].join('\n'),
        inline: true
      }
    )
    .setFooter({ text: paused ? '⏸️  SYSTEM PAUSED  •  Lion Notifier' : 'Use the buttons below to activate a slot or top up credits  •  Lion Notifier' })
    .setTimestamp();
 
  return embed;
}
 
// ===== SLOTS EMBED =====
function generateSlotsEmbed() {
  const now = Date.now();
  const paused = isSystemPaused();
  const embed = new EmbedBuilder()
    .setTitle('📊 Live Slot Overview')
    .setColor(paused ? 0x99AAB5 : 0x5865F2)
    .setTimestamp();
 
  if (paused) {
    embed.setDescription('⏸️  **Countdowns are frozen** — all expiry times are extended when the system unpauses.');
  }
 
  for (const [num, proj] of Object.entries(PROJECTS)) {
    if (AUCTION_PROJECTS.includes(Number(num))) continue;
    const active = slots.filter(s => s?.projectNum === Number(num) && s.expiry > now);
    let val = '';
    for (let i = 0; i < proj.maxSlots; i++) {
      const slot = active[i];
      val += slot
        ? `🔴 **Slot ${i + 1}** — <@${slot.userId}> · expires ${paused ? '(paused)' : `<t:${Math.floor(slot.expiry / 1000)}:R>`}\n`
        : `🟢 **Slot ${i + 1}** — Available\n`;
    }
    const icon = num === '1' ? '🔵' : '🟣';
    embed.addFields({ name: `${icon} ${proj.name} (${active.length}/${proj.maxSlots})`, value: val || 'No active slots.', inline: false });
  }
  return embed;
}
 
// ===== AUCTION EMBED =====
function generateAuctionSectionEmbed() {
  const now = Date.now();
  const paused = isSystemPaused();
  const embed = new EmbedBuilder()
    .setTitle('🏷️ Bid Slots — Farmer & Main')
    .setColor(paused ? 0x99AAB5 : 0xF5C542)
    .setDescription(
      `Auctions start when the **first bid** is placed and run for **${AUCTION_DURATION_MINS} minutes**.\n` +
      `The winner receives **${AUCTION_FIXED_HOURS} hours** flat — highest bid takes the slot.\n\n` +
      `> 🌾 **Farmer** minimum bid: **2 credits**\n` +
      `> ⚔️ **Main** minimum bid: **6 credits**\n\u200b`
    )
    .setTimestamp();
 
  for (const num of AUCTION_PROJECTS) {
    const proj = PROJECTS[num];
    const icon = num === 3 ? '🌾' : '⚔️';
    const minBid = AUCTION_MIN_BID[num];
 
    for (let i = 1; i <= BID_SLOTS; i++) {
      const aId     = getAuctionId(num, i);
      const auction = auctions[aId];
      let statusLine, topBidLine, timeLine;
 
      const onCooldown = isAuctionSlotOnCooldown(num, i);
 
      if (onCooldown) {
        const timeLeft = Math.max(0, auction.cooldownUntil - now);
        statusLine = '🔒 **Occupied** — key active';
        topBidLine = auction._lastWinner ? `<@${auction._lastWinner}>` : '—';
        timeLine   = `unlocks <t:${Math.floor(auction.cooldownUntil / 1000)}:R>`;
      } else if (!auction || auction.status === 'idle') {
        statusLine = '⚪ **Open** — waiting for first bid';
        topBidLine = `No bids yet (min **${minBid} cr**)`;
        timeLine   = '—';
      } else if (auction.status === 'live') {
        const timeLeft = Math.max(0, auction.endsAt - now);
        const top = getTopBid(auction);
        statusLine = '🔴 **Live Auction**';
        topBidLine = top ? `**${top.amount} credits** by <@${top.userId}>` : 'No bids yet';
        timeLine   = `<t:${Math.floor(auction.endsAt / 1000)}:R>`;
      } else {
        const top = getTopBid(auction);
        statusLine = '⏳ **Finalizing...**';
        topBidLine = top ? `**${top.amount} credits** by <@${top.userId}>` : 'No bids';
        timeLine   = '—';
      }
 
      embed.addFields({
        name:  `${icon} ${proj.name} — Slot ${i}`,
        value: [
          `Status: ${statusLine}`,
          `Top Bid: ${topBidLine}`,
          `Ends: ${timeLine}`,
          `Prize: **${AUCTION_FIXED_HOURS}h flat**`,
        ].join('\n'),
        inline: true
      });
    }
  }
  return embed;
}
 
// ===== ACTION ROWS =====
function buildPanelRow() {
  const paused = isSystemPaused();
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('select_project_1')
      .setLabel('🔵 Basic')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(paused),
    new ButtonBuilder()
      .setCustomId('select_project_2')
      .setLabel('🟣 Premium')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(paused),
    new ButtonBuilder()
      .setCustomId('buy_crypto')
      .setLabel('💳 Buy Credits')
      .setStyle(ButtonStyle.Success),  // always available
    new ButtonBuilder()
      .setCustomId('view_slots')
      .setLabel('📊 View Slots')
      .setStyle(ButtonStyle.Secondary)
  );
}
 
function buildBidRow() {
  const rows   = [];
  const paused = isSystemPaused();
  for (const num of AUCTION_PROJECTS) {
    const proj       = PROJECTS[num];
    const icon       = num === 3 ? '🌾' : '⚔️';
    const components = [];
    for (let i = 1; i <= BID_SLOTS; i++) {
      const aId        = getAuctionId(num, i);
      const auction    = auctions[aId];
      const onCooldown = isAuctionSlotOnCooldown(num, i);
      const isDisabled = paused || onCooldown || auction?.status === 'ended';
      components.push(
        new ButtonBuilder()
          .setCustomId(`place_bid_${aId}`)
          .setLabel(`${icon} ${proj.name} Slot ${i}`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(isDisabled)
      );
    }
    rows.push(new ActionRowBuilder().addComponents(...components));
  }
  return rows;
}
 
// ===== AUTO-UPDATE PANEL =====
async function updatePanelMessage() {
  if (!panelState.messageId || !panelState.channelId) return;
  try {
    const channel = await client.channels.fetch(panelState.channelId);
    const message = await channel.messages.fetch(panelState.messageId);
    await message.edit({
      embeds:     [generatePanelEmbed(), generateSlotsEmbed(), generateAuctionSectionEmbed()],
      components: [buildPanelRow(), ...buildBidRow()]
    });
  } catch (err) {
    console.error('❌ Failed to update panel:', err.message);
  }
}
 
// ===== AUCTION HELPERS =====
function getAuctionId(projectNum, slotIndex) { return `auction_${projectNum}_${slotIndex}`; }
 
function getTopBid(auction) {
  if (!auction?.bids?.length) return null;
  return auction.bids.reduce((a, b) => (a.amount >= b.amount ? a : b));
}
 
function ensureAuction(projectNum, slotIndex) {
  const aId = getAuctionId(projectNum, slotIndex);
  if (!auctions[aId]) {
    auctions[aId] = { projectNum, slotIndex, endsAt: null, bids: [], status: 'idle' };
    saveAuctions();
  }
  return aId;
}
 
const endingAuctions = new Set();
 
async function refundBidders(auction, winnerUserId = null) {
  for (const bid of (auction.bids || [])) {
    if (bid.userId === winnerUserId) continue;
    ensureUser(bid.userId);
    users[bid.userId].credits += bid.amount;
    console.log(`↩️  Refunded ${bid.amount} credits to ${bid.userId}`);
    try {
      const loser   = await client.users.fetch(bid.userId);
      const project = PROJECTS[auction.projectNum];
      await loser.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`❌ Auction Lost — ${project.name} Slot ${auction.slotIndex}`)
            .setColor(0xED4245)
            .setDescription(`You didn't win this round. Your **${bid.amount} credits** have been refunded.`)
            .addFields({ name: '💳 Balance', value: `**${users[bid.userId].credits} credits**`, inline: true })
            .setFooter({ text: 'Better luck next time  •  Lion Notifier' })
        ]
      });
    } catch {}
  }
}
 
async function endAuction(auctionId) {
  const auction = auctions[auctionId];
  if (!auction) return;
  if (auction.status === 'ended' || auction.status === 'idle') return;
  if (endingAuctions.has(auctionId)) return;
  endingAuctions.add(auctionId);
 
  auction.status = 'ended';
  saveAuctions();
  await updatePanelMessage();
 
  const topBid = getTopBid(auction);
 
  const resetToIdle = (delay = 10_000) => {
    setTimeout(() => {
      if (auctions[auctionId]) {
        auctions[auctionId] = {
          projectNum:    auction.projectNum,
          slotIndex:     auction.slotIndex,
          status:        'idle',
          bids:          [],
          endsAt:        null,
          cooldownUntil: null,
          _lastWinner:   null,
        };
        saveAuctions();
        updatePanelMessage().catch(() => {});
      }
      endingAuctions.delete(auctionId);
    }, delay);
  };
 
  if (!topBid) {
    console.log(`⚠️ Auction ${auctionId} ended with no bids`);
    return resetToIdle(5_000);
  }
 
  const project = PROJECTS[auction.projectNum];
  ensureUser(topBid.userId);
 
  if (users[topBid.userId].credits < 0) {
    console.warn(`⚠️ ${topBid.userId} has negative credits after winning ${auctionId}`);
  }
 
  let key, expiry, luarmorIdentifier;
  try {
    let username = topBid.userId;
    try {
      const u  = await client.users.fetch(topBid.userId);
      username = u.username;
    } catch {}
 
    const keyResult      = await createLuarmorKey(AUCTION_FIXED_HOURS, topBid.userId, username, project);
    key                  = keyResult.key;
    expiry               = keyResult.expiry;
    luarmorIdentifier    = keyResult.identifier;
  } catch (err) {
    console.error(`❌ Key generation failed for ${auctionId}:`, err.message);
 
    ensureUser(topBid.userId);
    users[topBid.userId].credits += topBid.amount;
    await refundBidders(auction, topBid.userId);
    saveUsers();
    saveCreditsBackup();
 
    try {
      const winner = await client.users.fetch(topBid.userId);
      await winner.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('⚠️ Key Generation Failed')
            .setColor(0xED4245)
            .setDescription(
              `You won **${project.name} Slot ${auction.slotIndex}** but there was an error generating your key.\n` +
              `Your **${topBid.amount} credits** have been refunded. Please contact an admin.`
            )
            .addFields({ name: '💳 Balance', value: `**${users[topBid.userId].credits} credits**`, inline: true })
            .setFooter({ text: 'Lion Notifier' })
        ]
      });
    } catch {}
 
    try {
      if (panelState.channelId) {
        const channel = await client.channels.fetch(panelState.channelId);
        await channel.send(`⚠️ <@${topBid.userId}> won **${auctionId}** but key generation failed. All bids refunded. Error: \`${err.message.slice(0, 200)}\``);
      }
    } catch {}
 
    return resetToIdle(5_000);
  }
 
  auction.cooldownUntil = Date.now() + AUCTION_COOLDOWN_MS;
  auction._lastWinner   = topBid.userId;
  saveAuctions();
 
  slots = slots.filter(s => !(s.userId === topBid.userId && s.projectNum === auction.projectNum));
  slots.push({
    userId:            topBid.userId,
    key,
    expiry,
    project:           project.name,
    projectNum:        auction.projectNum,
    luarmorIdentifier,
    fromAuction:       true,
    auctionId,
  });
  saveSlots();
 
  saveUsers();
  saveCreditsBackup();
 
  await updatePanelMessage();
 
  try {
    const discordUser = await client.users.fetch(topBid.userId);
    await discordUser.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`🎉 Auction Won — ${project.name} Slot ${auction.slotIndex}`)
          .setColor(0x57F287)
          .setDescription(`Congratulations! You placed the winning bid and your key is ready.`)
          .addFields(
            { name: '🔑 Your Key',          value: `\`${key}\``,                                   inline: false },
            { name: '⏳ Duration',           value: `${AUCTION_FIXED_HOURS} hours (flat)`,          inline: true  },
            { name: '📅 Expires',            value: `<t:${Math.floor(expiry / 1000)}:R>`,           inline: true  },
            { name: '💳 Credits Spent',      value: `**${topBid.amount}**`,                         inline: true  },
            { name: '💳 Credits Remaining',  value: `**${users[topBid.userId].credits}**`,          inline: true  }
          )
          .setFooter({ text: 'Keep your key private. The slot is now occupied for 2 hours.  •  Lion Notifier' })
      ]
    });
    console.log(`✅ Key DM sent to winner ${topBid.userId}`);
  } catch (err) {
    console.error(`❌ Could not DM winner ${topBid.userId}:`, err.message);
    try {
      if (panelState.channelId) {
        const channel = await client.channels.fetch(panelState.channelId);
        await channel.send({
          content: `⚠️ <@${topBid.userId}> — couldn't DM you. Here's your key (delete after copying):`,
          embeds: [
            new EmbedBuilder()
              .setTitle(`🎉 Auction Won — ${project.name} Slot ${auction.slotIndex}`)
              .setColor(0x57F287)
              .addFields(
                { name: '🔑 Key',     value: `\`${key}\``,                         inline: false },
                { name: '📅 Expires', value: `<t:${Math.floor(expiry / 1000)}:R>`, inline: true  }
              )
          ]
        });
      }
    } catch (fallbackErr) {
      console.error(`❌ Fallback channel send also failed:`, fallbackErr.message);
    }
  }
 
  await refundBidders(auction, topBid.userId);
  saveUsers();
  saveCreditsBackup();
 
  console.log(`🏆 Auction ${auctionId} won by ${topBid.userId} for ${topBid.amount} credits | Key: ${key}`);
 
  try {
    if (panelState.channelId) {
      const channel = await client.channels.fetch(panelState.channelId);
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🏆 Auction Closed — ${project.name} Slot ${auction.slotIndex}`)
            .setColor(0xF5C542)
            .setDescription(
              `<@${topBid.userId}> won with a bid of **${topBid.amount} credits** and has received their key via DM.\n` +
              `This slot is now **occupied for ${AUCTION_FIXED_HOURS} hours**.`
            )
            .setFooter({ text: 'Lion Notifier  •  Bid Auctions' })
            .setTimestamp()
        ]
      });
    }
  } catch {}
 
  resetToIdle(AUCTION_COOLDOWN_MS);
}
 
// ===== COMMAND HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const isAdmin = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).includes(interaction.user.id);
 
  if (interaction.commandName === 'panel' && isAdmin) {
    for (const num of AUCTION_PROJECTS) for (let i = 1; i <= BID_SLOTS; i++) ensureAuction(num, i);
    const reply = await interaction.reply({
      embeds:     [generatePanelEmbed(), generateSlotsEmbed(), generateAuctionSectionEmbed()],
      components: [buildPanelRow(), ...buildBidRow()],
      fetchReply: true
    });
    panelState = { messageId: reply.id, channelId: reply.channelId };
    savePanelState();
    return;
  }
 
  if (interaction.commandName === 'bidpanel' && isAdmin) {
    const lines = [];
    for (const num of AUCTION_PROJECTS) {
      const proj = PROJECTS[num];
      for (let i = 1; i <= BID_SLOTS; i++) {
        const aId = getAuctionId(num, i);
        const a   = auctions[aId];
        const onCooldown = isAuctionSlotOnCooldown(num, i);
        const st  = onCooldown
          ? `🔒 Cooldown (${formatTime(a.cooldownUntil - Date.now())} left)`
          : !a || a.status === 'idle' ? '⚪ Idle' : a.status === 'live' ? '🔴 Live' : '✅ Ended';
        const topBid = a ? getTopBid(a) : null;
        lines.push(`**${proj.name} Slot ${i}:** ${st}${topBid ? ` · Top: ${topBid.amount}cr by <@${topBid.userId}>` : ''}`);
      }
    }
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🏷️ Auction Status — Admin View')
          .setColor(0xF5C542)
          .setDescription(lines.join('\n') || 'No auctions.')
          .setFooter({ text: 'Lion Notifier Admin' })
          .setTimestamp()
      ],
      ephemeral: true
    });
  }
 
  if (interaction.commandName === 'givecredits' && isAdmin) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    ensureUser(target.id);
    users[target.id].credits += amount;
    saveUsers();
    saveCreditsBackup();
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ Credits Given')
          .setColor(0x57F287)
          .addFields(
            { name: 'User',        value: target.tag,                          inline: true },
            { name: 'Added',       value: `**+${amount} credits**`,            inline: true },
            { name: 'New Balance', value: `**${users[target.id].credits}**`,   inline: true }
          )
          .setFooter({ text: 'Lion Notifier Admin' })
      ],
      ephemeral: true
    });
  }
 
  if (interaction.commandName === 'backupcredits' && isAdmin) {
    saveCreditsBackup();
    const count = Object.keys(users).length;
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('💾 Credits Backed Up')
          .setColor(0x57F287)
          .setDescription(`Saved credits for **${count} user(s)** → \`credits_backup.json\``)
          .setFooter({ text: 'Lion Notifier Admin' })
          .setTimestamp()
      ],
      ephemeral: true
    });
  }
 
  if (interaction.commandName === 'restorecredits' && isAdmin) {
    const backup = loadCreditsBackup();
    if (!backup) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ No Backup Found')
            .setColor(0xED4245)
            .setDescription('Run `/backupcredits` first to create a backup file.')
            .setFooter({ text: 'Lion Notifier Admin' })
        ],
        ephemeral: true
      });
    }
    let restored = 0;
    for (const [userId, credits] of Object.entries(backup)) {
      ensureUser(userId);
      users[userId].credits = credits;
      restored++;
    }
    saveUsers();
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ Credits Restored')
          .setColor(0x57F287)
          .setDescription(`Restored credits for **${restored} user(s)** from backup.`)
          .setFooter({ text: 'Lion Notifier Admin' })
          .setTimestamp()
      ],
      ephemeral: true
    });
  }
 
  if (interaction.commandName === 'checkcredits' && isAdmin) {
    const target = interaction.options.getUser('user');
    ensureUser(target.id);
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('💳 Credit Balance')
          .setColor(0x5865F2)
          .addFields(
            { name: 'User',    value: target.tag,                                    inline: true },
            { name: 'Balance', value: `**${users[target.id].credits} credits**`,     inline: true }
          )
          .setFooter({ text: 'Lion Notifier Admin' })
      ],
      ephemeral: true
    });
  }
 
  if (interaction.commandName === 'forceendauction' && isAdmin) {
    const auctionId = interaction.options.getString('auction_id');
    if (!auctions[auctionId]) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('❌ Not Found').setColor(0xED4245).setDescription(`No auction with ID \`${auctionId}\`.`)],
        ephemeral: true
      });
    }
    await interaction.reply({ content: `⚙️ Force-ending \`${auctionId}\`...`, ephemeral: true });
    auctions[auctionId].status = 'live';
    endingAuctions.delete(auctionId);
    await endAuction(auctionId);
    return;
  }
 
  if (interaction.commandName === 'resetauction' && isAdmin) {
    const auctionId = interaction.options.getString('auction_id');
    if (!auctions[auctionId]) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('❌ Not Found').setColor(0xED4245).setDescription(`No auction with ID \`${auctionId}\`.`)],
        ephemeral: true
      });
    }
    const auction = auctions[auctionId];
    await refundBidders(auction, null);
    saveUsers();
    saveCreditsBackup();
    auctions[auctionId] = {
      projectNum:    auction.projectNum,
      slotIndex:     auction.slotIndex,
      status:        'idle',
      bids:          [],
      endsAt:        null,
      cooldownUntil: null,
      _lastWinner:   null,
    };
    saveAuctions();
    endingAuctions.delete(auctionId);
    await updatePanelMessage();
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ Auction Reset')
          .setColor(0x57F287)
          .setDescription(`Auction \`${auctionId}\` has been reset to idle. All bidders refunded.`)
          .setFooter({ text: 'Lion Notifier Admin' })
      ],
      ephemeral: true
    });
  }
 
  // ===== PAUSE =====
  if (interaction.commandName === 'pause' && isAdmin) {
    if (isSystemPaused()) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏸️ Already Paused')
            .setColor(0xFEE75C)
            .setDescription(`The system is already paused.\nPaused since: <t:${Math.floor(pauseState.pausedAt / 1000)}:R>\n\nUse \`/unpause\` to resume and grant players back their lost time.`)
            .setFooter({ text: 'Lion Notifier Admin' })
        ],
        ephemeral: true
      });
    }
    await pauseSystem();
    await updatePanelMessage();
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('⏸️ System Paused')
          .setColor(0xED4245)
          .setDescription(
            'The slot system is now **paused**.\n\n' +
            '• New slot purchases are **disabled**\n' +
            '• Auction bidding is **disabled**\n' +
            '• Slot countdowns are **frozen**\n' +
            '• Crypto payments **continue** processing\n\n' +
            'When you `/unpause`, all active keys will be **automatically extended** by the paused duration via the Luarmor API.'
          )
          .setFooter({ text: 'Lion Notifier Admin' })
          .setTimestamp()
      ],
      ephemeral: false
    });
  }
 
  // ===== UNPAUSE =====
  if (interaction.commandName === 'unpause' && isAdmin) {
    if (!isSystemPaused()) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('▶️ Already Running')
            .setColor(0xFEE75C)
            .setDescription('The system is not currently paused.')
            .setFooter({ text: 'Lion Notifier Admin' })
        ],
        ephemeral: true
      });
    }
    await interaction.deferReply({ ephemeral: false });
    const result = await unpauseSystem();
    await updatePanelMessage();
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('▶️ System Unpaused')
          .setColor(0x57F287)
          .setDescription(
            'The slot system is now **live** again.\n\n' +
            `• Paused for: **${formatTime(result.pausedDuration)}**\n` +
            `• Active keys extended: **${result.extended}**\n\n` +
            'All active Luarmor keys have been extended by the paused duration.'
          )
          .setFooter({ text: 'Lion Notifier Admin' })
          .setTimestamp()
      ]
    });
  }
 
  // ===== EXPORT CREDITS =====
  if (interaction.commandName === 'exportcredits' && isAdmin) {
    await interaction.deferReply({ ephemeral: true });
 
    const exportData = {};
    for (const [userId, data] of Object.entries(users)) {
      exportData[userId] = data.credits || 0;
    }
 
    const userCount  = Object.keys(exportData).length;
    const totalCreds = Object.values(exportData).reduce((a, b) => a + b, 0);
    const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName   = `lion_credits_export_${timestamp}.json`;
    const fileBuffer = Buffer.from(JSON.stringify(exportData, null, 2), 'utf8');
    const attachment = new AttachmentBuilder(fileBuffer, { name: fileName });
 
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📤 Credits Exported')
          .setColor(0x5865F2)
          .setDescription(
            `All user credit balances have been exported to **\`${fileName}\`**.\n\n` +
            `Use \`/importcredits\` and attach this file to restore or migrate balances.`
          )
          .addFields(
            { name: '👥 Users',         value: `**${userCount}**`,   inline: true },
            { name: '🪙 Total Credits', value: `**${totalCreds}**`,  inline: true },
            { name: '📅 Exported At',   value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
          )
          .setFooter({ text: 'Lion Notifier Admin  •  Keep this file safe' })
          .setTimestamp()
      ],
      files: [attachment]
    });
  }
 
  // ===== IMPORT CREDITS =====
  if (interaction.commandName === 'importcredits' && isAdmin) {
    await interaction.deferReply({ ephemeral: true });
 
    const attachment = interaction.options.getAttachment('file');
 
    if (!attachment.name.endsWith('.json')) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Invalid File')
            .setColor(0xED4245)
            .setDescription('Please attach a `.json` file exported by `/exportcredits`.')
            .setFooter({ text: 'Lion Notifier Admin' })
        ]
      });
    }
 
    let rawText;
    try {
      const resp = await axios.get(attachment.url, { responseType: 'text' });
      rawText = resp.data;
    } catch (err) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Download Failed')
            .setColor(0xED4245)
            .setDescription(`Could not download the attachment: \`${err.message}\``)
            .setFooter({ text: 'Lion Notifier Admin' })
        ]
      });
    }
 
    let importData;
    try {
      importData = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
    } catch {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Invalid JSON')
            .setColor(0xED4245)
            .setDescription('The file could not be parsed as JSON. Make sure you\'re using a file exported by `/exportcredits`.')
            .setFooter({ text: 'Lion Notifier Admin' })
        ]
      });
    }
 
    if (typeof importData !== 'object' || Array.isArray(importData)) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Invalid Format')
            .setColor(0xED4245)
            .setDescription('The file format is invalid. Expected `{ "userId": credits }` — use a file from `/exportcredits`.')
            .setFooter({ text: 'Lion Notifier Admin' })
        ]
      });
    }
 
    let imported = 0;
    let skipped  = 0;
 
    for (const [userId, credits] of Object.entries(importData)) {
      if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0) {
        skipped++;
        continue;
      }
      ensureUser(userId);
      users[userId].credits = Math.floor(credits);
      imported++;
    }
 
    saveUsers();
    saveCreditsBackup();
 
    console.log(`📥 Credits imported: ${imported} users updated, ${skipped} skipped`);
 
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📥 Credits Imported')
          .setColor(0x57F287)
          .setDescription(
            `Credit balances have been applied from **\`${attachment.name}\`**.\n\n` +
            `All imported users now have exactly the credits specified in the file.`
          )
          .addFields(
            { name: '✅ Imported', value: `**${imported} user(s)**`, inline: true },
            { name: '⏭️ Skipped',  value: `**${skipped} entry(s)**`, inline: true },
          )
          .setFooter({ text: 'Lion Notifier Admin  •  Credits have been saved and backed up' })
          .setTimestamp()
      ]
    });
  }
 
  // ===== NEW: /search =====
  // Search all Roblox accounts linked to a Discord user, or look up a Roblox name to find all linked discords.
  if (interaction.commandName === 'search' && isAdmin) {
    const targetUser = interaction.options.getUser('user');
    const robloxQuery = (interaction.options.getString('roblox') || '').trim().toLowerCase();
    const discordTagQuery = (interaction.options.getString('discord_tag') || '').trim().toLowerCase();
 
    // Must supply at least one search param
    if (!targetUser && !robloxQuery && !discordTagQuery) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ No Search Term')
            .setColor(0xED4245)
            .setDescription('Provide at least one of: `user`, `roblox`, or `discord_tag`.')
            .setFooter({ text: 'Lion Notifier Admin' })
        ],
        ephemeral: true
      });
    }
 
    await interaction.deferReply({ ephemeral: true });
 
    const embed = new EmbedBuilder()
      .setTitle('🔍 Account Search Results')
      .setColor(0x5865F2)
      .setFooter({ text: 'Lion Notifier Admin  •  Account Linking' })
      .setTimestamp();
 
    // ── Mode 1: Search by Discord user/tag — find all Roblox names they've used ──
    if (targetUser || discordTagQuery) {
      const searchId  = targetUser?.id  || null;
      const searchTag = targetUser?.username?.toLowerCase() || discordTagQuery;
 
      const matches = []; // { robloxName, linkedAt }
 
      for (const [robloxKey, entries] of Object.entries(links)) {
        for (const entry of entries) {
          const tagMatch  = entry.discordTag?.toLowerCase() === searchTag;
          const idMatch   = searchId && entry.discordId === searchId;
          if (tagMatch || idMatch) {
            matches.push({ robloxName: robloxKey, discordTag: entry.discordTag, linkedAt: entry.linkedAt });
          }
        }
      }
 
      if (matches.length === 0) {
        embed.setDescription(`No Roblox accounts found linked to **${targetUser?.tag || discordTagQuery}**.`);
      } else {
        embed.setDescription(
          `Found **${matches.length}** Roblox account${matches.length !== 1 ? 's' : ''} linked to ` +
          `**${targetUser?.tag || discordTagQuery}**:`
        );
        // Chunk into one field (Discord field value max 1024 chars)
        const lines = matches.map(m =>
          `• \`${m.robloxName}\` — <t:${Math.floor((m.linkedAt || 0) / 1000)}:D>`
        );
        // Split into multiple fields if needed
        const chunks = [];
        let current  = '';
        for (const line of lines) {
          if ((current + line + '\n').length > 1000) { chunks.push(current.trimEnd()); current = ''; }
          current += line + '\n';
        }
        if (current) chunks.push(current.trimEnd());
        chunks.forEach((c, i) => embed.addFields({
          name: i === 0 ? '🎮 Roblox Accounts' : '\u200b',
          value: c,
          inline: false
        }));
      }
 
      return interaction.editReply({ embeds: [embed] });
    }
 
    // ── Mode 2: Search by Roblox name — find all Discord accounts that logged in under it ──
    if (robloxQuery) {
      // Search partial match too
      const matchedKeys = Object.keys(links).filter(k => k.includes(robloxQuery));
 
      if (matchedKeys.length === 0) {
        embed.setDescription(`No Discord accounts found linked to Roblox name matching **"${robloxQuery}"**.`);
        return interaction.editReply({ embeds: [embed] });
      }
 
      embed.setDescription(`Found **${matchedKeys.length}** Roblox username${matchedKeys.length !== 1 ? 's' : ''} matching **"${robloxQuery}"**:`);
 
      for (const robloxKey of matchedKeys.slice(0, 15)) { // cap at 15 roblox names to avoid embed limits
        const entries = links[robloxKey];
        const lines   = entries.map(e =>
          `• \`${e.discordTag || 'unknown'}\`${e.discordId ? ` (<@${e.discordId}>)` : ''} — <t:${Math.floor((e.linkedAt || 0) / 1000)}:D>`
        );
        embed.addFields({
          name:  `🎮 ${robloxKey}`,
          value: lines.join('\n').slice(0, 1024) || '—',
          inline: false
        });
      }
 
      if (matchedKeys.length > 15) {
        embed.addFields({ name: '⚠️ Truncated', value: `Only showing first 15 of ${matchedKeys.length} results. Narrow your search.`, inline: false });
      }
 
      return interaction.editReply({ embeds: [embed] });
    }
  }
});
 
// ===== BUTTON HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const userId = interaction.user.id;
  ensureUser(userId);
 
  if (interaction.customId === 'buy_crypto') {
    const modal = new ModalBuilder()
      .setCustomId('buy_credits_modal')
      .setTitle('Buy Credits with Crypto');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('usd_amount')
          .setLabel(`Credits to buy (you have ${users[userId].credits}) — $1 = 1 credit`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 10')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('crypto_choice')
          .setLabel('Coin: btc or ltc')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('btc')
          .setRequired(true)
      )
    );
    return interaction.showModal(modal);
  }
 
  if (interaction.customId === 'view_slots') {
    return interaction.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
  }
 
  if (['select_project_1', 'select_project_2'].includes(interaction.customId)) {
    if (isSystemPaused()) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏸️ System Paused')
            .setColor(0xED4245)
            .setDescription('Slot purchases are currently unavailable while the system is paused.\nCheck back soon!')
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    const num         = interaction.customId === 'select_project_1' ? 1 : 2;
    const project     = PROJECTS[num];
    const userCredits = users[userId].credits;
 
    if (userCredits < project.minCredits) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Not Enough Credits')
            .setColor(0xED4245)
            .setDescription(
              `You need at least **${project.minCredits} credit${project.minCredits !== 1 ? 's' : ''}** to activate a **${project.name}** slot.\n` +
              `You currently have **${userCredits} credits**.\n\nUse **💳 Buy Credits** to top up.`
            )
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
    if (getActiveSlots(num) >= project.maxSlots) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ No Slots Available')
            .setColor(0xED4245)
            .setDescription(`All **${project.name}** slots are currently full. Try again later!`)
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    // BUG FIX: Modal label and placeholder corrected for both plans (both now take hours as input)
    const modal = new ModalBuilder()
      .setCustomId(`activate_modal_${num}`)
      .setTitle(`Activate ${project.name} Slot`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('credits_amount')
          .setLabel(
            num === 2
              ? `Hours to buy (min 1h = 2cr, have ${userCredits}cr)`
              : `Hours to buy (min 1h = 0.5cr, have ${userCredits}cr)`
          )
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(
            num === 1
              ? `e.g. 2 = 1cr, 4 = 2cr, 10 = 5cr`
              : `e.g. 1 = 2cr, 2 = 4cr, 5 = 10cr`
          )
          .setRequired(true)
      )
    );
    return interaction.showModal(modal);
  }
 
  if (interaction.customId.startsWith('place_bid_')) {
    if (isSystemPaused()) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏸️ System Paused')
            .setColor(0xED4245)
            .setDescription('Auction bidding is unavailable while the system is paused. Check back soon!')
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    const auctionId = interaction.customId.replace('place_bid_', '');
    const parts     = auctionId.split('_');
    const projNum   = parseInt(parts[1]);
    const slotIdx   = parseInt(parts[2]);
    ensureAuction(projNum, slotIdx);
    const auction   = auctions[auctionId];
    const minBid    = AUCTION_MIN_BID[projNum] || 1;
 
    if (isAuctionSlotOnCooldown(projNum, slotIdx)) {
      const timeLeft = formatTime(auction.cooldownUntil - Date.now());
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🔒 Slot Occupied')
            .setColor(0xED4245)
            .setDescription(`This slot is currently occupied. Bidding reopens in **${timeLeft}**.`)
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    if (auction.status === 'ended') {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏳ Auction Finalizing')
            .setColor(0xFEE75C)
            .setDescription('This auction just ended and is being finalized. Wait for the next round.')
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    const topBid      = getTopBid(auction);
    const existingBid = auction.bids.find(b => b.userId === userId);
    const calcMin     = Math.max(minBid, topBid ? topBid.amount + 1 : minBid);
 
    const modal = new ModalBuilder()
      .setCustomId(`bid_modal_${auctionId}`)
      .setTitle(`Bid — ${PROJECTS[auction.projectNum].name} Slot ${auction.slotIndex}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('bid_amount')
          .setLabel(`Min: ${calcMin} cr | Balance: ${users[userId].credits}${existingBid ? ` | Your bid: ${existingBid.amount}` : ''}`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(`e.g. ${calcMin}`)
          .setRequired(true)
      )
    );
    return interaction.showModal(modal);
  }
});
 
// ===== MODAL HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;
  const userId = interaction.user.id;
  ensureUser(userId);
 
  if (interaction.customId === 'buy_credits_modal') {
    await interaction.deferReply({ ephemeral: true });
 
    const rawUsd    = interaction.fields.getTextInputValue('usd_amount').trim();
    const rawCoin   = interaction.fields.getTextInputValue('crypto_choice').trim().toLowerCase();
    const usdAmount = parseInt(rawUsd);
 
    if (isNaN(usdAmount) || usdAmount < 1) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Invalid Amount')
            .setColor(0xED4245)
            .setDescription('Please enter a valid dollar amount (minimum **$1**).')
            .setFooter({ text: 'Lion Notifier' })
        ]
      });
    }
    if (!['btc', 'ltc'].includes(rawCoin)) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Invalid Coin')
            .setColor(0xED4245)
            .setDescription('Supported coins: **btc** or **ltc**')
            .setFooter({ text: 'Lion Notifier' })
        ]
      });
    }
 
    try {
      const paymentData = await createNowPayment(userId, rawCoin, usdAmount);
      const { payment_id, pay_address, pay_amount, pay_currency, expiration_estimate_date } = paymentData;
 
      if (!payment_id || !pay_address) {
        console.error('NowPayments incomplete response:', JSON.stringify(paymentData));
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ Invoice Error')
              .setColor(0xED4245)
              .setDescription('NowPayments returned an incomplete response. Please try again in a moment.')
              .setFooter({ text: 'Lion Notifier' })
          ]
        });
      }
 
      payments[payment_id] = {
        userId,
        usdAmount,
        currency:   pay_currency  || rawCoin,
        payAmount:  pay_amount    || 0,
        payAddress: pay_address,
        status:     'waiting',
        createdAt:  Date.now(),
        expiresAt:  expiration_estimate_date ? new Date(expiration_estimate_date).getTime() : null,
      };
      savePayments();
 
      console.log(`🧾 Invoice created: payment_id=${payment_id} userId=${userId} amount=${usdAmount} USD via ${pay_currency}`);
 
      let qrAttach = null;
      const qrFile = `${rawCoin}_qr.png`;
      try {
        qrAttach = new AttachmentBuilder(await generateQRBuffer(pay_address), { name: qrFile });
      } catch {}
 
      const coinLabel = (pay_currency || rawCoin).toUpperCase();
      const embed = new EmbedBuilder()
        .setTitle(`💳 ${coinLabel} Invoice — ${usdAmount} Credits`)
        .setColor(0xF5C542)
        .setDescription(
          '> Send **exactly** the amount shown to the address below.\n' +
          '> Credits are added **automatically** once your payment confirms.\n\n' +
          '⚠️ This invoice is **unique** — do not share or reuse it.\n' +
          '⚠️ Only send the **exact coin** to this address.'
        )
        .addFields(
          { name: `📬 ${coinLabel} Address`,    value: `\`\`\`${pay_address}\`\`\``,          inline: false },
          { name: '💸 Amount to Send',          value: `**${pay_amount} ${coinLabel}**`,       inline: true  },
          { name: "🎁 Credits You'll Receive",  value: `**${usdAmount} credits**`,             inline: true  },
          { name: '🆔 Payment ID',              value: `\`${payment_id}\``,                    inline: false },
        )
        .setFooter({ text: 'Invoice expires in ~20 min — create a new one if it expires  •  Lion Notifier' });
 
      if (expiration_estimate_date) {
        const expireTs = Math.floor(new Date(expiration_estimate_date).getTime() / 1000);
        embed.addFields({ name: '⏰ Expires', value: `<t:${expireTs}:R>`, inline: true });
      }
 
      if (qrAttach) embed.setImage(`attachment://${qrFile}`);
 
      return interaction.editReply({ embeds: [embed], files: qrAttach ? [qrAttach] : [] });
 
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error('createNowPayment error:', err.response?.data || err.message);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Payment Error')
            .setColor(0xED4245)
            .setDescription(`Failed to create payment invoice:\n\`\`\`${msg}\`\`\``)
            .setFooter({ text: 'Lion Notifier' })
        ]
      });
    }
  }
 
  if (interaction.customId.startsWith('activate_modal_')) {
    if (isSystemPaused()) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏸️ System Paused')
            .setColor(0xED4245)
            .setDescription('Slot purchases are unavailable while the system is paused.')
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    const num        = parseInt(interaction.customId.split('_')[2]);
    const project    = PROJECTS[num];
    const rawInput   = parseInt(interaction.fields.getTextInputValue('credits_amount'));
    const userCredits = users[userId].credits;
 
    // Both plans accept whole HOURS as input.
    const hoursEntered = rawInput;
 
    // BUG FIX: validate hours is a positive integer first
    if (isNaN(hoursEntered) || hoursEntered < 1) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Invalid Input')
            .setColor(0xED4245)
            .setDescription(`Please enter a whole number of hours (minimum **1 hour**).\nYou entered: **${rawInput}**`)
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    // Calculate credits to spend based on project rate
    // Basic: 0.5 credits/hour → 2h = 1cr, 4h = 2cr, etc.
    // Premium: 2 credits/hour → 1h = 2cr, 2h = 4cr, etc.
    const creditsToSpend = hoursEntered * project.creditsPerHour;
 
    // BUG FIX: validate the calculated credits cover the minimum
    if (creditsToSpend < project.minCredits) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Below Minimum')
            .setColor(0xED4245)
            .setDescription(
              `The minimum for **${project.name}** is **${project.minCredits} credit${project.minCredits !== 1 ? 's' : ''}**.\n` +
              `**${hoursEntered}h** only costs **${creditsToSpend} credit${creditsToSpend !== 1 ? 's' : ''}**.`
            )
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    if (creditsToSpend > userCredits) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Insufficient Credits')
            .setColor(0xED4245)
            .setDescription(
              `**${hoursEntered}h** costs **${creditsToSpend} credits** but you only have **${userCredits} credits**.\n\nUse **💳 Buy Credits** to top up.`
            )
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    if (getActiveSlots(num) >= project.maxSlots) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ No Slots Available')
            .setColor(0xED4245)
            .setDescription(`All **${project.name}** slots are currently full.`)
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    try {
      const username = interaction.user.username;
      const hours    = hoursEntered;
      const { key, expiry, identifier } = await createLuarmorKey(hours, userId, username, project);
 
      slots = slots.filter(s => !(s.userId === userId && s.projectNum === num));
      slots.push({ userId, key, expiry, project: project.name, projectNum: num, luarmorIdentifier: identifier });
      users[userId].credits -= creditsToSpend;
      saveUsers();
      saveSlots();
      saveCreditsBackup();
      updatePanelMessage();
 
      const hoursDisplay = `${hoursEntered}h`;
 
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`✅ ${project.name} Slot Activated`)
            .setColor(0x57F287)
            .setDescription(`Your slot is live and your key is ready to use!`)
            .addFields(
              { name: '🔑 Your Key',          value: `\`${key}\``,                         inline: false },
              { name: '⏳ Duration',           value: hoursDisplay,                          inline: true  },
              { name: '📅 Expires',            value: `<t:${Math.floor(expiry / 1000)}:R>`, inline: true  },
              { name: '💳 Credits Spent',      value: `**${creditsToSpend}**`,              inline: true  },
              { name: '💳 Credits Remaining',  value: `**${users[userId].credits}**`,       inline: true  }
            )
            .setFooter({ text: 'Keep your key private  •  Lion Notifier' })
        ],
        ephemeral: true
      });
    } catch (err) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Luarmor Error')
            .setColor(0xED4245)
            .setDescription(`\`\`\`${err.message.slice(0, 1800)}\`\`\``)
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
  }
 
  if (interaction.customId.startsWith('bid_modal_')) {
    if (isSystemPaused()) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏸️ System Paused')
            .setColor(0xED4245)
            .setDescription('Auction bidding is unavailable while the system is paused.')
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    const auctionId = interaction.customId.replace('bid_modal_', '');
    const parts     = auctionId.split('_');
    const projNum   = parseInt(parts[1]);
    const slotIdx   = parseInt(parts[2]);
    ensureAuction(projNum, slotIdx);
    const auction   = auctions[auctionId];
    const minBid    = AUCTION_MIN_BID[projNum] || 1;
 
    if (isAuctionSlotOnCooldown(projNum, slotIdx)) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🔒 Slot Occupied')
            .setColor(0xED4245)
            .setDescription('This slot is currently occupied by the winner. Bidding reopens when the key expires.')
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    if (auction.status === 'ended') {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏳ Auction Finalizing')
            .setColor(0xFEE75C)
            .setDescription('This auction just ended. Wait for the next round.')
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    const bidAmount = parseInt(interaction.fields.getTextInputValue('bid_amount'));
    if (isNaN(bidAmount) || bidAmount <= 0) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('❌ Invalid Bid').setColor(0xED4245).setDescription('Enter a valid bid amount.')],
        ephemeral: true
      });
    }
 
    const topBid  = getTopBid(auction);
    const calcMin = Math.max(minBid, topBid ? topBid.amount + 1 : minBid);
 
    if (bidAmount < calcMin) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Bid Too Low')
            .setColor(0xED4245)
            .setDescription(`Minimum bid is **${calcMin} credits** (floor: ${minBid}, current top: ${topBid ? topBid.amount : 'none'}).`)
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    ensureUser(userId);
    const existingBid    = auction.bids.find(b => b.userId === userId);
    const existingAmount = existingBid ? existingBid.amount : 0;
    const additionalCost = bidAmount - existingAmount;
 
    if (additionalCost > users[userId].credits) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Insufficient Credits')
            .setColor(0xED4245)
            .setDescription(
              `You need **${additionalCost} more credits** for this bid.\n` +
              `Current balance: **${users[userId].credits}** | Upgrading: **${existingAmount} → ${bidAmount}**`
            )
            .setFooter({ text: 'Lion Notifier' })
        ],
        ephemeral: true
      });
    }
 
    if (existingBid) {
      users[userId].credits -= additionalCost;
      existingBid.amount = bidAmount;
    } else {
      users[userId].credits -= bidAmount;
      auction.bids.push({ userId, amount: bidAmount });
    }
    saveUsers();
    saveCreditsBackup();
 
    const isFirstBid = auction.status === 'idle';
    if (isFirstBid) {
      auction.status = 'live';
      auction.endsAt = Date.now() + AUCTION_DURATION_MINS * 60 * 1000;
      setTimeout(() => endAuction(auctionId), AUCTION_DURATION_MINS * 60 * 1000);
      console.log(`⏰ Auction ${auctionId} started by ${userId}`);
    }
 
    const timeLeft = auction.endsAt ? (auction.endsAt - Date.now()) : 0;
    if (!isFirstBid && timeLeft < 60_000) {
      auction.endsAt = Date.now() + 60_000;
      endingAuctions.delete(auctionId);
      setTimeout(() => endAuction(auctionId), 60_000);
    }
 
    saveAuctions();
    await updatePanelMessage();
 
    const proj = PROJECTS[auction.projectNum];
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`✅ Bid Placed — ${proj.name} Slot ${auction.slotIndex}`)
          .setColor(0x57F287)
          .setDescription(isFirstBid ? '⏰ **Auction started! 5 minutes on the clock.**' : 'Your bid has been updated.')
          .addFields(
            { name: '💸 Your Bid',  value: `**${bidAmount} credits**`,         inline: true },
            { name: '🔒 On Hold',   value: `**${bidAmount} credits**`,         inline: true },
            { name: '💳 Balance',   value: `**${users[userId].credits}**`,     inline: true },
            { name: '🏆 Prize',     value: `**${AUCTION_FIXED_HOURS}h flat**`, inline: true },
          )
          .setFooter({ text: 'If outbid, your credits are refunded instantly  •  Lion Notifier' })
      ],
      ephemeral: true
    });
  }
});
 
// ===== INTERVALS =====
 
setInterval(() => {
  if (isSystemPaused()) return;
  const before = slots.length;
  slots = slots.filter(s => s && s.expiry > Date.now());
  if (slots.length !== before) { saveSlots(); console.log(`🧹 Cleaned ${before - slots.length} expired slot(s)`); }
}, 60_000);
 
setInterval(() => updatePanelMessage(), 30_000);
 
setInterval(() => {
  for (const [auctionId, auction] of Object.entries(auctions)) {
    if (auction.status !== 'live') continue;
    if (auction.endsAt <= Date.now()) endAuction(auctionId);
    else updatePanelMessage();
  }
}, 10_000);
 
setInterval(() => {
  pollPendingPayments().catch(err => console.error('❌ pollPendingPayments error:', err.message));
}, 2 * 60 * 1000);
 
// ===== READY =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
 
  for (const num of AUCTION_PROJECTS) for (let i = 1; i <= BID_SLOTS; i++) ensureAuction(num, i);
 
  for (const [auctionId, auction] of Object.entries(auctions)) {
    if (auction.status !== 'live') continue;
    const remaining = auction.endsAt - Date.now();
    if (remaining <= 0) {
      endAuction(auctionId);
    } else {
      setTimeout(() => endAuction(auctionId), remaining);
      console.log(`⏰ Resuming auction ${auctionId} — ends in ${Math.ceil(remaining / 1000)}s`);
    }
  }
 
  for (const [auctionId, auction] of Object.entries(auctions)) {
    if (!auction.cooldownUntil || auction.cooldownUntil <= Date.now()) {
      if (auction.cooldownUntil && auction.cooldownUntil <= Date.now() && auction.status !== 'idle') {
        auctions[auctionId] = {
          projectNum:    auction.projectNum,
          slotIndex:     auction.slotIndex,
          status:        'idle',
          bids:          [],
          endsAt:        null,
          cooldownUntil: null,
          _lastWinner:   null,
        };
        saveAuctions();
        console.log(`🔓 Cooldown expired while offline for ${auctionId} — reset to idle`);
      }
      continue;
    }
    const remaining = auction.cooldownUntil - Date.now();
    console.log(`🔒 Resuming cooldown for ${auctionId} — unlocks in ${formatTime(remaining)}`);
    setTimeout(() => {
      if (auctions[auctionId]) {
        auctions[auctionId] = {
          projectNum:    auction.projectNum,
          slotIndex:     auction.slotIndex,
          status:        'idle',
          bids:          [],
          endsAt:        null,
          cooldownUntil: null,
          _lastWinner:   null,
        };
        saveAuctions();
        updatePanelMessage().catch(() => {});
        console.log(`🔓 ${auctionId} cooldown expired — reset to idle`);
      }
    }, remaining);
  }
 
  https.get('https://api.ipify.org?format=json', res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => { try { console.log('🌐 Outbound IP:', JSON.parse(data).ip); } catch {} });
  });
 
  startWebhookServer();
 
  setTimeout(() => pollPendingPayments().catch(() => {}), 10_000);
  setTimeout(() => updatePanelMessage().catch(() => {}), 5_000);
});
 
client.login(process.env.BOT_TOKEN);

