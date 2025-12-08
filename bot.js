require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, ActivityType, MessageFlags } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Get the directory where bot.js is located
const botDir = __dirname;

// ==================== ENVIRONMENT VARIABLES VALIDATION ====================
const requiredEnvVars = [
  'DISCORD_TOKEN',
  'GUILD_ID',
  'WOLVESVILLE_EMAIL',
  'WOLVESVILLE_PASSWORD',
  'CAPTCHA_API_KEY'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingVars.forEach(varName => {
    console.error(`   - ${varName}`);
  });
  console.error('\n💡 On Cybrancee, set these in your hosting panel under "Environment Variables" or "Secrets"');
  console.error('💡 Required variables:');
  console.error('   - DISCORD_TOKEN (Your Discord bot token)');
  console.error('   - GUILD_ID (Your Discord server ID)');
  console.error('   - WOLVESVILLE_EMAIL (Wolvesville account email)');
  console.error('   - WOLVESVILLE_PASSWORD (Wolvesville account password)');
  console.error('   - CAPTCHA_API_KEY (Your 2Captcha API key)');
  console.error('   - LOG_CHANNEL_ID (Optional: Discord channel for logs)');
  console.error('   - GIFT_CHANNEL_ID (Optional: Discord channel for gift messages)');
  console.error('   - ADMIN_ROLE_ID (Optional: Discord role ID for admin commands)');
  process.exit(1);
}

const client = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
});

// ==================== TOKENS WOLVESVILLE ====================
let tokens = {
  idToken: process.env.WOLVESVILLE_ID_TOKEN,
  refreshToken: process.env.WOLVESVILLE_REFRESH_TOKEN,
  cfJwt: process.env.WOLVESVILLE_CF_JWT
};

// ==================== ACCOUNTS MANAGEMENT ====================
let accounts = {
  current: 'main',
  accounts: {
    main: {
      email: process.env.WOLVESVILLE_EMAIL,
      password: process.env.WOLVESVILLE_PASSWORD,
      idToken: process.env.WOLVESVILLE_ID_TOKEN,
      refreshToken: process.env.WOLVESVILLE_REFRESH_TOKEN,
      cfJwt: process.env.WOLVESVILLE_CF_JWT
    }
  }
};

function loadAccounts() {
  try {
    const data = fs.readFileSync(path.join(botDir, 'accounts.json'), 'utf8');
    accounts = JSON.parse(data);
    
    // Initialize gemCount for accounts that don't have it
    let needsSave = false;
    for (const accountName in accounts.accounts) {
      if (accounts.accounts[accountName].gemCount === undefined) {
        accounts.accounts[accountName].gemCount = 0;
        needsSave = true;
      }
    }
    if (needsSave) {
      saveAccounts();
    }
    
    // Load current account into tokens
    if (accounts.accounts[accounts.current]) {
      const acc = accounts.accounts[accounts.current];
      tokens.idToken = acc.idToken;
      tokens.refreshToken = acc.refreshToken;
      tokens.cfJwt = acc.cfJwt;
    }
    
    console.log('👥 Accounts loaded:', Object.keys(accounts.accounts).length, 'accounts');
    console.log('✅ Current account:', accounts.current);
  } catch (error) {
    console.log('📝 Creating accounts.json file');
    saveAccounts();
  }
}

function saveAccounts() {
  // Update current account with latest tokens
  if (accounts.accounts[accounts.current]) {
    accounts.accounts[accounts.current].idToken = tokens.idToken;
    accounts.accounts[accounts.current].refreshToken = tokens.refreshToken;
    accounts.accounts[accounts.current].cfJwt = tokens.cfJwt;
  }
  
  fs.writeFileSync(path.join(botDir, 'accounts.json'), JSON.stringify(accounts, null, 2));
}

function addAccount(name, email, password) {
  accounts.accounts[name] = {
    email: email,
    password: password,
    idToken: '',
    refreshToken: '',
    cfJwt: '',
    gemCount: 0
  };
  saveAccounts();
}

function removeAccount(name) {
  if (name === 'main') {
    throw new Error('Cannot remove main account');
  }
  if (accounts.current === name) {
    throw new Error('Cannot remove currently active account. Switch to another account first.');
  }
  delete accounts.accounts[name];
  saveAccounts();
}

function switchAccount(name) {
  if (!accounts.accounts[name]) {
    throw new Error(`Account '${name}' not found`);
  }
  
  // Save current account tokens
  saveAccounts();
  
  // Switch to new account
  accounts.current = name;
  const acc = accounts.accounts[name];
  tokens.idToken = acc.idToken;
  tokens.refreshToken = acc.refreshToken;
  tokens.cfJwt = acc.cfJwt;
  
  saveAccounts();
}

function listAccounts() {
  return Object.keys(accounts.accounts).map(name => ({
    name: name,
    email: accounts.accounts[name].email,
    current: accounts.current === name
  }));
}

// ==================== TOKEN MANAGEMENT ====================

// Function to sign in and get fresh tokens
async function signInWithEmailPassword() {
  try {
    console.log('🔐 Signing in with email and password...');
    console.log('👤 Account:', accounts.current);
    
    const currentAccount = accounts.accounts[accounts.current];
    
    const response = await axios.post(
      'https://auth.api-wolvesville.com/players/signInWithEmailAndPassword',
      {
        email: currentAccount.email,
        password: currentAccount.password
      },
      {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Cf-JWT': tokens.cfJwt,
          'Origin': 'https://www.wolvesville.com',
          'Referer': 'https://www.wolvesville.com/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
        }
      }
    );
    
    if (response.data && response.data.idToken) {
      tokens.idToken = response.data.idToken;
      tokens.refreshToken = response.data.refreshToken;
      
      console.log('✅ Login successful! New tokens obtained');
      console.log('📝 New idToken:', tokens.idToken.substring(0, 30) + '...');
      console.log('📝 New refreshToken:', tokens.refreshToken.substring(0, 30) + '...');
      
      updateEnvFile();
      
      return true;
    }
    
    return false;
  } catch (error) {
    // If cf-jwt is invalid, refresh it and retry
    if (error.response?.data?.code === 403 && error.response?.data?.message === 'Cloudflare JWT invalid') {
      console.log('🔄 Cloudflare JWT expired, refreshing with 2Captcha...');
      const refreshed = await refreshCfJwt();
      
      if (refreshed) {
        console.log('✅ Cloudflare JWT refreshed, retrying login...');
        // Retry login with new cf-jwt
        return signInWithEmailPassword();
      }
    }
    
    console.error('❌ Error signing in:', error.response?.data || error.message);
    return false;
  }
}

// Function to update .env file with new tokens
function updateEnvFile() {
  try {
    let envContent = fs.readFileSync(path.join(botDir, '.env'), 'utf8');
    
    envContent = envContent.replace(
      /WOLVESVILLE_ID_TOKEN=.*/,
      `WOLVESVILLE_ID_TOKEN=${tokens.idToken}`
    );
    
    envContent = envContent.replace(
      /WOLVESVILLE_REFRESH_TOKEN=.*/,
      `WOLVESVILLE_REFRESH_TOKEN=${tokens.refreshToken}`
    );
    
    if (tokens.cfJwt) {
      envContent = envContent.replace(
        /WOLVESVILLE_CF_JWT=.*/,
        `WOLVESVILLE_CF_JWT=${tokens.cfJwt}`
      );
    }
    
    fs.writeFileSync(path.join(botDir, '.env'), envContent);
    saveAccounts(); // Also save to accounts.json
    console.log('💾 Tokens saved to .env file and accounts.json');
  } catch (error) {
    console.error('⚠️  Could not update .env file:', error.message);
  }
}

// Check if idToken is expired
// Check if idToken is expired
function isTokenExpired(idToken) {
  try {
    if (!idToken || typeof idToken !== 'string') {
      console.log('⚠️  Invalid token format');
      return true;
    }
    
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      console.log('⚠️  Token does not have 3 parts');
      return true;
    }
    
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    
    if (!payload.exp) {
      console.log('⚠️  Token has no expiration');
      return true;
    }
    
    const expiryTime = payload.exp * 1000;
    const currentTime = Date.now();
    const timeRemaining = expiryTime - currentTime;
    
    const isExpired = timeRemaining < 5 * 60 * 1000;
    
    if (isExpired) {
      console.log('⚠️  Token expired or expiring soon');
      console.log(`⏰ Time remaining: ${Math.floor(timeRemaining / 1000)} seconds`);
    } else {
      console.log(`✅ Token valid for ${Math.floor(timeRemaining / 1000 / 60)} minutes`);
    }
    
    return isExpired;
  } catch (error) {
    console.error('❌ Error checking token expiry:', error.message);
    console.error('📋 Token preview:', idToken ? idToken.substring(0, 50) + '...' : 'null');
    return true;
  }
}

// Main token refresh function
async function refreshTokens() {
  try {
    if (!isTokenExpired(tokens.idToken)) {
      console.log('✅ Token still valid');
      return true;
    }
    
    console.log('🔄 Token expired, refreshing with email/password...');
    
    const refreshed = await signInWithEmailPassword();
    
    if (!refreshed) {
      console.error('❌ Failed to refresh tokens');
      console.log('⚠️  Please check your email/password in .env file');
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('❌ Error in token refresh flow:', error.message);
    return false;
  }
}

// Add periodic token refresh check (every 50 minutes)
setInterval(async () => {
  console.log('⏰ Periodic token check...');
  if (isTokenExpired(tokens.idToken)) {
    try {
      const refreshed = await refreshTokens();
      if (!refreshed) {
        console.error('⚠️  Periodic token refresh failed - account credentials may be invalid');
      }
    } catch (error) {
      console.error('❌ Error in periodic token refresh:', error.message);
    }
  }
}, 50 * 60 * 1000);

// Initialize token check on startup
setTimeout(async () => {
  console.log('🔍 Initial token validation...');
  if (isTokenExpired(tokens.idToken) || !tokens.idToken || tokens.idToken.trim() === '') {
    console.log('⚠️  Token expired or missing, refreshing now...');
    try {
      const refreshed = await refreshTokens();
      if (!refreshed) {
        console.error('⚠️  Initial token refresh failed - please check account credentials');
      }
    } catch (error) {
      console.error('❌ Error in initial token refresh:', error.message);
    }
  } else {
    try {
      const tokenParts = tokens.idToken.split('.');
      if (tokenParts.length === 3) {
        const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
        const minutesLeft = Math.floor((payload.exp * 1000 - Date.now()) / 60000);
        console.log('✅ Token valid for', minutesLeft, 'minutes');
      } else {
        console.log('⚠️  Invalid token format');
      }
    } catch (error) {
      console.log('⚠️  Invalid token format');
    }
  }
}, 5000);

// ==================== 2CAPTCHA INTEGRATION ====================
// Function to solve Cloudflare Turnstile using 2Captcha API
async function solveTurnstileCaptcha() {
  try {
    console.log('🧩 Solving Cloudflare Turnstile with 2Captcha...');
    console.log('⏳ This may take 10-30 seconds...');
    
    // Submit the task directly to 2Captcha API
    const submitResponse = await axios.post(
      'https://2captcha.com/in.php',
      null,
      {
        params: {
          key: process.env.CAPTCHA_API_KEY,
          method: 'turnstile',
          sitekey: '0x4AAAAAAATLZS5RyqlMGxsL',
          pageurl: 'https://www.wolvesville.com',
          json: 1
        }
      }
    );
    
    if (submitResponse.data.status !== 1) {
      throw new Error(submitResponse.data.request || 'Failed to submit captcha');
    }
    
    const taskId = submitResponse.data.request;
    console.log(`📋 Task ID: ${taskId}`);
    console.log('⏳ Waiting for solution...');
    
    // Poll for result (max 30 attempts, 3 seconds each = 90 seconds max)
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds
      
      const resultResponse = await axios.get(
        'https://2captcha.com/res.php',
        {
          params: {
            key: process.env.CAPTCHA_API_KEY,
            action: 'get',
            id: taskId,
            json: 1
          }
        }
      );
      
      if (resultResponse.data.status === 1) {
        console.log('✅ Captcha solved successfully!');
        return resultResponse.data.request;
      }
      
      if (resultResponse.data.request !== 'CAPCHA_NOT_READY') {
        throw new Error(resultResponse.data.request || 'Unknown error');
      }
      
      console.log(`⏳ Still solving... (${i + 1}/30)`);
    }
    
    throw new Error('Timeout waiting for captcha solution');
    
  } catch (error) {
    console.error('❌ Error solving captcha:', error.message);
    return null;
  }
}

// Function to get fresh cf-jwt using solved captcha
async function refreshCfJwt() {
  let turnstileToken = null;
  
  try {
    console.log('🔐 Refreshing Cloudflare JWT...');
    
    // First solve the captcha
    turnstileToken = await solveTurnstileCaptcha();
    
    if (!turnstileToken) {
      console.error('❌ Failed to solve captcha');
      return false;
    }
    
    console.log('🔑 Turnstile token obtained, verifying...');
    
    // Build request body - only include idToken if it's valid
    const requestBody = {
      token: turnstileToken,
      siteKey: '0x4AAAAAAATLZS5RyqlMGxsL'
    };
    
    // Only include idToken if it exists and is not obviously invalid
    const hasValidIdToken = tokens.idToken && tokens.idToken.trim() !== '' && tokens.idToken.length > 50;
    if (hasValidIdToken) {
      requestBody.idToken = tokens.idToken;
    }
    
    // Now verify it to get cf-jwt
    const response = await axios.post(
      'https://auth.api-wolvesville.com/cloudflareTurnstile/verify',
      requestBody,
      {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Origin': 'https://www.wolvesville.com',
          'Referer': 'https://www.wolvesville.com/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
        }
      }
    );
    
    if (response.data && response.data.jwt) {
      tokens.cfJwt = response.data.jwt;
      console.log('✅ Cloudflare JWT obtained');
      console.log('📝 New cf-jwt:', tokens.cfJwt.substring(0, 30) + '...');
      saveAccounts(); // Save to accounts.json
      updateEnvFile(); // Also update .env
      return true;
    }
    
    console.error('❌ No JWT in response:', response.data);
    return false;
  } catch (error) {
    console.error('❌ Error refreshing cf-jwt:', error.response?.data || error.message);
    
    // If 500 error and we included idToken, try without it
    if (error.response?.status === 500 && hasValidIdToken && turnstileToken) {
      console.log('🔄 Retrying without idToken...');
      try {
        const retryBody = {
          token: turnstileToken,
          siteKey: '0x4AAAAAAATLZS5RyqlMGxsL'
        };
        
        const retryResponse = await axios.post(
          'https://auth.api-wolvesville.com/cloudflareTurnstile/verify',
          retryBody,
          {
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Origin': 'https://www.wolvesville.com',
              'Referer': 'https://www.wolvesville.com/',
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
            }
          }
        );
        
        if (retryResponse.data && retryResponse.data.jwt) {
          tokens.cfJwt = retryResponse.data.jwt;
          console.log('✅ Cloudflare JWT obtained (without idToken)');
          console.log('📝 New cf-jwt:', tokens.cfJwt.substring(0, 30) + '...');
          saveAccounts();
          updateEnvFile();
          return true;
        }
      } catch (retryError) {
        console.error('❌ Retry also failed:', retryError.response?.data || retryError.message);
      }
    }
    
    return false;
  }
}

// ==================== STATISTICS ====================
let stats = {
  daily: { date: new Date().toDateString(), gems: 0, transactions: 0 },
  weekly: { week: getWeekNumber(), gems: 0, transactions: 0 },
  monthly: { month: new Date().getMonth(), gems: 0, transactions: 0 }
};

function getWeekNumber() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function loadStats() {
  try {
    const data = fs.readFileSync(path.join(botDir, 'stats.json'), 'utf8');
    const loaded = JSON.parse(data);
    
    if (loaded.daily.date !== new Date().toDateString()) {
      stats.daily = { date: new Date().toDateString(), gems: 0, transactions: 0 };
    } else {
      stats.daily = loaded.daily;
    }
    
    if (loaded.weekly.week !== getWeekNumber()) {
      stats.weekly = { week: getWeekNumber(), gems: 0, transactions: 0 };
    } else {
      stats.weekly = loaded.weekly;
    }
    
    if (loaded.monthly.month !== new Date().getMonth()) {
      stats.monthly = { month: new Date().getMonth(), gems: 0, transactions: 0 };
    } else {
      stats.monthly = loaded.monthly;
    }
    
    console.log('📊 Statistics loaded');
  } catch (error) {
    console.log('📝 Creating stats.json file');
    saveStats();
  }
}

function saveStats() {
  fs.writeFileSync(path.join(botDir, 'stats.json'), JSON.stringify(stats, null, 2));
}

function addTransaction(gems) {
  stats.daily.gems += gems;
  stats.daily.transactions += 1;
  stats.weekly.gems += gems;
  stats.weekly.transactions += 1;
  stats.monthly.gems += gems;
  stats.monthly.transactions += 1;
  saveStats();
}

// ==================== BALANCES ====================
let balances = { users: {}, totalGems: 0 };

function loadBalances() {
  try {
    const data = fs.readFileSync(path.join(botDir, 'balances.json'), 'utf8');
    const loaded = JSON.parse(data);
    
    // Migrate old format to new format
    if (loaded.totalGems === undefined) {
      balances = { users: loaded, totalGems: 0 };
      console.log('📝 Migrating balances.json format to new format');
      saveBalances();
    } else {
      balances = loaded;
    }
    
    console.log('💰 Balances loaded:', Object.keys(balances.users).length, 'users');
    console.log('💎 Total gems available:', balances.totalGems);
  } catch (error) {
    console.log('📝 Creating balances.json file');
    balances = { users: {}, totalGems: 0 };
    saveBalances();
  }
}

function saveBalances() {
  fs.writeFileSync(path.join(botDir, 'balances.json'), JSON.stringify(balances, null, 2));
}

function getBalance(userId) {
  return balances.users[userId] || 0;
}

function getTotalGems() {
  return balances.totalGems || 0;
}

function addBalance(userId, amount) {
  balances.users[userId] = (balances.users[userId] || 0) + amount;
  saveBalances();
  return balances.users[userId];
}

function removeBalance(userId, amount) {
  balances.users[userId] = (balances.users[userId] || 0) - amount;
  if (balances.users[userId] < 0) balances.users[userId] = 0;
  saveBalances();
  return balances.users[userId];
}

function addTotalGems(amount) {
  balances.totalGems = (balances.totalGems || 0) + amount;
  if (balances.totalGems < 0) balances.totalGems = 0;
  saveBalances();
  return balances.totalGems;
}

function removeTotalGems(amount) {
  balances.totalGems = (balances.totalGems || 0) - amount;
  if (balances.totalGems < 0) balances.totalGems = 0;
  saveBalances();
  return balances.totalGems;
}

function setTotalGems(amount) {
  balances.totalGems = Math.max(0, amount);
  saveBalances();
  return balances.totalGems;
}

// ==================== LOGS ====================
// Cache channels for single-server optimization
let logChannel = null;
let giftChannel = null;

async function getLogChannel() {
  if (!logChannel) {
    logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
  }
  return logChannel;
}

async function getGiftChannel() {
  if (!giftChannel) {
    giftChannel = await client.channels.fetch(process.env.GIFT_CHANNEL_ID);
  }
  return giftChannel;
}

async function sendLog(embed) {
  try {
    const channel = await getLogChannel();
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('❌ Error sending log:', error.message);
    // Reset cache on error
    logChannel = null;
  }
}

// ==================== GIFTS AND CALENDARS ====================
let giftsData = { items: [] };
let calendarsData = { calendars: [] };

function loadGiftsAndCalendars() {
  try {
    giftsData = JSON.parse(fs.readFileSync(path.join(botDir, 'gifts.json'), 'utf8'));
    console.log(`🎁 ${giftsData.items.length} items loaded`);
  } catch (error) {
    console.error('❌ Error loading gifts.json:', error.message);
  }
  
  try {
    calendarsData = JSON.parse(fs.readFileSync(path.join(botDir, 'calendars.json'), 'utf8'));
    console.log(`📅 ${calendarsData.calendars.length} calendars loaded`);
  } catch (error) {
    console.error('❌ Error loading calendars.json:', error.message);
  }
}

function saveGifts() {
  try {
    fs.writeFileSync(path.join(botDir, 'gifts.json'), JSON.stringify(giftsData, null, 2));
    console.log('💾 gifts.json saved');
    return true;
  } catch (error) {
    console.error('❌ Error saving gifts.json:', error.message);
    return false;
  }
}

// ==================== DAILY ROTATING SKINS (daily_skins.json) ====================
async function fetchAndUpdateDailySkins() {
  try {
    console.log('🔁 Fetching rotating limited offers for daily skins...');

    // Build headers using current tokens when available
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://www.wolvesville.com',
      'Referer': 'https://www.wolvesville.com/'
    };

    if (tokens.idToken) headers['Authorization'] = `Bearer ${tokens.idToken}`;
    if (tokens.cfJwt) headers['Cf-JWT'] = tokens.cfJwt;

    const resp = await axios.get('https://core.api-wolvesville.com/billing/rotatingLimitedOffers/v2', { headers });

    const offers = resp.data?.offers || [];

    const dailySkins = [];
    const seenTypes = new Set();

    for (const offer of offers) {
      if (!offer.itemSets || !Array.isArray(offer.itemSets)) continue;

      // Use offer.type as the identifier for matching gifts.json entries
      if (seenTypes.has(offer.type)) continue;

      // Take first itemSet as representative
      const itemSet = offer.itemSets[0];
      if (!itemSet) continue;

      const imageName = itemSet.imageName || itemSet.id || offer.type;
      const imageUrl = `https://cdn2.wolvesville.com/promos/${imageName}@2x.jpg`;

      dailySkins.push({
        id: itemSet.id || offer.type,
        offerType: offer.type,
        imageName,
        imageUrl,
        price: 380,
        expireDate: offer.expireDate || null
      });

      seenTypes.add(offer.type);
      if (dailySkins.length >= 4) break;
    }

    // Write daily_skins.json (overwrite)
    fs.writeFileSync(path.join(botDir, 'daily_skins.json'), JSON.stringify({ date: new Date().toISOString(), skins: dailySkins }, null, 2));
    console.log(`💾 daily_skins.json written (${dailySkins.length} skins)`);

    // Update giftsData: set enabled=true for skin_set items that match offer types
    let changed = false;
    for (const skin of dailySkins) {
      const match = giftsData.items.find(i => i.type === skin.offerType);
      if (match && !match.enabled) {
        match.enabled = true;
        changed = true;
      }
    }

    if (changed) {
      saveGifts();
      // reload in-memory data to be safe
      loadGiftsAndCalendars();
    }

    // Log to configured channel if available
    try {
      const embed = new EmbedBuilder()
        .setTitle('🔁 Daily Skins Updated')
        .setDescription(`Fetched ${dailySkins.length} daily skins`)
        .setColor('#00FFFF')
        .setTimestamp();

      dailySkins.forEach(s => embed.addFields({ name: s.offerType, value: s.imageUrl }));
      await sendLog(embed);
    } catch (err) {
      console.log('ℹ️  Could not send daily skins log (log channel may be missing)');
    }

    return dailySkins;
  } catch (error) {
    console.error('❌ Error fetching rotating offers:', error.response?.data || error.message);
    return [];
  }
}

function scheduleDailySkins() {
  // Calculate next 03:00 local time
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  const delay = next - now;
  console.log(`⏳ Scheduling next daily skin update in ${Math.round(delay / 1000 / 60)} minutes`);

  setTimeout(async function runAndSchedule() {
    try {
      await fetchAndUpdateDailySkins();
    } catch (e) {
      console.error('❌ Error in scheduled daily skins update:', e.message);
    }
    // schedule next in 24h
    setTimeout(runAndSchedule, 24 * 3600 * 1000);
  }, delay);
}

function loadDailySkins() {
  try {
    const data = fs.readFileSync(path.join(botDir, 'daily_skins.json'), 'utf8');
    const parsed = JSON.parse(data);
    return parsed.skins || [];
  } catch (err) {
    return [];
  }
}

function formatGiftName(type) {
  return type
    .replace(/_/g, ' ')
    .replace(/V2/g, '')
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getCategoryEmoji(category) {
  const emojis = {
    'skin_set': '👗',
    'lootbox': '🎁',
    'coins': '🪙',
    'bpcoins': '🎫',
    'xpbooster': '⚡',
    'calendar': '📅',
    'rolecards': '🎴',
    'premium': '👑',
    'emote': '😀'
  };
  return emojis[category] || '📦';
}

function getHeaders() {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${tokens.idToken}`,
    'Cf-JWT': tokens.cfJwt,
    'ids': '1'
  };
}

// ==================== API WOLVESVILLE ====================
async function searchPlayer(username, retryCount = 0) {
  try {
    // Check and refresh tokens before making the request
    if (isTokenExpired(tokens.idToken)) {
      await refreshTokens();
    }
    
    const response = await axios.get(
      `https://core.api-wolvesville.com/players/search?username=${encodeURIComponent(username)}`,
      { headers: getHeaders() }
    );
    
    if (response.data && response.data.length > 0) {
      return response.data[0];
    }
    return null;
  } catch (error) {
    // If authentication error and we haven't retried yet, force refresh and retry
    if ((error.response?.status === 401 || error.response?.status === 403) && retryCount === 0) {
      console.log('🔄 Authentication failed, forcing token refresh...');
      const refreshed = await refreshTokens();
      
      if (refreshed) {
        return searchPlayer(username, 1);
      }
    }
    
    console.error('❌ Error searching player:', error.response?.data || error.message);
    throw error;
  }
}

// Get current account's gem count from accounts.json
function getAccountGemCount(accountName = null) {
  const account = accountName || accounts.current;
  if (accounts.accounts[account]) {
    return accounts.accounts[account].gemCount || 0;
  }
  return 0;
}

// Set account gem count (sync with API response)
function setAccountGems(gemCount, accountName = null) {
  const account = accountName || accounts.current;
  if (accounts.accounts[account]) {
    accounts.accounts[account].gemCount = gemCount;
    saveAccounts();
    return gemCount;
  }
  return 0;
}

// Remove gems from an account after purchase
function removeAccountGems(amount, accountName = null) {
  const account = accountName || accounts.current;
  if (accounts.accounts[account]) {
    const currentGems = accounts.accounts[account].gemCount || 0;
    accounts.accounts[account].gemCount = Math.max(0, currentGems - amount);
    saveAccounts();
    return accounts.accounts[account].gemCount;
  }
  return 0;
}

async function sendGift(playerId, giftType, message, calendarId = null, retryCount = 0, accountSwitchRetry = false) {
  try {
    // Check and refresh tokens before making the request
    if (isTokenExpired(tokens.idToken)) {
      await refreshTokens();
    }
    
    const gift = giftsData.items.find(g => g.type === giftType) || calendarsData.calendars.find(c => c.id === calendarId);
    // Safety: prevent sending XP Boosters
    if (gift && gift.category === 'xpbooster') {
      const err = new Error('XP Boosters cannot be gifted');
      err.statusCode = 400;
      throw err;
    }
    const cost = gift ? gift.cost : 0;
    
    const body = {
      type: giftType,
      giftRecipientId: playerId,
      giftMessage: message || 'Have fun by Deykows!'
    };
    
    if (calendarId) {
      body.calendarId = calendarId;
    }
    
    let response;
    try {
      response = await axios.post(
      'https://core.api-wolvesville.com/gemOffers/purchases',
      body,
      { headers: getHeaders() }
    );
    } catch (apiError) {
      // If API error is due to insufficient gems and we haven't tried switching yet
      if ((apiError.response?.status === 400 || apiError.response?.status === 403) && 
          !accountSwitchRetry && 
          (apiError.response?.data?.message?.toLowerCase().includes('insufficient') || 
           apiError.response?.data?.message?.toLowerCase().includes('gem'))) {
        
        console.log(`⚠️  Current account (${accounts.current}) has insufficient gems. Attempting to switch accounts...`);
        
        // Try to switch to another account
        const availableAccounts = Object.keys(accounts.accounts).filter(name => name !== accounts.current);
        let switched = false;
        
        for (const accountName of availableAccounts) {
          try {
            switchAccount(accountName);
            await refreshTokens(); // Refresh tokens for new account
            console.log(`✅ Switched to account ${accountName}, retrying purchase...`);
            switched = true;
            break;
          } catch (switchError) {
            console.error(`❌ Error switching to account ${accountName}:`, switchError.message);
          }
        }
        
        if (switched) {
          // Retry with new account
          return sendGift(playerId, giftType, message, calendarId, 0, true);
        } else {
          throw new Error(`Insufficient gems on all accounts. Could not complete purchase.`);
        }
      }
      
      // Re-throw if it's not an insufficient gems error or we've already tried switching
      throw apiError;
    }
    
    // Extract actual gem count from API response
    const actualGemCount = response.data?.gemCount;
    
    if (actualGemCount !== undefined && actualGemCount !== null) {
      // Sync with actual gem count from API
      const storedGems = getAccountGemCount();
      if (actualGemCount !== storedGems) {
        console.log(`🔄 Syncing gem count: ${storedGems} → ${actualGemCount} (from API)`);
        setAccountGems(actualGemCount);
      }
    } else {
      // Fallback: deduct manually if API doesn't return gem count
      const currentGems = getAccountGemCount();
      const newAccountGems = removeAccountGems(cost);
      console.log(`💎 Account ${accounts.current} gems: ${currentGems} → ${newAccountGems} (manual deduction)`);
    }
    
    console.log('✅ Gift sent successfully');
    return { ...response.data, gemCount: actualGemCount || getAccountGemCount() };
  } catch (error) {
    // If authentication error and we haven't retried yet, force refresh and retry
    if ((error.response?.status === 401 || error.response?.status === 403) && retryCount === 0) {
      console.log('🔄 Authentication failed, forcing token refresh...');
      const refreshed = await refreshTokens();
      
      if (refreshed) {
        return sendGift(playerId, giftType, message, calendarId, 1, accountSwitchRetry);
      }
    }
    
    const errorData = error.response?.data || {};
    const errorMessage = errorData.message || error.message;
    
    console.error('❌ Error sending gift:', {
      giftType,
      playerId,
      error: errorMessage,
      fullError: errorData
    });
    
    // Create a more user-friendly error
    const friendlyError = new Error(errorMessage);
    friendlyError.giftType = giftType;
    friendlyError.statusCode = error.response?.status;
    throw friendlyError;
  }
}

// ==================== COMMANDS ====================
const commands = [
  {
    name: 'add-gems',
    description: 'Add gems (Admin)',
    options: [
      { name: 'user', type: 6, description: 'User', required: true },
      { name: 'amount', type: 4, description: 'Number of gems', required: true, min_value: 1 }
    ]
  },
  {
    name: 'remove-gems',
    description: 'Remove gems (Admin)',
    options: [
      { name: 'user', type: 6, description: 'User', required: true },
      { name: 'amount', type: 4, description: 'Number of gems', required: true, min_value: 1 }
    ]
  },
  {
    name: 'set-gems',
    description: 'Set balance (Admin)',
    options: [
      { name: 'user', type: 6, description: 'User', required: true },
      { name: 'amount', type: 4, description: 'Number of gems', required: true, min_value: 0 }
    ]
  },
  {
    name: 'check-balance',
    description: 'Check balance',
    options: [
      { name: 'user', type: 6, description: 'User (empty = yourself)', required: false }
    ]
  },
  {
    name: 'stats',
    description: 'View statistics'
  },
  {
    name: 'setup-gift',
    description: 'Setup the system (Admin)'
  },
  {
    name: 'reload-gifts',
    description: 'Reload gifts.json and calendars.json (Admin)'
  },
  {
    name: 'lookup-player',
    description: 'Search for a Wolvesville player',
    options: [
      { name: 'username', type: 3, description: 'Player username', required: true }
    ]
  },
  {
    name: 'set-total-gems',
    description: 'Set total gems available (Admin)',
    options: [
      { name: 'amount', type: 4, description: 'Number of gems', required: true, min_value: 0 }
    ]
  },
  {
    name: 'add-total-gems',
    description: 'Add gems to total (Admin)',
    options: [
      { name: 'amount', type: 4, description: 'Number of gems', required: true, min_value: 1 }
    ]
  },
  {
    name: 'refresh-tokens',
    description: 'Manually refresh Wolvesville tokens (Admin)'
  },
  {
    name: 'add-account',
    description: 'Add a new Wolvesville account (Admin)',
    options: [
      { name: 'email', type: 3, description: 'Wolvesville email', required: true },
      { name: 'password', type: 3, description: 'Wolvesville password', required: true },
      { name: 'name', type: 3, description: 'Account name/identifier', required: true }
    ]
  },
  {
    name: 'set-skin',
    description: 'Enable/disable a skin in gifts.json (Admin)',
    options: [
      { name: 'type', type: 3, description: 'Gift type identifier (type)', required: true },
      { name: 'enabled', type: 5, description: 'Enable (true) or disable (false)', required: true }
    ]
  },
  {
    name: 'list-accounts',
    description: 'List all Wolvesville accounts (Admin)'
  },
  {
    name: 'switch-account',
    description: 'Switch to a different Wolvesville account (Admin)',
    options: [
      { name: 'name', type: 3, description: 'Account name', required: true }
    ]
  },
  {
    name: 'remove-account',
    description: 'Remove a Wolvesville account (Admin)',
    options: [
      { name: 'name', type: 3, description: 'Account name', required: true }
    ]
  },
  {
    name: 'reload-commands',
    description: 'Re-register all slash commands (Admin)'
  }
];

// ==================== EVENTS ====================
client.once('clientReady', async () => {
  console.log(`✅ Bot connected: ${client.user.tag}`);
  console.log(`📅 Started on ${new Date().toLocaleString('en-US')}`);
  
  client.user.setStatus('online');
  client.user.setActivity('Gifting people', { type: ActivityType.Playing });
  
  loadBalances();
  loadAccounts();
  loadStats();
  loadGiftsAndCalendars();
  // Fetch today's rotating skins immediately and schedule daily updates at 03:00
  try {
    await fetchAndUpdateDailySkins();
    scheduleDailySkins();
  } catch (err) {
    console.error('❌ Error initializing daily skins:', err.message);
  }
  
  // Pre-cache channels for single-server optimization
  if (process.env.LOG_CHANNEL_ID) {
    getLogChannel().catch(() => {}); // Pre-fetch in background
  }
  if (process.env.GIFT_CHANNEL_ID) {
    getGiftChannel().catch(() => {}); // Pre-fetch in background
  }
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  // Get guild ID from environment (required for single-server setup)
  const guildId = process.env.GUILD_ID;
  
  if (!guildId) {
    console.error('❌ GUILD_ID is required in .env file for single-server setup!');
    console.error('💡 Get your server ID: Right-click server → Copy Server ID (Developer Mode must be enabled)');
    process.exit(1);
  }
  
  try {
    // First, clear global commands to prevent duplicates
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
        { body: [] }
      );
      console.log('✅ Global commands cleared');
    } catch (clearError) {
      console.log('ℹ️  No global commands to clear (or already cleared)');
    }
    
    // Register commands to the guild (instant availability, no sync delay)
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: commands }
    );
    console.log(`✅ Commands registered to guild (${commands.length} commands, instant availability)`);
    console.log(`📋 All commands available immediately:\n   - /add-account\n   - /list-accounts\n   - /switch-account\n   - /remove-account\n   - /reload-commands\n   - And ${commands.length - 5} other commands`);
  } catch (error) {
    console.error('❌ Error registering commands:', error);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
      if (error.response.status === 404) {
        console.error('💡 Make sure GUILD_ID is correct and the bot is in the server!');
      }
    }
  }
  
  const startEmbed = new EmbedBuilder()
    .setTitle('🚀 Bot Started')
    .setDescription(
      `**Statistics**:\n` +
      `📊 Today: ${stats.daily.gems} 💎 (${stats.daily.transactions} transactions)\n` +
      `📅 Week: ${stats.weekly.gems} 💎 (${stats.weekly.transactions} transactions)\n` +
      `📆 Month: ${stats.monthly.gems} 💎 (${stats.monthly.transactions} transactions)`
    )
    .setColor('#00FF00')
    .setTimestamp();
  
  await sendLog(startEmbed);
  
  console.log('\n🚀 Bot ready!');
});

client.on('interactionCreate', async interaction => {
  
  if (interaction.isCommand()) {
    const { commandName, member } = interaction;
    const isAdmin = member.roles.cache.has(process.env.ADMIN_ROLE_ID);
    
    if (commandName === 'add-gems') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      const user = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const newBalance = addBalance(user.id, amount);
      
      const embed = new EmbedBuilder()
        .setTitle('💎 Gems Added')
        .setDescription(`✅ **${amount} gems** added to ${user}\n\n**New balance**: ${newBalance} 💎`)
        .setColor('#00FF00')
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      
      const logEmbed = new EmbedBuilder()
        .setTitle('💎 Gems Added')
        .setDescription(`**Admin**: ${interaction.user.tag}\n**User**: ${user.tag}\n**Amount**: +${amount} 💎\n**New balance**: ${newBalance} 💎`)
        .setColor('#00FF00')
        .setTimestamp();
      
      await sendLog(logEmbed);
    }
    
    if (commandName === 'remove-gems') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      const user = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const oldBalance = getBalance(user.id);
      const newBalance = removeBalance(user.id, amount);
      
      const embed = new EmbedBuilder()
        .setTitle('💎 Gems Removed')
        .setDescription(`✅ **${amount} gems** removed from ${user}\n\n**Old balance**: ${oldBalance} 💎\n**New balance**: ${newBalance} 💎`)
        .setColor('#FF6B6B')
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      
      const logEmbed = new EmbedBuilder()
        .setTitle('💎 Gems Removed')
        .setDescription(`**Admin**: ${interaction.user.tag}\n**User**: ${user.tag}\n**Amount**: -${amount} 💎\n**New balance**: ${newBalance} 💎`)
        .setColor('#FF6B6B')
        .setTimestamp();
      
      await sendLog(logEmbed);
    }
    
    if (commandName === 'set-gems') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      const user = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const oldBalance = getBalance(user.id);
      balances.users[user.id] = amount;
      saveBalances();
      
      const embed = new EmbedBuilder()
        .setTitle('💎 Balance Set')
        .setDescription(`✅ Balance of ${user} set to **${amount} gems**\n\n**Old balance**: ${oldBalance} 💎\n**New balance**: ${amount} 💎`)
        .setColor('#4CAF50')
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      
      const logEmbed = new EmbedBuilder()
        .setTitle('💎 Balance Set')
        .setDescription(`**Admin**: ${interaction.user.tag}\n**User**: ${user.tag}\n**Old balance**: ${oldBalance} 💎\n**New balance**: ${amount} 💎`)
        .setColor('#4CAF50')
        .setTimestamp();
      
      await sendLog(logEmbed);
    }
    
    if (commandName === 'check-balance') {
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const balance = getBalance(targetUser.id);
      const totalGems = getTotalGems();
      
      const embed = new EmbedBuilder()
        .setTitle('💎 Balance')
        .setDescription(
          (targetUser.id === interaction.user.id 
            ? `Your balance: **${balance} gems** 💎\n`
            : `Balance of ${targetUser}: **${balance} gems** 💎\n`) +
          `\n💎 **Total gems available on the bot**: ${totalGems}`
        )
        .setColor('#4CAF50')
        .setThumbnail(targetUser.displayAvatarURL())
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    
    if (commandName === 'lookup-player') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      const username = interaction.options.getString('username').trim();
      
      try {
        const player = await searchPlayer(username);
        
        if (!player) {
          return interaction.editReply(`❌ Joueur **${username}** introuvable !`);
        }
        
        const embed = new EmbedBuilder()
          .setTitle(`👤 ${player.username}`)
          .setDescription(
            `**ID**: ${player.id}\n` +
            `**Level**: ${player.level || 'N/A'}`
          )
          .setColor('#4CAF50')
          .setTimestamp();
        
        if (player.avatarUrl) {
          embed.setThumbnail(player.avatarUrl);
        }
        
        await interaction.editReply({ embeds: [embed] });
        
      } catch (error) {
        await interaction.editReply(`❌ Error: ${error.message}`);
      }
    }
    
    if (commandName === 'set-total-gems') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      const amount = interaction.options.getInteger('amount');
      const oldTotal = getTotalGems();
      const newTotal = setTotalGems(amount);
      
      const embed = new EmbedBuilder()
        .setTitle('💎 Total Gems Set')
        .setDescription(`✅ Total gems set to **${newTotal} gems**\n\n**Old total**: ${oldTotal} 💎\n**New total**: ${newTotal} 💎`)
        .setColor('#4CAF50')
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      
      const logEmbed = new EmbedBuilder()
        .setTitle('💎 Total Gems Set')
        .setDescription(`**Admin**: ${interaction.user.tag}\n**Old total**: ${oldTotal} 💎\n**New total**: ${newTotal} 💎`)
        .setColor('#4CAF50')
        .setTimestamp();
      
      await sendLog(logEmbed);
    }
    
    if (commandName === 'add-total-gems') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      const amount = interaction.options.getInteger('amount');
      const oldTotal = getTotalGems();
      const newTotal = addTotalGems(amount);
      
      const embed = new EmbedBuilder()
        .setTitle('💎 Gems Added to Total')
        .setDescription(`✅ **${amount} gems** added to total\n\n**Old total**: ${oldTotal} 💎\n**New total**: ${newTotal} 💎`)
        .setColor('#00FF00')
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      
      const logEmbed = new EmbedBuilder()
        .setTitle('💎 Gems Added to Total')
        .setDescription(`**Admin**: ${interaction.user.tag}\n**Amount**: +${amount} 💎\n**Old total**: ${oldTotal} 💎\n**New total**: ${newTotal} 💎`)
        .setColor('#00FF00')
        .setTimestamp();
      
      await sendLog(logEmbed);
    }
    
    if (commandName === 'stats') {
      const embed = new EmbedBuilder()
        .setTitle('📊 Spending Statistics')
        .addFields(
          {
            name: '📊 Today',
            value: `**${stats.daily.gems} 💎** spent\n**${stats.daily.transactions}** transactions`,
            inline: true
          },
          {
            name: '📅 This Week',
            value: `**${stats.weekly.gems} 💎** spent\n**${stats.weekly.transactions}** transactions`,
            inline: true
          },
          {
            name: '📆 This Month',
            value: `**${stats.monthly.gems} 💎** spent\n**${stats.monthly.transactions}** transactions`,
            inline: true
          }
        )
        .setColor('#4CAF50')
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], ephemeral: false });
    }
    
    if (commandName === 'setup-gift') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        
        const channel = await getGiftChannel();
        // Ensure latest gifts/calendars loaded
        loadGiftsAndCalendars();
        
        const embed = new EmbedBuilder()
          .setTitle('🎁 Wolvesville Gift System')
          .setDescription(
            '**Welcome to the gift system!**\n\n' +
            '💎 **Balance**: Check your gem balance\n' +
            '🎁 **Gifts**: Choose a gift category\n\n' +
            `✅ **${giftsData.items.filter(i => i.enabled).length} gifts** and **${calendarsData.calendars.filter(c => c.enabled).length} calendars** available`
          )
          .setColor('#FF4081')
          .setTimestamp();
        
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('check_balance')
              .setLabel('💎 Balance')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('send_gift')
              .setLabel('🎁 Gifts')
              .setStyle(ButtonStyle.Success)
          );
        
        await channel.send({ embeds: [embed], components: [row] });
        await interaction.editReply({ content: '✅ Message sent!' });
        
      } catch (error) {
        await interaction.editReply({ content: `❌ Error: ${error.message}` });
      }
    }
    
    if (commandName === 'reload-gifts') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      loadGiftsAndCalendars();
      await interaction.reply({ content: `✅ Reloaded!\n🎁 ${giftsData.items.length} items\n📅 ${calendarsData.calendars.length} calendars`, flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'refresh-tokens') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      try {
        console.log('🔄 Manual token refresh requested by', interaction.user.tag);
        const success = await refreshTokens();
        
        if (success) {
          const embed = new EmbedBuilder()
            .setTitle('✅ Tokens Refreshed')
            .setDescription(
              `**Account**: ${accounts.current}\n` +
              `**Status**: Successfully refreshed\n` +
              `**idToken**: ${tokens.idToken.substring(0, 30)}...\n` +
              `**Tokens saved**: accounts.json & .env`
            )
            .setColor('#00FF00')
            .setTimestamp();
          
          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.editReply('❌ Failed to refresh tokens. Check console for details.');
        }
      } catch (error) {
        await interaction.editReply(`❌ Error: ${error.message}`);
      }
    }
    
    if (commandName === 'add-account') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      const name = interaction.options.getString('name');
      const email = interaction.options.getString('email');
      const password = interaction.options.getString('password');
      
      try {
        if (accounts.accounts[name]) {
          return interaction.editReply(`❌ Account '${name}' already exists!`);
        }
        
        addAccount(name, email, password);
      
      const embed = new EmbedBuilder()
          .setTitle('✅ Account Added')
          .setDescription(
            `**Name**: ${name}\n` +
            `**Email**: ${email}\n` +
            `**Status**: Account saved\n\n` +
            `💡 Use \`/switch-account name:${name}\` to switch to this account`
          )
          .setColor('#00FF00')
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        
        const logEmbed = new EmbedBuilder()
          .setTitle('👥 Account Added')
          .setDescription(`**Admin**: ${interaction.user.tag}\n**Account**: ${name}\n**Email**: ${email}`)
          .setColor('#00FF00')
          .setTimestamp();
        
        await sendLog(logEmbed);
        
      } catch (error) {
        await interaction.editReply(`❌ Error: ${error.message}`);
      }
    }

    if (commandName === 'set-skin') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });

      const type = interaction.options.getString('type').trim();
      const enabled = interaction.options.getBoolean('enabled');

      try {
        const gift = giftsData.items.find(g => g.type === type);
        if (!gift) return interaction.reply({ content: `❌ Skin type not found: ${type}`, flags: MessageFlags.Ephemeral });
        if (gift.category !== 'skin_set') return interaction.reply({ content: `❌ This command only works for skin_set items.`, flags: MessageFlags.Ephemeral });

        gift.enabled = !!enabled;
        const saved = saveGifts();
        if (!saved) return interaction.reply({ content: '❌ Failed to save gifts.json', flags: MessageFlags.Ephemeral });

        // Reload in-memory data
        loadGiftsAndCalendars();

        const embed = new EmbedBuilder()
          .setTitle('✅ Skin Updated')
          .setDescription(`**Type**: ${type}\n**Enabled**: ${gift.enabled}`)
          .setColor(gift.enabled ? '#00FF00' : '#FF6B6B')
          .setTimestamp();

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        const logEmbed = new EmbedBuilder()
          .setTitle('🔄 Skin Toggled')
          .setDescription(`**Admin**: ${interaction.user.tag}\n**Type**: ${type}\n**Enabled**: ${gift.enabled}`)
          .setColor('#00FF00')
          .setTimestamp();
        await sendLog(logEmbed);
      } catch (error) {
        await interaction.reply({ content: `❌ Error: ${error.message}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    if (commandName === 'list-accounts') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      const accountsList = listAccounts();
      
      let description = '';
      accountsList.forEach(acc => {
        const marker = acc.current ? '✅ **[ACTIVE]**' : '⚪';
        description += `${marker} **${acc.name}** - ${acc.email}\n`;
      });
      
      const embed = new EmbedBuilder()
        .setTitle('👥 Wolvesville Accounts')
        .setDescription(description || 'No accounts found')
        .setColor('#4CAF50')
        .setFooter({ text: `Total: ${accountsList.length} accounts` })
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    
    if (commandName === 'switch-account') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      const name = interaction.options.getString('name');
      
      try {
        if (!accounts.accounts[name]) {
          return interaction.editReply(`❌ Account '${name}' not found!`);
        }
        
        const oldAccount = accounts.current;
        const oldAccountData = { ...accounts.accounts[oldAccount] };
        
        // Switch account
        switchAccount(name);
        
        // Try to refresh tokens for new account if they're expired or invalid
        let tokenStatus = '✅ Valid';
        if (!tokens.idToken || tokens.idToken.trim() === '' || isTokenExpired(tokens.idToken)) {
          console.log('🔄 New account tokens expired or missing, attempting refresh...');
          
          try {
            const refreshed = await refreshTokens();
            
            if (!refreshed) {
              // Token refresh failed - switch back to previous account
              console.log('⚠️  Token refresh failed, switching back to previous account');
              switchAccount(oldAccount);
              
              const errorEmbed = new EmbedBuilder()
                .setTitle('❌ Account Switch Failed')
                .setDescription(
                  `**Attempted account**: ${name}\n` +
                  `**Email**: ${accounts.accounts[name]?.email || 'N/A'}\n` +
                  `**Error**: Failed to authenticate with this account\n\n` +
                  `**Reason**: Invalid credentials or account doesn't exist\n` +
                  `**Action**: Switched back to **${oldAccount}**`
                )
                .setColor('#FF0000')
                .setTimestamp();
              
              await interaction.editReply({ embeds: [errorEmbed] });
              
              const logEmbed = new EmbedBuilder()
                .setTitle('❌ Account Switch Failed')
                .setDescription(
                  `**Admin**: ${interaction.user.tag}\n` +
                  `**Attempted**: ${name}\n` +
                  `**Reason**: Invalid credentials`
                )
                .setColor('#FF0000')
                .setTimestamp();
              
              await sendLog(logEmbed);
              return;
            }
            
            tokenStatus = '✅ Valid (refreshed)';
          } catch (refreshError) {
            // Token refresh failed - switch back to previous account
            console.error('❌ Error refreshing tokens:', refreshError.message);
            switchAccount(oldAccount);
            
            const errorEmbed = new EmbedBuilder()
              .setTitle('❌ Account Switch Failed')
              .setDescription(
                `**Attempted account**: ${name}\n` +
                `**Email**: ${accounts.accounts[name]?.email || 'N/A'}\n` +
                `**Error**: ${refreshError.message || 'Failed to authenticate'}\n\n` +
                `**Action**: Switched back to **${oldAccount}**\n\n` +
                `💡 Please verify the account credentials are correct.`
              )
              .setColor('#FF0000')
              .setTimestamp();
            
            await interaction.editReply({ embeds: [errorEmbed] });
            
            const logEmbed = new EmbedBuilder()
              .setTitle('❌ Account Switch Failed')
              .setDescription(
                `**Admin**: ${interaction.user.tag}\n` +
                `**Attempted**: ${name}\n` +
                `**Error**: ${refreshError.message || 'Authentication failed'}`
              )
              .setColor('#FF0000')
              .setTimestamp();
            
            await sendLog(logEmbed);
            return;
          }
        }
        
        const embed = new EmbedBuilder()
          .setTitle('✅ Account Switched')
          .setDescription(
            `**Previous**: ${oldAccount}\n` +
            `**Current**: ${accounts.current}\n` +
            `**Email**: ${accounts.accounts[accounts.current].email}\n` +
            `**Token status**: ${tokenStatus}`
          )
          .setColor('#00FF00')
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        
        const logEmbed = new EmbedBuilder()
          .setTitle('🔄 Account Switched')
          .setDescription(`**Admin**: ${interaction.user.tag}\n**From**: ${oldAccount}\n**To**: ${name}`)
          .setColor('#FFA500')
          .setTimestamp();
        
        await sendLog(logEmbed);
        
      } catch (error) {
        await interaction.editReply(`❌ Error: ${error.message}`);
      }
    }
    
    if (commandName === 'remove-account') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      const name = interaction.options.getString('name');
      
      try {
        const email = accounts.accounts[name]?.email;
        removeAccount(name);
        
        const embed = new EmbedBuilder()
          .setTitle('✅ Account Removed')
          .setDescription(
            `**Name**: ${name}\n` +
            `**Email**: ${email}\n` +
            `**Status**: Removed from accounts.json`
          )
          .setColor('#FF6B6B')
          .setTimestamp();
        
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        
        const logEmbed = new EmbedBuilder()
          .setTitle('🗑️ Account Removed')
          .setDescription(`**Admin**: ${interaction.user.tag}\n**Account**: ${name}`)
          .setColor('#FF0000')
          .setTimestamp();
        
        await sendLog(logEmbed);
        
      } catch (error) {
        await interaction.reply({ content: `❌ Error: ${error.message}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    if (commandName === 'reload-commands') {
      if (!isAdmin) return interaction.reply({ content: '❌ Permission denied!', flags: MessageFlags.Ephemeral });
      
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const guildId = process.env.GUILD_ID || interaction.guildId;
        
        if (!guildId) {
          return interaction.editReply({ content: '❌ GUILD_ID not configured. Please set it in .env file.' });
        }
        
        // First, clear global commands to prevent duplicates
        try {
          await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [] }
          );
        } catch (clearError) {
          // Ignore errors when clearing (might not exist)
        }
        
        // Register to guild (instant availability)
        await rest.put(
          Routes.applicationGuildCommands(client.user.id, guildId),
          { body: commands }
        );
        
        await interaction.editReply({ 
          content: `✅ Commands re-registered!\n\n**Total commands**: ${commands.length}\n**Account commands**:\n- /add-account\n- /list-accounts\n- /switch-account\n- /remove-account\n- /reload-commands\n\n✅ Global commands cleared\n✅ Guild commands updated (instant availability)` 
        });
        
        const logEmbed = new EmbedBuilder()
          .setTitle('🔄 Commands Reloaded')
          .setDescription(`**Admin**: ${interaction.user.tag}\n**Commands**: ${commands.length} registered`)
          .setColor('#00FF00')
          .setTimestamp();
        
        await sendLog(logEmbed);
        
      } catch (error) {
        await interaction.editReply({ content: `❌ Error re-registering commands: ${error.message}` });
    }
    }
  }
  
  // ==================== BUTTONS ====================
  if (interaction.isButton()) {
    
    if (interaction.customId === 'check_balance') {
      const balance = getBalance(interaction.user.id);
      
      const embed = new EmbedBuilder()
        .setTitle('💎 Your Balance')
        .setDescription(`You have **${balance} gems** 💎`)
        .setColor('#4CAF50')
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    
    if (interaction.customId === 'send_gift') {
      const modal = new ModalBuilder()
        .setCustomId('gift_modal')
        .setTitle('🎁 Send a Gift');
      
      const usernameInput = new TextInputBuilder()
        .setCustomId('username')
        .setLabel('Wolvesville Username')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex: IBugs')
        .setRequired(true)
        .setMaxLength(20);
      
      const usernameConfirmInput = new TextInputBuilder()
        .setCustomId('username_confirm')
        .setLabel('Confirm username')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Retype the same username')
        .setRequired(true)
        .setMaxLength(20);
      
      const row1 = new ActionRowBuilder().addComponents(usernameInput);
      const row2 = new ActionRowBuilder().addComponents(usernameConfirmInput);
      
      modal.addComponents(row1, row2);
      
      await interaction.showModal(modal);
    }
    
    // Calendar selection button
    if (interaction.customId.startsWith('select_cal|')) {
      const parts = interaction.customId.split('|');
      const username = parts[1];
      const playerId = parts[2];
      const calendarId = parts[3];
      
      const calendar = calendarsData.calendars.find(c => c.id === calendarId);
      
      if (!calendar) {
        return interaction.reply({ content: `❌ Calendar not found`, flags: MessageFlags.Ephemeral });
      }
      
      const userBalance = getBalance(interaction.user.id);
      
      if (userBalance < calendar.cost) {
        return interaction.reply({ content: `❌ Insufficient balance!\n💎 Cost: ${calendar.cost} gems\n💰 Your balance: ${userBalance} gems`, flags: MessageFlags.Ephemeral });
      }
      
      // Check account gems and switch if needed
      let accountGems = getAccountGemCount();
      if (accountGems < calendar.cost) {
        // Try to switch to an account with enough gems
        const availableAccounts = Object.keys(accounts.accounts).filter(name => name !== accounts.current);
        let switched = false;
        
        for (const accountName of availableAccounts) {
          const newAccountGems = getAccountGemCount(accountName);
          if (newAccountGems >= calendar.cost) {
            try {
              switchAccount(accountName);
              await refreshTokens();
              console.log(`✅ Switched to account ${accountName} (${newAccountGems} gems) for calendar purchase`);
              switched = true;
              break;
            } catch (switchError) {
              console.error(`❌ Error switching to account ${accountName}:`, switchError.message);
            }
          }
        }
        
        if (!switched) {
          return interaction.reply({ content: `❌ Insufficient gems on all accounts!\n💎 Cost: ${calendar.cost} gems\n💰 Current account (${accounts.current}): ${accountGems} gems`, flags: MessageFlags.Ephemeral });
        }
      }
      
      // Show modal for personalized message
      const modal = new ModalBuilder()
        .setCustomId(`calendar_message|${username}|${playerId}|${calendarId}`)
        .setTitle('📅 Personalized Message');
        
      const messageInput = new TextInputBuilder()
        .setCustomId('gift_message')
        .setLabel('Message (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Leave empty to use default message')
        .setRequired(false)
        .setMaxLength(200);
      
      const row = new ActionRowBuilder().addComponents(messageInput);
      modal.addComponents(row);
        
      await interaction.showModal(modal);
    }
    
    
    // Calendar navigation
    if (interaction.customId.startsWith('cal_page_')) {
      const parts = interaction.customId.split('_');
      const page = parseInt(parts[2]);
      const username = parts[3];
      const playerId = parts[4];
      
      const userBalance = getBalance(interaction.user.id);
      const totalGems = getTotalGems();
      // Show all enabled calendars (do not filter by user's balance here)
      const enabledCalendars = calendarsData.calendars.filter(c => c.enabled);
      
      const itemsPerPage = 10;
      const totalPages = Math.ceil(enabledCalendars.length / itemsPerPage);
      const start = page * itemsPerPage;
      const end = start + itemsPerPage;
      const pageCalendars = enabledCalendars.slice(start, end);
      
      let description = `**Recipient**: ${username}\n**Your balance**: ${userBalance} 💎\n**Page**: ${page + 1}/${totalPages}\n\n`;
      
      pageCalendars.forEach((cal, idx) => {
        description += `**${start + idx + 1}.** ${cal.title} - **${cal.cost}💎**\n`;
      });
      
      const embed = new EmbedBuilder()
        .setTitle('📅 Available Calendars')
        .setDescription(description)
        .setColor('#4CAF50')
        .setTimestamp();
      
      // Create numbered buttons for calendars (max 10 per page)
      const rows = [];
      
      // Split buttons into rows of 5
      for (let i = 0; i < pageCalendars.length; i += 5) {
        const buttonRow = new ActionRowBuilder();
        for (let j = 0; j < 5 && i + j < pageCalendars.length; j++) {
          const idx = i + j;
          const cal = pageCalendars[idx];
          const calendarNum = start + idx + 1;
          
          buttonRow.addComponents(
            new ButtonBuilder()
              .setCustomId(`select_cal|${username}|${playerId}|${cal.id}`)
              .setLabel(`${calendarNum}`)
              .setStyle(ButtonStyle.Primary)
          );
        }
        rows.push(buttonRow);
      }
      
      // Navigation buttons
      const navRow = new ActionRowBuilder();
      
      if (page > 0) {
        navRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`cal_page_${page - 1}_${username}_${playerId}`)
            .setLabel('◀ Previous')
            .setStyle(ButtonStyle.Secondary)
        );
      }
      
      if (page < totalPages - 1) {
        navRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`cal_page_${page + 1}_${username}_${playerId}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
        );
      }
      
      if (navRow.components.length > 0) {
        rows.push(navRow);
      }
      
      await interaction.update({ embeds: [embed], components: rows });
    }

    // Gift page navigation (paginated gifts)
    if (interaction.customId.startsWith('gift_page|')) {
      const parts = interaction.customId.split('|');
      const page = parseInt(parts[1]);
      const username = parts[2];
      const playerId = parts[3];
      const category = parts[4];

      const userBalance = getBalance(interaction.user.id);
      const gifts = giftsData.items.filter(g => g.enabled && g.category === category);
      const itemsPerPage = 10;
      const totalPages = Math.ceil(gifts.length / itemsPerPage);
      const start = page * itemsPerPage;
      const end = start + itemsPerPage;
      const pageGifts = gifts.slice(start, end);

      const dailySkins = loadDailySkins();
      let thumbnail = null;

      let description = `**Recipient**: ${username}\n**Your balance**: ${userBalance} 💎\n**Page**: ${page + 1}/${totalPages}\n\n`;
      pageGifts.forEach((g, idx) => {
        const ds = dailySkins.find(s => s.offerType === g.type);
        const price = ds ? 380 : g.cost;
        if (ds && !thumbnail) thumbnail = ds.imageUrl;
        description += `**${start + idx + 1}.** ${formatGiftName(g.type)} - **${price}💎**\n`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`${getCategoryEmoji(category)} ${category.toUpperCase()}`)
        .setDescription(description)
        .setColor('#4CAF50')
        .setTimestamp();

      if (thumbnail) embed.setThumbnail(thumbnail);

      const rows = [];
      for (let i = 0; i < pageGifts.length; i += 5) {
        const buttonRow = new ActionRowBuilder();
        for (let j = 0; j < 5 && i + j < pageGifts.length; j++) {
          const idx = i + j;
          const g = pageGifts[idx];
          const giftNum = start + idx + 1;
          buttonRow.addComponents(
            new ButtonBuilder()
              .setCustomId(`select_gift|${username}|${playerId}|${g.type}`)
              .setLabel(`${giftNum}`)
              .setStyle(ButtonStyle.Primary)
          );
        }
        rows.push(buttonRow);
      }

      const navRow = new ActionRowBuilder();
      if (page > 0) {
        navRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`gift_page|${page - 1}|${username}|${playerId}|${category}`)
            .setLabel('◀ Previous')
            .setStyle(ButtonStyle.Secondary)
        );
      }
      if (page < totalPages - 1) {
        navRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`gift_page|${page + 1}|${username}|${playerId}|${category}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
        );
      }
      if (navRow.components.length > 0) rows.push(navRow);

      await interaction.update({ embeds: [embed], components: rows });
    }

    // User selected a numbered gift
    if (interaction.customId.startsWith('select_gift|')) {
      const parts = interaction.customId.split('|');
      const username = parts[1];
      const playerId = parts[2];
      const giftType = parts[3];

      const gift = giftsData.items.find(g => g.type === giftType);
      if (!gift) return interaction.reply({ content: `❌ Gift not found: ${giftType}`, flags: MessageFlags.Ephemeral });
      if (gift.category === 'xpbooster') return interaction.reply({ content: `❌ XP Boosters cannot be gifted.`, flags: MessageFlags.Ephemeral });

      const userBalance = getBalance(interaction.user.id);
      if (userBalance < gift.cost) {
        return interaction.reply({ content: `❌ Insufficient balance!\n💎 Cost: ${gift.cost} gems\n💰 Your balance: ${userBalance} gems`, flags: MessageFlags.Ephemeral });
      }

      // Check account gems and switch if needed (same logic as in select menu path)
      let accountGems = getAccountGemCount();
      if (accountGems < gift.cost) {
        const availableAccounts = Object.keys(accounts.accounts).filter(name => name !== accounts.current);
        let switched = false;
        for (const accountName of availableAccounts) {
          const newAccountGems = getAccountGemCount(accountName);
          if (newAccountGems >= gift.cost) {
            try {
              switchAccount(accountName);
              await refreshTokens();
              switched = true;
              break;
            } catch (e) {
              console.error('❌ Account switch error:', e.message);
            }
          }
        }
        if (!switched) {
          return interaction.reply({ content: `❌ Insufficient gems on all accounts!`, flags: MessageFlags.Ephemeral });
        }
      }

      // Show modal for personalized message (reuse same modal customId pattern)
      const modal = new ModalBuilder()
        .setCustomId(`gift_message|${username}|${playerId}|${giftType}`)
        .setTitle('🎁 Personalized Message');

      const messageInput = new TextInputBuilder()
        .setCustomId('gift_message')
        .setLabel('Message (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Leave empty to use default message')
        .setRequired(false)
        .setMaxLength(200);

      modal.addComponents(new ActionRowBuilder().addComponents(messageInput));
      await interaction.showModal(modal);
    }
    
    // Gift category buttons (for backward compatibility, but now we use select menu)
    if (interaction.customId.startsWith('category|')) {
      loadGiftsAndCalendars();
      
      const parts = interaction.customId.split('|');
      const category = parts[1];
      const username = parts[2];
      const playerId = parts[3];
      
      const userBalance = getBalance(interaction.user.id);
      const totalGems = getTotalGems();
      
      // Handle calendar category separately - show all enabled calendars
      if (category === 'calendar') {
        const enabledCalendars = calendarsData.calendars.filter(c => c.enabled);
        
        if (enabledCalendars.length === 0) {
          return interaction.editReply({ content: `❌ No calendars available`, flags: MessageFlags.Ephemeral });
        }
        
        // Page 0 by default
        const itemsPerPage = 10;
        const totalPages = Math.ceil(enabledCalendars.length / itemsPerPage);
        const pageCalendars = enabledCalendars.slice(0, itemsPerPage);
        
        let description = `**Recipient**: ${username}\n**Your balance**: ${userBalance} 💎\n**Page**: 1/${totalPages}\n\n`;
        
        pageCalendars.forEach((cal, idx) => {
          description += `**${idx + 1}.** ${cal.title} - **${cal.cost}💎**\n`;
        });
        
        const embed = new EmbedBuilder()
          .setTitle('📅 Available Calendars')
          .setDescription(description)
          .setColor('#4CAF50')
          .setTimestamp();
        
        // Create numbered buttons for calendars (max 10 per page)
        const rows = [];
        
        // Split buttons into rows of 5
        for (let i = 0; i < pageCalendars.length; i += 5) {
          const buttonRow = new ActionRowBuilder();
          for (let j = 0; j < 5 && i + j < pageCalendars.length; j++) {
            const idx = i + j;
            const cal = pageCalendars[idx];
            const calendarNum = idx + 1;
            
            buttonRow.addComponents(
              new ButtonBuilder()
                .setCustomId(`select_cal|${username}|${playerId}|${cal.id}`)
                .setLabel(`${calendarNum}`)
                .setStyle(ButtonStyle.Primary)
            );
          }
          rows.push(buttonRow);
        }
        
        // Navigation buttons if more than one page
        if (totalPages > 1) {
          const navRow = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`cal_page_1_${username}_${playerId}`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Secondary)
            );
          rows.push(navRow);
        }
        
        await interaction.reply({ embeds: [embed], components: rows, flags: MessageFlags.Ephemeral });
      } else {
        // Block XP Boosters category entirely — they cannot be gifted
        if (category === 'xpbooster') {
          return interaction.editReply({ content: `❌ XP Boosters cannot be gifted.`, flags: MessageFlags.Ephemeral });
        }

        // Handle other gift categories - show enabled gifts in paginated numbered buttons
        const gifts = giftsData.items.filter(g => g.enabled && g.category === category);

        if (gifts.length === 0) {
          return interaction.reply({ content: `❌ No gifts available in this category`, flags: MessageFlags.Ephemeral });
        }

        const itemsPerPage = 10;
        const totalPages = Math.ceil(gifts.length / itemsPerPage);
        const pageGifts = gifts.slice(0, itemsPerPage);

        const dailySkins = loadDailySkins();
        let thumbnail = null;

        let description = `**Recipient**: ${username}\n**Your balance**: ${userBalance} 💎\n**Page**: 1/${totalPages}\n\n`;
        pageGifts.forEach((g, idx) => {
          const ds = dailySkins.find(s => s.offerType === g.type);
          const price = ds ? 380 : g.cost;
          if (ds && !thumbnail) thumbnail = ds.imageUrl;
          description += `**${idx + 1}.** ${formatGiftName(g.type)} - **${price}💎**\n`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`${getCategoryEmoji(category)} ${category.toUpperCase()}`)
          .setDescription(description)
          .setColor('#4CAF50')
          .setTimestamp();

        if (thumbnail) embed.setThumbnail(thumbnail);

        const rows = [];
        for (let i = 0; i < pageGifts.length; i += 5) {
          const buttonRow = new ActionRowBuilder();
          for (let j = 0; j < 5 && i + j < pageGifts.length; j++) {
            const idx = i + j;
            const g = pageGifts[idx];
            const giftNum = idx + 1;
            buttonRow.addComponents(
              new ButtonBuilder()
                .setCustomId(`select_gift|${username}|${playerId}|${g.type}`)
                .setLabel(`${giftNum}`)
                .setStyle(ButtonStyle.Primary)
            );
          }
          rows.push(buttonRow);
        }

        if (totalPages > 1) {
          const navRow = new ActionRowBuilder();
          navRow.addComponents(
            new ButtonBuilder()
              .setCustomId(`gift_page|${1}|${username}|${playerId}|${category}`)
              .setLabel('Next ▶')
              .setStyle(ButtonStyle.Secondary)
          );
          rows.push(navRow);
        }

        await interaction.reply({ embeds: [embed], components: rows, flags: MessageFlags.Ephemeral });
      }
    }
  }
  
  // ==================== MODAL ====================
  if (interaction.isModalSubmit()) {
    
    // Gift message modal (after selecting a gift item)
    if (interaction.customId.startsWith('gift_message')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      // Parse using | delimiter to handle underscores in gift types
      const parts = interaction.customId.split('|');
      const username = parts[1];
      const playerId = parts[2];
      const giftType = parts[3];
      
      const giftMessage = interaction.fields.getTextInputValue('gift_message').trim();
      const finalMessage = giftMessage || `Gift from ${interaction.user.username}`;
      
      const gift = giftsData.items.find(g => g.type === giftType);
      
      if (!gift) {
        return interaction.editReply(`❌ Gift type not found: ${giftType}`);
      }
      
      const userBalance = getBalance(interaction.user.id);
      
      if (userBalance < gift.cost) {
        return interaction.editReply(`❌ Insufficient balance!\n💎 Cost: ${gift.cost} gems\n💰 Your balance: ${userBalance} gems`);
      }
      
      try {
        const result = await sendGift(playerId, giftType, finalMessage);
        
        const newBalance = removeBalance(interaction.user.id, gift.cost);
        const newTotalGems = removeTotalGems(gift.cost);
        addTransaction(gift.cost);
        
        // Get actual account gem count
        const accountGems = result?.gemCount || getAccountGemCount();
        
        const embed = new EmbedBuilder()
          .setTitle('✅ Gift Sent')
          .setDescription(
            `🎁 **Gift**: ${formatGiftName(gift.type)}\n` +
            `👤 **Recipient**: ${username}\n` +
            `💬 **Message**: ${finalMessage}\n` +
            `💎 **Cost**: ${gift.cost} gems\n` +
            `💰 **Your new balance**: ${newBalance} gems`
          )
          .setColor('#00FF00')
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        
        const logEmbed = new EmbedBuilder()
          .setTitle('🎁 Gift Sent')
          .setDescription(
            `**User**: ${interaction.user.tag}\n` +
            `**Recipient**: ${username}\n` +
            `**Type**: ${formatGiftName(gift.type)}\n` +
            `**Message**: ${finalMessage}\n` +
            `**Cost**: ${gift.cost} 💎\n` +
            `**Account**: ${accounts.current}`
          )
          .setColor('#00FF00')
          .setTimestamp();
        
        await sendLog(logEmbed);
        
      } catch (error) {
        let errorMessage = error.message;
        
        // Provide more helpful error messages
        if (error.message === 'Cannot be gifted') {
          errorMessage = `❌ **Cannot be gifted**: The gift type "${formatGiftName(gift.type)}" (${gift.type}) is not giftable according to the Wolvesville API.\n\n💡 This item may be restricted or no longer available for gifting. Please try a different gift.`;
        } else if (error.statusCode === 400) {
          errorMessage = `❌ **Bad Request**: ${error.message}\n\n**Gift Type**: ${formatGiftName(gift.type)} (${gift.type})\n💡 This gift may not be available or there may be an issue with the request.`;
        }
        
        await interaction.editReply(errorMessage);
        
        const logEmbed = new EmbedBuilder()
          .setTitle('❌ Send Error')
          .setDescription(
            `**User**: ${interaction.user.tag}\n` +
            `**Recipient**: ${username}\n` +
            `**Gift Type**: ${formatGiftName(gift.type)} (${gift.type})\n` +
            `**Error**: ${error.message}\n` +
            `**Status Code**: ${error.statusCode || 'N/A'}`
          )
          .setColor('#FF0000')
          .setTimestamp();
        
        await sendLog(logEmbed);
      }
    }
    
    // Calendar message modal (after selecting a calendar)
    if (interaction.customId.startsWith('calendar_message')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      // Parse using | delimiter to handle underscores
      const parts = interaction.customId.split('|');
      const username = parts[1];
      const playerId = parts[2];
      const calendarId = parts[3];
      
      const giftMessage = interaction.fields.getTextInputValue('gift_message').trim();
      const finalMessage = giftMessage || `Calendar from ${interaction.user.username}`;
      
      const calendar = calendarsData.calendars.find(c => c.id === calendarId);
      
      if (!calendar) {
        return interaction.editReply(`❌ Calendar not found: ${calendarId}`);
      }
      
      const userBalance = getBalance(interaction.user.id);
      
      if (userBalance < calendar.cost) {
        return interaction.editReply(`❌ Insufficient balance!\n💎 Cost: ${calendar.cost} gems\n💰 Your balance: ${userBalance} gems`);
      }
      
      try {
        const result = await sendGift(playerId, 'CALENDAR_LEGACY', finalMessage, calendarId);
        
        const newBalance = removeBalance(interaction.user.id, calendar.cost);
        const newTotalGems = removeTotalGems(calendar.cost);
        addTransaction(calendar.cost);
        
        // Get actual account gem count
        const accountGems = result?.gemCount || getAccountGemCount();
        
        const embed = new EmbedBuilder()
          .setTitle('✅ Calendar Sent')
          .setDescription(
            `📅 **Calendar**: ${calendar.title}\n` +
            `👤 **Recipient**: ${username}\n` +
            `💬 **Message**: ${finalMessage}\n` +
            `💎 **Cost**: ${calendar.cost} gems\n` +
            `💰 **Your new balance**: ${newBalance} gems`
          )
          .setColor('#00FF00')
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        
        const logEmbed = new EmbedBuilder()
          .setTitle('📅 Calendar Sent')
          .setDescription(
            `**User**: ${interaction.user.tag}\n` +
            `**Recipient**: ${username}\n` +
            `**Calendar**: ${calendar.title}\n` +
            `**Message**: ${finalMessage}\n` +
            `**Cost**: ${calendar.cost} 💎\n` +
            `**Account**: ${accounts.current}`
          )
          .setColor('#00FF00')
          .setTimestamp();
        
        await sendLog(logEmbed);
        
      } catch (error) {
        let errorMessage = error.message;
        
        // Provide more helpful error messages
        if (error.message === 'Cannot be gifted') {
          errorMessage = `❌ **Cannot be gifted**: The calendar "${calendar.title}" (ID: ${calendar.id}) is not giftable according to the Wolvesville API.\n\n💡 This calendar may be restricted or no longer available for gifting. Please try a different calendar.`;
        } else if (error.statusCode === 400) {
          errorMessage = `❌ **Bad Request**: ${error.message}\n\n**Calendar**: ${calendar.title} (ID: ${calendar.id})\n💡 This calendar may not be available or there may be an issue with the request.`;
        }
        
        await interaction.editReply(errorMessage);
        
        const logEmbed = new EmbedBuilder()
          .setTitle('❌ Calendar Send Error')
          .setDescription(
            `**User**: ${interaction.user.tag}\n` +
            `**Recipient**: ${username}\n` +
            `**Calendar**: ${calendar.title} (ID: ${calendar.id})\n` +
            `**Error**: ${error.message}\n` +
            `**Status Code**: ${error.statusCode || 'N/A'}`
          )
          .setColor('#FF0000')
          .setTimestamp();
        
        await sendLog(logEmbed);
      }
    }
    
    if (interaction.customId === 'gift_modal') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      const username = interaction.fields.getTextInputValue('username').trim();
      const usernameConfirm = interaction.fields.getTextInputValue('username_confirm').trim();
      
      if (username !== usernameConfirm) {
        return interaction.editReply('❌ Usernames do not match!');
      }
      
      try {
        // Reload to ensure latest data (files may have changed since bot start)
        loadGiftsAndCalendars();
        
        const player = await searchPlayer(username);
        
        if (!player) {
          return interaction.editReply(`❌ Joueur **${username}** introuvable !`);
        }
        
        const userBalance = getBalance(interaction.user.id);
        const totalGems = getTotalGems();
        
        // Get all unique categories from gifts.json (excluding calendar and xpbooster)
        // Show categories even if their items are currently disabled so users can see available groups
        const categories = [...new Set(giftsData.items
          .filter(g => g.category !== 'calendar' && g.category !== 'xpbooster')
          .map(g => g.category))];

        // Add calendar category if there are any enabled calendars
        const enabledCalendars = calendarsData.calendars.filter(c => c.enabled);
        if (enabledCalendars.length > 0) {
          categories.push('calendar');
        }

        if (categories.length === 0) {
          return interaction.editReply(`❌ No categories available.\n💎 Your balance: **${userBalance} gems**`);
        }

        // Build category buttons (5 per row)
        const rows = [];
        let currentRow = new ActionRowBuilder();
        for (let i = 0; i < categories.length; i++) {
          const cat = categories[i];
          currentRow.addComponents(
            new ButtonBuilder()
              .setCustomId(`category|${cat}|${player.username}|${player.id}`)
              .setLabel((getCategoryEmoji(cat) || '') + ' ' + (cat === 'calendar' ? 'Calendars' : cat.replace(/_/g, ' ').toUpperCase()))
              .setStyle(ButtonStyle.Primary)
          );

          if (currentRow.components.length >= 5 || i === categories.length - 1) {
            rows.push(currentRow);
            currentRow = new ActionRowBuilder();
          }
        }

        const embed = new EmbedBuilder()
          .setTitle('🎁 Gift Categories')
          .setDescription(
            `**Recipient**: ${player.username}\n` +
            `**Level**: ${player.level || 'N/A'}\n` +
            `**Your balance**: ${userBalance} 💎\n\n` +
            `Choose a category:`
          )
          .setColor('#4CAF50')
          .setTimestamp();

        await interaction.editReply({ embeds: [embed], components: rows });
        
      } catch (error) {
        await interaction.editReply(`❌ Error: ${error.message}`);
      }
    }
  }
  
  // ==================== SELECT MENU ====================
  if (interaction.isStringSelectMenu()) {
    
    // Category selection
    if (interaction.customId.startsWith('category_select_')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      const parts = interaction.customId.split('_');
      const username = parts[2];
      const playerId = parts[3];
      const category = interaction.values[0];
      
      const userBalance = getBalance(interaction.user.id);
      const totalGems = getTotalGems();
      
      // Block XP Boosters selection
      if (category === 'xpbooster') {
        return interaction.editReply(`❌ XP Boosters cannot be gifted.`);
      }

      // Handle calendar category separately - show all enabled calendars
      if (category === 'calendar') {
        const enabledCalendars = calendarsData.calendars.filter(c => c.enabled);
        
        if (enabledCalendars.length === 0) {
          return interaction.editReply(`❌ No calendars available with your balance!\n💎 Your balance: **${userBalance} gems**`);
        }
        
        // Page 0 by default
        const itemsPerPage = 10;
        const totalPages = Math.ceil(enabledCalendars.length / itemsPerPage);
        const pageCalendars = enabledCalendars.slice(0, itemsPerPage);
        
        let description = `**Recipient**: ${username}\n**Your balance**: ${userBalance} 💎\n**Page**: 1/${totalPages}\n\n`;
        
        pageCalendars.forEach((cal, idx) => {
          description += `**${idx + 1}.** ${cal.title} - **${cal.cost}💎**\n`;
        });
        
        const embed = new EmbedBuilder()
          .setTitle('📅 Available Calendars')
          .setDescription(description)
          .setColor('#4CAF50')
          .setTimestamp();
        
        // Create numbered buttons for calendars (max 10 per page)
        const rows = [];
        for (let i = 0; i < pageCalendars.length; i += 5) {
          const buttonRow = new ActionRowBuilder();
          for (let j = 0; j < 5 && i + j < pageCalendars.length; j++) {
            const idx = i + j;
            const cal = pageCalendars[idx];
            const calendarNum = idx + 1;
            buttonRow.addComponents(
              new ButtonBuilder()
                .setCustomId(`select_cal|${username}|${playerId}|${cal.id}`)
                .setLabel(`${calendarNum}`)
                .setStyle(ButtonStyle.Primary)
            );
          }
          rows.push(buttonRow);
        }

        if (totalPages > 1) {
          const navRow = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`cal_page_1_${username}_${playerId}`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Secondary)
            );
          rows.push(navRow);
        }

        await interaction.editReply({ embeds: [embed], components: rows });
      } else {
        // Handle other gift categories - show all enabled gifts, check affordability on purchase
        const gifts = giftsData.items.filter(g => g.enabled && g.category === category);
        
        if (gifts.length === 0) {
          return interaction.editReply({ content: `❌ No gifts available in this category`, flags: MessageFlags.Ephemeral });
        }
        
        const giftOptions = gifts.slice(0, 25).map(gift => ({
          label: formatGiftName(gift.type),
          value: gift.type,
          description: `${gift.cost} gems`,
          emoji: getCategoryEmoji(gift.category)
        }));
        
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(`gift_select_${username}_${playerId}`)
          .setPlaceholder('Choose a gift')
          .addOptions(giftOptions);
        
        const row = new ActionRowBuilder().addComponents(selectMenu);
        
        const embed = new EmbedBuilder()
          .setTitle(`${getCategoryEmoji(category)} ${category.toUpperCase()}`)
          .setDescription(`**Recipient**: ${username}\n**Your balance**: ${userBalance} 💎\n**Available**: ${gifts.length} items`)
          .setColor('#4CAF50')
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed], components: [row] });
      }
    }
    
    // Gift selection
    if (interaction.customId.startsWith('gift_select_')) {
      const parts = interaction.customId.split('_');
      const username = parts[2];
      const playerId = parts[3];
      
      const giftType = interaction.values[0];
      const gift = giftsData.items.find(g => g.type === giftType);
      
      if (!gift) {
        return interaction.reply({ content: `❌ Gift type not found: ${giftType}`, flags: MessageFlags.Ephemeral });
      }

      // Prevent gifting XP Boosters
      if (gift.category === 'xpbooster') {
        return interaction.reply({ content: `❌ XP Boosters cannot be gifted.`, flags: MessageFlags.Ephemeral });
      }
      
      const userBalance = getBalance(interaction.user.id);
      
      if (userBalance < gift.cost) {
        return interaction.reply({ content: `❌ Insufficient balance!\n💎 Cost: ${gift.cost} gems\n💰 Your balance: ${userBalance} gems`, flags: MessageFlags.Ephemeral });
      }
      
      // Check account gems and switch if needed
      let accountGems = getAccountGemCount();
      if (accountGems < gift.cost) {
        // Try to switch to an account with enough gems
        const availableAccounts = Object.keys(accounts.accounts).filter(name => name !== accounts.current);
        let switched = false;
        
        for (const accountName of availableAccounts) {
          const newAccountGems = getAccountGemCount(accountName);
          if (newAccountGems >= gift.cost) {
            try {
              switchAccount(accountName);
              await refreshTokens();
              console.log(`✅ Switched to account ${accountName} (${newAccountGems} gems) for gift purchase`);
              switched = true;
              break;
            } catch (switchError) {
              console.error(`❌ Error switching to account ${accountName}:`, switchError.message);
            }
          }
        }
        
        if (!switched) {
          return interaction.reply({ content: `❌ Insufficient gems on all accounts!\n💎 Cost: ${gift.cost} gems\n💰 Current account (${accounts.current}): ${accountGems} gems`, flags: MessageFlags.Ephemeral });
        }
      }
      
      // Show modal for personalized message
      // Use | as delimiter to avoid issues with underscores in gift types
      const modal = new ModalBuilder()
        .setCustomId(`gift_message|${username}|${playerId}|${giftType}`)
        .setTitle('🎁 Personalized Message');
        
      const messageInput = new TextInputBuilder()
        .setCustomId('gift_message')
        .setLabel('Message (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Leave empty to use default message')
        .setRequired(false)
        .setMaxLength(200);
      
      const row = new ActionRowBuilder().addComponents(messageInput);
      modal.addComponents(row);
        
      await interaction.showModal(modal);
    }
  }
});

// ==================== ERROR HANDLING ====================
client.on('error', error => {
  console.error('❌ Discord error:', error);
});

process.on('unhandledRejection', error => {
  console.error('❌ Unhandled promise rejection:', error);
});

// ==================== STARTUP ====================
// Validate Discord token format before attempting login
const discordToken = process.env.DISCORD_TOKEN;
if (!discordToken) {
  console.error('❌ DISCORD_TOKEN is not set in environment variables!');
  console.error('💡 Set it in your Cybrancee hosting panel under "Environment Variables"');
  process.exit(1);
}

// Check token length (Discord tokens are typically 59-70 characters)
if (discordToken.length < 50) {
  console.error('❌ DISCORD_TOKEN appears to be too short or incomplete!');
  console.error(`💡 Current length: ${discordToken.length} characters (should be ~59-70)`);
  console.error('💡 Make sure you copied the FULL token from Discord Developer Portal');
  console.error('💡 Token should look like: MTQ0NTcy... (much longer)');
  console.error('💡 Get a new token: https://discord.com/developers/applications → Your Bot → Reset Token');
  process.exit(1);
}

console.log('🔑 Discord token loaded (length: ' + discordToken.length + ' characters)');

client.login(discordToken).catch(error => {
  console.error('❌ Failed to login to Discord:', error.message);
  if (error.code === 'TokenInvalid') {
    console.error('💡 Your DISCORD_TOKEN is invalid or expired!');
    console.error('💡 Steps to fix:');
    console.error('   1. Go to https://discord.com/developers/applications');
    console.error('   2. Select your application');
    console.error('   3. Go to "Bot" section');
    console.error('   4. Click "Reset Token" to get a new token');
    console.error('   5. Copy the FULL token (it should be ~59-70 characters long)');
    console.error('   6. Update it in your Cybrancee environment variables');
  } else {
    console.error('💡 Check that your DISCORD_TOKEN is correct in your hosting panel');
  }
  process.exit(1);
});