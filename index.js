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
 
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
 
// ===== FILES =====
const USERS_FILE = './users.json';
const SLOTS_FILE = './slots.json';
 
let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : {};
let slots = fs.existsSync(SLOTS_FILE) ? JSON.parse(fs.readFileSync(SLOTS_FILE)) : [];
 
// ===== PROJECT CONFIG =====
const PROJECTS = {
  1: { id: process.env.LUARMOR_PROJECT_ID_1, name: "Basic",   creditToHours: 2, maxSlots: 12, apiKey: process.env.LUARMOR_API_KEY },
  2: { id: process.env.LUARMOR_PROJECT_ID_2, name: "Premium", creditToHours: 1, maxSlots: 6,  apiKey: process.env.LUARMOR_API_KEY }
};
 
// ===== SAVE FUNCTIONS =====
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveSlots() { fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2)); }
 
// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('Open slot panel'),
  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits to a user')
    .addUserOption(opt => opt.setName('user').setDescription('User to give credits to').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of credits').setRequired(true))
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
      {
        discord_id: discordId,
        auth_expire: expiryUnix
      },
      {
        headers: {
          Authorization: project.apiKey,
          'Content-Type': 'application/json'
        }
      }
    );
 
    console.log('✅ Luarmor response:', JSON.stringify(res.data, null, 2));
 
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
    console.error('❌ Luarmor FULL error:', errorData);
    throw new Error(typeof errorData === 'string' ? errorData : JSON.stringify(errorData, null, 2));
  }
}
 
// ===== TIME FORMAT =====
function formatTime(ms) {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
 
function getActiveSlots(projectNum) {
  return slots.filter(s => s?.projectNum === projectNum && s.expiry > Date.now()).length;
}
 
// ===== ENSURE USER EXISTS =====
function ensureUser(userId) {
  if (!users[userId]) users[userId] = { credits: 0, processed: [], btc: null, ltc: null };
}
 
// ===== PANEL EMBED =====
function generatePanelEmbed() {
  const basicActive  = getActiveSlots(1);
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
    .setFooter({ text: 'Use the buttons below to activate a slot or buy credits.' })
    .setTimestamp();
}
 
// ===== SLOTS EMBED (shows Basic + Premium in separate sections) =====
function generateSlotsEmbed() {
  const now = Date.now();
  const basicActive   = slots.filter(s => s?.projectNum === 1 && s.expiry > now);
  const premiumActive = slots.filter(s => s?.projectNum === 2 && s.expiry > now);
 
  const embed = new EmbedBuilder()
    .setTitle('📊 Live Slot Overview')
    .setColor(0x5865F2)
    .setTimestamp();
 
  // ── Basic slots ──
  let basicValue = '';
  for (let i = 0; i < PROJECTS[1].maxSlots; i++) {
    const slot = basicActive[i];
    if (slot) {
      const user = client.users.cache.get(slot.userId);
      basicValue += `🔴 Slot ${i + 1} — ${user ? `<@${slot.userId}>` : 'Unknown'} | expires in ${formatTime(slot.expiry - now)}\n`;
    } else {
      basicValue += `🟢 Slot ${i + 1} — Available\n`;
    }
  }
 
  // ── Premium slots ──
  let premiumValue = '';
  for (let i = 0; i < PROJECTS[2].maxSlots; i++) {
    const slot = premiumActive[i];
    if (slot) {
      const user = client.users.cache.get(slot.userId);
      premiumValue += `🔴 Slot ${i + 1} — ${user ? `<@${slot.userId}>` : 'Unknown'} | expires in ${formatTime(slot.expiry - now)}\n`;
    } else {
      premiumValue += `🟢 Slot ${i + 1} — Available\n`;
    }
  }
 
  embed.addFields(
    { name: `🔵 Basic (${basicActive.length}/${PROJECTS[1].maxSlots})`,   value: basicValue   || 'No slots.',   inline: false },
    { name: `🟣 Premium (${premiumActive.length}/${PROJECTS[2].maxSlots})`, value: premiumValue || 'No slots.', inline: false }
  );
 
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
 
// ===== COMMAND HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
 
  const isAdmin = process.env.ADMIN_IDS.split(',').includes(interaction.user.id);
 
  if (interaction.commandName === 'panel' && isAdmin) {
    return interaction.reply({
      embeds: [generatePanelEmbed(), generateSlotsEmbed()],
      components: [buildPanelRow()]
    });
  }
 
  if (interaction.commandName === 'givecredits' && isAdmin) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    ensureUser(target.id);
    users[target.id].credits += amount;
    saveUsers();
    return interaction.reply({ content: `✅ Gave **${amount} credits** to ${target.tag}. They now have **${users[target.id].credits}** credits.` });
  }
});
 
// ===== BUTTON HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
 
  const userId = interaction.user.id;
  ensureUser(userId);
 
  // ── Buy crypto ──
  if (interaction.customId === 'buy_crypto') {
    try {
      const btc = await axios.post('https://api.blockcypher.com/v1/btc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });
      const ltc = await axios.post('https://api.blockcypher.com/v1/ltc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });
 
      users[userId].btc = btc.data.address;
      users[userId].ltc = ltc.data.address;
      users[userId].processed = [];
      saveUsers();
 
      const embed = new EmbedBuilder()
        .setTitle('💳 Your Payment Addresses')
        .setColor(0xF5C542)
        .setDescription('Send any amount. Credits are added automatically once confirmed.')
        .addFields(
          { name: '₿ Bitcoin (BTC)', value: `\`${users[userId].btc}\``, inline: false },
          { name: 'Ł Litecoin (LTC)', value: `\`${users[userId].ltc}\``, inline: false },
          { name: '📋 Rate', value: '1 satoshi = 1 credit (BTC/LTC)', inline: false }
        )
        .setFooter({ text: 'Requires 1 confirmation. Check back shortly after sending.' });
 
      return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (err) {
      return interaction.reply({ content: '❌ Failed to generate addresses. Try again later.', ephemeral: true });
    }
  }
 
  // ── View slots ──
  if (interaction.customId === 'view_slots') {
    return interaction.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
  }
 
  // ── Select project ──
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
});
 
// ===== MODAL HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith('activate_modal_')) return;
 
  const userId = interaction.user.id;
  ensureUser(userId);
 
  const num = parseInt(interaction.customId.split('_')[2]);
  const project = PROJECTS[num];
  const creditsToSpend = parseInt(interaction.fields.getTextInputValue('credits_amount'));
  const userCredits = users[userId].credits;
 
  if (!creditsToSpend || isNaN(creditsToSpend) || creditsToSpend <= 0) {
    return interaction.reply({ content: '❌ Enter a valid number of credits.', ephemeral: true });
  }
 
  if (creditsToSpend > userCredits) {
    return interaction.reply({ content: `❌ You only have **${userCredits} credits** but tried to spend **${creditsToSpend}**.`, ephemeral: true });
  }
 
  if (getActiveSlots(num) >= project.maxSlots) {
    return interaction.reply({ content: `❌ All **${project.name}** slots are full! (${project.maxSlots}/${project.maxSlots})\nTry again when one frees up.`, ephemeral: true });
  }
 
  try {
    const hours = creditsToSpend * project.creditToHours;
    const { key, expiry } = await createLuarmorKey(hours, userId, project);
 
    // Remove any existing slot for this user in this project tier
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
      .setFooter({ text: 'Keep your key private. Do not share it.' });
 
    return interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (err) {
    return interaction.reply({ content: `❌ Luarmor Error:\n\`\`\`${err.message.slice(0, 1800)}\`\`\``, ephemeral: true });
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
 
// ===== CRYPTO PAYMENT CHECK =====
setInterval(async () => {
  for (const id in users) {
    const user = users[id];
    for (const type of ['btc', 'ltc']) {
      if (!user[type]) continue;
      try {
        const res = await axios.get(`https://api.blockcypher.com/v1/${type}/main/addrs/${user[type]}`);
        const txs = res.data.txrefs || [];
        for (const tx of txs) {
          if (tx.confirmations >= 1 && !user.processed.includes(tx.tx_hash)) {
            const credits = Math.floor(tx.value / 100000);
            if (credits > 0) {
              user.credits += credits;
              user.processed.push(tx.tx_hash);
              console.log(`💰 Added ${credits} credits to ${id} via ${type.toUpperCase()} (tx: ${tx.tx_hash})`);
 
              // DM the user if possible
              try {
                const discordUser = await client.users.fetch(id);
                const embed = new EmbedBuilder()
                  .setTitle('💰 Credits Received!')
                  .setColor(0xF5C542)
                  .addFields(
                    { name: 'Method', value: type.toUpperCase(), inline: true },
                    { name: 'Credits Added', value: `${credits}`, inline: true },
                    { name: 'New Balance', value: `${user.credits}`, inline: true }
                  );
                await discordUser.send({ embeds: [embed] });
              } catch {}
            }
          }
        }
      } catch {}
    }
  }
  saveUsers();
}, 20000);
 
// ===== READY =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
 
  https.get('https://api.ipify.org?format=json', res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try { console.log('🌐 Outbound IP:', JSON.parse(data).ip); } catch {}
    });
  });
});
 
client.login(process.env.BOT_TOKEN);
