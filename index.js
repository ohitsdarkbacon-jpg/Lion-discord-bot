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

const MAX_SLOTS = 6;

function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
function saveSlots() { fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2)); }

// ===== COMMANDS =====
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Open panel'),

  new SlashCommandBuilder()
    .setName('givecredits')
    .setDescription('Give credits to a user')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('User to give credits to')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('amount')
        .setDescription('Amount of credits')
        .setRequired(true)
    )
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
async function createLuarmorKey(hours, discordId) {
  const expiryUnix = Math.floor(Date.now() / 1000) + hours * 3600;

  try {
    const res = await axios.post(
      `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}/users`,
      {
        discord_id: discordId,
        auth_expire: expiryUnix
      },
      {
        headers: {
          Authorization: process.env.LUARMOR_API_KEY,
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

    return { key, expiry: expiryUnix * 1000 }; // expiry in ms

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

// ===== SLOTS EMBED =====
function generateSlotsEmbed() {
  const embed = new EmbedBuilder()
    .setTitle('🎟️ Global Slots')
    .setColor(0x0099ff);

  const now = Date.now();
  const activeSlots = slots.filter(s => s && s.expiry > now).sort((a, b) => a.expiry - b.expiry);

  for (let i = 0; i < MAX_SLOTS; i++) {
    const slot = activeSlots[i];
    if (slot) {
      const user = client.users.cache.get(slot.userId);
      embed.addFields({
        name: `Slot ${i + 1}`,
        value: `🔴 Taken by ${user ? user.tag : 'Unknown'}\nExpires in: ${formatTime(slot.expiry - now)}`
      });
    } else {
      embed.addFields({
        name: `Slot ${i + 1}`,
        value: '🟢 Available'
      });
    }
  }

  return embed;
}

// ===== COMMAND HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'panel' &&
      process.env.ADMIN_IDS.split(',').includes(interaction.user.id)) {

    const embed = new EmbedBuilder()
      .setTitle('🔑 Slot System')
      .setDescription('1 Credit = 2 Hours\nMax 6 Global Slots')
      .setColor(0x00ff00);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('get_credits').setLabel('💰 Credits').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('activate_slot').setLabel('⚡ Activate').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('view_slots').setLabel('📊 Slots').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_crypto').setLabel('💳 Crypto').setStyle(ButtonStyle.Success)
    );

    await interaction.reply({ embeds: [embed, generateSlotsEmbed()], components: [row] });
  }

  if (interaction.commandName === 'givecredits' &&
      process.env.ADMIN_IDS.split(',').includes(interaction.user.id)) {

    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');

    if (!users[target.id]) users[target.id] = { credits: 0, processed: [], btc: null, ltc: null };
    users[target.id].credits += amount;
    saveUsers();

    await interaction.reply(`✅ Gave **${amount} credits** to ${target.tag}`);
  }
});

// ===== BUTTON HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const userId = interaction.user.id;
  if (!users[userId]) users[userId] = { credits: 0, processed: [], btc: null, ltc: null };

  if (interaction.customId === 'get_credits') {
    return interaction.reply({ content: `💰 You have ${users[userId].credits} credits`, ephemeral: true });
  }

  if (interaction.customId === 'activate_slot') {
    if (slots.filter(s => s && s.expiry > Date.now()).length >= MAX_SLOTS)
      return interaction.reply({ content: '❌ All slots are full!', ephemeral: true });

    const modal = new ModalBuilder()
      .setCustomId('activate_modal')
      .setTitle('Activate Slot');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('credits_amount')
          .setLabel('Credits to spend')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );

    return interaction.showModal(modal);
  }

  if (interaction.customId === 'view_slots') {
    return interaction.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
  }

  if (interaction.customId === 'buy_crypto') {
    try {
      const btcAddr = await axios.post('https://api.blockcypher.com/v1/btc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });
      const ltcAddr = await axios.post('https://api.blockcypher.com/v1/ltc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });

      users[userId].btc = btcAddr.data.address;
      users[userId].ltc = ltcAddr.data.address;
      users[userId].processed = [];
      saveUsers();

      return interaction.reply({
        content: `💳 Send crypto to get credits automatically:\nBTC: ${users[userId].btc}\nLTC: ${users[userId].ltc}`,
        ephemeral: true
      });

    } catch (err) {
      return interaction.reply({ content: `❌ Failed to generate wallets\n${err.message}`, ephemeral: true });
    }
  }
});

// ===== MODAL HANDLER =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit() || interaction.customId !== 'activate_modal') return;

  const creditsToSpend = parseInt(interaction.fields.getTextInputValue('credits_amount'));
  const userData = users[interaction.user.id];

  if (!creditsToSpend || creditsToSpend > userData.credits)
    return interaction.reply({ content: '❌ Invalid or insufficient credits', ephemeral: true });

  if (slots.filter(s => s && s.expiry > Date.now()).length >= MAX_SLOTS)
    return interaction.reply({ content: '❌ All slots full', ephemeral: true });

  const hours = creditsToSpend * 2;

  try {
    // ✅ Generate a fresh key with discord_id so Luarmor expiry works
    const { key, expiry } = await createLuarmorKey(hours, interaction.user.id);

    // Find existing slot for this user (one slot per user)
    const existingSlotIndex = slots.findIndex(s => s.userId === interaction.user.id && s.expiry > Date.now());
    if (existingSlotIndex !== -1) {
      slots[existingSlotIndex] = { userId: interaction.user.id, key, expiry }; // replace existing
    } else {
      slots.push({ userId: interaction.user.id, key, expiry });
    }

    userData.credits -= creditsToSpend;

    saveUsers();
    saveSlots();

    return interaction.reply({
      content: `✅ Slot activated!\nKey: ${key}\nExpires in: ${formatTime(expiry - Date.now())}`,
      ephemeral: true
    });

  } catch (err) {
    return interaction.reply({
      content: `❌ Luarmor Error:\n\`\`\`json\n${err.message.slice(0, 1800)}\n\`\`\``,
      ephemeral: true
    });
  }
});

// ===== AUTO CLEANUP =====
setInterval(() => {
  slots = slots.filter(s => s && s.expiry > Date.now());
  saveSlots();
}, 60000);

// ===== AUTO CRYPTO PAYMENT CHECK =====
setInterval(async () => {
  for (const id in users) {
    const user = users[id];
    for (const type of ['btc', 'ltc']) {
      if (!user[type]) continue;
      try {
        const res = await axios.get(`https://api.blockcypher.com/v1/${type}/main/addrs/${user[type]}`);
        const txs = res.data.txrefs || [];
        for (const tx of txs) {
          if (tx.confirmations < 1 || user.processed.includes(tx.tx_hash)) continue;
          const credits = Math.floor(tx.value / 100000);
          if (credits > 0) {
            user.credits += credits;
            user.processed.push(tx.tx_hash);
            console.log(`💰 Added ${credits} credits to ${id}`);
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
    res.on('end', () => { try { console.log('Outbound IP:', JSON.parse(data).ip); } catch {} });
  });
});

client.login(process.env.BOT_TOKEN);
