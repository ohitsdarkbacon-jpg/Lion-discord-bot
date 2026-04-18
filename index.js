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
const USERS_FILE       = './users.json';
const SLOTS_FILE       = './slots.json';
const AUCTIONS_FILE    = './auctions.json';
const PANEL_STATE_FILE = './panel_state.json';
const PAYMENTS_FILE    = './payments.json';
 
let users      = fs.existsSync(USERS_FILE)       ? JSON.parse(fs.readFileSync(USERS_FILE))       : {};
let slots      = fs.existsSync(SLOTS_FILE)       ? JSON.parse(fs.readFileSync(SLOTS_FILE))       : [];
let auctions   = fs.existsSync(AUCTIONS_FILE)    ? JSON.parse(fs.readFileSync(AUCTIONS_FILE))    : {};
let panelState = fs.existsSync(PANEL_STATE_FILE) ? JSON.parse(fs.readFileSync(PANEL_STATE_FILE)) : {};
// payments[payment_id] = { userId, usdAmount, currency, payAmount, payAddress, status, createdAt }
let payments   = fs.existsSync(PAYMENTS_FILE)    ? JSON.parse(fs.readFileSync(PAYMENTS_FILE))    : {};
 
// ===== PROJECT CONFIG =====
const PROJECTS = {
  1: { id: process.env.LUARMOR_PROJECT_ID_1, name: 'Basic',   creditToHours: 2, maxSlots: 12, apiKey: process.env.LUARMOR_API_KEY },
  2: { id: process.env.LUARMOR_PROJECT_ID_2, name: 'Premium', creditToHours: 1, maxSlots: 6,  apiKey: process.env.LUARMOR_API_KEY },
  3: { id: process.env.LUARMOR_PROJECT_ID_3, name: 'Farmer',  creditToHours: 2, maxSlots: 2,  apiKey: process.env.LUARMOR_API_KEY },
  4: { id: process.env.LUARMOR_PROJECT_ID_4, name: 'Main',    creditToHours: 1, maxSlots: 2,  apiKey: process.env.LUARMOR_API_KEY },
};
 
const AUCTION_PROJECTS      = [3, 4];
const BID_SLOTS             = 2;
const AUCTION_DURATION_MINS = 5;
const AUCTION_FIXED_HOURS   = 2;
 
const WEBHOOK_PORT     = parseInt(process.env.WEBHOOK_PORT || '3000');
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || `http://localhost:${WEBHOOK_PORT}`;
 
const NOWPAYMENTS_API_KEY    = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const NOWPAYMENTS_BASE       = 'https://api.nowpayments.io/v1';
 
// ===== SAVE FUNCTIONS =====
function saveUsers()     { fs.writeFileSync(USERS_FILE,       JSON.stringify(users,      null, 2)); }
function saveSlots()     { fs.writeFileSync(SLOTS_FILE,       JSON.stringify(slots,      null, 2)); }
function saveAuctions()  { fs.writeFileSync(AUCTIONS_FILE,    JSON.stringify(auctions,   null, 2)); }
function savePanelState(){ fs.writeFileSync(PANEL_STATE_FILE, JSON.stringify(panelState, null, 2)); }
function savePayments()  { fs.writeFileSync(PAYMENTS_FILE,    JSON.stringify(payments,   null, 2)); }
 
// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open slot panel'),
  new SlashCommandBuilder().setName('bidpanel').setDescription('Show auction status (admin)'),
  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits to a user ($1 = 1 credit)')
    .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of credits').setRequired(true)),
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
    return { key, expiry: expiryUnix * 1000 };
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
 
// ===== QR CODE =====
async function generateQRBuffer(text) {
  return QRCode.toBuffer(text, { type: 'png', width: 200, margin: 2 });
}
 
// ========================================
// ========= NOWPAYMENTS HELPERS ==========
// ========================================
 
// NowPayments IPN signature: HMAC-SHA512 over alphabetically-sorted JSON body
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
 
// Create a NowPayments invoice and return the full response
async function createNowPayment(userId, currency, usdAmount) {
  const orderId = `${userId}_${Date.now()}`;
  const res = await axios.post(
    `${NOWPAYMENTS_BASE}/payment`,
    {
      price_amount:        usdAmount,
      price_currency:      'usd',
      pay_currency:        currency,
      order_id:            orderId,         // format: "{userId}_{ts}" — used as fallback lookup
      order_description:   userId,          // plain userId for easy IPN lookup
      ipn_callback_url:    `${WEBHOOK_BASE_URL}/nowpayments-webhook`,
      is_fixed_rate:       false,
      is_fee_paid_by_user: false,
    },
    { headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' } }
  );
  return { ...res.data, _orderId: orderId };
}
 
// Poll NowPayments for a single payment's current status
async function pollPaymentStatus(paymentId) {
  const res = await axios.get(
    `${NOWPAYMENTS_BASE}/payment/${paymentId}`,
    { headers: { 'x-api-key': NOWPAYMENTS_API_KEY } }
  );
  return res.data;
}
 
// ===================================================
// ===== CREDIT DELIVERY — single source of truth ====
// ===================================================
// Called from both the IPN webhook AND the polling fallback.
// Deduplication ensures credits are never double-awarded.
async function deliverCredits(paymentId, paymentStatus, actuallyPaid, payCurrency) {
  // Primary lookup: our local payments store (guaranteed to have userId)
  const record = payments[paymentId];
  if (!record) {
    console.warn(`⚠️  deliverCredits: no local record found for payment_id=${paymentId}`);
    return;
  }
 
  const { userId, usdAmount, payAmount } = record;
  ensureUser(userId);
 
  // Deduplication guard — never credit the same payment twice
  const dedupKey = `np_${paymentId}`;
  if (users[userId].processed.includes(dedupKey)) {
    console.log(`⏭️  Payment ${paymentId} already credited to ${userId} — skipping`);
    return;
  }
 
  // Calculate USD value to credit
  let usdValue = 0;
 
  if (paymentStatus === 'finished' || paymentStatus === 'confirmed') {
    // Full payment — credit exactly what was invoiced in USD
    usdValue = parseFloat(usdAmount) || 0;
  } else if (paymentStatus === 'partially_paid') {
    // Pro-rate: how much crypto arrived vs how much was expected
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
 
  // Apply credits atomically, mark as processed, save
  users[userId].credits += credits;
  users[userId].processed.push(dedupKey);
  if (users[userId].processed.length > 200) users[userId].processed = users[userId].processed.slice(-200);
  saveUsers();
 
  // Update the payment record
  record.status       = 'credited';
  record.creditedAt   = Date.now();
  record.creditsGiven = credits;
  savePayments();
 
  console.log(`💰 Credited ${credits} credits to ${userId} (payment ${paymentId}, ~$${usdValue.toFixed(2)} via ${payCurrency})`);
 
  // DM the user
  try {
    const discordUser = await client.users.fetch(userId);
    await discordUser.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('💰 Payment Confirmed!')
          .setColor(0x57F287)
          .setDescription('Your crypto payment has been confirmed and credits have been added to your account.')
          .addFields(
            { name: '🪙 Coin',          value: (payCurrency || 'crypto').toUpperCase(), inline: true },
            { name: '💵 USD Value',     value: `~$${usdValue.toFixed(2)}`,              inline: true },
            { name: '✅ Credits Added', value: `**${credits}**`,                         inline: true },
            { name: '💳 New Balance',   value: `**${users[userId].credits}**`,           inline: true },
          )
          .setFooter({ text: 'Credits are rounded down to the nearest dollar.' })
      ]
    });
  } catch (err) {
    console.error(`❌ Could not DM user ${userId}:`, err.message);
  }
 
  updatePanelMessage().catch(() => {});
}
 
// ===================================================
// ========== POLLING FALLBACK (every 2 min) =========
// ===================================================
// Catches payments where the IPN webhook was never delivered.
async function pollPendingPayments() {
  const pending = Object.entries(payments).filter(([, p]) => p.status === 'waiting');
  if (pending.length === 0) return;
 
  console.log(`🔄 Polling ${pending.length} pending payment(s)...`);
 
  for (const [paymentId, record] of pending) {
    // Skip payments < 2 min old — give NowPayments time to process
    if (Date.now() - record.createdAt < 2 * 60 * 1000) continue;
 
    // Auto-expire after 90 minutes
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
 
    // Brief pause between calls to avoid rate limiting
    await new Promise(r => setTimeout(r, 600));
  }
}
 
// ===== WEBHOOK HTTP SERVER =====
function startWebhookServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/nowpayments-webhook')) {
      res.writeHead(404);
      return res.end('Not found');
    }
 
    // Collect full body first
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      // Respond 200 immediately so NowPayments doesn't retry
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
 
      const body = Buffer.concat(chunks).toString('utf8');
      processWebhookBody(body, req.headers).catch(err => {
        console.error('❌ processWebhookBody error:', err.message);
      });
    });
  });
 
  server.listen(WEBHOOK_PORT, () => {
    console.log(`🌐 Webhook server on port ${WEBHOOK_PORT}`);
    console.log(`   IPN URL → ${WEBHOOK_BASE_URL}/nowpayments-webhook`);
  });
}
 
async function processWebhookBody(body, headers) {
  if (!body || body.trim() === '') {
    console.warn('⚠️  Empty webhook body received');
    return;
  }
 
  // Verify IPN signature
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
 
  // If we have no local record (e.g. server restarted after invoice was created but before it was saved),
  // try to reconstruct one from the IPN data. order_id format is "{userId}_{timestamp}".
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
  return new EmbedBuilder()
    .setTitle('🦁 Lion Notifier — Slot System')
    .setColor(0xF5C542)
    .setDescription('**$1 = 1 Credit** — Payments are processed automatically.')
    .addFields(
      {
        name: '🔵 Basic',
        value: [`> **1 Credit = 2 Hours**`, `> Slots: **${basicActive}/${PROJECTS[1].maxSlots}**`, `> ${basicActive >= PROJECTS[1].maxSlots ? '🔴 Full' : '🟢 Available'}`].join('\n'),
        inline: true
      },
      {
        name: '🟣 Premium',
        value: [`> **1 Credit = 1 Hour**`, `> Slots: **${premiumActive}/${PROJECTS[2].maxSlots}**`, `> ${premiumActive >= PROJECTS[2].maxSlots ? '🔴 Full' : '🟢 Available'}`].join('\n'),
        inline: true
      }
    )
    .setFooter({ text: 'Use buttons below to activate a slot or buy credits.' })
    .setTimestamp();
}
 
// ===== SLOTS EMBED =====
function generateSlotsEmbed() {
  const now = Date.now();
  const embed = new EmbedBuilder().setTitle('📊 Live Slot Overview').setColor(0x5865F2).setTimestamp();
  for (const [num, proj] of Object.entries(PROJECTS)) {
    if (AUCTION_PROJECTS.includes(Number(num))) continue;
    const active = slots.filter(s => s?.projectNum === Number(num) && s.expiry > now);
    let val = '';
    for (let i = 0; i < proj.maxSlots; i++) {
      const slot = active[i];
      val += slot
        ? `🔴 Slot ${i + 1} — <@${slot.userId}> | expires in ${formatTime(slot.expiry - now)}\n`
        : `🟢 Slot ${i + 1} — Available\n`;
    }
    const icon = num === '1' ? '🔵' : '🟣';
    embed.addFields({ name: `${icon} ${proj.name} (${active.length}/${proj.maxSlots})`, value: val || 'No slots.', inline: false });
  }
  return embed;
}
 
// ===== AUCTION EMBED =====
function generateAuctionSectionEmbed() {
  const now = Date.now();
  const embed = new EmbedBuilder()
    .setTitle('🏷️ Bid Slots — Farmer & Main')
    .setColor(0xF5C542)
    .setDescription(`Bid slots start automatically when the first bid is placed. Auction lasts **5 minutes** from first bid.\nWinner always receives **${AUCTION_FIXED_HOURS} hours** flat — highest bid wins.\n\u200b`)
    .setTimestamp();
 
  for (const num of AUCTION_PROJECTS) {
    const proj = PROJECTS[num];
    const icon = num === 3 ? '🌾' : '⚔️';
    for (let i = 1; i <= BID_SLOTS; i++) {
      const aId     = getAuctionId(num, i);
      const auction = auctions[aId];
      let statusLine, topBidLine, timeLine;
 
      if (!auction || auction.status === 'idle') {
        statusLine = '⚪ **Waiting for first bid**'; topBidLine = 'No bids yet'; timeLine = '—';
      } else if (auction.status === 'live') {
        const timeLeft = Math.max(0, auction.endsAt - now);
        const top = getTopBid(auction);
        statusLine = '🔴 **Live**';
        topBidLine = top ? `**${top.amount} credits** by <@${top.userId}>` : 'No bids yet';
        timeLine   = `${Math.floor(timeLeft / 60000)}m ${Math.floor((timeLeft % 60000) / 1000)}s`;
      } else {
        const top = getTopBid(auction);
        statusLine = '✅ **Ended**';
        topBidLine = top ? `**${top.amount} credits** by <@${top.userId}>` : 'No bids';
        timeLine   = '—';
      }
 
      embed.addFields({
        name:  `${icon} ${proj.name} — Slot ${i}`,
        value: `Status: ${statusLine}\nTop Bid: ${topBidLine}\nTime Left: ${timeLine}\nReward: **${AUCTION_FIXED_HOURS}h flat**`,
        inline: true
      });
    }
  }
  return embed;
}
 
// ===== ACTION ROWS =====
function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('select_project_1').setLabel('🔵 Basic').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('select_project_2').setLabel('🟣 Premium').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('buy_crypto').setLabel('💳 Buy Credits').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('view_slots').setLabel('📊 View Slots').setStyle(ButtonStyle.Secondary)
  );
}
 
function buildBidRow() {
  const rows = [];
  for (const num of AUCTION_PROJECTS) {
    const proj       = PROJECTS[num];
    const icon       = num === 3 ? '🌾' : '⚔️';
    const components = [];
    for (let i = 1; i <= BID_SLOTS; i++) {
      const aId    = getAuctionId(num, i);
      const auction = auctions[aId];
      components.push(
        new ButtonBuilder()
          .setCustomId(`place_bid_${aId}`)
          .setLabel(`${icon} ${proj.name} Slot ${i}`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(auction?.status === 'ended')
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
 
async function endAuction(auctionId) {
  const auction = auctions[auctionId];
  if (!auction || auction.status === 'ended') return;
  if (endingAuctions.has(auctionId)) return;
  endingAuctions.add(auctionId);
 
  auction.status = 'ended';
  saveAuctions();
 
  const topBid = getTopBid(auction);
  await updatePanelMessage();
 
  const resetToIdle = (delay = 10_000) => {
    setTimeout(() => {
      if (auctions[auctionId]) {
        auctions[auctionId] = { ...auctions[auctionId], status: 'idle', bids: [], endsAt: null };
        saveAuctions();
        updatePanelMessage();
      }
      endingAuctions.delete(auctionId);
    }, delay);
  };
 
  if (!topBid) {
    console.log(`⚠️ Auction ${auctionId} ended with no bids`);
    return resetToIdle();
  }
 
  const project = PROJECTS[auction.projectNum];
  ensureUser(topBid.userId);
 
  if (users[topBid.userId].credits < topBid.amount) {
    console.warn(`⚠️ ${topBid.userId} won ${auctionId} but has insufficient credits`);
    try {
      const channel = await client.channels.fetch(panelState.channelId);
      await channel.send(`⚠️ <@${topBid.userId}> won **${auctionId}** but has insufficient credits. Slot not activated.`);
    } catch {}
    return resetToIdle();
  }
 
  try {
    let username = topBid.userId;
    try { const u = await client.users.fetch(topBid.userId); username = u.username; } catch {}
 
    const { key, expiry } = await createLuarmorKey(AUCTION_FIXED_HOURS, topBid.userId, username, project);
 
    slots = slots.filter(s => !(s.userId === topBid.userId && s.projectNum === auction.projectNum));
    slots.push({ userId: topBid.userId, key, expiry, project: project.name, projectNum: auction.projectNum });
 
    users[topBid.userId].credits -= topBid.amount;
    saveUsers();
    saveSlots();
 
    try {
      const discordUser = await client.users.fetch(topBid.userId);
      await discordUser.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🎉 You won ${project.name} Slot ${auction.slotIndex}!`)
            .setColor(0x57F287)
            .addFields(
              { name: '🔑 Your Key',         value: `\`${key}\``,                                   inline: false },
              { name: '⏳ Duration',          value: `${AUCTION_FIXED_HOURS} hours (flat)`,          inline: true  },
              { name: '📅 Expires',           value: `<t:${Math.floor(expiry / 1000)}:R>`,           inline: true  },
              { name: '💳 Credits Deducted',  value: `${topBid.amount}`,                             inline: true  },
              { name: '💳 Credits Remaining', value: `${users[topBid.userId].credits}`,              inline: true  }
            )
            .setFooter({ text: 'Keep your key private.' })
        ]
      });
    } catch {}
 
    // Refund all losing bidders then save once
    for (const bid of auction.bids) {
      if (bid.userId === topBid.userId) continue;
      ensureUser(bid.userId);
      users[bid.userId].credits += bid.amount;
      try {
        const loser = await client.users.fetch(bid.userId);
        await loser.send({
          embeds: [
            new EmbedBuilder()
              .setTitle(`❌ You lost the ${project.name} Slot ${auction.slotIndex} auction`)
              .setColor(0xED4245)
              .setDescription(`Your **${bid.amount} credits** have been refunded.\nBalance: **${users[bid.userId].credits}**`)
          ]
        });
      } catch {}
    }
    saveUsers();
 
    console.log(`🏆 Auction ${auctionId} won by ${topBid.userId} for ${topBid.amount} credits`);
    resetToIdle(15_000);
 
  } catch (err) {
    console.error(`❌ Key generation failed for ${auctionId}:`, err.message);
    endingAuctions.delete(auctionId);
  }
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
        const st  = !a || a.status === 'idle' ? '⚪ Idle' : a.status === 'live' ? '🔴 Live' : '✅ Ended';
        lines.push(`${proj.name} Slot ${i}: ${st}`);
      }
    }
    return interaction.reply({
      embeds: [new EmbedBuilder().setTitle('🏷️ Auction Status').setColor(0xF5C542).setDescription(lines.join('\n') || 'No auctions.')],
      ephemeral: true
    });
  }
 
  if (interaction.commandName === 'givecredits' && isAdmin) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    ensureUser(target.id);
    users[target.id].credits += amount;
    saveUsers();
    return interaction.reply({ content: `✅ Gave **${amount} credits** to ${target.tag}. Balance: **${users[target.id].credits}**` });
  }
});
 
// ===== BUTTON HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const userId = interaction.user.id;
  ensureUser(userId);
 
  // ===== BUY CREDITS =====
  if (interaction.customId === 'buy_crypto') {
    const modal = new ModalBuilder()
      .setCustomId('buy_credits_modal')
      .setTitle('Buy Credits with Crypto');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('usd_amount')
          .setLabel(`Credits to buy — Balance: ${users[userId].credits} ($1 = 1 credit)`)
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
    const num         = interaction.customId === 'select_project_1' ? 1 : 2;
    const project     = PROJECTS[num];
    const userCredits = users[userId].credits;
 
    if (userCredits <= 0) {
      return interaction.reply({ content: `❌ You have **0 credits**. Buy some first using **💳 Buy Credits**.`, ephemeral: true });
    }
    if (getActiveSlots(num) >= project.maxSlots) {
      return interaction.reply({ content: `❌ All **${project.name}** slots are full right now!`, ephemeral: true });
    }
 
    const modal = new ModalBuilder()
      .setCustomId(`activate_modal_${num}`)
      .setTitle(`Activate ${project.name} Slot`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('credits_amount')
          .setLabel(`Credits (you have ${userCredits}) — 1c = ${project.creditToHours}h`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(`e.g. 5 = ${5 * project.creditToHours} hours`)
          .setRequired(true)
      )
    );
    return interaction.showModal(modal);
  }
 
  if (interaction.customId.startsWith('place_bid_')) {
    const auctionId = interaction.customId.replace('place_bid_', '');
    const parts     = auctionId.split('_');
    ensureAuction(parseInt(parts[1]), parseInt(parts[2]));
    const auction   = auctions[auctionId];
 
    if (auction.status === 'ended') {
      return interaction.reply({ content: '❌ This auction just ended. Wait for the next one.', ephemeral: true });
    }
 
    const topBid = getTopBid(auction);
    const minBid = topBid ? topBid.amount + 1 : 1;
 
    const modal = new ModalBuilder()
      .setCustomId(`bid_modal_${auctionId}`)
      .setTitle(`Bid for ${AUCTION_FIXED_HOURS}h — ${PROJECTS[auction.projectNum].name} Slot ${auction.slotIndex}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('bid_amount')
          .setLabel(`Min bid: ${minBid} credits | You have: ${users[userId].credits}`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(`e.g. ${minBid}`)
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
 
  // ===== BUY CREDITS MODAL =====
  if (interaction.customId === 'buy_credits_modal') {
    await interaction.deferReply({ ephemeral: true });
 
    const rawUsd    = interaction.fields.getTextInputValue('usd_amount').trim();
    const rawCoin   = interaction.fields.getTextInputValue('crypto_choice').trim().toLowerCase();
    const usdAmount = parseInt(rawUsd);
 
    if (isNaN(usdAmount) || usdAmount < 1) {
      return interaction.editReply({ content: '❌ Enter a valid dollar amount (minimum $1).' });
    }
    if (!['btc', 'ltc'].includes(rawCoin)) {
      return interaction.editReply({ content: '❌ Invalid coin. Type **btc** or **ltc**.' });
    }
 
    try {
      const paymentData = await createNowPayment(userId, rawCoin, usdAmount);
      const { payment_id, pay_address, pay_amount, pay_currency, expiration_estimate_date } = paymentData;
 
      if (!payment_id || !pay_address) {
        console.error('NowPayments incomplete response:', JSON.stringify(paymentData));
        return interaction.editReply({ content: '❌ NowPayments returned an incomplete response. Try again in a moment.' });
      }
 
      // Save record — deliverCredits will look this up by payment_id to get userId
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
 
      // Generate QR code
      let qrAttach   = null;
      const qrFile   = `${rawCoin}_qr.png`;
      try {
        qrAttach = new AttachmentBuilder(await generateQRBuffer(pay_address), { name: qrFile });
      } catch {}
 
      const coinLabel = (pay_currency || rawCoin).toUpperCase();
      const embed = new EmbedBuilder()
        .setTitle(`💳 Pay with ${coinLabel} — ${usdAmount} Credits`)
        .setColor(0xF5C542)
        .setDescription(
          'Send **exactly** the amount shown below to the address provided.\n' +
          'Credits are added **automatically** once your payment confirms.\n\n' +
          '⚠️ This invoice is **unique to you** — do not share or reuse it.\n' +
          '⚠️ Send **only** the specified coin to this address.'
        )
        .addFields(
          { name: `${coinLabel} Address`,     value: `\`${pay_address}\``,               inline: false },
          { name: 'Amount to Send',           value: `**${pay_amount} ${coinLabel}**`,   inline: true  },
          { name: "Credits You'll Receive",   value: `**${usdAmount}**`,                 inline: true  },
          { name: 'Payment ID',               value: `\`${payment_id}\``,                inline: false },
        )
        .setFooter({ text: 'Invoice expires in ~20 min. Create a new one if it expires.' });
 
      if (expiration_estimate_date) {
        const expireTs = Math.floor(new Date(expiration_estimate_date).getTime() / 1000);
        embed.addFields({ name: 'Expires', value: `<t:${expireTs}:R>`, inline: true });
      }
 
      if (qrAttach) embed.setImage(`attachment://${qrFile}`);
 
      return interaction.editReply({ embeds: [embed], files: qrAttach ? [qrAttach] : [] });
 
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error('createNowPayment error:', err.response?.data || err.message);
      return interaction.editReply({ content: `❌ Failed to create payment invoice: ${msg}` });
    }
  }
 
  // ===== ACTIVATE SLOT MODAL =====
  if (interaction.customId.startsWith('activate_modal_')) {
    const num            = parseInt(interaction.customId.split('_')[2]);
    const project        = PROJECTS[num];
    const creditsToSpend = parseInt(interaction.fields.getTextInputValue('credits_amount'));
    const userCredits    = users[userId].credits;
 
    if (!creditsToSpend || isNaN(creditsToSpend) || creditsToSpend <= 0) {
      return interaction.reply({ content: '❌ Enter a valid number of credits.', ephemeral: true });
    }
    if (creditsToSpend > userCredits) {
      return interaction.reply({ content: `❌ You only have **${userCredits} credits**.`, ephemeral: true });
    }
    if (getActiveSlots(num) >= project.maxSlots) {
      return interaction.reply({ content: `❌ All **${project.name}** slots are full!`, ephemeral: true });
    }
 
    try {
      const username        = interaction.user.username;
      const hours           = creditsToSpend * project.creditToHours;
      const { key, expiry } = await createLuarmorKey(hours, userId, username, project);
 
      slots = slots.filter(s => !(s.userId === userId && s.projectNum === num));
      slots.push({ userId, key, expiry, project: project.name, projectNum: num });
      users[userId].credits -= creditsToSpend;
      saveUsers();
      saveSlots();
      updatePanelMessage();
 
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`✅ ${project.name} Slot Activated!`)
            .setColor(0x57F287)
            .addFields(
              { name: '🔑 Your Key',         value: `\`${key}\``,                         inline: false },
              { name: '⏳ Duration',          value: `${hours} hours`,                     inline: true  },
              { name: '📅 Expires',           value: `<t:${Math.floor(expiry / 1000)}:R>`, inline: true  },
              { name: '💳 Credits Remaining', value: `${users[userId].credits}`,           inline: true  }
            )
            .setFooter({ text: 'Keep your key private.' })
        ],
        ephemeral: true
      });
    } catch (err) {
      return interaction.reply({
        content: `❌ Luarmor Error:\n\`\`\`${err.message.slice(0, 1800)}\`\`\``,
        ephemeral: true
      });
    }
  }
 
  // ===== BID MODAL =====
  if (interaction.customId.startsWith('bid_modal_')) {
    const auctionId = interaction.customId.replace('bid_modal_', '');
    const parts     = auctionId.split('_');
    ensureAuction(parseInt(parts[1]), parseInt(parts[2]));
    const auction   = auctions[auctionId];
 
    if (auction.status === 'ended') {
      return interaction.reply({ content: '❌ This auction just ended.', ephemeral: true });
    }
 
    const bidAmount = parseInt(interaction.fields.getTextInputValue('bid_amount'));
    if (isNaN(bidAmount) || bidAmount <= 0) {
      return interaction.reply({ content: '❌ Enter a valid bid amount.', ephemeral: true });
    }
 
    const topBid = getTopBid(auction);
    const minBid = topBid ? topBid.amount + 1 : 1;
 
    if (bidAmount < minBid) {
      return interaction.reply({ content: `❌ Minimum bid is **${minBid} credits**.`, ephemeral: true });
    }
    if (bidAmount > users[userId].credits) {
      return interaction.reply({ content: `❌ You only have **${users[userId].credits} credits**.`, ephemeral: true });
    }
 
    const isFirstBid = auction.status === 'idle';
    if (isFirstBid) {
      auction.status = 'live';
      auction.endsAt = Date.now() + AUCTION_DURATION_MINS * 60 * 1000;
      setTimeout(() => endAuction(auctionId), AUCTION_DURATION_MINS * 60 * 1000);
      console.log(`⏰ Auction ${auctionId} started by ${userId}`);
    }
 
    auction.bids = auction.bids.filter(b => b.userId !== userId);
    auction.bids.push({ userId, amount: bidAmount });
 
    // Anti-snipe: extend by 1 min if < 1 min left
    const timeLeft = auction.endsAt - Date.now();
    if (!isFirstBid && timeLeft < 60_000) {
      auction.endsAt = Date.now() + 60_000;
      setTimeout(() => endAuction(auctionId), 60_000);
    }
 
    saveAuctions();
    await updatePanelMessage();
 
    return interaction.reply({
      content: `✅ Bid of **${bidAmount} credits** placed on ${PROJECTS[auction.projectNum].name} Slot ${auction.slotIndex}!\nIf you win, you'll receive **${AUCTION_FIXED_HOURS} hours** flat.${isFirstBid ? '\n⏰ **Auction started! 5 minutes on the clock.**' : ''}`,
      ephemeral: true
    });
  }
});
 
// ===== INTERVALS =====
 
// Slot expiry cleanup every 60s
setInterval(() => {
  const before = slots.length;
  slots = slots.filter(s => s && s.expiry > Date.now());
  if (slots.length !== before) { saveSlots(); console.log(`🧹 Cleaned ${before - slots.length} expired slot(s)`); }
}, 60_000);
 
// Panel refresh every 30s
setInterval(() => updatePanelMessage(), 30_000);
 
// Auction countdown every 10s
setInterval(() => {
  for (const [auctionId, auction] of Object.entries(auctions)) {
    if (auction.status !== 'live') continue;
    if (auction.endsAt <= Date.now()) endAuction(auctionId);
    else updatePanelMessage();
  }
}, 10_000);
 
// Payment polling fallback every 2 minutes
setInterval(() => {
  pollPendingPayments().catch(err => console.error('❌ pollPendingPayments error:', err.message));
}, 2 * 60 * 1000);
 
// ===== READY =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
 
  for (const num of AUCTION_PROJECTS) for (let i = 1; i <= BID_SLOTS; i++) ensureAuction(num, i);
 
  // Resume any auctions that were live before restart
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
 
  https.get('https://api.ipify.org?format=json', res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => { try { console.log('🌐 Outbound IP:', JSON.parse(data).ip); } catch {} });
  });
 
  startWebhookServer();
 
  // Poll once 10s after startup to catch anything missed while offline
  setTimeout(() => pollPendingPayments().catch(() => {}), 10_000);
});
 
client.login(process.env.BOT_TOKEN);
 
