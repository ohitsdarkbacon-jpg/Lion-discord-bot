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
  1: { 
    id: process.env.LUARMOR_PROJECT_ID_1, 
    name: "Basic",   
    creditToHours: 2,      // ← Changed to 2 hours per credit
    maxSlots: 12, 
    apiKey: process.env.LUARMOR_API_KEY 
  },
  2: { 
    id: process.env.LUARMOR_PROJECT_ID_2, 
    name: "Premium", 
    creditToHours: 1,      // 1 hour per credit (kept as requested)
    maxSlots: 6,  
    apiKey: process.env.LUARMOR_API_KEY 
  }
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

// ===== LUARMOR KEY GENERATOR (Original System) =====
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

// ===== SLOTS EMBED =====
function generateSlotsEmbed() {
  const basicActive = getActiveSlots(1);
  const premiumActive = getActiveSlots(2);

  const embed = new EmbedBuilder()
    .setTitle('🎟️ Global Slots')
    .setDescription(`**Basic**: ${basicActive}/${PROJECTS[1].maxSlots} • **Premium**: ${premiumActive}/${PROJECTS[2].maxSlots}`)
    .setColor(0x0099ff);

  const now = Date.now();
  const activeSlots = slots.filter(s => s && s.expiry > now);

  for (let i = 0; i < 12; i++) {
    const slot = activeSlots[i];
    if (slot) {
      const user = client.users.cache.get(slot.userId);
      embed.addFields({
        name: `Slot ${i + 1}`,
        value: `🔴 ${slot.project} - ${user ? user.tag : 'Unknown'}\nExpires in: ${formatTime(slot.expiry - now)}`
      });
    } else {
      embed.addFields({ name: `Slot ${i + 1}`, value: '🟢 Available' });
    }
  }
  return embed;
}

// ===== SINGLE COMMAND + INTERACTION HANDLER =====
client.on('interactionCreate', async interaction => {
  // === Slash Commands ===
  if (interaction.isChatInputCommand()) {
    const isAdmin = process.env.ADMIN_IDS.split(',').includes(interaction.user.id);

    if (interaction.commandName === 'panel' && isAdmin) {
      const embed = new EmbedBuilder()
        .setTitle('🔑 Slot System')
        .setDescription('**Basic**: 1 Credit = **2 Hours** (12 slots)\n**Premium**: 1 Credit = **1 Hour** (6 slots)')
        .setColor(0x0099ff);

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('select_project_1').setLabel('Basic (2h)').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('select_project_2').setLabel('Premium (1h)').setStyle(ButtonStyle.Success)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_crypto').setLabel('💳 Buy Credits').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('view_slots').setLabel('📊 View Slots').setStyle(ButtonStyle.Secondary)
      );

      return interaction.reply({ 
        embeds: [embed, generateSlotsEmbed()], 
        components: [row1, row2] 
      });
    }

    if (interaction.commandName === 'givecredits' && isAdmin) {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      if (!users[target.id]) users[target.id] = { credits: 0, processed: [], btc: null, ltc: null };
      users[target.id].credits += amount;
      saveUsers();
      return interaction.reply(`✅ Gave **${amount} credits** to ${target.tag}`);
    }
  }

  // === Button Handler ===
  if (interaction.isButton()) {
    const userId = interaction.user.id;
    if (!users[userId]) users[userId] = { credits: 0, processed: [], btc: null, ltc: null };

    if (interaction.customId === 'buy_crypto') {
      try {
        const btc = await axios.post('https://api.blockcypher.com/v1/btc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });
        const ltc = await axios.post('https://api.blockcypher.com/v1/ltc/main/addrs', {}, { params: { token: process.env.BLOCKCYPHER_TOKEN } });

        users[userId].btc = btc.data.address;
        users[userId].ltc = ltc.data.address;
        users[userId].processed = [];
        saveUsers();

        await interaction.reply({
          content: `**💳 Your Payment Addresses**\n\n**BTC**: \`${users[userId].btc}\`\n**LTC**: \`${users[userId].ltc}\`\n\nSend any amount. Credits added automatically.`,
          ephemeral: true
        });
      } catch (err) {
        await interaction.reply({ content: '❌ Failed to generate addresses.', ephemeral: true });
      }
      return;
    }

    if (interaction.customId === 'view_slots') {
      return interaction.reply({ embeds: [generateSlotsEmbed()], ephemeral: true });
    }

    if (['select_project_1', 'select_project_2'].includes(interaction.customId)) {
      const num = interaction.customId === 'select_project_1' ? 1 : 2;
      const project = PROJECTS[num];

      const modal = new ModalBuilder()
        .setCustomId(`activate_modal_${num}`)
        .setTitle(`Activate ${project.name} Slot`);

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('credits_amount')
            .setLabel(`Credits to spend (1c = ${project.creditToHours}h)`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );

      return interaction.showModal(modal);
    }
  }

  // === Modal Handler ===
  if (interaction.isModalSubmit() && interaction.customId.startsWith('activate_modal_')) {
    const num = parseInt(interaction.customId.split('_')[2]);
    const project = PROJECTS[num];
    const creditsToSpend = parseInt(interaction.fields.getTextInputValue('credits_amount'));

    if (!creditsToSpend || creditsToSpend > (users[interaction.user.id]?.credits || 0))
      return interaction.reply({ content: '❌ Invalid or insufficient credits!', ephemeral: true });

    if (getActiveSlots(num) >= project.maxSlots)
      return interaction.reply({ content: `❌ All ${project.name} slots are full! (Max ${project.maxSlots})`, ephemeral: true });

    try {
      const { key, expiry } = await createLuarmorKey(creditsToSpend * project.creditToHours, interaction.user.id, project);

      slots = slots.filter(s => s.userId !== interaction.user.id);
      slots.push({ userId: interaction.user.id, key, expiry, project: project.name, projectNum: num });

      users[interaction.user.id].credits -= creditsToSpend;
      saveUsers();
      saveSlots();

      await interaction.reply({
        content: `✅ **${project.name} Slot Activated!**\n🔑 Key: ${key}\n⏳ Expires in: ${formatTime(expiry - Date.now())}`,
        ephemeral: true
      });
    } catch (err) {
      await interaction.reply({ content: `❌ Luarmor Error:\n\`\`\`${err.message.slice(0, 1800)}\`\`\``, ephemeral: true });
    }
  }
});

// ===== AUTO CLEANUP =====
setInterval(() => {
  slots = slots.filter(s => s && s.expiry > Date.now());
  saveSlots();
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
            const credits = Math.floor(tx.value / 100000); // satoshis to credits (adjust if needed)
            if (credits > 0) {
              user.credits += credits;
              user.processed.push(tx.tx_hash);
              console.log(`💰 Added ${credits} credits to ${id} via ${type}`);
            }
          }
        }
      } catch (e) {
        // Silent fail as before
      }
    }
  }
  saveUsers();
}, 20000);

// ===== READY =====
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();

  // Outbound IP
  https.get('https://api.ipify.org?format=json', res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        console.log('🌐 Outbound IP:', JSON.parse(data).ip);
      } catch (e) {}
    });
  });
});

client.login(process.env.BOT_TOKEN);
