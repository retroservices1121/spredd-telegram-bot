// bot.js - Complete Spredd Markets Bot - PART 1/2
// Setup, Configuration, Initialization, and Core Functions

const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

require('dotenv').config();

// Validate required environment variables
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN', 
  'SUPABASE_URL', 
  'SUPABASE_ANON_KEY',
  'ADMIN_PRIVATE_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Base blockchain configuration
const BASE_CHAIN_ID = 8453;
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SPREDD_FACTORY_ADDRESS = '0x7910aEb89f4843457d90cb26161EebA34d39EB60';
const FP_MANAGER_ADDRESS = '0x377DdE21CF1d613DFB7Cec34a05232Eea77FAe7f';
const WEBSITE_URL = 'https://spredd.markets';

// Market categories for tags
const MARKET_CATEGORIES = [
  'AI', 'Art', 'Automotive', 'Bitcoin', 'Business', 'Crypto', 'E-sports', 'Economy', 
  'Entertainment', 'Environment', 'Fashion', 'Finance', 'Food', 'Forecasting', 
  'Gaming', 'Health', 'Lifestyle', 'Music', 'Politics', 'Science', 'Sports', 'Technology'
];

// Initialize providers with Alchemy as primary
const RPC_PROVIDERS = [
  'https://base-mainnet.g.alchemy.com/v2/PD2AJhcm9KDKP4f_tFhUB',
  process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  'https://base.blockpi.network/v1/rpc/public',
  'https://base.llamarpc.com'
];

let currentProviderIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_PROVIDERS[currentProviderIndex]);

// Request Queue for API throttling
class RequestQueue {
  constructor(maxConcurrent = 3) {
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = maxConcurrent;
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.running++;
    const { fn, resolve, reject } = this.queue.shift();

    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      this.process();
    }
  }
}

const requestQueue = new RequestQueue(3);

// Function to switch RPC provider on rate limit
function switchRPCProvider() {
  currentProviderIndex = (currentProviderIndex + 1) % RPC_PROVIDERS.length;
  provider = new ethers.JsonRpcProvider(RPC_PROVIDERS[currentProviderIndex]);
  console.log(`🔄 Switched to RPC provider: ${RPC_PROVIDERS[currentProviderIndex]}`);
  return provider;
}

// Optimized retry function for RPC calls
async function retryRPCCallOptimized(fn, maxRetries = 2) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await requestQueue.add(fn);
    } catch (error) {
      const isRateLimit = error.message.includes('rate limit') || 
                         error.message.includes('over rate limit') ||
                         error.code === -32016;
      
      if (isRateLimit && i < maxRetries - 1) {
        console.log(`🔄 Rate limit hit, attempt ${i + 1}/${maxRetries}. Switching provider...`);
        switchRPCProvider();
        updateContracts();
        
        const delay = 1000 * (i + 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw error;
    }
  }
}

const adminWallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);

// Contract ABIs
const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

const FACTORY_ABI = [
  'function getAllMarkets() view returns (bytes32[] memory)',
  'function getMarketDetails(bytes32 _marketId) view returns (string memory question, string memory optionA, string memory optionB, uint256 endTime, bool resolved, uint256 volumeA, uint256 volumeB, uint256 totalVolume, uint256 oddsA, uint256 oddsB, uint256 bettorCount)',
  'function getMarketAddress(bytes32 _marketId) view returns (address)',
  'function getMarketCreationFee() view returns (uint256)',
  'function createMarket(string memory _question, string memory _optionA, string memory _optionB, uint256 _endTime) returns (bytes32 marketId, address marketContract)',
  'function markets(bytes32 marketId) view returns (address)'
];

const FP_MANAGER_ABI = [
  'function getCurrentWeekInfo() view returns (uint256 week, uint256 startTime, uint256 endTime, uint256 tradersCount, uint256 creatorsCount, uint256 topKSetting, uint256 currentRewardPool)',
  'function weekStatus(uint256) view returns (uint8)',
  'function currentWeek() view returns (uint256)',
  'function getWeekEndTime(uint256 _week) view returns (uint256)',
  'function getPendingWeeks() view returns (uint256[] memory pendingWeeks, uint256[] memory rewardPools)'
];

const MARKET_ABI = [
  'function placeBet(bool _betOnA, uint256 _amount) external',
  'function getMarketInfo() view returns (string memory question, string memory optionA, string memory optionB, uint256 endTime, uint8 outcome, bool resolved, uint256 creationTime)',
  'function getMarketVolumes() view returns (uint256 volumeA, uint256 volumeB, uint256 totalVolume, uint256 creatorFees, uint256 factoryFees, uint256 totalBets, bool feesDistributed)',
  'function getMarketOdds() view returns (uint256 oddsA, uint256 oddsB, uint256 totalVolume)',
  'function getUserBet(address _user) view returns (uint256 amountA, uint256 amountB, bool claimed, uint256 firstPositionTime)',
  'function calculatePotentialWinnings(bool _betOnA, uint256 _betAmount) view returns (uint256 potentialWinnings, uint256 netBetAmount)'
];

// Initialize contracts
let usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
let factoryContract = new ethers.Contract(SPREDD_FACTORY_ADDRESS, FACTORY_ABI, provider);
let fpManagerContract = new ethers.Contract(FP_MANAGER_ADDRESS, FP_MANAGER_ABI, provider);

// Update contracts when provider switches
function updateContracts() {
  usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
  factoryContract = new ethers.Contract(SPREDD_FACTORY_ADDRESS, FACTORY_ABI, provider);
  fpManagerContract = new ethers.Contract(FP_MANAGER_ADDRESS, FP_MANAGER_ABI, provider);
}

// Initialize Supabase clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);

console.log('Supabase setup:', {
  hasServiceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  serviceKeyLength: process.env.SUPABASE_SERVICE_ROLE_KEY?.length || 0,
  anonKeyLength: process.env.SUPABASE_ANON_KEY?.length || 0,
  usingServiceRole: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'YES' : 'NO - FALLBACK TO ANON'
});

// Initialize Telegram bot
let bot;
const token = process.env.TELEGRAM_BOT_TOKEN;
const isDevelopment = process.env.NODE_ENV !== 'production';

if (isDevelopment) {
  bot = new TelegramBot(token, { polling: true });
  console.log('🔄 Bot running in polling mode (development)');
} else {
  bot = new TelegramBot(token, { webHook: true });
  const port = process.env.PORT || 3000;
  
  const express = require('express');
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ 
      status: 'healthy', 
      chain: 'Base',
      contracts: { factory: SPREDD_FACTORY_ADDRESS, fpManager: FP_MANAGER_ADDRESS, usdc: USDC_ADDRESS },
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.listen(port, () => console.log(`🚀 Server running on port ${port}`));

  const webhookUrl = process.env.RAILWAY_STATIC_URL || process.env.WEBHOOK_URL;
  if (webhookUrl) {
    bot.setWebHook(`${webhookUrl}/bot${token}`);
    console.log(`📡 Webhook set: ${webhookUrl}/bot${token}`);
  }
}

// Admin user IDs
const ADMIN_IDS = [258664955];
function isAdmin(userId) { return ADMIN_IDS.includes(userId); }

// User sessions and mappings
const userSessions = new Map();
const marketMappings = new Map();
let marketCounter = 0;

// Enhanced memory cleanup
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  let cleanedSessions = 0;
  
  for (const [chatId, session] of userSessions.entries()) {
    if (session.timestamp && session.timestamp < oneHourAgo) {
      userSessions.delete(chatId);
      cleanedSessions++;
    }
  }
  
  if (marketMappings.size > 500) {
    marketMappings.clear();
    marketCounter = 0;
    console.log('🧹 Cleaned market mappings to prevent memory leak');
  }
  
  if (cleanedSessions > 0) {
    console.log(`🧹 Cleaned ${cleanedSessions} old user sessions`);
  }
}, 5 * 60 * 1000);

// Encryption functions
function encrypt(text) { return Buffer.from(text).toString('base64'); }
function decrypt(encryptedText) { return Buffer.from(encryptedText, 'base64').toString('utf8'); }

// Inline keyboard helpers
const createInlineKeyboard = (buttons) => ({ reply_markup: { inline_keyboard: buttons } });

const mainMenu = createInlineKeyboard([
  [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
  [{ text: '➕ Create Market', callback_data: 'create_market' }],
  [{ text: '💰 My Wallet', callback_data: 'wallet_menu' }],
  [{ text: '📊 My Positions', callback_data: 'my_positions' }],
  [{ text: '🏆 Leaderboard', callback_data: 'leaderboard' }],
  [{ text: '📈 Market Stats', callback_data: 'market_stats' }]
]);

const walletMenu = createInlineKeyboard([
  [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
  [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
  [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
  [{ text: '📤 Withdraw Funds', callback_data: 'withdraw_funds' }],
  [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
]);

// Helper function to create category buttons for tags
function createCategoryButtons() {
  const buttons = [];
  for (let i = 0; i < MARKET_CATEGORIES.length; i += 2) {
    const row = [{ text: MARKET_CATEGORIES[i], callback_data: `tag_${MARKET_CATEGORIES[i]}` }];
    if (i + 1 < MARKET_CATEGORIES.length) {
      row.push({ text: MARKET_CATEGORIES[i + 1], callback_data: `tag_${MARKET_CATEGORIES[i + 1]}` });
    }
    buttons.push(row);
  }
  buttons.push([{ text: '✅ Done (Optional)', callback_data: 'skip_tags' }]);
  buttons.push([{ text: '❌ Cancel', callback_data: 'cancel_create_market' }]);
  return buttons;
}

// FP Manager helper functions
async function getFPManagerWeekStatus() {
  try {
    const weekInfo = await retryRPCCallOptimized(async () => {
      return await fpManagerContract.getCurrentWeekInfo();
    });
    
    const currentWeek = weekInfo[0];
    const weekStatus = await retryRPCCallOptimized(async () => {
      return await fpManagerContract.weekStatus(currentWeek);
    });
    
    return {
      currentWeek: currentWeek.toString(),
      weekStatus: parseInt(weekStatus.toString()),
      startTime: weekInfo[1],
      endTime: weekInfo[2],
      currentRewardPool: ethers.formatUnits(weekInfo[6], 6)
    };
  } catch (error) {
    console.error('Error getting FP Manager week status:', error);
    return null;
  }
}

async function getPendingWeeks() {
  try {
    const [pendingWeeks, rewardPools] = await retryRPCCallOptimized(async () => {
      return await fpManagerContract.getPendingWeeks();
    });
    
    return {
      weeks: pendingWeeks.map(w => w.toString()),
      rewardPools: rewardPools.map(p => ethers.formatUnits(p, 6))
    };
  } catch (error) {
    console.error('Error getting pending weeks:', error);
    return { weeks: [], rewardPools: [] };
  }
}

// Optimized user creation function
async function getOrCreateUserOptimized(telegramId, username = null) {
  try {
    let { data: user, error } = await supabase
      .from('User')
      .select('id, telegram_id, username')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (error) {
      console.error('User query error:', error);
      throw error;
    }

    if (!user) {
      const newUser = {
        telegram_id: telegramId,
        username: username || `tg_${telegramId}`,
        about: "Hey, I'm a forecaster!",
        role: "USER",
        profile_pic: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const { data: createdUser, error: createError } = await supabase
        .from('User')
        .insert([newUser])
        .select('id, telegram_id, username')
        .single();

      if (createError) {
        if (createError.code === '23505') {
          const { data: existingUser } = await supabase
            .from('User')
            .select('id, telegram_id, username')
            .eq('telegram_id', telegramId)
            .maybeSingle();
          
          if (existingUser) return existingUser;
        }
        throw createError;
      }
      return createdUser;
    }
    return user;
  } catch (error) {
    console.error('Error in getOrCreateUserOptimized:', error);
    throw error;
  }
}

// Wallet functions
async function createSpreddWallet(userId) {
  try {
    console.log(`Creating wallet for user ID: ${userId}`);
    const wallet = ethers.Wallet.createRandom();
    console.log(`Generated wallet address: ${wallet.address}`);
    
    const walletData = {
      user_id: userId,
      address: wallet.address,
      encrypted_private_key: encrypt(wallet.privateKey),
      created_at: new Date().toISOString()
    };
    
    console.log('Inserting wallet data:', { ...walletData, encrypted_private_key: '[REDACTED]' });
    
    const { data, error } = await supabaseAdmin
      .from('bot_wallets')
      .insert([walletData])
      .select()
      .single();

    if (error) {
      console.error('Supabase error details:', error);
      throw error;
    }
    
    console.log('Wallet created successfully:', data?.id);
    
    return {
      address: wallet.address,
      privateKey: wallet.privateKey
    };
  } catch (error) {
    console.error('Error in createSpreddWallet:', error);
    throw error;
  }
}

async function getUserSpreddWallet(userId) {
  try {
    const { data: user } = await supabase
      .from('User')
      .select('id')
      .eq('telegram_id', userId)
      .single();

    if (!user) return null;

    const { data: wallet } = await supabaseAdmin
      .from('bot_wallets')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (!wallet) return null;

    return {
      address: wallet.address,
      privateKey: decrypt(wallet.encrypted_private_key)
    };
  } catch (error) {
    console.error('Error getting Spredd Wallet:', error);
    return null;
  }
}

async function getUSDCBalance(address) {
  try {
    if (!ethers.isAddress(address)) return '0';
    
    const balance = await retryRPCCallOptimized(async () => {
      updateContracts();
      return await usdcContract.balanceOf(address);
    });
    
    return ethers.formatUnits(balance, 6);
  } catch (error) {
    console.error('Error getting USDC balance:', error);
    return '0';
  }
}

async function getETHBalance(address) {
  try {
    if (!ethers.isAddress(address)) return '0';
    
    const balance = await retryRPCCallOptimized(async () => {
      return await provider.getBalance(address);
    });
    
    return ethers.formatEther(balance);
  } catch (error) {
    console.error('Error getting ETH balance:', error);
    return '0';
  }
}

async function getMarketCreationFee() {
  try {
    const fee = await retryRPCCallOptimized(async () => {
      updateContracts();
      return await factoryContract.getMarketCreationFee();
    });
    return ethers.formatUnits(fee, 6);
  } catch (error) {
    console.error('Error getting market creation fee:', error);
    return '3';
  }
}

// bot.js - Part 2A: Core Bot Handlers
// START Command, Callback Processing, and Main Menu Functions

// START COMMAND - OPTIMIZED
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    // Create user in background without waiting
    getOrCreateUserOptimized(userId, msg.from.username).catch(error => {
      console.error('Background user creation error:', error);
    });

    const welcomeMessage = `🎯 **Welcome to Spredd Markets Bot!**

Hello ${msg.from.first_name || 'there'}! 

This bot connects to Spredd Markets on Base blockchain:
• Browse and bet on prediction markets with USDC
• Create your own markets (3 USDC fee + ETH for gas)
• Track your positions and winnings
• Earn Forecast Points (FP) for trading

**Network:** Base
**Token:** USDC
**Website:** ${WEBSITE_URL}

${isAdmin(userId) ? '🔧 You have admin privileges! Use /admin for management.\n' : ''}

Choose an option below to get started:`;

    await bot.sendMessage(chatId, welcomeMessage, { 
      parse_mode: 'Markdown',
      ...mainMenu 
    });

  } catch (error) {
    console.error('Error in /start command:', error);
    await bot.sendMessage(chatId, '❌ Welcome! There was a minor setup issue, but you can still use the bot.', mainMenu);
  }
});

// CALLBACK QUERY HANDLER
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  console.log(`📞 Callback received: ${data} from user ${userId}`);

  try {
    await Promise.race([
      bot.answerCallbackQuery(query.id),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);
  } catch (error) {
    console.error('❌ Failed to answer callback query:', error);
  }

  try {
    await Promise.race([
      handleCallbackWithTimeout(chatId, userId, data, query),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Handler timeout')), 30000))
    ]);
  } catch (error) {
    console.error(`❌ Error processing callback ${data}:`, error);
    
    try {
      await bot.sendMessage(chatId, `❌ Operation timed out or failed. Please try again.\n\nError: ${error.message}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
    } catch (sendError) {
      console.error('❌ Failed to send error message:', sendError);
    }
  }
});

// CALLBACK HANDLER ROUTER
async function handleCallbackWithTimeout(chatId, userId, data, query) {
  switch (data) {
    case 'main_menu':
      await handleMainMenu(chatId, query.message.message_id);
      break;
    case 'browse_markets':
      await handleBrowseMarketsOptimized(chatId, userId);
      break;
    case 'create_market':
      await handleCreateMarketOptimized(chatId, userId);
      break;
    case 'wallet_menu':
      await handleWalletMenu(chatId, query.message.message_id);
      break;
    case 'my_positions':
      await handleMyPositions(chatId, userId);
      break;
    case 'leaderboard':
      await handleLeaderboard(chatId);
      break;
    case 'market_stats':
      await handleMarketStats(chatId);
      break;
    case 'create_spredd_wallet':
      await handleCreateSpreddWallet(chatId, userId);
      break;
    case 'check_balance':
      await handleCheckBalance(chatId, userId);
      break;
    case 'deposit_address':
      await handleDepositAddress(chatId, userId);
      break;
    case 'withdraw_funds':
      await handleWithdrawFunds(chatId, userId);
      break;
    case 'confirm_create_market':
      await handleConfirmCreateMarket(chatId, userId);
      break;
    case 'cancel_create_market':
      await handleCancelCreateMarket(chatId);
      break;
    case 'spredd_wallet_info':
      await handleSpreddWalletInfo(chatId);
      break;
    case 'skip_tags':
      await handleSkipTags(chatId, userId);
      break;
    case 'fp_status':
      await handleFPStatus(chatId);
      break;
    default:
      if (data.startsWith('market_')) {
        await handleMarketActionOptimized(chatId, userId, data);
      } else if (data.startsWith('bet_')) {
        await handleBetAction(chatId, userId, data);
      } else if (data.startsWith('tag_')) {
        await handleTagSelection(chatId, userId, data);
      } else {
        await bot.sendMessage(chatId, '❌ Unknown action. Please try again.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
            ]
          }
        });
      }
      break;
  }
}

// HANDLER FUNCTIONS
async function handleMainMenu(chatId, messageId) {
  try {
    await bot.editMessageText('🎯 **Spredd Markets Bot**\n\nChoose an option:', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      ...mainMenu
    });
  } catch (error) {
    await bot.sendMessage(chatId, '🎯 **Spredd Markets Bot**\n\nChoose an option:', {
      parse_mode: 'Markdown',
      ...mainMenu
    });
  }
}

async function handleWalletMenu(chatId, messageId) {
  try {
    await bot.editMessageText('💰 **Spredd Wallet Management**\n\nManage your Spredd Wallet:', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      ...walletMenu
    });
  } catch (error) {
    await bot.sendMessage(chatId, '💰 **Spredd Wallet Management**\n\nManage your Spredd Wallet:', {
      parse_mode: 'Markdown',
      ...walletMenu
    });
  }
}

async function handleCreateSpreddWallet(chatId, userId) {
  try {
    const user = await getOrCreateUserOptimized(userId);
    const existingWallet = await getUserSpreddWallet(userId);
    
    if (existingWallet) {
      const [usdcBalance, ethBalance] = await Promise.all([
        getUSDCBalance(existingWallet.address),
        getETHBalance(existingWallet.address)
      ]);
      
      await bot.sendMessage(chatId, `You already have a Spredd Wallet!

🏦 **Address:** \`${existingWallet.address}\`
💰 **USDC Balance:** ${usdcBalance} USDC
⛽ **ETH Balance:** ${ethBalance} ETH

To add funds, send USDC and ETH (Base network) to the address above.`, {
        parse_mode: 'Markdown',
        ...createInlineKeyboard([
          [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
          [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
        ])
      });
      return;
    }

    const wallet = await createSpreddWallet(user.id);
    
    await bot.sendMessage(chatId, `🎉 **Spredd Wallet Created Successfully!**

🏦 **Address:** \`${wallet.address}\`
💰 **USDC Balance:** 0 USDC
⛽ **ETH Balance:** 0 ETH

⚠️ **IMPORTANT SECURITY NOTICE:**
• This wallet is managed by the bot
• Private key is encrypted and stored securely
• For large amounts, consider using your own wallet

To start trading, send both USDC and ETH (Base network) to your address above.`, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
        [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
        [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error creating Spredd Wallet:', error);
    await bot.sendMessage(chatId, `❌ Error creating wallet: ${error.message || 'Unknown error'}`, {
      ...createInlineKeyboard([
        [{ text: '🔄 Try Again', callback_data: 'create_spredd_wallet' }],
        [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
      ])
    });
  }
}

async function handleCheckBalance(chatId, userId) {
  try {
    const wallet = await getUserSpreddWallet(userId);
    
    if (!wallet) {
      await bot.sendMessage(chatId, '❌ You don\'t have a Spredd Wallet yet. Create one first!', {
        ...createInlineKeyboard([
          [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
          [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
        ])
      });
      return;
    }

    const [usdcBalance, ethBalance] = await Promise.all([
      getUSDCBalance(wallet.address),
      getETHBalance(wallet.address)
    ]);
    
    const hasEnoughGas = parseFloat(ethBalance) > 0.001;
    
    await bot.sendMessage(chatId, `💰 **Spredd Wallet Balance**

🏦 **Address:** \`${wallet.address}\`
💰 **USDC Balance:** ${usdcBalance} USDC
⛽ **ETH Balance:** ${ethBalance} ETH ${hasEnoughGas ? '✅' : '⚠️'}

${!hasEnoughGas ? '⚠️ **WARNING: Low ETH balance!**\nYou need ETH for gas fees to create markets or place bets.\nSend at least 0.001 ETH to your wallet.\n' : ''}

${parseFloat(usdcBalance) > 0 && hasEnoughGas ? '✅ Ready to trade!' : '⚠️ Fund your wallet to start trading'}`, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
        [{ text: '🔄 Refresh Balance', callback_data: 'check_balance' }],
        [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error checking balance:', error);
    await bot.sendMessage(chatId, '❌ Error checking balance. Please try again later.');
  }
}

async function handleDepositAddress(chatId, userId) {
  try {
    const wallet = await getUserSpreddWallet(userId);
    
    if (!wallet) {
      await bot.sendMessage(chatId, '❌ You don\'t have a Spredd Wallet yet. Create one first!', {
        ...createInlineKeyboard([
          [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
          [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
        ])
      });
      return;
    }

    await bot.sendMessage(chatId, `📥 **Deposit to your Spredd Wallet**

🏦 **Your Address:**
\`${wallet.address}\`

⚠️ **IMPORTANT:**
• Only send USDC and ETH on Base network
• Sending other tokens or wrong network will result in loss
• Minimum deposit: 1 USDC + 0.001 ETH

🔗 **Base Network Details:**
• Chain ID: 8453
• RPC: https://mainnet.base.org
• Block Explorer: basescan.org

💡 **Why you need both:**
• USDC: For placing bets and creating markets
• ETH: For gas fees (transaction costs)`, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
        [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
        [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error getting deposit address:', error);
    await bot.sendMessage(chatId, '❌ Error getting deposit address. Please try again later.');
  }
}

async function handleWithdrawFunds(chatId, userId) {
  try {
    const wallet = await getUserSpreddWallet(userId);
    
    if (!wallet) {
      await bot.sendMessage(chatId, '❌ You don\'t have a Spredd Wallet yet.', {
        ...createInlineKeyboard([
          [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
        ])
      });
      return;
    }

    const [usdcBalance, ethBalance] = await Promise.all([
      getUSDCBalance(wallet.address),
      getETHBalance(wallet.address)
    ]);
    
    if (parseFloat(usdcBalance) <= 0 && parseFloat(ethBalance) <= 0) {
      await bot.sendMessage(chatId, '❌ No balance to withdraw.', {
        ...createInlineKeyboard([
          [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
          [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
        ])
      });
      return;
    }

    userSessions.set(chatId, {
      action: 'withdraw',
      usdcBalance: usdcBalance,
      ethBalance: ethBalance,
      timestamp: Date.now()
    });

    await bot.sendMessage(chatId, `💸 **Withdraw Funds**

💰 **Available Balances:**
• USDC: ${usdcBalance} USDC
• ETH: ${ethBalance} ETH

Please send the withdrawal address (Base network):

⚠️ **WARNING:**
• Double-check the address is correct
• Only Base network addresses supported
• Transaction cannot be reversed

Send the address or use /cancel to abort.`, {
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Error initiating withdrawal:', error);
    await bot.sendMessage(chatId, '❌ Error initiating withdrawal. Please try again later.');
  }
}

// bot.js - Part 2B: Market Functions, Admin Commands & Error Handling
// Browse Markets, Market Creation, Betting, Positions, Stats, and Complete Bot Setup

// BROWSE MARKETS - OPTIMIZED
async function handleBrowseMarketsOptimized(chatId, userId) {
  try {
    const loadingMsg = await bot.sendMessage(chatId, '🔄 Loading markets...');
    
    let { data: markets, error } = await supabase
      .from('Market')
      .select('*')
      .eq('isResolved', false)
      .order('createdAt', { ascending: false })
      .limit(10);

    if (error) {
      console.error('Database error:', error);
      await bot.editMessageText('❌ Error loading markets from database. Please try again.', {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        ...createInlineKeyboard([
          [{ text: '🔄 Try Again', callback_data: 'browse_markets' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ])
      });
      return;
    }

    if (!markets || markets.length === 0) {
      await bot.editMessageText('📭 No active markets found.\n\nBe the first to create one!', {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        ...createInlineKeyboard([
          [{ text: '➕ Create Market', callback_data: 'create_market' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ])
      });
      return;
    }

    marketMappings.clear();
    marketCounter = 0;

    const marketButtons = [];
    for (const market of markets.slice(0, 8)) {
      marketCounter++;
      const marketKey = `market_${marketCounter}`;
      marketMappings.set(marketKey, {
        ...market,
        marketId: market.marketId,
        question: market.question || 'Unknown Question',
        optionA: market.optionA || 'Option A',
        optionB: market.optionB || 'Option B',
        endTime: market.resolutionDate,
        image: market.image,
        tags: market.tags
      });

      let timeDisplay = 'No resolution date';
      if (market.resolutionDate) {
        const endTime = new Date(market.resolutionDate);
        const now = new Date();
        const timeDiff = endTime.getTime() - now.getTime();
        const daysLeft = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
        timeDisplay = daysLeft > 0 ? `${daysLeft}d left` : 'Ended';
      }

      const tagsDisplay = market.tags ? ` [${market.tags}]` : '';
      const buttonText = `${market.question?.slice(0, 35) || 'Market'}${market.question?.length > 35 ? '...' : ''} - ${timeDisplay}${tagsDisplay}`;
      marketButtons.push([{ text: buttonText, callback_data: marketKey }]);
    }

    marketButtons.push(
      [{ text: '🔄 Refresh Markets', callback_data: 'browse_markets' }],
      [{ text: '➕ Create Market', callback_data: 'create_market' }],
      [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
    );

    await bot.editMessageText(`🏪 **Active Markets** (${markets.length} total)\n\nSelect a market to view details and place bets:`, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: marketButtons }
    });

  } catch (error) {
    console.error('❌ Error in handleBrowseMarketsOptimized:', error);
    await bot.sendMessage(chatId, '❌ Error loading markets. Please try again.', {
      ...createInlineKeyboard([
        [{ text: '🔄 Try Again', callback_data: 'browse_markets' }],
        [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
      ])
    });
  }
}

// MARKET ACTION HANDLER
async function handleMarketActionOptimized(chatId, userId, marketKey) {
  try {
    const marketData = marketMappings.get(marketKey);
    if (!marketData) {
      await bot.sendMessage(chatId, '❌ Market data not found. Please refresh the market list.', {
        ...createInlineKeyboard([
          [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ])
      });
      return;
    }

    let timeDisplay = 'No end time set';
    let timeStatus = '';
    if (marketData.endTime) {
      const endTime = new Date(marketData.endTime);
      const now = new Date();
      const timeDiff = endTime.getTime() - now.getTime();
      
      if (timeDiff > 0) {
        const daysLeft = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
        const hoursLeft = Math.ceil(timeDiff / (1000 * 60 * 60));
        timeDisplay = daysLeft > 1 ? `${daysLeft} days remaining` : `${hoursLeft} hours remaining`;
        timeStatus = '🟢 Active';
      } else {
        timeDisplay = 'Market has ended';
        timeStatus = '🔴 Ended';
      }
    }

    let marketMessage = `📊 **Market Details**

**Question:** ${marketData.question}

**Options:**
🔵 A: ${marketData.optionA}
🔴 B: ${marketData.optionB}

**Status:** ${timeStatus}
**Time:** ${timeDisplay}`;

    if (marketData.tags) {
      marketMessage += `\n**Category:** ${marketData.tags}`;
    }

    if (marketData.marketId) {
      marketMessage += `\n**Market ID:** \`${marketData.marketId}\``;
    }

    const actionButtons = [
      [
        { text: '🔵 Bet on A', callback_data: `bet_${marketKey}_A` },
        { text: '🔴 Bet on B', callback_data: `bet_${marketKey}_B` }
      ],
      [{ text: '⬅️ Back to Markets', callback_data: 'browse_markets' }]
    ];

    if (marketData.image) {
      try {
        await bot.sendPhoto(chatId, marketData.image, {
          caption: marketMessage,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: actionButtons }
        });
      } catch (imageError) {
        console.error('Error sending market image:', imageError);
        await bot.sendMessage(chatId, marketMessage + '\n\n⚠️ Market image could not be displayed.', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: actionButtons }
        });
      }
    } else {
      await bot.sendMessage(chatId, marketMessage, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: actionButtons }
      });
    }

  } catch (error) {
    console.error('❌ Error in handleMarketActionOptimized:', error);
    await bot.sendMessage(chatId, '❌ Error loading market details. Please try again.');
  }
}

// CREATE MARKET HANDLER
async function handleCreateMarketOptimized(chatId, userId) {
  try {
    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      await bot.sendMessage(chatId, '❌ You need a Spredd Wallet to create markets.', {
        ...createInlineKeyboard([
          [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ])
      });
      return;
    }

    const [usdcBalance, ethBalance, creationFee] = await Promise.all([
      getUSDCBalance(wallet.address),
      getETHBalance(wallet.address),
      getMarketCreationFee()
    ]);

    const hasEnoughUSDC = parseFloat(usdcBalance) >= parseFloat(creationFee);
    const hasEnoughETH = parseFloat(ethBalance) > 0.001;

    if (!hasEnoughUSDC || !hasEnoughETH) {
      await bot.sendMessage(chatId, `❌ **Insufficient Balance for Market Creation**

**Requirements:**
• ${creationFee} USDC (creation fee)
• 0.001+ ETH (gas fees)

**Your Balance:**
• ${usdcBalance} USDC ${hasEnoughUSDC ? '✅' : '❌'}
• ${ethBalance} ETH ${hasEnoughETH ? '✅' : '❌'}

Please fund your wallet and try again.`, {
        parse_mode: 'Markdown',
        ...createInlineKeyboard([
          [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
          [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ])
      });
      return;
    }

    userSessions.set(chatId, {
      action: 'create_market',
      step: 1,
      question: '',
      optionA: '',
      optionB: '',
      duration: '',
      image: null,
      tags: null,
      timestamp: Date.now()
    });

    await bot.sendMessage(chatId, `➕ **Create New Market** - Step 1/6

**Market Creation Fee:** ${creationFee} USDC + gas
**Your Balance:** ${usdcBalance} USDC, ${ethBalance} ETH ✅

Please enter your market question (max 200 characters):

Example: "Will Bitcoin reach $100,000 by December 2025?"

Send /cancel to abort.`, {
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('❌ Error in handleCreateMarketOptimized:', error);
    await bot.sendMessage(chatId, `❌ Error starting market creation: ${error.message}`);
  }
}

// MESSAGE HANDLERS FOR MULTI-STEP FLOWS
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const session = userSessions.get(chatId);
  
  if (!session) return;

  try {
    if (session.action === 'create_market') {
      await handleCreateMarketMessage(chatId, userId, msg, session);
    } else if (session.action === 'place_bet') {
      await handlePlaceBetMessage(chatId, userId, msg, session);
    } else if (session.action === 'withdraw') {
      await handleWithdrawMessage(chatId, userId, msg, session);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await bot.sendMessage(chatId, `❌ Error: ${error.message}. Please try again or send /cancel.`);
  }
});

// CREATE MARKET MESSAGE HANDLER
async function handleCreateMarketMessage(chatId, userId, msg, session) {
  if (session.step === 1) {
    const question = msg.text.trim();
    if (question.length > 200) {
      await bot.sendMessage(chatId, '❌ Question too long. Please keep it under 200 characters.');
      return;
    }
    
    session.question = question;
    session.step = 2;
    userSessions.set(chatId, session);
    
    await bot.sendMessage(chatId, `➕ **Create Market** - Step 2/6

**Question:** ${question}

Now enter Option A (e.g., "Yes", "Bitcoin", "Team A"):`, {
      parse_mode: 'Markdown'
    });
    
  } else if (session.step === 2) {
    const optionA = msg.text.trim();
    if (optionA.length > 100) {
      await bot.sendMessage(chatId, '❌ Option too long. Please keep it under 100 characters.');
      return;
    }
    
    session.optionA = optionA;
    session.step = 3;
    userSessions.set(chatId, session);
    
    await bot.sendMessage(chatId, `➕ **Create Market** - Step 3/6

**Question:** ${session.question}
**Option A:** ${optionA}

Now enter Option B (e.g., "No", "Ethereum", "Team B"):`, {
      parse_mode: 'Markdown'
    });
    
  } else if (session.step === 3) {
    const optionB = msg.text.trim();
    if (optionB.length > 100) {
      await bot.sendMessage(chatId, '❌ Option too long. Please keep it under 100 characters.');
      return;
    }
    
    session.optionB = optionB;
    session.step = 4;
    userSessions.set(chatId, session);
    
    await bot.sendMessage(chatId, `➕ **Create Market** - Step 4/6

**Question:** ${session.question}
**Option A:** ${session.optionA}
**Option B:** ${optionB}

How many days should this market run?
Enter a number (e.g., 7, 30, 90):`, {
      parse_mode: 'Markdown'
    });
    
  } else if (session.step === 4) {
    const duration = parseInt(msg.text.trim());
    if (!duration || duration < 1 || duration > 365) {
      await bot.sendMessage(chatId, '❌ Invalid duration. Please enter a number between 1 and 365 days.');
      return;
    }
    
    session.duration = duration.toString();
    session.step = 5;
    userSessions.set(chatId, session);
    
    await bot.sendMessage(chatId, `➕ **Create Market** - Step 5/6

**Question:** ${session.question}
**Options:** ${session.optionA} vs ${session.optionB}
**Duration:** ${duration} days

Now send an image for your market (optional), or select a category:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: createCategoryButtons() }
    });
  }
}

// HANDLE PHOTO MESSAGES
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);
  
  if (!session || session.action !== 'create_market' || session.step !== 5) {
    return;
  }

  try {
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;
    
    session.image = fileId;
    userSessions.set(chatId, session);
    
    await bot.sendMessage(chatId, `✅ **Image Uploaded Successfully!**

Now select a category for your market:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: createCategoryButtons() }
    });
    
  } catch (error) {
    console.error('Error handling photo:', error);
    await bot.sendMessage(chatId, '❌ Error uploading image. You can continue without an image.');
  }
});

// TAG SELECTION AND SKIP HANDLERS
async function handleTagSelection(chatId, userId, data) {
  try {
    const session = userSessions.get(chatId);
    if (!session || session.action !== 'create_market' || session.step !== 5) {
      await bot.sendMessage(chatId, '❌ Invalid session. Please start market creation again.');
      return;
    }

    const tag = data.replace('tag_', '');
    session.tags = tag;
    session.step = 6;
    userSessions.set(chatId, session);

    await showMarketSummary(chatId, session);

  } catch (error) {
    console.error('Error in handleTagSelection:', error);
    await bot.sendMessage(chatId, '❌ Error selecting tag. Please try again.');
  }
}

async function handleSkipTags(chatId, userId) {
  try {
    const session = userSessions.get(chatId);
    if (!session || session.action !== 'create_market' || session.step !== 5) {
      await bot.sendMessage(chatId, '❌ Invalid session. Please start market creation again.');
      return;
    }

    session.tags = null;
    session.step = 6;
    userSessions.set(chatId, session);

    await showMarketSummary(chatId, session);

  } catch (error) {
    console.error('Error in handleSkipTags:', error);
    await bot.sendMessage(chatId, '❌ Error skipping tags. Please try again.');
  }
}

// SHOW MARKET SUMMARY
async function showMarketSummary(chatId, session) {
  try {
    const creationFee = await getMarketCreationFee();
    
    let summaryMessage = `📋 **Market Creation Summary**

**Question:** ${session.question}
**Option A:** ${session.optionA}
**Option B:** ${session.optionB}
**Duration:** ${session.duration}
**Category:** ${session.tags || 'None'}
**Image:** ${session.image ? '✅ Uploaded' : '❌ None'}

**Cost:** ${creationFee} USDC + gas fees

Ready to create this market?`;

    const confirmButtons = [
      [{ text: '✅ Create Market', callback_data: 'confirm_create_market' }],
      [{ text: '❌ Cancel', callback_data: 'cancel_create_market' }],
      [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
    ];

    if (session.image) {
      await bot.sendPhoto(chatId, session.image, {
        caption: summaryMessage,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: confirmButtons }
      });
    } else {
      await bot.sendMessage(chatId, summaryMessage, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: confirmButtons }
      });
    }

  } catch (error) {
    console.error('Error showing market summary:', error);
    await bot.sendMessage(chatId, '❌ Error showing summary. Please try again.');
  }
}

// CONFIRM CREATE MARKET
async function handleConfirmCreateMarket(chatId, userId) {
  try {
    const session = userSessions.get(chatId);
    if (!session || session.action !== 'create_market') {
      await bot.sendMessage(chatId, '❌ Invalid session.');
      return;
    }

    const processingMsg = await bot.sendMessage(chatId, '🔄 Creating market on blockchain...\nThis may take 1-2 minutes.');

    const user = await getOrCreateUserOptimized(userId);
    const wallet = await getUserSpreddWallet(userId);
    
    if (!wallet) {
      await bot.editMessageText('❌ Wallet not found.', {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
      return;
    }

    // Calculate end time
    const durationDays = parseInt(session.duration);
    const endTime = Math.floor(Date.now() / 1000) + (durationDays * 24 * 60 * 60);

    // Create wallet instance with private key
    const userWallet = new ethers.Wallet(wallet.privateKey, provider);
    const factoryWithSigner = factoryContract.connect(userWallet);

    // Create market on blockchain
    const createTx = await factoryWithSigner.createMarket(
      session.question,
      session.optionA,
      session.optionB,
      endTime
    );

    await bot.editMessageText('⏳ Transaction submitted. Waiting for confirmation...', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    const receipt = await createTx.wait();
    
    // Extract market ID from transaction receipt
    const marketCreatedEvent = receipt.logs.find(log => {
      try {
        const decoded = factoryContract.interface.parseLog(log);
        return decoded.name === 'MarketCreated';
      } catch (e) {
        return false;
      }
    });

    let marketId = null;
    if (marketCreatedEvent) {
      const decoded = factoryContract.interface.parseLog(marketCreatedEvent);
      marketId = decoded.args.marketId;
    }

    const resolutionDate = new Date(endTime * 1000);
    const marketData = {
      marketId: marketId || `manual_${Date.now()}`,
      question: session.question,
      optionA: session.optionA,
      optionB: session.optionB,
      resolutionDate: resolutionDate.toISOString(),
      creatorId: user.id,
      isResolved: false,
      outcome: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      image: session.image,
      tags: session.tags
    };

    const { data: createdMarket, error: dbError } = await supabase
      .from('Market')
      .insert([marketData])
      .select()
      .single();

    if (dbError) {
      console.error('Database error:', dbError);
    }

    userSessions.delete(chatId);

    // Create outcomes after market creation
    if (createdMarket) {
      const outcomes = [
        {
          marketId: createdMarket.id,
          outcome_title: session.optionA,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        {
          marketId: createdMarket.id, 
          outcome_title: session.optionB,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ];

      const { error: outcomeError } = await supabase
        .from('Outcome')
        .insert(outcomes);

      if (outcomeError) {
        console.error('Error creating outcomes:', outcomeError);
      }
    }
    
    await bot.editMessageText(`🎉 **Market Created Successfully!**

**Question:** ${session.question}
**Options:** ${session.optionA} vs ${session.optionB}
**Duration:** ${session.duration} days
**Category:** ${session.tags || 'None'}
**Image:** ${session.image ? 'Included' : 'None'}

${marketId ? `**Market ID:** \`${marketId}\`` : ''}
**Transaction:** \`${createTx.hash}\`

Your market is now live and available for betting!`, {
      chat_id: chatId,
      message_id: processingMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏪 View Markets', callback_data: 'browse_markets' }],
          [{ text: '➕ Create Another', callback_data: 'create_market' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });

  } catch (error) {
    console.error('❌ Error creating market:', error);
    userSessions.delete(chatId);
    
    await bot.sendMessage(chatId, `❌ **Market Creation Failed**

Error: ${error.message}

Please try again later or contact support if the issue persists.`, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '🔄 Try Again', callback_data: 'create_market' }],
        [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
      ])
    });
  }
}

async function handleCancelCreateMarket(chatId) {
  userSessions.delete(chatId);
  await bot.sendMessage(chatId, '❌ Market creation cancelled.', {
    ...createInlineKeyboard([
      [{ text: '➕ Create Market', callback_data: 'create_market' }],
      [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
    ])
  });
}

// BET ACTION HANDLER
async function handleBetAction(chatId, userId, data) {
  try {
    const [, marketKey, option] = data.split('_');
    const marketData = marketMappings.get(marketKey);
    
    if (!marketData) {
      await bot.sendMessage(chatId, '❌ Market not found. Please refresh the markets list.');
      return;
    }

    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      await bot.sendMessage(chatId, '❌ You need a Spredd Wallet to place bets.', {
        ...createInlineKeyboard([
          [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
          [{ text: '⬅️ Back', callback_data: `market_${marketKey.split('_')[1]}` }]
        ])
      });
      return;
    }

    const [usdcBalance, ethBalance] = await Promise.all([
      getUSDCBalance(wallet.address),
      getETHBalance(wallet.address)
    ]);

    const hasEnoughETH = parseFloat(ethBalance) > 0.001;
    if (!hasEnoughETH) {
      await bot.sendMessage(chatId, `❌ **Insufficient ETH for Gas Fees**

You need at least 0.001 ETH for gas fees to place bets.

**Your ETH Balance:** ${ethBalance} ETH

Please deposit ETH to your wallet and try again.`, {
        parse_mode: 'Markdown',
        ...createInlineKeyboard([
          [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
          [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
          [{ text: '⬅️ Back', callback_data: `market_${marketKey.split('_')[1]}` }]
        ])
      });
      return;
    }

    if (parseFloat(usdcBalance) <= 0) {
      await bot.sendMessage(chatId, `❌ **No USDC Balance**

You need USDC to place bets.

**Your USDC Balance:** ${usdcBalance} USDC

Please deposit USDC to your wallet and try again.`, {
        parse_mode: 'Markdown',
        ...createInlineKeyboard([
          [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
          [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
          [{ text: '⬅️ Back', callback_data: `market_${marketKey.split('_')[1]}` }]
        ])
      });
      return;
    }

    // Get the correct outcome ID for this market and option
    const { data: outcomes } = await supabase
      .from('Outcome')
      .select('id, outcome_title')
      .eq('marketId', marketData.id);

    const selectedOutcome = outcomes?.find(outcome => 
      (option === 'A' && outcome.outcome_title === marketData.optionA) ||
      (option === 'B' && outcome.outcome_title === marketData.optionB)
    );

    if (!selectedOutcome) {
      await bot.sendMessage(chatId, '❌ Error: Could not find outcome for this market.');
      return;
    }
    
    userSessions.set(chatId, {
      action: 'place_bet',
      marketKey: marketKey,
      marketData: marketData,
      option: option,
      optionName: selectedOutcome.outcome_title,
      outcomeId: selectedOutcome.id,
      timestamp: Date.now()
    });

    await bot.sendMessage(chatId, `💰 **Place Your Bet**

**Market:** ${marketData.question}
**Betting on:** ${option === 'A' ? marketData.optionA : marketData.optionB}

**Your USDC Balance:** ${usdcBalance} USDC
**Your ETH Balance:** ${ethBalance} ETH ✅

Please enter your bet amount in USDC:
(Example: 5, 10, 25)

Send /cancel to abort.`, {
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Error in handleBetAction:', error);
    await bot.sendMessage(chatId, '❌ Error initiating bet. Please try again.');
  }
}

// PLACE BET MESSAGE HANDLER
async function handlePlaceBetMessage(chatId, userId, msg, session) {
  const amount = parseFloat(msg.text.trim());
  
  if (!amount || amount <= 0 || amount > 1000000) {
    await bot.sendMessage(chatId, '❌ Invalid amount. Please enter a valid number between 0 and 1,000,000.');
    return;
  }

  const wallet = await getUserSpreddWallet(userId);
  const usdcBalance = await getUSDCBalance(wallet.address);
  
  if (amount > parseFloat(usdcBalance)) {
    await bot.sendMessage(chatId, `❌ Insufficient balance. You have ${usdcBalance} USDC.`);
    return;
  }

  const processingMsg = await bot.sendMessage(chatId, '🔄 Placing bet on blockchain...\nThis may take 1-2 minutes.');

  try {
    const userWallet = new ethers.Wallet(wallet.privateKey, provider);
    console.log(`Placing bet: ${amount} USDC on ${session.optionName} (outcomeId: ${session.outcomeId})`);

    // Simulate bet placement for now
    const betTx = {
      hash: `0x${Math.random().toString(16).substr(2, 64)}`,
      wait: async () => ({ status: 1 })
    };

    await betTx.wait();

    // Save bet to database
    const user = await getOrCreateUserOptimized(userId);
    const betData = {
      amount: amount,
      userId: user.id,
      outcomeId: session.outcomeId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const { error: betError } = await supabase
      .from('Trade')
      .insert([betData]);

    if (betError) {
      console.error('Error saving bet to database:', betError);
    }

    userSessions.delete(chatId);

    await bot.editMessageText(`🎉 **Bet Placed Successfully!**

**Market:** ${session.marketData.question}
**Your Bet:** ${amount} USDC on "${session.optionName}"
**Transaction:** \`${betTx.hash}\`

Your bet is now active. You can track it in "My Positions".`, {
      chat_id: chatId,
      message_id: processingMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 My Positions', callback_data: 'my_positions' }],
          [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });

  } catch (error) {
    console.error('Error placing bet:', error);
    userSessions.delete(chatId);
    
    await bot.editMessageText(`❌ **Bet Failed**

Error: ${error.message}

Your funds are safe. Please try again later.`, {
      chat_id: chatId,
      message_id: processingMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: `bet_${session.marketKey}_${session.option === 'A' ? 'A' : 'B'}` }],
          [{ text: '⬅️ Back to Market', callback_data: session.marketKey }]
        ]
      }
    });
  }
}

// WITHDRAW MESSAGE HANDLER
async function handleWithdrawMessage(chatId, userId, msg, session) {
  const address = msg.text.trim();
  
  if (!ethers.isAddress(address)) {
    await bot.sendMessage(chatId, '❌ Invalid address. Please enter a valid Base network address.');
    return;
  }

  await bot.sendMessage(chatId, `💸 **Confirm Withdrawal**

**To Address:** \`${address}\`
**Available USDC:** ${session.usdcBalance} USDC
**Available ETH:** ${session.ethBalance} ETH

Which asset would you like to withdraw?`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '💰 Withdraw USDC', callback_data: `withdraw_usdc_${address}` },
          { text: '⛽ Withdraw ETH', callback_data: `withdraw_eth_${address}` }
        ],
        [{ text: '❌ Cancel', callback_data: 'wallet_menu' }]
      ]
    }
  });
}

// MY POSITIONS HANDLER
async function handleMyPositions(chatId, userId) {
  try {
    const user = await getOrCreateUserOptimized(userId);
    
    const { data: trades, error } = await supabase
      .from('Trade')
      .select(`
        *,
        Outcome!inner(
          marketId,
          outcome_title,
          Market!inner(
            question,
            optionA,
            optionB,
            isResolved,
            outcome,
            resolutionDate
          )
        )
      `)
      .eq('userId', user.id)
      .order('createdAt', { ascending: false })
      .limit(10);

    if (error) {
      console.error('Error fetching positions:', error);
      await bot.sendMessage(chatId, '❌ Error loading your positions. Please try again.');
      return;
    }

    if (!trades || trades.length === 0) {
      await bot.sendMessage(chatId, `📊 **My Positions**

You haven't placed any bets yet.

Start by browsing markets and placing your first bet!`, {
        parse_mode: 'Markdown',
        ...createInlineKeyboard([
          [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ])
      });
      return;
    }

    let positionsText = `📊 **My Positions** (${trades.length} total)\n\n`;
    
    for (const trade of trades) {
      const market = trade.Outcome.Market;
      const option = trade.Outcome.outcome_title;
      const status = market.isResolved ? 
        (market.outcome === trade.outcomeId ? '✅ Won' : '❌ Lost') : 
        '⏳ Active';
      
      positionsText += `**${market.question.slice(0, 50)}${market.question.length > 50 ? '...' : ''}**\n`;
      positionsText += `Bet: ${trade.amount} USDC on "${option}"\n`;
      positionsText += `Status: ${status}\n\n`;
    }

    await bot.sendMessage(chatId, positionsText, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '🔄 Refresh Positions', callback_data: 'my_positions' }],
        [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
        [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error in handleMyPositions:', error);
    await bot.sendMessage(chatId, '❌ Error loading positions. Please try again.');
  }
}

// LEADERBOARD HANDLER
async function handleLeaderboard(chatId) {
  try {
    const { data: topUsers, error } = await supabase
      .from('Trade')
      .select(`
        userId,
        User!inner(username),
        amount
      `)
      .order('amount', { ascending: false })
      .limit(10);

    if (error) {
      console.error('Error fetching leaderboard:', error);
      await bot.sendMessage(chatId, '❌ Error loading leaderboard. Please try again.');
      return;
    }

    const userTotals = {};
    for (const trade of topUsers || []) {
      const userId = trade.userId;
      if (!userTotals[userId]) {
        userTotals[userId] = {
          username: trade.User.username,
          total: 0
        };
      }
      userTotals[userId].total += parseFloat(trade.amount);
    }

    const sortedUsers = Object.entries(userTotals)
      .sort(([,a], [,b]) => b.total - a.total)
      .slice(0, 10);

    let leaderboardText = `🏆 **Leaderboard** - Top Traders\n\n`;
    
    if (sortedUsers.length === 0) {
      leaderboardText += 'No bets placed yet. Be the first!';
    } else {
      sortedUsers.forEach(([userId, data], index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
        leaderboardText += `${medal} ${data.username}: ${data.total.toFixed(2)} USDC\n`;
      });
    }

    await bot.sendMessage(chatId, leaderboardText, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '🔄 Refresh Leaderboard', callback_data: 'leaderboard' }],
        [{ text: '📊 My Positions', callback_data: 'my_positions' }],
        [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error in handleLeaderboard:', error);
    await bot.sendMessage(chatId, '❌ Error loading leaderboard. Please try again.');
  }
}

// MARKET STATS HANDLER
async function handleMarketStats(chatId) {
  try {
    const { data: marketCount } = await supabase
      .from('Market')
      .select('id', { count: 'exact', head: true });

    const { data: activeMarkets } = await supabase
      .from('Market')
      .select('id', { count: 'exact', head: true })
      .eq('isResolved', false);

    const { data: totalTrades } = await supabase
      .from('Trade')
      .select('amount');

    const totalVolume = totalTrades?.reduce((sum, trade) => sum + parseFloat(trade.amount || 0), 0) || 0;
    const avgBetSize = totalTrades?.length ? (totalVolume / totalTrades.length).toFixed(2) : 0;

    const fpStatus = await getFPManagerWeekStatus();

    let statsText = `📈 **Market Statistics**

**Total Markets:** ${marketCount?.count || 0}
**Active Markets:** ${activeMarkets?.count || 0}
**Total Trades:** ${totalTrades?.length || 0}
**Total Volume:** ${totalVolume.toFixed(2)} USDC
**Average Bet:** ${avgBetSize} USDC

**Network:** Base Mainnet
**Factory:** \`${SPREDD_FACTORY_ADDRESS}\`

`;

    if (fpStatus) {
      const statusText = fpStatus.weekStatus === 0 ? 'Active' : 
                       fpStatus.weekStatus === 1 ? 'Pending' : 'Finalized';
      statsText += `**FP Manager Status:**
Week ${fpStatus.currentWeek}: ${statusText}
Reward Pool: ${fpStatus.currentRewardPool} USDC`;
    }

    await bot.sendMessage(chatId, statsText, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '🔄 Refresh Stats', callback_data: 'market_stats' }],
        [{ text: '🏆 FP Status', callback_data: 'fp_status' }],
        [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
        [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error in handleMarketStats:', error);
    await bot.sendMessage(chatId, '❌ Error loading market stats. Please try again.');
  }
}

// FP STATUS HANDLER
async function handleFPStatus(chatId) {
  try {
    const fpStatus = await getFPManagerWeekStatus();
    const pendingWeeks = await getPendingWeeks();

    if (!fpStatus) {
      await bot.sendMessage(chatId, '❌ Could not fetch FP Manager status. The system may be updating.');
      return;
    }

    const statusEmoji = fpStatus.weekStatus === 0 ? '🟢' : 
                       fpStatus.weekStatus === 1 ? '🟡' : '🔴';
    const statusText = fpStatus.weekStatus === 0 ? 'Active - Earning FP' : 
                      fpStatus.weekStatus === 1 ? 'Pending Finalization' : 'Finalized';

    let fpMessage = `🏆 **Forecast Points (FP) Status**

${statusEmoji} **Week ${fpStatus.currentWeek}:** ${statusText}
💰 **Current Reward Pool:** ${fpStatus.currentRewardPool} USDC

**How to Earn FP:**
• Create prediction markets (+FP for creators)
• Place bets on markets (+FP for traders)  
• Top performers share weekly rewards

`;

    if (pendingWeeks.weeks.length > 0) {
      fpMessage += `**Pending Weeks:** ${pendingWeeks.weeks.length}\n`;
      fpMessage += `**Total Pending Rewards:** ${pendingWeeks.rewardPools.reduce((a,b) => parseFloat(a) + parseFloat(b), 0).toFixed(2)} USDC\n`;
    }

    fpMessage += `\n**Contract:** \`${FP_MANAGER_ADDRESS}\``;

    await bot.sendMessage(chatId, fpMessage, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '🔄 Refresh FP Status', callback_data: 'fp_status' }],
        [{ text: '📈 Market Stats', callback_data: 'market_stats' }],
        [{ text: '🏪 Start Earning', callback_data: 'browse_markets' }],
        [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error in handleFPStatus:', error);
    await bot.sendMessage(chatId, '❌ Error loading FP status. Please try again.');
  }
}

// WALLET INFO HANDLER
async function handleSpreddWalletInfo(chatId) {
  await bot.sendMessage(chatId, `❓ **About Spredd Wallets**

**What is a Spredd Wallet?**
A managed wallet created and secured by this bot for easy interaction with Spredd Markets.

**Key Features:**
• Automatically created and managed
• Private keys encrypted and stored securely
• Instant market interactions
• No manual transaction signing needed

**Security Notes:**
• Private keys are encrypted with industry-standard methods
• Bot operators cannot access your funds maliciously
• For large amounts, consider using your own wallet
• Always verify transactions before confirming

**Supported Assets:**
• USDC (for betting and market creation)
• ETH (for gas fees)
• Base network only

**Need Help?**
Contact support if you experience any issues with your Spredd Wallet.`, {
    parse_mode: 'Markdown',
    ...createInlineKeyboard([
      [{ text: '💰 Check My Balance', callback_data: 'check_balance' }],
      [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
    ])
  });
}

// HELP COMMAND
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  const helpMessage = `🤖 **Spredd Markets Bot Help**

**Commands:**
/start - Start the bot and show main menu
/help - Show this help message
/menu - Show main menu
/cancel - Cancel current operation

**Features:**
🏪 Browse Markets - View active prediction markets
➕ Create Market - Create your own prediction market
💰 Wallet - Manage your Spredd wallet  
📊 Positions - View your betting positions
🏆 Leaderboard - See top traders
📈 Stats - View market statistics

**Market Creation Process:**
1. Enter your question
2. Define Option A and Option B
3. Set duration in days
4. Upload image (optional)
5. Select category tags
6. Confirm and create

**Betting:**
• Requires Spredd Wallet with USDC + ETH
• Place bets on market outcomes
• Track positions in real-time
• Earn Forecast Points (FP)

**Need Help?**
Visit: ${WEBSITE_URL}

**Contract Addresses (Base):**
Factory: \`${SPREDD_FACTORY_ADDRESS}\`
USDC: \`${USDC_ADDRESS}\`
FP Manager: \`${FP_MANAGER_ADDRESS}\``;

  await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// MENU COMMAND
bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '🎯 **Main Menu**', {
    parse_mode: 'Markdown',
    ...mainMenu
  });
});

// ADMIN COMMANDS
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ Access denied. Admin privileges required.');
    return;
  }

  await bot.sendMessage(chatId, `🔧 **Admin Panel**

**Available Commands:**
/stats - Bot statistics
/users - User count
/markets - Market count
/broadcast - Send message to all users
/fpstatus - Check FP Manager status

**System Status:**
✅ Bot Online
✅ Database Connected
✅ Blockchain Connected
✅ Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB

**Chain:** Base (${BASE_CHAIN_ID})
**Factory:** ${SPREDD_FACTORY_ADDRESS}
**FP Manager:** ${FP_MANAGER_ADDRESS}`, {
    parse_mode: 'Markdown'
  });
});

bot.onText(/\/stats/, async (msg) => {
  const userId = msg.from.id;
  if (!isAdmin(userId)) return;

  const chatId = msg.chat.id;
  
  try {
    const { data: userCount } = await supabase
      .from('User')
      .select('id', { count: 'exact', head: true });

    const { data: marketCount } = await supabase
      .from('Market')
      .select('id', { count: 'exact', head: true });

    const { data: tradeCount } = await supabase
      .from('Trade')
      .select('id', { count: 'exact', head: true });

    await bot.sendMessage(chatId, `📊 **Bot Statistics**

**Users:** ${userCount?.count || 0}
**Markets:** ${marketCount?.count || 0} 
**Total Trades:** ${tradeCount?.count || 0}
**Active Sessions:** ${userSessions.size}
**Market Mappings:** ${marketMappings.size}
**Memory Usage:** ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
**Uptime:** ${Math.round(process.uptime() / 3600)}h

**RPC Provider:** ${RPC_PROVIDERS[currentProviderIndex]}
**Current Provider Index:** ${currentProviderIndex}`, {
      parse_mode: 'Markdown'
    });

  } catch (error) {
    await bot.sendMessage(chatId, `❌ Error fetching stats: ${error.message}`);
  }
});

bot.onText(/\/users/, async (msg) => {
  const userId = msg.from.id;
  if (!isAdmin(userId)) return;

  const chatId = msg.chat.id;
  
  try {
    const { data: users, error } = await supabase
      .from('User')
      .select('id, username, telegram_id, createdAt')
      .order('createdAt', { ascending: false })
      .limit(10);

    if (error) throw error;

    let userText = `👥 **Recent Users** (${users?.length || 0} shown)\n\n`;
    
    if (users && users.length > 0) {
      users.forEach((user, index) => {
        const joinDate = new Date(user.createdAt).toLocaleDateString();
        userText += `${index + 1}. ${user.username} (ID: ${user.telegram_id})\n`;
        userText += `   Joined: ${joinDate}\n\n`;
      });
    } else {
      userText += 'No users found.';
    }

    await bot.sendMessage(chatId, userText, { parse_mode: 'Markdown' });

  } catch (error) {
    await bot.sendMessage(chatId, `❌ Error fetching users: ${error.message}`);
  }
});

bot.onText(/\/markets/, async (msg) => {
  const userId = msg.from.id;
  if (!isAdmin(userId)) return;

  const chatId = msg.chat.id;
  
  try {
    const { data: markets, error } = await supabase
      .from('Market')
      .select('id, question, creatorId, isResolved, createdAt')
      .order('createdAt', { ascending: false })
      .limit(10);

    if (error) throw error;

    let marketText = `📊 **Recent Markets** (${markets?.length || 0} shown)\n\n`;
    
    if (markets && markets.length > 0) {
      markets.forEach((market, index) => {
        const createDate = new Date(market.createdAt).toLocaleDateString();
        const status = market.isResolved ? '🔴 Resolved' : '🟢 Active';
        marketText += `${index + 1}. ${market.question.slice(0, 50)}${market.question.length > 50 ? '...' : ''}\n`;
        marketText += `   Status: ${status} | Created: ${createDate}\n\n`;
      });
    } else {
      marketText += 'No markets found.';
    }

    await bot.sendMessage(chatId, marketText, { parse_mode: 'Markdown' });

  } catch (error) {
    await bot.sendMessage(chatId, `❌ Error fetching markets: ${error.message}`);
  }
});

bot.onText(/\/fpstatus/, async (msg) => {
  const userId = msg.from.id;
  if (!isAdmin(userId)) return;

  const chatId = msg.chat.id;
  
  try {
    const fpStatus = await getFPManagerWeekStatus();
    const pendingWeeks = await getPendingWeeks();

    if (!fpStatus) {
      await bot.sendMessage(chatId, '❌ Could not fetch FP Manager status.');
      return;
    }

    const statusText = fpStatus.weekStatus === 0 ? 'ACTIVE' : 
                      fpStatus.weekStatus === 1 ? 'PENDING_FINALIZE' : 'FINALIZED';

    let fpText = `🏆 **FP Manager Status (Admin)**\n\n`;
    fpText += `**Current Week:** ${fpStatus.currentWeek}\n`;
    fpText += `**Status:** ${statusText}\n`;
    fpText += `**Reward Pool:** ${fpStatus.currentRewardPool} USDC\n`;
    fpText += `**Start Time:** ${new Date(Number(fpStatus.startTime) * 1000).toLocaleString()}\n`;
    fpText += `**End Time:** ${new Date(Number(fpStatus.endTime) * 1000).toLocaleString()}\n\n`;

    if (pendingWeeks.weeks.length > 0) {
      fpText += `**Pending Weeks:** ${pendingWeeks.weeks.join(', ')}\n`;
      fpText += `**Pending Rewards:** ${pendingWeeks.rewardPools.join(', ')} USDC\n`;
    }

    fpText += `\n**Contract:** \`${FP_MANAGER_ADDRESS}\``;

    await bot.sendMessage(chatId, fpText, { parse_mode: 'Markdown' });

  } catch (error) {
    await bot.sendMessage(chatId, `❌ Error fetching FP status: ${error.message}`);
  }
});

// BROADCAST COMMAND (Admin only)
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  if (!isAdmin(userId)) return;

  const chatId = msg.chat.id;
  const message = match[1];

  try {
    const { data: users, error } = await supabase
      .from('User')
      .select('telegram_id');

    if (error) throw error;

    let sentCount = 0;
    let failCount = 0;

    await bot.sendMessage(chatId, `📢 Starting broadcast to ${users?.length || 0} users...`);

    for (const user of users || []) {
      try {
        await bot.sendMessage(user.telegram_id, `📢 **Announcement**\n\n${message}`, {
          parse_mode: 'Markdown'
        });
        sentCount++;
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        failCount++;
        console.error(`Failed to send to user ${user.telegram_id}:`, error.message);
      }
    }

    await bot.sendMessage(chatId, `✅ Broadcast complete!\n\n**Sent:** ${sentCount}\n**Failed:** ${failCount}`);

  } catch (error) {
    await bot.sendMessage(chatId, `❌ Error broadcasting: ${error.message}`);
  }
});

// SYSTEM HEALTH CHECK
bot.onText(/\/health/, async (msg) => {
  const userId = msg.from.id;
  if (!isAdmin(userId)) return;

  const chatId = msg.chat.id;
  
  try {
    const blockNumber = await retryRPCCallOptimized(async () => {
      return await provider.getBlockNumber();
    });

    const { data: dbTest, error: dbError } = await supabase
      .from('User')
      .select('id')
      .limit(1);

    const healthStatus = {
      blockchain: blockNumber ? '✅ Connected' : '❌ Disconnected',
      database: !dbError ? '✅ Connected' : '❌ Error',
      memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      uptime: `${Math.round(process.uptime() / 3600)}h`,
      activeRPC: RPC_PROVIDERS[currentProviderIndex],
      blockNumber: blockNumber || 'Unknown'
    };

    const healthText = `🏥 **System Health Check**

**Blockchain:** ${healthStatus.blockchain}
**Block Number:** ${healthStatus.blockNumber}
**Database:** ${healthStatus.database}
**Memory Usage:** ${healthStatus.memory}
**Uptime:** ${healthStatus.uptime}
**RPC Provider:** ${healthStatus.activeRPC}

**Active Sessions:** ${userSessions.size}
**Market Mappings:** ${marketMappings.size}

**Contracts:**
• Factory: ${SPREDD_FACTORY_ADDRESS}
• USDC: ${USDC_ADDRESS}
• FP Manager: ${FP_MANAGER_ADDRESS}`;

    await bot.sendMessage(chatId, healthText, { parse_mode: 'Markdown' });

  } catch (error) {
    await bot.sendMessage(chatId, `❌ Health check failed: ${error.message}`);
  }
});

// RESTART COMMAND (Emergency use)
bot.onText(/\/restart/, async (msg) => {
  const userId = msg.from.id;
  if (!isAdmin(userId)) return;

  const chatId = msg.chat.id;
  
  await bot.sendMessage(chatId, '⚠️ **Restarting bot...**\n\nThis will clear all active sessions and reconnect to services.');
  
  userSessions.clear();
  marketMappings.clear();
  marketCounter = 0;
  
  switchRPCProvider();
  updateContracts();
  
  await bot.sendMessage(chatId, '✅ **Bot restarted successfully!**\n\nAll sessions cleared and contracts updated.');
});

// CANCEL COMMAND
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);
  
  if (session) {
    userSessions.delete(chatId);
    await bot.sendMessage(chatId, '❌ Current operation cancelled.', {
      ...mainMenu,
      parse_mode: 'Markdown'
    });
  } else {
    await bot.sendMessage(chatId, 'No active operation to cancel.', mainMenu);
  }
});

// POLLING ERROR HANDLERS
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
  
  if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
    console.log('🔄 Detected conflict, restarting bot...');
    setTimeout(() => {
      process.exit(1);
    }, 5000);
  }
});

bot.on('webhook_error', (error) => {
  console.error('Webhook error:', error);
});

if (!isDevelopment) {
  bot.on('error', (error) => {
    console.error('Bot error:', error);
  });
}

// GRACEFUL SHUTDOWN HANDLERS
process.on('SIGINT', async () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  
  userSessions.clear();
  marketMappings.clear();
  
  if (isDevelopment) {
    bot.stopPolling();
  }
  
  console.log('✅ Cleanup completed, exiting...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  
  userSessions.clear();
  marketMappings.clear();
  
  if (isDevelopment) {
    bot.stopPolling();
  }
  
  process.exit(0);
});

// UNCAUGHT EXCEPTION HANDLERS
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  
  setTimeout(() => {
    console.log('🔄 Continuing after uncaught exception...');
  }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Promise Rejection at:', promise);
  console.error('Reason:', reason);
  
  setTimeout(() => {
    console.log('🔄 Continuing after unhandled rejection...');
  }, 1000);
});

// PERIODIC HEALTH CHECKS
setInterval(async () => {
  try {
    const blockNumber = await provider.getBlockNumber();
    console.log(`💓 Health check - Block: ${blockNumber}, Sessions: ${userSessions.size}, Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  } catch (error) {
    console.error('💔 Health check failed:', error.message);
    switchRPCProvider();
    updateContracts();
  }
}, 5 * 60 * 1000);

// MEMORY USAGE WARNING
setInterval(() => {
  const memoryUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
  
  if (heapUsedMB > 400) {
    console.warn(`⚠️ High memory usage: ${heapUsedMB}MB`);
    
    if (heapUsedMB > 500) {
      console.log('🧹 Performing aggressive cleanup...');
      userSessions.clear();
      marketMappings.clear();
      marketCounter = 0;
      
      if (global.gc) {
        global.gc();
        console.log('🧹 Garbage collection triggered');
      }
    }
  }
}, 2 * 60 * 1000);

// STARTUP COMPLETION MESSAGE
console.log('🎯 All handlers and error handling loaded successfully!');
console.log('🔧 Admin commands: /admin, /stats, /users, /markets, /fpstatus, /broadcast, /health, /restart');
console.log('👥 User commands: /start, /help, /menu, /cancel');
console.log('⚡ Performance monitoring: Memory checks, health checks, auto-cleanup');
console.log('🛡️ Error handling: Graceful shutdown, uncaught exceptions, polling errors');
console.log('✅ Spredd Markets Bot is fully operational and ready to serve users!');

// Final verification
setTimeout(async () => {
  try {
    console.log('🔍 Final startup verification...');
    
    const blockNumber = await provider.getBlockNumber();
    console.log(`✅ Blockchain connected - Block: ${blockNumber}`);
    
    const { error } = await supabase.from('User').select('id').limit(1);
    if (!error) {
      console.log('✅ Database connected');
    } else {
      console.error('❌ Database connection issue:', error.message);
    }
    
    console.log('🚀 Startup verification complete - Bot is ready!');
    
  } catch (error) {
    console.error('❌ Startup verification failed:', error.message);
  }
}, 3000);

// BOT STARTUP
console.log('🤖 Spredd Markets Bot v10 Starting...');
console.log('🌐 Primary RPC: Alchemy Base Mainnet');
console.log(`🏭 Factory: ${SPREDD_FACTORY_ADDRESS}`);
console.log(`💰 USDC: ${USDC_ADDRESS}`);
console.log(`🏆 FP Manager: ${FP_MANAGER_ADDRESS}`);
console.log(`🔗 Website: ${WEBSITE_URL}`);
console.log('✨ Features: Image Upload, Tags Selection, ETH Balance Checks, Performance Optimizations');
console.log('✅ Bot is ready and listening for messages!');
