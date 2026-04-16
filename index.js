require(‘dotenv’).config();
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
} = require(‘discord.js’);
const axios = require(‘axios’);
const fs = require(‘fs’);
const https = require(‘https’);
const QRCode = require(‘qrcode’);
const crypto = require(‘crypto’);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== FILES =====
const USERS_FILE = ‘./users.json’;
const SLOTS_FILE = ‘./slots.json’;
const AUCTIONS_FILE = ‘./auctions.json’;
const PANEL_STATE_FILE = ‘./panel_state.json’;

let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : {};
let slots = fs.existsSync(SLOTS_FILE) ? JSON.parse(fs.readFileSync(SLOTS_FILE)) : [];
let auctions = fs.existsSync(AUCTIONS_FILE) ? JSON.parse(fs.readFileSync(AUCTIONS_FILE)) : {};
let panelState = fs.existsSync(PANEL_STATE_FILE) ? JSON.parse(fs.readFileSync(PANEL_STATE_FILE)) : {};

// ===== PROJECT CONFIG =====
// creditToHours: how many hours 1 credit gives
// $1 = 1 credit
const PROJECTS = {
1: { id: process.env.LUARMOR_PROJECT_ID_1, name: ‘Basic’, creditToHours: 2, maxSlots: 12, apiKey: process.env.LUARMOR_API_KEY },
2: { id: process.env.LUARMOR_PROJECT_ID_2, name: ‘Premium’, creditToHours: 1, maxSlots: 6, apiKey: process.env.LUARMOR_API_KEY },
3: { id: process.env.LUARMOR_PROJECT_ID_3, name: ‘Farmer’, creditToHours: 2, maxSlots: 2, apiKey: process.env.LUARMOR_API_KEY },
4: { id: process.env.LUARMOR_PROJECT_ID_4, name: ‘Main’, creditToHours: 1, maxSlots: 2, apiKey: process.env.LUARMOR_API_KEY },
};

// Projects 3 & 4 use the auction system
const AUCTION_PROJECTS = [3, 4];
const BID_SLOTS = 2;
// Default auction duration when first bid is placed (minutes)
const AUCTION_DURATION_MINS = 5;

// ===== SAVE FUNCTIONS =====
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveSlots() { fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2)); }
function saveAuctions() { fs.writeFileSync(AUCTIONS_FILE, JSON.stringify(auctions, null, 2)); }
function savePanelState() { fs.writeFileSync(PANEL_STATE_FILE, JSON.stringify(panelState, null, 2)); }

// ===== COMMANDS =====
const commands = [
new SlashCommandBuilder().setName(‘panel’).setDescription(‘Open slot panel’),
new SlashCommandBuilder().setName(‘bidpanel’).setDescription(‘Show auction status (admin)’),
new SlashCommandBuilder()
.setName(‘givecredits’)
.setDescription(‘Give credits to a user ($1 = 1 credit)’)
.addUserOption(opt => opt.setName(‘user’).setDescription(‘User’).setRequired(true))
.addIntegerOption(opt => opt.setName(‘amount’).setDescription(‘Amount of credits’).setRequired(true)),
// /startauction is removed — auctions now start automatically on first bid
].map(c => c.toJSON());

const rest = new REST({ version: ‘10’ }).setToken(process.env.BOT_TOKEN);

async function registerCommands() {
await rest.put(
Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
{ body: commands }
);
console.log(‘✅ Commands registered’);
}

// ===== USER IDENTIFIER =====
// Generates a stable unique identifier for a user based on their Discord username.
// This is stored in Luarmor as the “identifier” field so keys are tied to the user.
function getUserIdentifier(userId, username) {
// Use a deterministic hash of userId + username so it never changes per user
return crypto.createHash(‘sha256’).update(`${userId}:${username}`).digest(‘hex’).slice(0, 32);
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
identifier, // stable per-user identifier based on username
auth_expire: expiryUnix,
note: `${username} (${discordId})`
},
{ headers: { Authorization: project.apiKey, ‘Content-Type’: ‘application/json’ } }
);

```
// Recursively find the user_key in the response
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
```

} catch (err) {
const errorData = err.response?.data || err.message;
throw new Error(typeof errorData === ‘string’ ? errorData : JSON.stringify(errorData, null, 2));
}
}

// ===== HELPERS =====
function formatTime(ms) {
if (ms <= 0) return ‘0m’;
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
return QRCode.toBuffer(text, { type: ‘png’, width: 200, margin: 2 });
}

// ===== PANEL EMBED =====
function generatePanelEmbed() {
const basicActive = getActiveSlots(1);
const premiumActive = getActiveSlots(2);

return new EmbedBuilder()
.setTitle(‘🦁 Lion Notifier — Slot System’)
.setColor(0xF5C542)
.setDescription(’**$1 = 1 Credit**’)
.addFields(
{
name: ‘🔵 Basic’,
value: [
`> **1 Credit = 2 Hours**`,
`> Slots: **${basicActive}/${PROJECTS[1].maxSlots}**`,
`> ${basicActive >= PROJECTS[1].maxSlots ? '🔴 Full' : '🟢 Available'}`
].join(’\n’),
inline: true
},
{
name: ‘🟣 Premium’,
value: [
`> **1 Credit = 1 Hour**`,
`> Slots: **${premiumActive}/${PROJECTS[2].maxSlots}**`,
`> ${premiumActive >= PROJECTS[2].maxSlots ? '🔴 Full' : '🟢 Available'}`
].join(’\n’),
inline: true
}
)
.setFooter({ text: ‘Use buttons below to activate a slot or buy credits.’ })
.setTimestamp();
}

// ===== SLOTS EMBED =====
function generateSlotsEmbed() {
const now = Date.now();
const embed = new EmbedBuilder()
.setTitle(‘📊 Live Slot Overview’)
.setColor(0x5865F2)
.setTimestamp();

for (const [num, proj] of Object.entries(PROJECTS)) {
if (AUCTION_PROJECTS.includes(Number(num))) continue;
const active = slots.filter(s => s?.projectNum === Number(num) && s.expiry > now);
let val = ‘’;
for (let i = 0; i < proj.maxSlots; i++) {
const slot = active[i];
val += slot
? `🔴 Slot ${i + 1} — <@${slot.userId}> | expires in ${formatTime(slot.expiry - now)}\n`
: `🟢 Slot ${i + 1} — Available\n`;
}
const icon = num === ‘1’ ? ‘🔵’ : ‘🟣’;
embed.addFields({ name: `${icon} ${proj.name} (${active.length}/${proj.maxSlots})`, value: val || ‘No slots.’, inline: false });
}

return embed;
}

// ===== AUCTION EMBEDS =====
// These are always shown in the panel — “Waiting for first bid” when idle.
function generateAuctionSectionEmbed() {
const now = Date.now();
const embed = new EmbedBuilder()
.setTitle(‘🏷️ Bid Slots — Farmer & Main’)
.setColor(0xF5C542)
.setDescription(‘Bid slots start automatically when the first bid is placed. Auction lasts **5 minutes** from first bid.\n\u200b’)
.setTimestamp();

for (const num of AUCTION_PROJECTS) {
const proj = PROJECTS[num];
const icon = num === 3 ? ‘🌾’ : ‘⚔️’;
for (let i = 1; i <= BID_SLOTS; i++) {
const aId = getAuctionId(num, i);
const auction = auctions[aId];

```
let statusLine, topBidLine, timeLine;

if (!auction || auction.status === 'idle') {
statusLine = '⚪ **Waiting for first bid**';
topBidLine = 'No bids yet';
timeLine = '—';
} else if (auction.status === 'live') {
const timeLeft = Math.max(0, auction.endsAt - now);
const mins = Math.floor(timeLeft / 60000);
const secs = Math.floor((timeLeft % 60000) / 1000);
const top = getTopBid(auction);
statusLine = '🔴 **Live**';
topBidLine = top ? `**${top.amount} credits** by <@${top.userId}>` : 'No bids yet';
timeLine = `${mins}m ${secs}s`;
} else {
// ended
const top = getTopBid(auction);
statusLine = '✅ **Ended**';
topBidLine = top ? `**${top.amount} credits** by <@${top.userId}>` : 'No bids';
timeLine = '—';
}

embed.addFields({
name: `${icon} ${proj.name} — Slot ${i}`,
value: `Status: ${statusLine}\nTop Bid: ${topBidLine}\nTime Left: ${timeLine}`,
inline: true
});
}
```

}

return embed;
}

// ===== ACTION ROWS =====
function buildPanelRow() {
return new ActionRowBuilder().addComponents(
new ButtonBuilder().setCustomId(‘select_project_1’).setLabel(‘🔵 Basic’).setStyle(ButtonStyle.Primary),
new ButtonBuilder().setCustomId(‘select_project_2’).setLabel(‘🟣 Premium’).setStyle(ButtonStyle.Secondary),
new ButtonBuilder().setCustomId(‘buy_crypto’).setLabel(‘💳 Buy Credits’).setStyle(ButtonStyle.Success),
new ButtonBuilder().setCustomId(‘view_slots’).setLabel(‘📊 View Slots’).setStyle(ButtonStyle.Secondary)
);
}

function buildBidRow() {
const rows = [];
for (const num of AUCTION_PROJECTS) {
const proj = PROJECTS[num];
const icon = num === 3 ? ‘🌾’ : ‘⚔️’;
const components = [];
for (let i = 1; i <= BID_SLOTS; i++) {
const aId = getAuctionId(num, i);
const auction = auctions[aId];
const ended = auction?.status === ‘ended’;
components.push(
new ButtonBuilder()
.setCustomId(`place_bid_${aId}`)
.setLabel(`${icon} ${proj.name} Slot ${i}`)
.setStyle(ButtonStyle.Primary)
.setDisabled(ended)
);
}
rows.push(new ActionRowBuilder().addComponents(…components));
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
embeds: [generatePanelEmbed(), generateSlotsEmbed(), generateAuctionSectionEmbed()],
components: [buildPanelRow(), …buildBidRow()]
});
} catch (err) {
console.error(‘❌ Failed to update panel:’, err.message);
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

// Ensures an auction entry exists in idle state
function ensureAuction(projectNum, slotIndex) {
const aId = getAuctionId(projectNum, slotIndex);
if (!auctions[aId]) {
auctions[aId] = {
projectNum,
slotIndex,
endsAt: null,
bids: [],
status: ‘idle’ // idle → live → ended → idle (resets after ended)
};
saveAuctions();
}
return aId;
}

async function endAuction(auctionId) {
const auction = auctions[auctionId];
if (!auction || auction.status === ‘ended’) return;
auction.status = ‘ended’;
saveAuctions();

const topBid = getTopBid(auction);
await updatePanelMessage();

if (!topBid) {
console.log(`⚠️ Auction ${auctionId} ended with no bids — resetting to idle.`);
// Reset to idle so it can be bid on again
setTimeout(() => {
if (auctions[auctionId]) {
auctions[auctionId] = { …auctions[auctionId], status: ‘idle’, bids: [], endsAt: null };
saveAuctions();
updatePanelMessage();
}
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
// Reset auction to idle
setTimeout(() => {
auctions[auctionId] = { …auctions[auctionId], status: ‘idle’, bids: [], endsAt: null };
saveAuctions();
updatePanelMessage();
}, 10_000);
return;
}

try {
// Fetch Discord username for identifier generation
let username = topBid.userId;
try {
const discordUser = await client.users.fetch(topBid.userId);
username = discordUser.username;
} catch {}

```
const hours = topBid.amount * project.creditToHours;
const { key, expiry } = await createLuarmorKey(hours, topBid.userId, username, project);

slots = slots.filter(s => !(s.userId === topBid.userId && s.projectNum === auction.projectNum));
slots.push({ userId: topBid.userId, key, expiry, project: project.name, projectNum: auction.projectNum });
users[topBid.userId].credits -= topBid.amount;
saveUsers();
saveSlots();

// DM winner
try {
const discordUser = await client.users.fetch(topBid.userId);
await discordUser.send({
embeds: [
new EmbedBuilder()
.setTitle(`🎉 You won ${project.name} Slot ${auction.slotIndex}!`)
.setColor(0x57F287)
.addFields(
{ name: '🔑 Your Key', value: `\`${key}\``, inline: false },
{ name: '⏳ Duration', value: `${hours} hours`, inline: true },
{ name: '📅 Expires', value: `<t:${Math.floor(expiry / 1000)}:R>`, inline: true },
{ name: '💳 Credits Remaining', value: `${users[topBid.userId].credits}`, inline: true }
)
.setFooter({ text: 'Keep your key private.' })
]
});
} catch {}

// DM losing bidders — refund credits
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
console.log(`🏆 Auction ${auctionId} won by ${topBid.userId} for ${topBid.amount} credits.`);

// Reset auction to idle after a short delay so it can run again
setTimeout(() => {
auctions[auctionId] = { ...auctions[auctionId], status: 'idle', bids: [], endsAt: null };
saveAuctions();
updatePanelMessage();
}, 15_000);
```

} catch (err) {
console.error(`❌ Key generation failed for ${auctionId}:`, err.message);
}
}

// ===== COMMAND HANDLER =====
client.on(‘interactionCreate’, async interaction => {
if (!interaction.isChatInputCommand()) return;
const isAdmin = (process.env.ADMIN_IDS || ‘’).split(’,’).includes(interaction.user.id);

// /panel
if (interaction.commandName === ‘panel’ && isAdmin) {
// Ensure all auction slots exist in idle state
for (const num of AUCTION_PROJECTS) {
for (let i = 1; i <= BID_SLOTS; i++) ensureAuction(num, i);
}
const reply = await interaction.reply({
embeds: [generatePanelEmbed(), generateSlotsEmbed(), generateAuctionSectionEmbed()],
components: [buildPanelRow(), …buildBidRow()],
fetchReply: true
});
panelState = { messageId: reply.id, channelId: reply.channelId };
savePanelState();
return;
}

// /bidpanel — shows auction status to admin
if (interaction.commandName === ‘bidpanel’ && isAdmin) {
const lines = [];
for (const num of AUCTION_PROJECTS) {
const proj = PROJECTS[num];
for (let i = 1; i <= BID_SLOTS; i++) {
const aId = getAuctionId(num, i);
const a = auctions[aId];
const st = !a || a.status === ‘idle’ ? ‘⚪ Idle’ : a.status === ‘live’ ? ‘🔴 Live’ : ‘✅ Ended’;
lines.push(`${proj.name} Slot ${i}: ${st}`);
}
}
return interaction.reply({
embeds: [
new EmbedBuilder()
.setTitle(‘🏷️ Auction Status’)
.setColor(0xF5C542)
.setDescription(lines.join(’\n’) || ‘No auctions.’)
],
ephemeral: true
});
}

// /givecredits ($1 = 1 credit)
if (interaction.commandName === ‘givecredits’ && isAdmin) {
const target = interaction.options.getUser(‘user’);
const amount = interaction.options.getInteger(‘amount’);
ensureUser(target.id);
users[target.id].credits += amount;
saveUsers();
return interaction.reply({
content: `✅ Gave **${amount} credits** (\$${amount}) to ${target.tag}. Balance: **${users[target.id].credits}**`
});
}
});

// ===== BUTTON HANDLER =====
client.on(‘interactionCreate’, async interaction => {
if (!interaction.isButton()) return;
const userId = interaction.user.id;
ensureUser(userId);

// ── Buy crypto ──
if (interaction.customId === ‘buy_crypto’) {
const btcAddress = process.env.BTC_ADDRESS;
const ltcAddress = process.env.LTC_ADDRESS;
if (!btcAddress || !ltcAddress) {
return interaction.reply({ content: ‘❌ Payment addresses not configured.’, ephemeral: true });
}
try {
await interaction.deferReply({ ephemeral: true });
const [btcQR, ltcQR] = await Promise.all([generateQRBuffer(btcAddress), generateQRBuffer(ltcAddress)]);
const btcAttach = new AttachmentBuilder(btcQR, { name: ‘btc_qr.png’ });
const ltcAttach = new AttachmentBuilder(ltcQR, { name: ‘ltc_qr.png’ });
const embed = new EmbedBuilder()
.setTitle(‘💳 Payment Addresses’)
.setColor(0xF5C542)
.setDescription(
‘Send crypto below. Credits are added manually by admins after confirmation.\n\n’ +
‘**Rate: $1 = 1 Credit**\n\n’ +
‘**Example:** Spend $5 of crypto → get 5 credits → 10 hours Basic or 5 hours Premium’
)
.addFields(
{ name: ‘₿ Bitcoin (BTC)’, value: `\`${btcAddress}``, inline: false }, { name: 'Ł Litecoin (LTC)', value: ``${ltcAddress}``, inline: false }
)
.setImage(‘attachment://btc_qr.png’)
.setFooter({ text: ‘QR shown is BTC. LTC QR attached below.’ });
const ltcEmbed = new EmbedBuilder()
.setTitle(‘Ł LTC QR Code’)
.setColor(0xA5A5A5)
.setImage(‘attachment://ltc_qr.png’);
return interaction.editReply({ embeds: [embed, ltcEmbed], files: [btcAttach, ltcAttach] });
} catch (err) {
console.error(‘QR error:’, err);
return interaction.editReply({ content: ‘❌ Failed to generate QR codes.’ });
}
}

// ── View slots ──
if (interaction.customId === ‘view_slots’) {
return interaction.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
}

// ── Select project (Basic/Premium) ──
if ([‘select_project_1’, ‘select_project_2’].includes(interaction.customId)) {
const num = interaction.customId === ‘select_project_1’ ? 1 : 2;
const project = PROJECTS[num];
const userCredits = users[userId].credits;

```
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
```

}

// ── Place bid ──
if (interaction.customId.startsWith(‘place_bid_’)) {
const auctionId = interaction.customId.replace(‘place_bid_’, ‘’);
ensureAuction(
parseInt(auctionId.split(’*’)[1]),
parseInt(auctionId.split(’*’)[2])
);
const auction = auctions[auctionId];

```
if (auction.status === 'ended') {
return interaction.reply({ content: '❌ This auction just ended. Wait for the next one.', ephemeral: true });
}

const topBid = getTopBid(auction);
const minBid = topBid ? topBid.amount + 1 : 1;

const modal = new ModalBuilder()
.setCustomId(`bid_modal_${auctionId}`)
.setTitle(`Bid — ${PROJECTS[auction.projectNum].name} Slot ${auction.slotIndex}`);
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
```

}
});

// ===== MODAL HANDLER =====
client.on(‘interactionCreate’, async interaction => {
if (!interaction.isModalSubmit()) return;
const userId = interaction.user.id;
ensureUser(userId);

// ── Activate Basic/Premium slot ──
if (interaction.customId.startsWith(‘activate_modal_’)) {
const num = parseInt(interaction.customId.split(’_’)[2]);
const project = PROJECTS[num];
const creditsToSpend = parseInt(interaction.fields.getTextInputValue(‘credits_amount’));
const userCredits = users[userId].credits;

```
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
const username = interaction.user.username;
const hours = creditsToSpend * project.creditToHours;
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
{ name: '🔑 Your Key', value: `\`${key}\``, inline: false },
{ name: '⏳ Duration', value: `${hours} hours`, inline: true },
{ name: '📅 Expires', value: `<t:${Math.floor(expiry / 1000)}:R>`, inline: true },
{ name: '💳 Credits Remaining', value: `${users[userId].credits}`, inline: true }
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
```

}

// ── Bid modal ──
if (interaction.customId.startsWith(‘bid_modal_’)) {
const auctionId = interaction.customId.replace(‘bid_modal_’, ‘’);
ensureAuction(
parseInt(auctionId.split(’*’)[1]),
parseInt(auctionId.split(’*’)[2])
);
const auction = auctions[auctionId];

```
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

// ── Start auction timer on FIRST bid ──
const isFirstBid = auction.status === 'idle';
if (isFirstBid) {
auction.status = 'live';
auction.endsAt = Date.now() + AUCTION_DURATION_MINS * 60 * 1000;
setTimeout(() => endAuction(auctionId), AUCTION_DURATION_MINS * 60 * 1000);
console.log(`⏰ Auction ${auctionId} started by first bid from ${userId}`);
}

// Replace previous bid by this user (no stacking)
auction.bids = auction.bids.filter(b => b.userId !== userId);
auction.bids.push({ userId, amount: bidAmount });

// Sniping protection: extend to 1 min if bid placed in last minute
const timeLeft = auction.endsAt - Date.now();
if (timeLeft < 60_000) {
auction.endsAt = Date.now() + 60_000;
setTimeout(() => endAuction(auctionId), 60_000);
}

saveAuctions();
await updatePanelMessage();

return interaction.reply({
content: `✅ Bid of **${bidAmount} credits** placed on ${PROJECTS[auction.projectNum].name} Slot ${auction.slotIndex}!${isFirstBid ? '\n⏰ **Auction started! 5 minutes on the clock.**' : ''}`,
ephemeral: true
});
```

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
if (auction.status !== ‘live’) continue;
if (auction.endsAt <= Date.now()) {
endAuction(auctionId);
} else {
// Just refresh panel to update countdown
updatePanelMessage();
}
}
}, 10_000);

// ===== READY =====
client.once(‘ready’, async () => {
console.log(`✅ Logged in as ${client.user.tag}`);
await registerCommands();

// Ensure all auction slots exist
for (const num of AUCTION_PROJECTS) {
for (let i = 1; i <= BID_SLOTS; i++) ensureAuction(num, i);
}

// Resume any live auctions that survived a restart
for (const [auctionId, auction] of Object.entries(auctions)) {
if (auction.status !== ‘live’) continue;
const remaining = auction.endsAt - Date.now();
if (remaining <= 0) {
endAuction(auctionId);
} else {
setTimeout(() => endAuction(auctionId), remaining);
console.log(`⏰ Resuming auction ${auctionId} — ends in ${Math.ceil(remaining / 1000)}s`);
}
}

// Log outbound IP (useful for Luarmor whitelisting)
https.get(‘https://api.ipify.org?format=json’, res => {
let data = ‘’;
res.on(‘data’, chunk => data += chunk);
res.on(‘end’, () => {
try { console.log(‘🌐 Outbound IP:’, JSON.parse(data).ip); } catch {}
});
});
});

client.login(process.env.BOT_TOKEN);
 
