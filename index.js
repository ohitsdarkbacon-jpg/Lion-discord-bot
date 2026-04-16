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
  SlashCommandBuilder
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const QRCode = require('qrcode');
 
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
 
// ===== FILES =====
const USERS_FILE = './users.json';
const SLOTS_FILE = './slots.json';
const AUCTIONS_FILE = './auctions.json';
const PANEL_STATE_FILE = './panel_state.json';
 
let users    = fs.existsSync(USERS_FILE)    ? JSON.parse(fs.readFileSync(USERS_FILE))    : {};
let slots    = fs.existsSync(SLOTS_FILE)    ? JSON.parse(fs.readFileSync(SLOTS_FILE))    : [];
let auctions = fs.existsSync(AUCTIONS_FILE) ? JSON.parse(fs.readFileSync(AUCTIONS_FILE)) : {};
// { auctionId: { projectNum, slotIndex, endsAt, bids: [{userId, amount}], messageId, channelId, status } }
 
let panelState = fs.existsSync(PANEL_STATE_FILE) ? JSON.parse(fs.readFileSync(PANEL_STATE_FILE)) : {};
// { messageId, channelId }
 
// ===== PROJECT CONFIG =====
const PROJECTS = {
  1: { id: process.env.LUARMOR_PROJECT_ID_1, name: 'Basic',   creditToHours: 2, maxSlots: 12, apiKey: process.env.LUARMOR_API_KEY },
  2: { id: process.env.LUARMOR_PROJECT_ID_2, name: 'Premium', creditToHours: 1, maxSlots: 6,  apiKey: process.env.LUARMOR_API_KEY },
  3: { id: process.env.LUARMOR_PROJECT_ID_3, name: 'Farmer',  creditToHours: 2, maxSlots: 2,  apiKey: process.env.LUARMOR_API_KEY },
  4: { id: process.env.LUARMOR_PROJECT_ID_4, name: 'Main',    creditToHours: 1, maxSlots: 2,  apiKey: process.env.LUARMOR_API_KEY },
};
 
const AUCTION_PROJECTS = [3, 4]; // Farmer & Main use bidding
const BID_SLOTS = 2;             // each auction tier has 2 slots
 
// ===== SAVE FUNCTIONS =====
function saveUsers()    { fs.writeFileSync(USERS_FILE,    JSON.stringify(users, null, 2)); }
function saveSlots()    { fs.writeFileSync(SLOTS_FILE,    JSON.stringify(slots, null, 2)); }
function saveAuctions() { fs.writeFileSync(AUCTIONS_FILE, JSON.stringify(auctions, null, 2)); }
function savePanelState() { fs.writeFileSync(PANEL_STATE_FILE, JSON.stringify(panelState, null, 2)); }
 
// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open slot panel'),
  new SlashCommandBuilder().setName('bidpanel').setDescription('Open the auction bid panel (admin)'),
  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits to a user')
    .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Amount').setRequired(true)),
  new SlashCommandBuilder()
    .setName('startauction')
    .setDescription('Start a new auction for a bid slot')
    .addIntegerOption(opt =>
      opt.setName('project').setDescription('3=Farmer 4=Main').setRequired(true)
        .addChoices({ name: 'Farmer', value: 3 }, { name: 'Main', value: 4 })
    )
    .addIntegerOption(opt => opt.setName('slot').setDescription('Slot number (1 or 2)').setRequired(true)),
].map(c => c.toJSON());
 
const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
 
async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('✅ Commands registered');
}
 
// ===== LUARMOR KEY GENERATOR =====
async function createLuarmorKey(hours, discordId, project) {
  const expiryUnix = Math.floor(Date.now() / 1000) + Math.floor(hours * 3600);
  try {
    const res = await axios.post(
      `https://api.luarmor.net/v3/projects/${project.id}/users`,
      { discord_id: discordId, auth_expire: expiryUnix },
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
    if (!key) throw new Error(`No key found: ${JSON.stringify(res.data)}`);
    return { key, expiry: expiryUnix * 1000 };
  } catch (err) {
    const errorData = err.response?.data || err.message;
    throw new Error(typeof errorData === 'string' ? errorData : JSON.stringify(errorData, null, 2));
  }
}
 
// ===== HELPERS =====
function formatTime(ms) {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
 
function getActiveSlots(projectNum) {
  return slots.filter(s => s?.projectNum === projectNum && s.expiry > Date.now()).length;
}
 
function ensureUser(userId) {
  if (!users[userId]) users[userId] = { credits: 0, processed: [] };
}
 
// ===== QR CODE HELPER =====
async function generateQRBuffer(text) {
  return await QRCode.toBuffer(text, { type: 'png', width: 200, margin: 2 });
}
 
// ===== PANEL EMBED =====
function generatePanelEmbed() {
  const basicActive   = getActiveSlots(1);
  const premiumActive = getActiveSlots(2);
 
  return new EmbedBuilder()
    .setTitle('🦁 Lion Notifier — Slot System')
    .setColor(0xF5C542)
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
    if (AUCTION_PROJECTS.includes(Number(num))) continue; // auctions shown separately
    const active = slots.filter(s => s?.projectNum === Number(num) && s.expiry > now);
    let val = '';
    for (let i = 0; i < proj.maxSlots; i++) {
      const slot = active[i];
      if (slot) {
        val += `🔴 Slot ${i + 1} — <@${slot.userId}> | expires in ${formatTime(slot.expiry - now)}\n`;
      } else {
        val += `🟢 Slot ${i + 1} — Available\n`;
      }
    }
    const icon = num === '1' ? '🔵' : '🟣';
    embed.addFields({ name: `${icon} ${proj.name} (${active.length}/${proj.maxSlots})`, value: val || 'No slots.', inline: false });
  }
 
  return embed;
}
 
// ===== ACTION ROW =====
function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('select_project_1').setLabel('🔵 Basic').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('select_project_2').setLabel('🟣 Premium').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('buy_crypto').setLabel('💳 Buy Credits').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('view_slots').setLabel('📊 View Slots').setStyle(ButtonStyle.Secondary)
  );
}
 
// ===== AUTO-UPDATE PANEL EMBED =====
async function updatePanelMessage() {
  if (!panelState.messageId || !panelState.channelId) return;
  try {
    const channel = await client.channels.fetch(panelState.channelId);
    const message = await channel.messages.fetch(panelState.messageId);
    await message.edit({
      embeds: [generatePanelEmbed(), generateSlotsEmbed()],
      components: [buildPanelRow()]
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
  if (!auction.bids || auction.bids.length === 0) return null;
  return auction.bids.reduce((a, b) => (a.amount >= b.amount ? a : b));
}
 
function buildAuctionEmbed(auctionId) {
  const auction = auctions[auctionId];
  if (!auction) return null;
 
  const project = PROJECTS[auction.projectNum];
  const now = Date.now();
  const timeLeft = Math.max(0, auction.endsAt - now);
  const mins = Math.floor(timeLeft / 60000);
  const secs = Math.floor((timeLeft % 60000) / 1000);
  const topBid = getTopBid(auction);
  const icon = auction.projectNum === 3 ? '🌾' : '⚔️';
 
  const embed = new EmbedBuilder()
    .setTitle(`${icon} ${project.name} Slot ${auction.slotIndex} — Live Auction`)
    .setColor(auction.status === 'ended' ? 0x57F287 : 0xF5C542)
    .addFields(
      { name: '⏳ Time Remaining', value: auction.status === 'ended' ? '✅ Ended' : `${mins}m ${secs}s`, inline: true },
      { name: '🏆 Top Bid', value: topBid ? `**${topBid.amount} credits** by <@${topBid.userId}>` : 'No bids yet', inline: true },
      { name: '📋 Total Bids', value: `${auction.bids.length}`, inline: true }
    );
 
  if (auction.bids.length > 0) {
    const sorted = [...auction.bids].sort((a, b) => b.amount - a.amount).slice(0, 5);
    embed.addFields({
      name: '📊 Leaderboard',
      value: sorted.map((b, i) => `${['🥇','🥈','🥉','4️⃣','5️⃣'][i]} <@${b.userId}> — **${b.amount}** credits`).join('\n'),
      inline: false
    });
  }
 
  if (auction.status === 'ended' && topBid) {
    embed.addFields({ name: '🎉 Winner', value: `<@${topBid.userId}> won with **${topBid.amount} credits**!`, inline: false });
  }
 
  embed.setFooter({ text: 'Use /bid or the Bid button to place your bid.' }).setTimestamp();
  return embed;
}
 
function buildAuctionRow(auctionId) {
  const auction = auctions[auctionId];
  const ended = !auction || auction.status === 'ended';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`place_bid_${auctionId}`)
      .setLabel('💰 Place Bid')
      .setStyle(ButtonStyle.Success)
      .setDisabled(ended)
  );
}
 
async function updateAuctionMessage(auctionId) {
  const auction = auctions[auctionId];
  if (!auction?.messageId || !auction?.channelId) return;
  try {
    const channel = await client.channels.fetch(auction.channelId);
    const message = await channel.messages.fetch(auction.messageId);
    const embed = buildAuctionEmbed(auctionId);
    await message.edit({ embeds: [embed], components: [buildAuctionRow(auctionId)] });
  } catch (err) {
    console.error(`❌ Failed to update auction ${auctionId}:`, err.message);
  }
}
 
async function endAuction(auctionId) {
  const auction = auctions[auctionId];
  if (!auction || auction.status === 'ended') return;
  auction.status = 'ended';
  saveAuctions();
 
  const topBid = getTopBid(auction);
  await updateAuctionMessage(auctionId);
 
  if (!topBid) {
    console.log(`⚠️ Auction ${auctionId} ended with no bids.`);
    return;
  }
 
  const project = PROJECTS[auction.projectNum];
  ensureUser(topBid.userId);
 
  if (users[topBid.userId].credits < topBid.amount) {
    // Edge case: user spent credits between bidding and winning
    try {
      const channel = await client.channels.fetch(auction.channelId);
      await channel.send(`⚠️ <@${topBid.userId}> won auction **${auctionId}** but doesn't have enough credits. Slot not activated.`);
    } catch {}
    return;
  }
 
  try {
    const hours = topBid.amount * project.creditToHours;
    const { key, expiry } = await createLuarmorKey(hours, topBid.userId, project);
 
    slots = slots.filter(s => !(s.userId === topBid.userId && s.projectNum === auction.projectNum));
    slots.push({ userId: topBid.userId, key, expiry, project: project.name, projectNum: auction.projectNum });
    users[topBid.userId].credits -= topBid.amount;
    saveUsers();
    saveSlots();
 
    const winEmbed = new EmbedBuilder()
      .setTitle(`🎉 You won the ${project.name} Slot ${auction.slotIndex} auction!`)
      .setColor(0x57F287)
      .addFields(
        { name: '🔑 Your Key', value: `\`${key}\``, inline: false },
        { name: '⏳ Duration', value: `${hours} hours`, inline: true },
        { name: '📅 Expires', value: `<t:${Math.floor(expiry / 1000)}:R>`, inline: true },
        { name: '💳 Credits Remaining', value: `${users[topBid.userId].credits}`, inline: true }
      )
      .setFooter({ text: 'Keep your key private.' });
 
    try {
      const discordUser = await client.users.fetch(topBid.userId);
      await discordUser.send({ embeds: [winEmbed] });
    } catch {}
 
    // Refund all losing bidders
    for (const bid of auction.bids) {
      if (bid.userId === topBid.userId) continue;
      ensureUser(bid.userId);
      users[bid.userId].credits += bid.amount;
      try {
        const loser = await client.users.fetch(bid.userId);
        await loser.send({ embeds: [
          new EmbedBuilder()
            .setTitle(`❌ You lost the ${project.name} Slot ${auction.slotIndex} auction`)
            .setColor(0xED4245)
            .setDescription(`Your **${bid.amount} credits** have been refunded. Balance: **${users[bid.userId].credits}**`)
        ]});
      } catch {}
    }
    saveUsers();
    console.log(`🏆 Auction ${auctionId} won by ${topBid.userId} for ${topBid.amount} credits.`);
  } catch (err) {
    console.error(`❌ Auction key generation failed for ${auctionId}:`, err.message);
  }
}
 
// ===== COMMAND HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
 
  const isAdmin = process.env.ADMIN_IDS.split(',').includes(interaction.user.id);
 
  // /panel
  if (interaction.commandName === 'panel' && isAdmin) {
    const reply = await interaction.reply({
      embeds: [generatePanelEmbed(), generateSlotsEmbed()],
      components: [buildPanelRow()],
      fetchReply: true
    });
    panelState = { messageId: reply.id, channelId: reply.channelId };
    savePanelState();
    return;
  }
 
  // /bidpanel
  if (interaction.commandName === 'bidpanel' && isAdmin) {
    const lines = [];
    for (const num of AUCTION_PROJECTS) {
      const proj = PROJECTS[num];
      for (let i = 1; i <= BID_SLOTS; i++) {
        const aId = getAuctionId(num, i);
        const a = auctions[aId];
        const status = a ? (a.status === 'ended' ? '✅ Ended' : '🔴 Live') : '⚪ Not started';
        lines.push(`${proj.name} Slot ${i}: ${status}`);
      }
    }
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🏷️ Auction Panel')
        .setColor(0xF5C542)
        .setDescription(lines.join('\n') || 'No auctions yet.')
      ],
      ephemeral: true
    });
  }
 
  // /givecredits
  if (interaction.commandName === 'givecredits' && isAdmin) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    ensureUser(target.id);
    users[target.id].credits += amount;
    saveUsers();
    return interaction.reply({ content: `✅ Gave **${amount} credits** to ${target.tag}. Balance: **${users[target.id].credits}**` });
  }
 
  // /startauction
  if (interaction.commandName === 'startauction' && isAdmin) {
    const projectNum = interaction.options.getInteger('project');
    const slotIndex  = interaction.options.getInteger('slot');
 
    if (slotIndex < 1 || slotIndex > BID_SLOTS) {
      return interaction.reply({ content: `❌ Slot must be 1 or 2.`, ephemeral: true });
    }
 
    const auctionId = getAuctionId(projectNum, slotIndex);
    if (auctions[auctionId] && auctions[auctionId].status !== 'ended') {
      return interaction.reply({ content: `❌ Auction **${auctionId}** is already running.`, ephemeral: true });
    }
 
    const endsAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    auctions[auctionId] = {
      projectNum,
      slotIndex,
      endsAt,
      bids: [],
      messageId: null,
      channelId: null,
      status: 'live'
    };
    saveAuctions();
 
    const embed = buildAuctionEmbed(auctionId);
    const reply = await interaction.reply({ embeds: [embed], components: [buildAuctionRow(auctionId)], fetchReply: true });
    auctions[auctionId].messageId = reply.id;
    auctions[auctionId].channelId = reply.channelId;
    saveAuctions();
 
    // Schedule end
    setTimeout(() => endAuction(auctionId), 5 * 60 * 1000);
    return;
  }
});
 
// ===== BUTTON HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
 
  const userId = interaction.user.id;
  ensureUser(userId);
 
  // ── Buy crypto ──
  if (interaction.customId === 'buy_crypto') {
    const btcAddress = process.env.BTC_ADDRESS;
    const ltcAddress = process.env.LTC_ADDRESS;
 
    if (!btcAddress || !ltcAddress) {
      return interaction.reply({ content: '❌ Payment addresses not configured.', ephemeral: true });
    }
 
    try {
      await interaction.deferReply({ ephemeral: true });
 
      const [btcQR, ltcQR] = await Promise.all([
        generateQRBuffer(btcAddress),
        generateQRBuffer(ltcAddress)
      ]);
 
      const { AttachmentBuilder } = require('discord.js');
      const btcAttach = new AttachmentBuilder(btcQR, { name: 'btc_qr.png' });
      const ltcAttach = new AttachmentBuilder(ltcQR, { name: 'ltc_qr.png' });
 
      const embed = new EmbedBuilder()
        .setTitle('💳 Payment Addresses')
        .setColor(0xF5C542)
        .setDescription('Send crypto to the addresses below. Credits are added manually by admins after confirmation.\n\n**Rate:** 1 satoshi = 1 credit (BTC/LTC)')
        .addFields(
          { name: '₿ Bitcoin (BTC)', value: `\`${btcAddress}\``, inline: false },
          { name: 'Ł Litecoin (LTC)', value: `\`${ltcAddress}\``, inline: false }
        )
        .setImage('attachment://btc_qr.png')
        .setFooter({ text: 'QR code shown is BTC. LTC QR attached below.' });
 
      const ltcEmbed = new EmbedBuilder()
        .setTitle('Ł LTC QR Code')
        .setColor(0xA5A5A5)
        .setImage('attachment://ltc_qr.png');
 
      return interaction.editReply({ embeds: [embed, ltcEmbed], files: [btcAttach, ltcAttach] });
    } catch (err) {
      console.error('QR generation error:', err);
      return interaction.editReply({ content: '❌ Failed to generate QR codes.' });
    }
  }
 
  // ── View slots ──
  if (interaction.customId === 'view_slots') {
    return interaction.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
  }
 
  // ── Select project (Basic/Premium) ──
  if (['select_project_1', 'select_project_2'].includes(interaction.customId)) {
    const num = interaction.customId === 'select_project_1' ? 1 : 2;
    const project = PROJECTS[num];
    const userCredits = users[userId].credits;
 
    if (userCredits <= 0) {
      return interaction.reply({ content: `❌ You have **0 credits**. Buy some first using **💳 Buy Credits**.`, ephemeral: true });
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
 
  // ── Place bid ──
  if (interaction.customId.startsWith('place_bid_')) {
    const auctionId = interaction.customId.replace('place_bid_', '');
    const auction = auctions[auctionId];
 
    if (!auction || auction.status === 'ended') {
      return interaction.reply({ content: '❌ This auction has ended.', ephemeral: true });
    }
    if (auction.endsAt <= Date.now()) {
      return interaction.reply({ content: '❌ This auction has already expired.', ephemeral: true });
    }
 
    const topBid = getTopBid(auction);
    const minBid = topBid ? topBid.amount + 1 : 1;
 
    const modal = new ModalBuilder()
      .setCustomId(`bid_modal_${auctionId}`)
      .setTitle(`Place Bid — ${PROJECTS[auction.projectNum].name} Slot ${auction.slotIndex}`);
 
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('bid_amount')
          .setLabel(`Your bid (min: ${minBid} credits, you have: ${users[userId].credits})`)
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
 
  // ── Activate Basic/Premium slot ──
  if (interaction.customId.startsWith('activate_modal_')) {
    const num = parseInt(interaction.customId.split('_')[2]);
    const project = PROJECTS[num];
    const creditsToSpend = parseInt(interaction.fields.getTextInputValue('credits_amount'));
    const userCredits = users[userId].credits;
 
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
      const hours = creditsToSpend * project.creditToHours;
      const { key, expiry } = await createLuarmorKey(hours, userId, project);
 
      slots = slots.filter(s => !(s.userId === userId && s.projectNum === num));
      slots.push({ userId, key, expiry, project: project.name, projectNum: num });
      users[userId].credits -= creditsToSpend;
      saveUsers();
      saveSlots();
 
      const embed = new EmbedBuilder()
        .setTitle(`✅ ${project.name} Slot Activated!`)
        .setColor(0x57F287)
        .addFields(
          { name: '🔑 Your Key', value: `\`${key}\``, inline: false },
          { name: '⏳ Duration', value: `${hours} hours`, inline: true },
          { name: '📅 Expires', value: `<t:${Math.floor(expiry / 1000)}:R>`, inline: true },
          { name: '💳 Credits Remaining', value: `${users[userId].credits}`, inline: true }
        )
        .setFooter({ text: 'Keep your key private.' });
 
      return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (err) {
      return interaction.reply({ content: `❌ Luarmor Error:\n\`\`\`${err.message.slice(0, 1800)}\`\`\``, ephemeral: true });
    }
  }
 
  // ── Bid modal ──
  if (interaction.customId.startsWith('bid_modal_')) {
    const auctionId = interaction.customId.replace('bid_modal_', '');
    const auction = auctions[auctionId];
 
    if (!auction || auction.status === 'ended' || auction.endsAt <= Date.now()) {
      return interaction.reply({ content: '❌ This auction has ended.', ephemeral: true });
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
 
    // Remove previous bid by this user (replace, not stack)
    auction.bids = auction.bids.filter(b => b.userId !== userId);
    auction.bids.push({ userId, amount: bidAmount });
 
    // Sniping protection: if bid placed with < 1 min left, extend to 1 min
    const timeLeft = auction.endsAt - Date.now();
    if (timeLeft < 60 * 1000) {
      auction.endsAt = Date.now() + 60 * 1000;
      // Re-schedule the end
      setTimeout(() => endAuction(auctionId), 60 * 1000);
    }
 
    saveAuctions();
    await updateAuctionMessage(auctionId);
 
    return interaction.reply({
      content: `✅ Bid of **${bidAmount} credits** placed on ${PROJECTS[auction.projectNum].name} Slot ${auction.slotIndex}!`,
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
}, 60000);
 
// ===== AUTO-UPDATE PANEL EMBED (every 30s) =====
setInterval(() => {
  updatePanelMessage();
}, 30 * 1000);
 
// ===== AUTO-UPDATE LIVE AUCTION EMBEDS (every 10s) =====
setInterval(() => {
  for (const [auctionId, auction] of Object.entries(auctions)) {
    if (auction.status !== 'live') continue;
 
    if (auction.endsAt <= Date.now()) {
      endAuction(auctionId);
    } else {
      updateAuctionMessage(auctionId);
    }
  }
}, 10 * 1000);
 
// ===== READY =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
 
  // Resume any live auctions that survived a restart
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
});
 
client.login(process.env.BOT_TOKEN);
 
