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
const fs = require('fs');
const https = require('https');
const http = require('http');
const QRCode = require('qrcode');
const crypto = require('crypto');
 
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
 
// ===== FILES =====
const USERS_FILE         = './users.json';
const SLOTS_FILE         = './slots.json';
const AUCTIONS_FILE      = './auctions.json';
const PANEL_STATE_FILE   = './panel_state.json';
const PAY_ADDRESSES_FILE = './pay_addresses.json';
 
let users       = fs.existsSync(USERS_FILE)         ? JSON.parse(fs.readFileSync(USERS_FILE))         : {};
let slots       = fs.existsSync(SLOTS_FILE)         ? JSON.parse(fs.readFileSync(SLOTS_FILE))         : [];
let auctions    = fs.existsSync(AUCTIONS_FILE)       ? JSON.parse(fs.readFileSync(AUCTIONS_FILE))       : {};
let panelState  = fs.existsSync(PANEL_STATE_FILE)   ? JSON.parse(fs.readFileSync(PANEL_STATE_FILE))   : {};
// payAddresses: { userId: { btc: { address, webhookId }, ltc: { address, webhookId } } }
let payAddresses = fs.existsSync(PAY_ADDRESSES_FILE) ? JSON.parse(fs.readFileSync(PAY_ADDRESSES_FILE)) : {};
 
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
 
// Webhook server port — expose this via reverse proxy or open firewall port
// BlockCypher will POST to: http://YOUR_SERVER_IP:WEBHOOK_PORT/webhook
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3000');
// Your publicly reachable URL, e.g. "http://123.45.67.89:3000" or "https://yourdomain.com"
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || `http://localhost:${WEBHOOK_PORT}`;
 
// ===== SAVE FUNCTIONS =====
function saveUsers()        { fs.writeFileSync(USERS_FILE,         JSON.stringify(users,        null, 2)); }
function saveSlots()        { fs.writeFileSync(SLOTS_FILE,         JSON.stringify(slots,        null, 2)); }
function saveAuctions()     { fs.writeFileSync(AUCTIONS_FILE,      JSON.stringify(auctions,     null, 2)); }
function savePanelState()   { fs.writeFileSync(PANEL_STATE_FILE,   JSON.stringify(panelState,   null, 2)); }
function savePayAddresses() { fs.writeFileSync(PAY_ADDRESSES_FILE, JSON.stringify(payAddresses, null, 2)); }
 
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
 
// ===== LUARMOR KEY GENERATOR =====
async function createLuarmorKey(hours, discordId, username, project) {
  const expiryUnix = Math.floor(Date.now() / 1000) + Math.floor(hours * 3600);
  const identifier = getUserIdentifier(discordId, username);
  try {
    const res = await axios.post(
      `https://api.luarmor.net/v3/projects/${project.id}/users`,
      {
        discord_id: discordId,
        identifier,
        auth_expire: expiryUnix,
        note: `${username} (${discordId})`
      },
      { headers: { Authorization: project.apiKey, 'Content-Type': 'application/json' } }
    );
 
    const findKey = obj => {
      if (typeof obj === 'string' && /^[A-Za-z0-9]{6,}$/.test(obj)) return obj;
      if (typeof obj === 'object' && obj) {
        for (const val of Object.values(obj)) {
          const k = findKey(val);
          if (k) return k;
        }
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
 
function ensureUser(userId) {
  if (!users[userId]) users[userId] = { credits: 0, processed: [] };
}
 
// ===== QR CODE HELPER =====
async function generateQRBuffer(text) {
  return QRCode.toBuffer(text, { type: 'png', width: 200, margin: 2 });
}
 
// ===========================
// ===== CRYPTO PAYMENTS =====
// ===========================
 
// Get live BTC price in USD from CoinGecko (free, no key needed)
async function getBtcPriceUSD() {
  const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { timeout: 8000 });
  return res.data.bitcoin.usd;
}
 
// Get live LTC price in USD from CoinGecko
async function getLtcPriceUSD() {
  const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd', { timeout: 8000 });
  return res.data.litecoin.usd;
}
 
/**
 * Creates a BlockCypher forwarding address for a user + coin.
 * Payments sent to this address are forwarded to your real wallet.
 * BlockCypher sends a webhook on each confirmed payment.
 *
 * @param {string} userId      - Discord user ID
 * @param {'btc'|'ltc'} coin   - Coin type
 * @param {string} destination - Your real wallet address
 * @returns {{ address: string, webhookId: string }}
 */
async function createForwardingAddress(userId, coin, destination) {
  const chain     = coin === 'btc' ? 'main' : 'ltc/main';
  const coinSlug  = coin === 'btc' ? 'btc'  : 'ltc';
  const apiToken  = process.env.BLOCKCYPHER_TOKEN;
  const callbackUrl = `${WEBHOOK_BASE_URL}/webhook?coin=${coinSlug}&userId=${userId}`;
 
  // 1. Create forwarding address
  const fwdRes = await axios.post(
    `https://api.blockcypher.com/v1/${coin === 'btc' ? 'btc/main' : 'ltc/main'}/forwards?token=${apiToken}`,
    {
      destination,
      callback_url: callbackUrl,
      // Only fire callback once it has at least 1 confirmation
      confirmations: 1,
    }
  );
 
  const address = fwdRes.data.input_address;
  if (!address) throw new Error(`BlockCypher did not return an address: ${JSON.stringify(fwdRes.data)}`);
 
  return { address, webhookId: fwdRes.data.id || null };
}
 
/**
 * Get or create a payment address for a user + coin.
 * Reuses the same address if already created.
 */
async function getOrCreatePayAddress(userId, coin) {
  if (!payAddresses[userId]) payAddresses[userId] = {};
  if (payAddresses[userId][coin]) return payAddresses[userId][coin].address;
 
  const destination = coin === 'btc' ? process.env.BTC_ADDRESS : process.env.LTC_ADDRESS;
  if (!destination) throw new Error(`${coin.toUpperCase()} address not configured.`);
 
  const { address, webhookId } = await createForwardingAddress(userId, coin, destination);
  payAddresses[userId][coin] = { address, webhookId };
  savePayAddresses();
  console.log(`📬 Created ${coin.toUpperCase()} forwarding address for ${userId}: ${address}`);
  return address;
}
 
/**
 * Called when BlockCypher confirms a payment.
 * Calculates USD value → credits and assigns to user.
 */
async function handleConfirmedPayment(userId, coin, satoshis) {
  ensureUser(userId);
 
  // satoshis for BTC/LTC (1 BTC = 100,000,000 satoshis)
  const units    = satoshis / 1e8;
  let   priceUSD = 0;
 
  try {
    priceUSD = coin === 'btc' ? await getBtcPriceUSD() : await getLtcPriceUSD();
  } catch (err) {
    console.error(`❌ Failed to fetch ${coin.toUpperCase()} price:`, err.message);
    // Fallback: notify admin and bail
    try {
      const adminIds = (process.env.ADMIN_IDS || '').split(',').filter(Boolean);
      for (const adminId of adminIds) {
        const admin = await client.users.fetch(adminId);
        await admin.send(`⚠️ Payment received for <@${userId}> (${units} ${coin.toUpperCase()}) but price lookup failed. Please assign credits manually.`);
      }
    } catch {}
    return;
  }
 
  const usdValue = units * priceUSD;
  const credits  = Math.floor(usdValue); // 1 credit = $1 USD, floor so no partial credits
 
  if (credits <= 0) {
    console.log(`⚠️ Payment from ${userId} too small: ${units} ${coin.toUpperCase()} = $${usdValue.toFixed(4)} → 0 credits`);
    return;
  }
 
  users[userId].credits += credits;
  saveUsers();
 
  console.log(`💰 Auto-credited ${credits} credits to ${userId} (${units} ${coin.toUpperCase()} ≈ $${usdValue.toFixed(2)})`);
 
  // DM the user
  try {
    const discordUser = await client.users.fetch(userId);
    await discordUser.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('💰 Payment Received!')
          .setColor(0x57F287)
          .setDescription(`Your crypto payment has been confirmed and credits have been added automatically.`)
          .addFields(
            { name: '🪙 Coin',             value: coin.toUpperCase(),                 inline: true },
            { name: '📦 Amount',           value: `${units} ${coin.toUpperCase()}`,   inline: true },
            { name: '💵 USD Value',        value: `~$${usdValue.toFixed(2)}`,         inline: true },
            { name: '✅ Credits Added',    value: `**${credits}**`,                   inline: true },
            { name: '💳 New Balance',      value: `**${users[userId].credits}**`,     inline: true },
          )
          .setFooter({ text: 'Credits are rounded down to the nearest dollar.' })
      ]
    });
  } catch (err) {
    console.error(`❌ Could not DM user ${userId}:`, err.message);
  }
 
  // Update the panel
  updatePanelMessage().catch(() => {});
}
 
// ===== WEBHOOK HTTP SERVER =====
// BlockCypher POSTs here when a forwarded payment is confirmed.
function startWebhookServer() {
  const server = http.createServer(async (req, res) => {
    // Only accept POST /webhook
    if (req.method !== 'POST' || !req.url.startsWith('/webhook')) {
      res.writeHead(404);
      return res.end();
    }
 
    const urlObj = new URL(req.url, `http://localhost`);
    const coin   = urlObj.searchParams.get('coin');   // 'btc' or 'ltc'
    const userId = urlObj.searchParams.get('userId');
 
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      // Always respond 200 immediately so BlockCypher doesn't retry
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
 
      if (!coin || !userId) {
        console.warn('⚠️ Webhook missing coin or userId params');
        return;
      }
 
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        console.warn('⚠️ Webhook body is not valid JSON');
        return;
      }
 
      // BlockCypher forwarding webhooks include `value` (in satoshis) on the tx outputs
      // We look for the total value sent to the input_address (user's forwarding address)
      const userAddr = payAddresses[userId]?.[coin]?.address;
 
      // `outputs` array has { addresses, value }
      // We sum any output whose address matches the user's forwarding address
      let satoshis = 0;
 
      // BlockCypher sends the transaction object; for forwarding addresses,
      // the value is the amount received at the input_address.
      // The payload's top-level `value` field (if present) is the total tx value.
      // Safest: sum outputs addressed to userAddr if available, else use payload.value.
      if (payload.outputs && Array.isArray(payload.outputs) && userAddr) {
        for (const out of payload.outputs) {
          if (out.addresses && out.addresses.includes(userAddr)) {
            satoshis += out.value || 0;
          }
        }
      }
      // Fallback: use top-level `value`
      if (satoshis === 0 && payload.value) {
        satoshis = payload.value;
      }
 
      if (satoshis <= 0) {
        console.log(`⚠️ Webhook for ${userId} had 0 satoshis — ignoring`);
        return;
      }
 
      // Deduplicate: don't process the same tx twice
      const txHash = payload.hash;
      ensureUser(userId);
      if (!users[userId].processed) users[userId].processed = [];
      if (txHash && users[userId].processed.includes(txHash)) {
        console.log(`⚠️ Duplicate webhook for tx ${txHash} — skipping`);
        return;
      }
      if (txHash) {
        users[userId].processed.push(txHash);
        // Keep processed list from growing forever
        if (users[userId].processed.length > 200) {
          users[userId].processed = users[userId].processed.slice(-200);
        }
        saveUsers();
      }
 
      console.log(`📩 Webhook: ${userId} | ${coin.toUpperCase()} | ${satoshis} satoshis | tx: ${txHash}`);
      handleConfirmedPayment(userId, coin, satoshis).catch(err => {
        console.error(`❌ handleConfirmedPayment error:`, err.message);
      });
    });
  });
 
  server.listen(WEBHOOK_PORT, () => {
    console.log(`🌐 Webhook server listening on port ${WEBHOOK_PORT}`);
    console.log(`   BlockCypher should POST to: ${WEBHOOK_BASE_URL}/webhook?coin=btc&userId=USER_ID`);
  });
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
        value: [
          `> **1 Credit = 2 Hours**`,
          `> Slots: **${basicActive}/${PROJECTS[1].maxSlots}**`,
          `> ${basicActive >= PROJECTS[1].maxSlots ? '🔴 Full' : '🟢 Available'}`
        ].join('\n'),
        inline: true
      },
      {
        name: '🟣 Premium',
        value: [
          `> **1 Credit = 1 Hour**`,
          `> Slots: **${premiumActive}/${PROJECTS[2].maxSlots}**`,
          `> ${premiumActive >= PROJECTS[2].maxSlots ? '🔴 Full' : '🟢 Available'}`
        ].join('\n'),
        inline: true
      }
    )
    .setFooter({ text: 'Use buttons below to activate a slot or buy credits.' })
    .setTimestamp();
}
 
// ===== SLOTS EMBED =====
function generateSlotsEmbed() {
  const now = Date.now();
  const embed = new EmbedBuilder()
    .setTitle('📊 Live Slot Overview')
    .setColor(0x5865F2)
    .setTimestamp();
 
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
      const aId = getAuctionId(num, i);
      const auction = auctions[aId];
 
      let statusLine, topBidLine, timeLine;
 
      if (!auction || auction.status === 'idle') {
        statusLine = '⚪ **Waiting for first bid**';
        topBidLine = 'No bids yet';
        timeLine   = '—';
      } else if (auction.status === 'live') {
        const timeLeft = Math.max(0, auction.endsAt - now);
        const mins = Math.floor(timeLeft / 60000);
        const secs = Math.floor((timeLeft % 60000) / 1000);
        const top  = getTopBid(auction);
        statusLine = '🔴 **Live**';
        topBidLine = top ? `**${top.amount} credits** by <@${top.userId}>` : 'No bids yet';
        timeLine   = `${mins}m ${secs}s`;
      } else {
        const top  = getTopBid(auction);
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
    const proj = PROJECTS[num];
    const icon = num === 3 ? '🌾' : '⚔️';
    const components = [];
    for (let i = 1; i <= BID_SLOTS; i++) {
      const aId    = getAuctionId(num, i);
      const auction = auctions[aId];
      const ended  = auction?.status === 'ended';
      components.push(
        new ButtonBuilder()
          .setCustomId(`place_bid_${aId}`)
          .setLabel(`${icon} ${proj.name} Slot ${i}`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(ended)
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
function getAuctionId(projectNum, slotIndex) {
  return `auction_${projectNum}_${slotIndex}`;
}
 
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
 
  if (!topBid) {
    console.log(`⚠️ Auction ${auctionId} ended with no bids — resetting to idle.`);
    setTimeout(() => {
      if (auctions[auctionId]) {
        auctions[auctionId] = { ...auctions[auctionId], status: 'idle', bids: [], endsAt: null };
        saveAuctions();
        updatePanelMessage();
      }
      endingAuctions.delete(auctionId);
    }, 10_000);
    return;
  }
 
  const project = PROJECTS[auction.projectNum];
  ensureUser(topBid.userId);
 
  if (users[topBid.userId].credits < topBid.amount) {
    console.warn(`⚠️ ${topBid.userId} won auction ${auctionId} but has insufficient credits.`);
    try {
      const channel = await client.channels.fetch(panelState.channelId);
      await channel.send(`⚠️ <@${topBid.userId}> won **${auctionId}** but has insufficient credits. Slot not activated.`);
    } catch {}
    setTimeout(() => {
      auctions[auctionId] = { ...auctions[auctionId], status: 'idle', bids: [], endsAt: null };
      saveAuctions();
      updatePanelMessage();
      endingAuctions.delete(auctionId);
    }, 10_000);
    return;
  }
 
  try {
    let username = topBid.userId;
    try {
      const discordUser = await client.users.fetch(topBid.userId);
      username = discordUser.username;
    } catch {}
 
    const hours = AUCTION_FIXED_HOURS;
    const { key, expiry } = await createLuarmorKey(hours, topBid.userId, username, project);
 
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
              { name: '🔑 Your Key',         value: `\`${key}\``,                                 inline: false },
              { name: '⏳ Duration',          value: `${hours} hours (flat)`,                      inline: true  },
              { name: '📅 Expires',           value: `<t:${Math.floor(expiry / 1000)}:R>`,         inline: true  },
              { name: '💳 Credits Deducted',  value: `${topBid.amount}`,                           inline: true  },
              { name: '💳 Credits Remaining', value: `${users[topBid.userId].credits}`,            inline: true  }
            )
            .setFooter({ text: 'Keep your key private.' })
        ]
      });
    } catch {}
 
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
    console.log(`🏆 Auction ${auctionId} won by ${topBid.userId} for ${topBid.amount} credits — ${hours}h awarded.`);
 
    setTimeout(() => {
      auctions[auctionId] = { ...auctions[auctionId], status: 'idle', bids: [], endsAt: null };
      saveAuctions();
      updatePanelMessage();
      endingAuctions.delete(auctionId);
    }, 15_000);
 
  } catch (err) {
    console.error(`❌ Key generation failed for ${auctionId}:`, err.message);
    endingAuctions.delete(auctionId);
  }
}
 
// ===== COMMAND HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const isAdmin = (process.env.ADMIN_IDS || '').split(',').includes(interaction.user.id);
 
  if (interaction.commandName === 'panel' && isAdmin) {
    for (const num of AUCTION_PROJECTS) {
      for (let i = 1; i <= BID_SLOTS; i++) ensureAuction(num, i);
    }
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
      embeds: [
        new EmbedBuilder()
          .setTitle('🏷️ Auction Status')
          .setColor(0xF5C542)
          .setDescription(lines.join('\n') || 'No auctions.')
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
    return interaction.reply({
      content: `✅ Gave **${amount} credits** ($${amount}) to ${target.tag}. Balance: **${users[target.id].credits}**`
    });
  }
});
 
// ===== BUTTON HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const userId = interaction.user.id;
  ensureUser(userId);
 
  // ===== BUY CREDITS (AUTO) =====
  if (interaction.customId === 'buy_crypto') {
    try {
      await interaction.deferReply({ ephemeral: true });
 
      // Generate (or reuse) forwarding addresses for this user
      let btcAddress, ltcAddress;
      try {
        [btcAddress, ltcAddress] = await Promise.all([
          getOrCreatePayAddress(userId, 'btc'),
          getOrCreatePayAddress(userId, 'ltc'),
        ]);
      } catch (err) {
        console.error('BlockCypher address error:', err.message);
        return interaction.editReply({ content: `❌ Failed to generate payment address: ${err.message}` });
      }
 
      const [btcQR, ltcQR] = await Promise.all([
        generateQRBuffer(btcAddress),
        generateQRBuffer(ltcAddress)
      ]);
 
      const btcAttach = new AttachmentBuilder(btcQR, { name: 'btc_qr.png' });
      const ltcAttach = new AttachmentBuilder(ltcQR, { name: 'ltc_qr.png' });
 
      // Fetch live prices for display
      let btcPrice = '?', ltcPrice = '?';
      try { btcPrice = `$${(await getBtcPriceUSD()).toLocaleString()}`; } catch {}
      try { ltcPrice = `$${(await getLtcPriceUSD()).toFixed(2)}`; } catch {}
 
      const embed = new EmbedBuilder()
        .setTitle('💳 Buy Credits — Automatic Payment')
        .setColor(0xF5C542)
        .setDescription(
          '**These addresses are unique to you.** Credits are added automatically after 1 confirmation.\n\n' +
          '**Rate: $1 = 1 Credit** (calculated at live price when your payment confirms)\n\n' +
          '**Example:** Send $5 worth of BTC → receive 5 credits → 10h Basic or 5h Premium'
        )
        .addFields(
          { name: '₿ Bitcoin (BTC)',       value: `\`${btcAddress}\`\nLive price: **${btcPrice}**`, inline: false },
          { name: 'Ł Litecoin (LTC)',      value: `\`${ltcAddress}\`\nLive price: **${ltcPrice}**`, inline: false },
          { name: '⚠️ Important',          value: 'Send only BTC to the BTC address and LTC to the LTC address. Credits appear automatically after confirmation (usually 10–30 min for BTC, 2–5 min for LTC).', inline: false }
        )
        .setImage('attachment://btc_qr.png')
        .setFooter({ text: 'QR shown is BTC. LTC QR attached below.' });
 
      const ltcEmbed = new EmbedBuilder()
        .setTitle('Ł LTC QR Code')
        .setColor(0xA5A5A5)
        .setImage('attachment://ltc_qr.png');
 
      return interaction.editReply({ embeds: [embed, ltcEmbed], files: [btcAttach, ltcAttach] });
 
    } catch (err) {
      console.error('buy_crypto error:', err);
      return interaction.editReply({ content: '❌ Failed to generate payment details.' });
    }
  }
 
  if (interaction.customId === 'view_slots') {
    return interaction.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
  }
 
  if (['select_project_1', 'select_project_2'].includes(interaction.customId)) {
    const num          = interaction.customId === 'select_project_1' ? 1 : 2;
    const project      = PROJECTS[num];
    const userCredits  = users[userId].credits;
 
    if (userCredits <= 0) {
      return interaction.reply({
        content: `❌ You have **0 credits**. Buy some first using **💳 Buy Credits**.`,
        ephemeral: true
      });
    }
    if (getActiveSlots(num) >= project.maxSlots) {
      return interaction.reply({
        content: `❌ All **${project.name}** slots are full right now!`,
        ephemeral: true
      });
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
      console.log(`⏰ Auction ${auctionId} started by first bid from ${userId}`);
    }
 
    auction.bids = auction.bids.filter(b => b.userId !== userId);
    auction.bids.push({ userId, amount: bidAmount });
 
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
 
// ===== AUTO CLEANUP =====
setInterval(() => {
  const before = slots.length;
  slots = slots.filter(s => s && s.expiry > Date.now());
  if (slots.length !== before) {
    saveSlots();
    console.log(`🧹 Cleaned ${before - slots.length} expired slot(s)`);
  }
}, 60_000);
 
// ===== AUTO-UPDATE PANEL (every 30s) =====
setInterval(() => updatePanelMessage(), 30_000);
 
// ===== AUTO-UPDATE LIVE AUCTION COUNTDOWN (every 10s) =====
setInterval(() => {
  for (const [auctionId, auction] of Object.entries(auctions)) {
    if (auction.status !== 'live') continue;
    if (auction.endsAt <= Date.now()) {
      endAuction(auctionId);
    } else {
      updatePanelMessage();
    }
  }
}, 10_000);
 
// ===== READY =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
 
  for (const num of AUCTION_PROJECTS) {
    for (let i = 1; i <= BID_SLOTS; i++) ensureAuction(num, i);
  }
 
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
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try { console.log('🌐 Outbound IP:', JSON.parse(data).ip); } catch {}
    });
  });
 
  // Start webhook server after bot is ready so client is available
  startWebhookServer();
});
 
client.login(process.env.BOT_TOKEN);
