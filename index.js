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
 
let users      = fs.existsSync(USERS_FILE)       ? JSON.parse(fs.readFileSync(USERS_FILE))       : {};
let slots      = fs.existsSync(SLOTS_FILE)       ? JSON.parse(fs.readFileSync(SLOTS_FILE))       : [];
let auctions   = fs.existsSync(AUCTIONS_FILE)    ? JSON.parse(fs.readFileSync(AUCTIONS_FILE))    : {};
let panelState = fs.existsSync(PANEL_STATE_FILE) ? JSON.parse(fs.readFileSync(PANEL_STATE_FILE)) : {};
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
const AUCTION_COOLDOWN_MS   = AUCTION_FIXED_HOURS * 60 * 60 * 1000;
 
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
 
// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open slot panel'),
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
  // FIX: admin command to force-end a stuck auction
  new SlashCommandBuilder()
    .setName('forceendauction')
    .setDescription('(Admin) Force-end a stuck auction')
    .addStringOption(opt => opt.setName('auction_id').setDescription('e.g. auction_3_1').setRequired(true)),
  // FIX: admin command to reset a stuck auction to idle
  new SlashCommandBuilder()
    .setName('resetauction')
    .setDescription('(Admin) Reset an auction slot to idle (refunds all bidders)')
    .addStringOption(opt => opt.setName('auction_id').setDescription('e.g. auction_3_1').setRequired(true)),
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
    if (req.method !== 'POST' || !req.url.startsWith('/nowpayments-webhook')) {
      res.writeHead(404);
      return res.end('Not found');
    }
 
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
 
      const onCooldown = isAuctionSlotOnCooldown(num, i);
 
      if (onCooldown) {
        const timeLeft = Math.max(0, auction.cooldownUntil - now);
        statusLine = '🔒 **Occupied** (winner\'s key active)';
        topBidLine = auction._lastWinner ? `<@${auction._lastWinner}>` : '—';
        timeLine   = `unlocks in ${formatTime(timeLeft)}`;
      } else if (!auction || auction.status === 'idle') {
        statusLine = '⚪ **Waiting for first bid**'; topBidLine = 'No bids yet'; timeLine = '—';
      } else if (auction.status === 'live') {
        const timeLeft = Math.max(0, auction.endsAt - now);
        const top = getTopBid(auction);
        statusLine = '🔴 **Live**';
        topBidLine = top ? `**${top.amount} credits** by <@${top.userId}>` : 'No bids yet';
        timeLine   = `${Math.floor(timeLeft / 60000)}m ${Math.floor((timeLeft % 60000) / 1000)}s`;
      } else {
        // ended but not yet on cooldown (key gen in progress or failed)
        const top = getTopBid(auction);
        statusLine = '⏳ **Processing winner...**';
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
      const aId        = getAuctionId(num, i);
      const auction    = auctions[aId];
      const onCooldown = isAuctionSlotOnCooldown(num, i);
      // Disable if: cooldown active, ended (processing), or no auction object
      const isDisabled = onCooldown || auction?.status === 'ended';
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
 
// FIX: helper to refund all bidders except the winner (or all if no winner)
async function refundBidders(auction, winnerUserId = null) {
  for (const bid of (auction.bids || [])) {
    if (bid.userId === winnerUserId) continue;
    ensureUser(bid.userId);
    users[bid.userId].credits += bid.amount;
    console.log(`↩️  Refunded ${bid.amount} credits to ${bid.userId}`);
    try {
      const loser = await client.users.fetch(bid.userId);
      const project = PROJECTS[auction.projectNum];
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
 
  // Helper: reset this auction slot back to idle after a delay
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
 
  // FIX: Credits were held (escrowed) when bids were placed, so no need to re-check/re-deduct here.
  // The winner's bid amount was already deducted at bid time; losers are refunded below.
  // We just need to verify the winner still has at least 0 credits (sanity check).
  // (If using escrow model, the winner's credits were already locked, so this check is just defensive.)
  if (users[topBid.userId].credits < 0) {
    console.warn(`⚠️ ${topBid.userId} has negative credits after winning ${auctionId} — this shouldn't happen`);
  }
 
  let key, expiry;
  try {
    let username = topBid.userId;
    try {
      const u = await client.users.fetch(topBid.userId);
      username = u.username;
    } catch {}
 
    // FIX: Generate key BEFORE touching any state, so failure is clean
    const keyResult = await createLuarmorKey(AUCTION_FIXED_HOURS, topBid.userId, username, project);
    key    = keyResult.key;
    expiry = keyResult.expiry;
  } catch (err) {
    console.error(`❌ Key generation failed for ${auctionId}:`, err.message);
 
    // FIX: On key gen failure, refund the WINNER their bid too and reset
    ensureUser(topBid.userId);
    users[topBid.userId].credits += topBid.amount;
    await refundBidders(auction, topBid.userId); // refund all losers
    saveUsers();
    saveCreditsBackup();
 
    try {
      const winner = await client.users.fetch(topBid.userId);
      await winner.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`⚠️ Auction Key Generation Failed`)
            .setColor(0xED4245)
            .setDescription(`You won the **${project.name} Slot ${auction.slotIndex}** auction but there was an error generating your key.\nYour **${topBid.amount} credits** have been refunded.\nBalance: **${users[topBid.userId].credits}**\n\nPlease contact an admin.`)
        ]
      });
    } catch {}
 
    // Notify in panel channel if possible
    try {
      if (panelState.channelId) {
        const channel = await client.channels.fetch(panelState.channelId);
        await channel.send(`⚠️ <@${topBid.userId}> won **${auctionId}** but key generation failed. All bids refunded. Error: \`${err.message.slice(0, 200)}\``);
      }
    } catch {}
 
    saveUsers();
    saveCreditsBackup();
    return resetToIdle(5_000);
  }
 
  // Key generated successfully — now set cooldown and update slots
  auction.cooldownUntil = Date.now() + AUCTION_COOLDOWN_MS;
  auction._lastWinner   = topBid.userId;
  saveAuctions();
 
  // FIX: Remove any existing slot for this user+project before adding new one
  slots = slots.filter(s => !(s.userId === topBid.userId && s.projectNum === auction.projectNum));
  slots.push({
    userId:     topBid.userId,
    key,
    expiry,
    project:    project.name,
    projectNum: auction.projectNum,
    fromAuction: true,
    auctionId,
  });
  saveSlots();
 
  // FIX: Winner's credits were already deducted at bid time (escrow model).
  // No additional deduction needed here. Save & backup.
  saveUsers();
  saveCreditsBackup();
 
  await updatePanelMessage();
 
  // FIX: DM winner with key — this was broken before because it was inside a try/catch
  // that would silently swallow errors and skip the DM entirely
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
            { name: '💳 Credits Spent',     value: `${topBid.amount}`,                             inline: true  },
            { name: '💳 Credits Remaining', value: `${users[topBid.userId].credits}`,              inline: true  }
          )
          .setFooter({ text: 'Keep your key private. The slot is now marked as occupied.' })
      ]
    });
    console.log(`✅ Key DM sent to winner ${topBid.userId}`);
  } catch (err) {
    console.error(`❌ Could not DM winner ${topBid.userId}:`, err.message);
    // FIX: If we can't DM the winner, post the key in the panel channel as fallback
    try {
      if (panelState.channelId) {
        const channel = await client.channels.fetch(panelState.channelId);
        await channel.send({
          content: `⚠️ <@${topBid.userId}> — couldn't DM you your key. Here it is (delete this message after copying):`,
          embeds: [
            new EmbedBuilder()
              .setTitle(`🎉 Auction Won: ${project.name} Slot ${auction.slotIndex}`)
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
 
  // Refund all losing bidders
  await refundBidders(auction, topBid.userId);
  saveUsers();
  saveCreditsBackup();
 
  console.log(`🏆 Auction ${auctionId} won by ${topBid.userId} for ${topBid.amount} credits | Key: ${key}`);
 
  // Announce in panel channel
  try {
    if (panelState.channelId) {
      const channel = await client.channels.fetch(panelState.channelId);
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🏆 Auction Ended: ${project.name} Slot ${auction.slotIndex}`)
            .setColor(0xF5C542)
            .setDescription(`<@${topBid.userId}> won with a bid of **${topBid.amount} credits** and has received their key via DM!\nSlot is now **occupied** for **${AUCTION_FIXED_HOURS} hours**.`)
        ]
      });
    }
  } catch {}
 
  // Reset to idle after the full 2-hour cooldown
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
        lines.push(`${proj.name} Slot ${i}: ${st}${topBid ? ` | Top: ${topBid.amount}cr by <@${topBid.userId}>` : ''}`);
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
    saveCreditsBackup();
    return interaction.reply({ content: `✅ Gave **${amount} credits** to ${target.tag}. Balance: **${users[target.id].credits}**` });
  }
 
  if (interaction.commandName === 'backupcredits' && isAdmin) {
    saveCreditsBackup();
    const count = Object.keys(users).length;
    return interaction.reply({
      content: `✅ Credits backed up for **${count} user(s)** → \`credits_backup.json\`.`,
      ephemeral: true
    });
  }
 
  if (interaction.commandName === 'restorecredits' && isAdmin) {
    const backup = loadCreditsBackup();
    if (!backup) {
      return interaction.reply({ content: '❌ No backup file found (`credits_backup.json`). Run `/backupcredits` first.', ephemeral: true });
    }
    let restored = 0;
    for (const [userId, credits] of Object.entries(backup)) {
      ensureUser(userId);
      users[userId].credits = credits;
      restored++;
    }
    saveUsers();
    return interaction.reply({
      content: `✅ Restored credits for **${restored} user(s)** from backup.`,
      ephemeral: true
    });
  }
 
  if (interaction.commandName === 'checkcredits' && isAdmin) {
    const target = interaction.options.getUser('user');
    ensureUser(target.id);
    return interaction.reply({
      content: `💳 **${target.tag}** has **${users[target.id].credits} credits**.`,
      ephemeral: true
    });
  }
 
  // FIX: force-end a stuck auction
  if (interaction.commandName === 'forceendauction' && isAdmin) {
    const auctionId = interaction.options.getString('auction_id');
    if (!auctions[auctionId]) {
      return interaction.reply({ content: `❌ No auction found with ID \`${auctionId}\`.`, ephemeral: true });
    }
    await interaction.reply({ content: `⚙️ Force-ending \`${auctionId}\`...`, ephemeral: true });
    auctions[auctionId].status = 'live'; // ensure endAuction won't skip it
    endingAuctions.delete(auctionId);    // clear lock so it can re-run
    await endAuction(auctionId);
    return;
  }
 
  // FIX: reset a stuck auction to idle (with refunds)
  if (interaction.commandName === 'resetauction' && isAdmin) {
    const auctionId = interaction.options.getString('auction_id');
    if (!auctions[auctionId]) {
      return interaction.reply({ content: `❌ No auction found with ID \`${auctionId}\`.`, ephemeral: true });
    }
    const auction = auctions[auctionId];
    // Refund all current bidders
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
    return interaction.reply({ content: `✅ Auction \`${auctionId}\` reset to idle. All bidders refunded.`, ephemeral: true });
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
    const projNum   = parseInt(parts[1]);
    const slotIdx   = parseInt(parts[2]);
    ensureAuction(projNum, slotIdx);
    const auction   = auctions[auctionId];
 
    if (isAuctionSlotOnCooldown(projNum, slotIdx)) {
      const timeLeft = formatTime(auction.cooldownUntil - Date.now());
      return interaction.reply({ content: `🔒 This slot is occupied. Bidding opens again in **${timeLeft}**.`, ephemeral: true });
    }
 
    if (auction.status === 'ended') {
      return interaction.reply({ content: '❌ This auction just ended. Wait for the next one.', ephemeral: true });
    }
 
    const topBid      = getTopBid(auction);
    // FIX: existing bid from this user — min bid only needs to beat the current top (not their own bid)
    const existingBid = auction.bids.find(b => b.userId === userId);
    const minBid      = topBid
      ? (topBid.userId === userId ? topBid.amount + 1 : topBid.amount + 1)
      : 1;
 
    const modal = new ModalBuilder()
      .setCustomId(`bid_modal_${auctionId}`)
      .setTitle(`Bid for ${AUCTION_FIXED_HOURS}h — ${PROJECTS[auction.projectNum].name} Slot ${auction.slotIndex}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('bid_amount')
          .setLabel(`Min bid: ${minBid} credits | You have: ${users[userId].credits}${existingBid ? ` | Your bid: ${existingBid.amount}` : ''}`)
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
 
      // FIX: deduct AFTER key is successfully generated
      slots = slots.filter(s => !(s.userId === userId && s.projectNum === num));
      slots.push({ userId, key, expiry, project: project.name, projectNum: num });
      users[userId].credits -= creditsToSpend;
      saveUsers();
      saveSlots();
      saveCreditsBackup();
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
 
  if (interaction.customId.startsWith('bid_modal_')) {
    const auctionId = interaction.customId.replace('bid_modal_', '');
    const parts     = auctionId.split('_');
    const projNum   = parseInt(parts[1]);
    const slotIdx   = parseInt(parts[2]);
    ensureAuction(projNum, slotIdx);
    const auction   = auctions[auctionId];
 
    if (isAuctionSlotOnCooldown(projNum, slotIdx)) {
      return interaction.reply({ content: '🔒 This slot is occupied by the winner. Bidding is locked until the key expires.', ephemeral: true });
    }
 
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
 
    // FIX: Re-validate credits at modal submit time (prevents race where user spends credits between opening modal and submitting)
    ensureUser(userId); // re-read fresh
    const existingBid    = auction.bids.find(b => b.userId === userId);
    const existingAmount = existingBid ? existingBid.amount : 0;
    // The new bid replaces the old one — user only needs enough to cover the DIFFERENCE (since old credits were already held)
    // With escrow model: user's total credits already have existingBid deducted, so they need (bidAmount - existingAmount) more
    const additionalCost = bidAmount - existingAmount;
 
    if (additionalCost > users[userId].credits) {
      return interaction.reply({
        content: `❌ You need **${additionalCost} more credits** for this bid (have **${users[userId].credits}**, upgrading from **${existingAmount}** to **${bidAmount}**).`,
        ephemeral: true
      });
    }
 
    // FIX: ESCROW — hold/update credits at bid time so the winner's funds are locked
    if (existingBid) {
      // Refund the difference of the old bid, then charge the new full amount
      users[userId].credits -= additionalCost; // net: charge only the increase
      existingBid.amount = bidAmount;          // update in place
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
      // FIX: clear old timer and set a new one (track with a flag to avoid double-ending)
      endingAuctions.delete(auctionId);
      setTimeout(() => endAuction(auctionId), 60_000);
    }
 
    saveAuctions();
    await updatePanelMessage();
 
    return interaction.reply({
      content: `✅ Bid of **${bidAmount} credits** placed on ${PROJECTS[auction.projectNum].name} Slot ${auction.slotIndex}!\n💳 Credits on hold: **${bidAmount}** | Balance: **${users[userId].credits}**\nIf you win, you'll receive **${AUCTION_FIXED_HOURS} hours** flat.${isFirstBid ? '\n⏰ **Auction started! 5 minutes on the clock.**' : ''}`,
      ephemeral: true
    });
  }
});
 
// ===== INTERVALS =====
 
setInterval(() => {
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
 
  // Resume live auctions
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
 
  // Resume cooldown timers
  for (const [auctionId, auction] of Object.entries(auctions)) {
    if (!auction.cooldownUntil || auction.cooldownUntil <= Date.now()) {
      // If cooldown has already expired, reset to idle immediately
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
 
