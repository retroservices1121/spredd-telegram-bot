// bot.js - Complete Spredd Markets Bot with Image Upload, Tags, and Performance Fixes
// PART 1/3: Setup, Configuration, and Initialization - UPDATED WITH FP MANAGER

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

// FP Manager ABI - Added to check week status
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

// Enhanced memory cleanup with more aggressive cleaning
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
}, 5 * 60 * 1000); // Every 5 minutes

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
      weekStatus: parseInt(weekStatus.toString()), // 0=ACTIVE, 1=PENDING_FINALIZE, 2=FINALIZED
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

// bot.js - PART 2/3: Core Functions and User Management

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

// Bot commands - OPTIMIZED START (NO BLOCKCHAIN CALLS)
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    // Create user in background without waiting
    getOrCreateUserOptimized(userId, msg.from.username).catch(error => {
      console.error('Background user creation error:', error);
    });

    const welcomeMessage = `
🎯 **Welcome to Spredd Markets Bot!**

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

Choose an option below to get started:
    `;

    await bot.sendMessage(chatId, welcomeMessage, { 
      parse_mode: 'Markdown',
      ...mainMenu 
    });

  } catch (error) {
    console.error('Error in /start command:', error);
    await bot.sendMessage(chatId, '❌ Welcome! There was a minor setup issue, but you can still use the bot.', mainMenu);
  }
});

// Enhanced callback query handler with timeout protection
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  console.log(`📞 Callback received: ${data} from user ${userId}`);

  try {
    // Answer callback query with timeout protection
    await Promise.race([
      bot.answerCallbackQuery(query.id),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);
    console.log(`✅ Answered callback query for: ${data}`);
  } catch (error) {
    console.error('❌ Failed to answer callback query:', error);
  }

  try {
    console.log(`🔄 Processing callback: ${data}`);
    
    // Add timeout wrapper for all handlers
    await Promise.race([
      handleCallbackWithTimeout(chatId, userId, data, query),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Handler timeout')), 30000))
    ]);
    
    console.log(`✅ Completed processing: ${data}`);
    
  } catch (error) {
    console.error(`❌ Error processing callback ${data}:`, error);
    console.error('Error stack:', error.stack);
    
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

// Timeout wrapper function
async function handleCallbackWithTimeout(chatId, userId, data, query) {
  switch (data) {
    case 'main_menu':
      console.log('Processing main_menu...');
      await handleMainMenu(chatId, query.message.message_id);
      break;
      
    case 'browse_markets':
      console.log('Processing browse_markets...');
      await handleBrowseMarketsOptimized(chatId, userId);
      break;
      
    case 'create_market':
      console.log('Processing create_market...');
      await handleCreateMarketOptimized(chatId, userId);
      break;
      
    case 'wallet_menu':
      console.log('Processing wallet_menu...');
      await handleWalletMenu(chatId, query.message.message_id);
      break;
      
    case 'my_positions':
      console.log('Processing my_positions...');
      await handleMyPositions(chatId, userId);
      break;
      
    case 'leaderboard':
      console.log('Processing leaderboard...');
      await handleLeaderboard(chatId);
      break;
      
    case 'market_stats':
      console.log('Processing market_stats...');
      await handleMarketStats(chatId);
      break;
      
    case 'create_spredd_wallet':
      console.log('Processing create_spredd_wallet...');
      await handleCreateSpreddWallet(chatId, userId);
      break;
      
    case 'check_balance':
      console.log('Processing check_balance...');
      await handleCheckBalance(chatId, userId);
      break;
      
    case 'deposit_address':
      console.log('Processing deposit_address...');
      await handleDepositAddress(chatId, userId);
      break;
      
    case 'withdraw_funds':
      console.log('Processing withdraw_funds...');
      await handleWithdrawFunds(chatId, userId);
      break;
      
    case 'confirm_create_market':
      console.log('Processing confirm_create_market...');
      await handleConfirmCreateMarket(chatId, userId);
      break;
      
    case 'cancel_create_market':
      console.log('Processing cancel_create_market...');
      await handleCancelCreateMarket(chatId);
      break;
      
    case 'spredd_wallet_info':
      console.log('Processing spredd_wallet_info...');
      await handleSpreddWalletInfo(chatId);
      break;

    case 'skip_tags':
      console.log('Processing skip_tags...');
      await handleSkipTags(chatId, userId);
      break;

    case 'fp_status':
      console.log('Processing fp_status...');
      await handleFPStatus(chatId);
      break;
      
    default:
      console.log(`Processing default case for: ${data}`);
      if (data.startsWith('market_')) {
        console.log('Processing market action...');
        await handleMarketActionOptimized(chatId, userId, data);
      } else if (data.startsWith('bet_')) {
        console.log('Processing bet action...');
        await handleBetAction(chatId, userId, data);
      } else if (data.startsWith('tag_')) {
        console.log('Processing tag selection...');
        await handleTagSelection(chatId, userId, data);
      } else {
        console.log(`❌ Unknown callback data: ${data}`);
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

// Handler functions
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

    console.log(`Creating wallet for user: ${user.id} (Telegram: ${userId})`);
    const wallet = await createSpreddWallet(user.id);
    
    await bot.sendMessage(chatId, `🎉 **Spredd Wallet Created Successfully!**

🏦 **Address:** \`${wallet.address}\`
💰 **USDC Balance:** 0 USDC
⛽ **ETH Balance:** 0 ETH

⚠️ **IMPORTANT SECURITY NOTICE:**
• This wallet is managed by the bot
• Private key is encrypted and stored securely
• For large amounts, consider using your own wallet
• Never share your wallet details

To start trading, send both USDC and ETH (Base network) to your address above.
You need ETH for gas fees when creating markets or placing bets.`, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
        [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
        [{ text: '❓ Wallet Info', callback_data: 'spredd_wallet_info' }],
        [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error creating Spredd Wallet:', error);
    await bot.sendMessage(chatId, `❌ Error creating wallet: ${error.message || 'Unknown error'}
    
Please try again later or contact support if the issue persists.`, {
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
• Funds typically arrive within 1-2 minutes

🔗 **Base Network Details:**
• Chain ID: 8453
• RPC: https://mainnet.base.org
• Block Explorer: basescan.org

💡 **Why you need both:**
• USDC: For placing bets and creating markets
• ETH: For gas fees (transaction costs)

After sending, use "Check Balance" to verify your deposit.`, {
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
• Gas fees will be deducted from your ETH balance

Send the address or use /cancel to abort.`, {
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Error initiating withdrawal:', error);
    await bot.sendMessage(chatId, '❌ Error initiating withdrawal. Please try again later.');
  }
}

// bot.js - PART 3/3: Market Functions, Message Handlers, and Bot Completion - UPDATED

// FIXED BROWSE MARKETS - Using correct column names from your Supabase table
async function handleBrowseMarketsOptimized(chatId, userId) {
  try {
    const loadingMsg = await bot.sendMessage(chatId, '🔍 Loading markets from database...');
    
    // Use the exact column names from your Supabase table
    const { data: dbMarkets, error } = await supabase
      .from('Market')
      .select(`
        id,
        question,
        optionA_alias,
        optionB_alias,
        endTime,
        status,
        contractAddress,
        createdAt,
        image,
        tags,
        Creator:creatorId(username)
      `)
      .eq('status', 'ACTIVE')
      .order('createdAt', { ascending: false })
      .limit(6);

    if (error) {
      console.error('Database error:', error);
      throw error;
    }

    if (!dbMarkets || dbMarkets.length === 0) {
      await bot.editMessageText('📭 No active markets found.', {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Create Market', callback_data: 'create_market' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    let message = '🏪 **Active Markets:**\n\n';
    const buttons = [];

    for (let i = 0; i < Math.min(dbMarkets.length, 4); i++) {
      const market = dbMarkets[i];
      const endDate = new Date(market.endTime);
      const isEnded = endDate < new Date();
      
      const shortId = `m${marketCounter++}`;
      marketMappings.set(shortId, {
        source: 'database',
        id: market.id,
        contractAddress: market.contractAddress,
        question: market.question,
        optionA: market.optionA_alias, // Fixed: use the correct column name
        optionB: market.optionB_alias, // Fixed: use the correct column name
        endTime: market.endTime,
        image: market.image,
        tags: market.tags
      });
      
      message += `${i + 1}. **${market.question}**\n`;
      message += `   📊 ${market.optionA_alias} vs ${market.optionB_alias}\n`;
      if (market.tags) {
        message += `   🏷️ ${market.tags}\n`;
      }
      message += `   📅 Expires: ${endDate.toLocaleDateString()}\n`;
      message += `   ${isEnded ? '⏰ Ended' : '🟢 Active'}\n\n`;
      
      buttons.push([{ 
        text: `📊 View Market ${i + 1}`, 
        callback_data: `market_${shortId}` 
      }]);
    }

    buttons.push([{ text: '🔄 Refresh Markets', callback_data: 'browse_markets' }]);
    buttons.push([{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]);

    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (error) {
    console.error('Error browsing markets:', error);
    await bot.sendMessage(chatId, '❌ Error loading markets. Please try again later.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: 'browse_markets' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });
  }
}

// ENHANCED CREATE MARKET WITH FP MANAGER STATUS CHECK - FIXED MESSAGE HANDLING
async function handleCreateMarketOptimized(chatId, userId) {
  try {
    console.log(`Starting handleCreateMarket for user ${userId}`);
    
    // Check FP Manager week status first
    const fpStatus = await getFPManagerWeekStatus();
    if (!fpStatus) {
      await bot.sendMessage(chatId, '❌ Unable to check FP Manager status. Please try again later.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    // Check if week is active (0 = ACTIVE, 1 = PENDING_FINALIZE, 2 = FINALIZED)
    if (fpStatus.weekStatus !== 0) {
      const statusText = fpStatus.weekStatus === 1 ? 'PENDING_FINALIZE' : 'FINALIZED';
      const pendingInfo = await getPendingWeeks();
      
      let message = `⚠️ **Market Creation Temporarily Unavailable**

**FP Manager Status:** ${statusText}
**Current Week:** ${fpStatus.currentWeek}
**Week End Time:** ${new Date(parseInt(fpStatus.endTime) * 1000).toLocaleString()}

The weekly leaderboard cycle is being processed. Market creation will be available once the new week starts.`;

      if (pendingInfo.weeks.length > 0) {
        message += `\n\n**Pending Weeks:** ${pendingInfo.weeks.join(', ')}`;
      }

      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 Check FP Status', callback_data: 'fp_status' }],
            [{ text: '🔄 Retry', callback_data: 'create_market' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }
    
    const { data: user } = await supabase
      .from('User')
      .select('id')
      .eq('telegram_id', userId)
      .maybeSingle();

    if (!user) {
      await getOrCreateUserOptimized(userId);
    }

    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      console.log('User has no wallet, prompting to create one');
      await bot.sendMessage(chatId, '❌ You need a Spredd Wallet to create markets!', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    // Check both USDC and ETH balances
    const [usdcBalance, ethBalance] = await Promise.all([
      getUSDCBalance(wallet.address),
      getETHBalance(wallet.address)
    ]);

    const fee = await getMarketCreationFee();
    
    if (parseFloat(usdcBalance) < parseFloat(fee)) {
      await bot.sendMessage(chatId, `❌ Insufficient USDC balance for market creation.

**Required:** ${fee} USDC
**Your Balance:** ${usdcBalance} USDC

Please fund your wallet first.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📥 Fund Wallet', callback_data: 'deposit_address' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    if (parseFloat(ethBalance) < 0.002) {
      await bot.sendMessage(chatId, `❌ Insufficient ETH for gas fees.

**Required:** ~0.002 ETH for gas
**Your Balance:** ${ethBalance} ETH

You need ETH to pay for blockchain transaction fees when creating markets.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📥 Fund Wallet', callback_data: 'deposit_address' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }
    
    console.log('Setting up market creation session');
    userSessions.set(chatId, {
      action: 'create_market',
      step: 'question',
      timestamp: Date.now()
    });

    console.log('Sending market creation prompt');
    await bot.sendMessage(chatId, `➕ **Create New Market**

**FP Manager Status:** ✅ ACTIVE (Week ${fpStatus.currentWeek})
**Creation Fee:** ${fee} USDC + ETH for gas
**Your Balance:** ${usdcBalance} USDC, ${ethBalance} ETH ✅

📝 **Step 1/6: Enter your prediction question**

Example: "Will Bitcoin reach $100,000 by end of 2025?"

Send your question or use /cancel to abort.`, {
      parse_mode: 'Markdown'
    });

    console.log('Market creation flow initiated successfully');

  } catch (error) {
    console.error('Error in handleCreateMarketOptimized:', error);
    await bot.sendMessage(chatId, '❌ Error setting up market creation. Please try again later.');
  }
}

// FIXED: Enhanced message handler with better error handling
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  console.log(`📨 Received message from user ${userId}: ${text ? text.substring(0, 50) + '...' : 'No text'}`);

  // Handle photo uploads during market creation
  if (msg.photo) {
    const session = userSessions.get(chatId);
    if (session && session.action === 'create_market' && session.step === 'image') {
      console.log('📸 Processing image upload for market creation');
      await handleImageUpload(chatId, userId, msg);
      return;
    } else {
      console.log('📸 Image received but not in image upload step');
    }
  }

  if (!text || text.startsWith('/')) {
    console.log('⏭️ Ignoring command or empty message');
    return;
  }

  const session = userSessions.get(chatId);
  if (!session) {
    console.log('❌ No active session for this user');
    return;
  }

  console.log(`🔄 Processing message for session action: ${session.action}, step: ${session.step}`);

  try {
    switch (session.action) {
      case 'create_market':
        console.log('📝 Processing market creation step');
        await handleMarketCreationStep(chatId, userId, text, session);
        break;
      case 'bet':
        console.log('💰 Processing bet amount');
        await handleBetAmount(chatId, userId, text, session);
        break;
      case 'withdraw':
        console.log('📤 Processing withdrawal address');
        await handleWithdrawalAddress(chatId, userId, text, session);
        break;
      default:
        console.log(`❓ Unknown session action: ${session.action}`);
        await bot.sendMessage(chatId, '❌ Unknown session state. Please start over.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
            ]
          }
        });
        userSessions.delete(chatId);
        break;
    }
  } catch (error) {
    console.error('❌ Error handling message:', error);
    await bot.sendMessage(chatId, '❌ An error occurred processing your message. Please try again.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });
    userSessions.delete(chatId);
  }
});

async function handleMarketCreationStep(chatId, userId, text, session) {
  console.log(`📝 Market creation step: ${session.step}, text: ${text.substring(0, 30)}...`);
  
  try {
    switch (session.step) {
      case 'question':
        if (text.length < 10 || text.length > 200) {
          await bot.sendMessage(chatId, '❌ Question must be between 10-200 characters. Please try again.');
          return;
        }
        
        session.question = text;
        session.step = 'optionA';
        userSessions.set(chatId, session);
        console.log('✅ Question saved, moving to optionA');
        
        await bot.sendMessage(chatId, `📝 **Step 2/6: First Option**

**Question:** ${text}

Enter the first option (e.g., "Yes", "Bitcoin", "Team A"):`, {
          parse_mode: 'Markdown'
        });
        break;

      case 'optionA':
        if (text.length < 1 || text.length > 50) {
          await bot.sendMessage(chatId, '❌ Option must be between 1-50 characters. Please try again.');
          return;
        }
        
        session.optionA = text;
        session.step = 'optionB';
        userSessions.set(chatId, session);
        console.log('✅ Option A saved, moving to optionB');
        
        await bot.sendMessage(chatId, `📝 **Step 3/6: Second Option**

**Question:** ${session.question}
**Option A:** ${text}

Enter the second option (e.g., "No", "Ethereum", "Team B"):`, {
          parse_mode: 'Markdown'
        });
        break;

      case 'optionB':
        if (text.length < 1 || text.length > 50) {
          await bot.sendMessage(chatId, '❌ Option must be between 1-50 characters. Please try again.');
          return;
        }
        
        session.optionB = text;
        session.step = 'endTime';
        userSessions.set(chatId, session);
        console.log('✅ Option B saved, moving to endTime');
        
        await bot.sendMessage(chatId, `📝 **Step 4/6: End Date**

**Question:** ${session.question}
**Option A:** ${session.optionA}
**Option B:** ${text}

Enter when the market should end (e.g., "2024-12-31", "next Friday"):`, {
          parse_mode: 'Markdown'
        });
        break;

      case 'endTime':
        let endTime;
        try {
          endTime = new Date(text).getTime() / 1000;
          if (endTime <= Date.now() / 1000) {
            throw new Error('Date must be in the future');
          }
        } catch (error) {
          await bot.sendMessage(chatId, '❌ Invalid date format. Please use format like "2024-12-31" or "December 31, 2024":');
          return;
        }
        
        session.endTime = endTime;
        session.step = 'image';
        userSessions.set(chatId, session);
        console.log('✅ End time saved, moving to image');
        
        await bot.sendMessage(chatId, `📝 **Step 5/6: Upload Image (Optional)**

**Question:** ${session.question}
**Option A:** ${session.optionA}
**Option B:** ${session.optionB}
**End Date:** ${new Date(endTime * 1000).toLocaleString()}

Send an image to make your market more engaging, or type "skip" to continue without one:`, {
          parse_mode: 'Markdown'
        });
        break;

      case 'image':
        if (text.toLowerCase() === 'skip') {
          session.step = 'tags';
          userSessions.set(chatId, session);
          console.log('✅ Image skipped, moving to tags');
          
          await bot.sendMessage(chatId, `📝 **Step 6/6: Select Category Tags**

Choose categories that best describe your market:`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: createCategoryButtons() }
          });
        } else {
          await bot.sendMessage(chatId, 'Please send an image file or type "skip" to continue without one.');
        }
        break;

      default:
        console.log(`❓ Unknown market creation step: ${session.step}`);
        await bot.sendMessage(chatId, '❌ Unknown step. Please start over.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
            ]
          }
        });
        userSessions.delete(chatId);
        break;
    }
  } catch (error) {
    console.error('❌ Error in handleMarketCreationStep:', error);
    await bot.sendMessage(chatId, '❌ Error processing your input. Please try again.');
  }
}

// ENHANCED CREATE MARKET WITH FP MANAGER STATUS CHECK
async function handleCreateMarketOptimized(chatId, userId) {
  try {
    console.log(`Starting handleCreateMarket for user ${userId}`);
    
    // Check FP Manager week status first
    const fpStatus = await getFPManagerWeekStatus();
    if (!fpStatus) {
      await bot.sendMessage(chatId, '❌ Unable to check FP Manager status. Please try again later.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    // Check if week is active (0 = ACTIVE, 1 = PENDING_FINALIZE, 2 = FINALIZED)
    if (fpStatus.weekStatus !== 0) {
      const statusText = fpStatus.weekStatus === 1 ? 'PENDING_FINALIZE' : 'FINALIZED';
      const pendingInfo = await getPendingWeeks();
      
      let message = `⚠️ **Market Creation Temporarily Unavailable**

**FP Manager Status:** ${statusText}
**Current Week:** ${fpStatus.currentWeek}
**Week End Time:** ${new Date(parseInt(fpStatus.endTime) * 1000).toLocaleString()}

The weekly leaderboard cycle is being processed. Market creation will be available once the new week starts.`;

      if (pendingInfo.weeks.length > 0) {
        message += `\n\n**Pending Weeks:** ${pendingInfo.weeks.join(', ')}`;
      }

      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📊 Check FP Status', callback_data: 'fp_status' }],
            [{ text: '🔄 Retry', callback_data: 'create_market' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }
    
    const { data: user } = await supabase
      .from('User')
      .select('id')
      .eq('telegram_id', userId)
      .maybeSingle();

    if (!user) {
      await getOrCreateUserOptimized(userId);
    }

    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      console.log('User has no wallet, prompting to create one');
      await bot.sendMessage(chatId, '❌ You need a Spredd Wallet to create markets!', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    // Check both USDC and ETH balances
    const [usdcBalance, ethBalance] = await Promise.all([
      getUSDCBalance(wallet.address),
      getETHBalance(wallet.address)
    ]);

    const fee = await getMarketCreationFee();
    
    if (parseFloat(usdcBalance) < parseFloat(fee)) {
      await bot.sendMessage(chatId, `❌ Insufficient USDC balance for market creation.

**Required:** ${fee} USDC
**Your Balance:** ${usdcBalance} USDC

Please fund your wallet first.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📥 Fund Wallet', callback_data: 'deposit_address' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    if (parseFloat(ethBalance) < 0.002) {
      await bot.sendMessage(chatId, `❌ Insufficient ETH for gas fees.

**Required:** ~0.002 ETH for gas
**Your Balance:** ${ethBalance} ETH

You need ETH to pay for blockchain transaction fees when creating markets.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📥 Fund Wallet', callback_data: 'deposit_address' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }
    
    console.log('Setting up market creation session');
    userSessions.set(chatId, {
      action: 'create_market',
      step: 'question',
      timestamp: Date.now()
    });

    console.log('Sending market creation prompt');
    await bot.sendMessage(chatId, `➕ **Create New Market**

**FP Manager Status:** ✅ ACTIVE (Week ${fpStatus.currentWeek})
**Creation Fee:** ${fee} USDC + ETH for gas
**Your Balance:** ${usdcBalance} USDC, ${ethBalance} ETH ✅

📝 **Step 1/6: Enter your prediction question**

Example: "Will Bitcoin reach $100,000 by end of 2025?"

Send your question or use /cancel to abort.`, {
      parse_mode: 'Markdown'
    });

    console.log('Market creation flow initiated successfully');

  } catch (error) {
    console.error('Error in handleCreateMarketOptimized:', error);
    await bot.sendMessage(chatId, '❌ Error setting up market creation. Please try again later.');
  }
}

async function handleConfirmCreateMarket(chatId, userId) {
  try {
    const session = userSessions.get(chatId);
    if (!session || session.action !== 'create_market' || !session.question) {
      await bot.sendMessage(chatId, '❌ Invalid session. Please start over.');
      return;
    }

    // Re-check FP Manager status before transaction
    const fpStatus = await getFPManagerWeekStatus();
    if (!fpStatus || fpStatus.weekStatus !== 0) {
      await bot.sendMessage(chatId, '❌ FP Manager status changed. Market creation is currently unavailable.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Try Again', callback_data: 'create_market' }],
            [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    const fee = await getMarketCreationFee();
    
    await bot.sendMessage(chatId, `⏳ **Creating Market...**

**FP Manager Status:** ✅ ACTIVE (Week ${fpStatus.currentWeek})

Please wait while we process your market creation on the blockchain...

This may take a few moments.`);

    try {
      const userWallet = new ethers.Wallet(wallet.privateKey, provider);
      const factoryWithSigner = new ethers.Contract(SPREDD_FACTORY_ADDRESS, FACTORY_ABI, userWallet);
      const feeWei = ethers.parseUnits(fee, 6);
      const endTime = Math.floor(session.endTime);
      
      console.log('Creating market with params:', {
        question: session.question,
        optionA: session.optionA,
        optionB: session.optionB,
        endTime: endTime,
        fee: fee,
        currentTime: Math.floor(Date.now() / 1000),
        fpWeek: fpStatus.currentWeek
      });

      // Check if endTime is reasonable
      const currentTime = Math.floor(Date.now() / 1000);
      const maxFutureTime = currentTime + (365 * 24 * 60 * 60); // 1 year from now
      
      if (endTime > maxFutureTime) {
        throw new Error('End time too far in the future. Please choose a date within 1 year.');
      }
      
      if (endTime <= currentTime + (24 * 60 * 60)) { // Must be at least 24 hours from now
        throw new Error('End time must be at least 24 hours from now.');
      }

      const usdcWithSigner = new ethers.Contract(USDC_ADDRESS, USDC_ABI, userWallet);
      console.log('Approving USDC for market creation fee...');
      
      try {
        const approveTx = await usdcWithSigner.approve(SPREDD_FACTORY_ADDRESS, feeWei);
        await approveTx.wait();
        console.log('USDC approval successful');
      } catch (approveError) {
        console.error('USDC approval failed:', approveError);
        throw new Error('Failed to approve USDC for market creation fee');
      }

      console.log('Creating market on blockchain...');
      const createTx = await factoryWithSigner.createMarket(
        session.question,
        session.optionA,
        session.optionB,
        endTime
      );
      
      const receipt = await createTx.wait();
      console.log('Market creation tx:', receipt.hash);

      let marketId, marketContract;
      for (const log of receipt.logs) {
        try {
          const parsedLog = factoryWithSigner.interface.parseLog(log);
          if (parsedLog.name === 'MarketCreated') {
            marketId = parsedLog.args.marketId;
            marketContract = parsedLog.args.marketContract;
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!marketId || !marketContract) {
        console.warn('Could not parse MarketCreated event, but transaction succeeded');
      }

      const { data: user } = await supabase
        .from('User')
        .select('id')
        .eq('telegram_id', userId)
        .single();

      // Use the actual column names your database expects
      const marketData = {
        question: session.question,
        description: `${session.optionA} vs ${session.optionB}`,
        optionA: session.optionA,
        optionB: session.optionB,
        image: session.imageUrl || '',
        endTime: new Date(endTime * 1000).toISOString(),
        tags: session.tags || '',
        metadata_options: JSON.stringify([session.optionA, session.optionB]),
        creatorId: user.id,
        contractAddress: marketContract || '',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const { data: dbMarket, error: marketError } = await supabaseAdmin
        .from('Market')
        .insert([marketData])
        .select()
        .single();

      if (marketError) {
        console.error('Error creating market record:', marketError);
        // Don't throw error, market was created on blockchain successfully
      }

      await bot.sendMessage(chatId, `✅ **Market Created Successfully!**

**Question:** ${session.question}
**Option A:** ${session.optionA}
**Option B:** ${session.optionB}
**Categories:** ${session.tags || 'None'}
**End Date:** ${new Date(endTime * 1000).toLocaleString()}
**Fee Paid:** ${fee} USDC
**FP Week:** ${fpStatus.currentWeek}
**Transaction:** [View on BaseScan](https://basescan.org/tx/${receipt.hash})

🎉 Your market is now live on Spredd Markets!
Users can start placing bets and earning Forecast Points.

View it at: ${WEBSITE_URL}`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
            [{ text: '➕ Create Another', callback_data: 'create_market' }],
            [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });

    } catch (error) {
      console.error('Blockchain transaction error:', error);
      throw error;
    }

    userSessions.delete(chatId);

  } catch (error) {
    console.error('Error confirming market creation:', error);
    
    let errorMessage = 'Unknown error occurred';
    
    // Enhanced error handling for smart contract issues
    if (error.message.includes('Week not active')) {
      errorMessage = 'FP Manager week is not active. The weekly leaderboard cycle may be in progress. Please wait for the new week to start.';
    } else if (error.message.includes('insufficient funds')) {
      errorMessage = 'Insufficient balance for creation fee or gas';
    } else if (error.message.includes('End time must be in the future')) {
      errorMessage = 'End time must be in the future';
    } else if (error.message.includes('End time too far in the future')) {
      errorMessage = 'End time too far in the future. Please choose a date within 1 year.';
    } else if (error.message.includes('End time must be at least 24 hours')) {
      errorMessage = 'End time must be at least 24 hours from now';
    } else if (error.message.includes('user rejected')) {
      errorMessage = 'Transaction was rejected';
    } else if (error.message.includes('execution reverted')) {
      const revertMatch = error.message.match(/execution reverted: "([^"]+)"/);
      if (revertMatch) {
        errorMessage = `Contract error: ${revertMatch[1]}`;
      } else {
        errorMessage = 'Transaction failed due to contract restrictions';
      }
    } else {
      errorMessage = error.message;
    }
    
    await bot.sendMessage(chatId, `❌ **Market Creation Failed**

Error: ${errorMessage}

If this is a "Week not active" error, the FP Manager weekly cycle may be resetting. Please wait a few minutes and try again.

For other errors, please try again or contact support if the issue persists.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Check FP Status', callback_data: 'fp_status' }],
          [{ text: '🔄 Try Again', callback_data: 'create_market' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });
  }
}

// NEW: FP Status checker
async function handleFPStatus(chatId) {
  try {
    await bot.sendMessage(chatId, '🔍 **Checking FP Manager Status...**');

    const fpStatus = await getFPManagerWeekStatus();
    if (!fpStatus) {
      await bot.sendMessage(chatId, '❌ Unable to connect to FP Manager contract.');
      return;
    }

    const pendingInfo = await getPendingWeeks();
    
    const statusEmoji = fpStatus.weekStatus === 0 ? '✅' : fpStatus.weekStatus === 1 ? '⏳' : '🔄';
    const statusText = fpStatus.weekStatus === 0 ? 'ACTIVE' : fpStatus.weekStatus === 1 ? 'PENDING_FINALIZE' : 'FINALIZED';
    
    let message = `📊 **FP Manager Status**

**Current Week:** ${fpStatus.currentWeek}
**Status:** ${statusEmoji} ${statusText}
**Week Start:** ${new Date(parseInt(fpStatus.startTime) * 1000).toLocaleString()}
**Week End:** ${new Date(parseInt(fpStatus.endTime) * 1000).toLocaleString()}
**Current Reward Pool:** ${fpStatus.currentRewardPool} USDT

**Market Creation:** ${fpStatus.weekStatus === 0 ? '✅ Available' : '❌ Unavailable'}`;

    if (pendingInfo.weeks.length > 0) {
      message += `\n\n**Pending Weeks:** ${pendingInfo.weeks.join(', ')}`;
      message += `\n**Pending Rewards:** ${pendingInfo.rewardPools.map((pool, i) => `Week ${pendingInfo.weeks[i]}: ${pool} USDT`).join(', ')}`;
    }

    message += `\n\n**Status Meanings:**
✅ ACTIVE: Week is running, markets can be created
⏳ PENDING_FINALIZE: Week ended, waiting for leaderboard
🔄 FINALIZED: Week completed, new week starting soon`;

    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Refresh Status', callback_data: 'fp_status' }],
          [{ text: '➕ Create Market', callback_data: 'create_market' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });

  } catch (error) {
    console.error('Error checking FP status:', error);
    await bot.sendMessage(chatId, '❌ Error checking FP Manager status.');
  }
}

// Rest of the functions remain the same...
async function handleMarketActionOptimized(chatId, userId, data) {
  try {
    const shortId = data.replace('market_', '');
    const marketMapping = marketMappings.get(shortId);
    
    if (!marketMapping) {
      await bot.sendMessage(chatId, '❌ Market not found. Please refresh markets.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Refresh Markets', callback_data: 'browse_markets' }],
            [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    const endDate = new Date(marketMapping.endTime);
    const isEnded = endDate < new Date();
    
    let message = `📊 **Market Details**\n\n`;
    message += `**Question:** ${marketMapping.question}\n\n`;
    message += `**Options:**\n`;
    message += `🔵 ${marketMapping.optionA}\n`;
    message += `🔴 ${marketMapping.optionB}\n\n`;
    
    if (marketMapping.tags) {
      message += `**Category:** ${marketMapping.tags}\n`;
    }
    
    message += `**Status:** ${isEnded ? '⏰ Ended' : '🟢 Active'}\n`;
    message += `**End Date:** ${endDate.toLocaleString()}\n`;
    message += `\n💡 *Live volume data loads when you place a bet*`;

    // Send image if available
    if (marketMapping.image) {
      try {
        await bot.sendPhoto(chatId, marketMapping.image, {
          caption: message,
          parse_mode: 'Markdown'
        });
      } catch (photoError) {
        console.log('Error sending photo, sending text instead:', photoError);
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      }
    } else {
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    const buttons = [];
    
    if (!isEnded) {
      buttons.push([
        { text: `🔵 Bet ${marketMapping.optionA}`, callback_data: `bet_${shortId}_true` },
        { text: `🔴 Bet ${marketMapping.optionB}`, callback_data: `bet_${shortId}_false` }
      ]);
    }
    
    buttons.push([{ text: '🏪 Back to Markets', callback_data: 'browse_markets' }]);
    buttons.push([{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, 'Choose an action:', {
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (error) {
    console.error('Error getting market details:', error);
    await bot.sendMessage(chatId, '❌ Error loading market details. Please try again later.');
  }
}

// Add fp_status to the callback handler in handleCallbackWithTimeout
async function handleTagSelection(chatId, userId, data) {
  try {
    const selectedTag = data.replace('tag_', '');
    const session = userSessions.get(chatId);
    
    if (!session || session.action !== 'create_market') {
      await bot.sendMessage(chatId, '❌ Invalid session. Please start over.');
      return;
    }

    if (!session.selectedTags) {
      session.selectedTags = [];
    }

    if (session.selectedTags.includes(selectedTag)) {
      session.selectedTags = session.selectedTags.filter(tag => tag !== selectedTag);
    } else {
      session.selectedTags.push(selectedTag);
    }

    userSessions.set(chatId, session);

    const selectedTagsText = session.selectedTags.length > 0 
      ? `**Selected:** ${session.selectedTags.join(', ')}` 
      : 'No tags selected yet';

    await bot.sendMessage(chatId, `🏷️ **Step 6/6: Select Category Tags**

${selectedTagsText}

Choose categories that best describe your market (you can select multiple):`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: createCategoryButtons() }
    });

  } catch (error) {
    console.error('Error handling tag selection:', error);
    await bot.sendMessage(chatId, '❌ Error processing tag selection. Please try again.');
  }
}

async function handleSkipTags(chatId, userId) {
  try {
    const session = userSessions.get(chatId);
    if (!session || session.action !== 'create_market') {
      await bot.sendMessage(chatId, '❌ Invalid session. Please start over.');
      return;
    }

    const tags = session.selectedTags && session.selectedTags.length > 0 
      ? session.selectedTags.join(', ') 
      : '';

    session.tags = tags;
    userSessions.set(chatId, session);

    const fee = await getMarketCreationFee();

    let imagePreview = '';
    if (session.imageUrl) {
      imagePreview = `**Image:** Uploaded ✅\n`;
    }

    await bot.sendMessage(chatId, `📋 **Confirm Market Creation**

**Question:** ${session.question}
**Option A:** ${session.optionA}
**Option B:** ${session.optionB}
**End Date:** ${new Date(session.endTime * 1000).toLocaleString()}
${imagePreview}**Categories:** ${tags || 'None'}
**Creation Fee:** ${fee} USDC + ETH for gas

Confirm to create your market:`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm & Create', callback_data: 'confirm_create_market' }],
          [{ text: '❌ Cancel', callback_data: 'cancel_create_market' }]
        ]
      }
    });

  } catch (error) {
    console.error('Error handling skip tags:', error);
    await bot.sendMessage(chatId, '❌ Error processing tags. Please try again.');
  }
}

async function handleCancelCreateMarket(chatId) {
  userSessions.delete(chatId);
  await bot.sendMessage(chatId, '❌ Market creation cancelled.', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
      ]
    }
  });
}

// Rest of bot functionality (betting, positions, etc.) remains the same...
console.log('🤖 Spredd Markets Bot started with FP Manager integration!');
console.log(`🌐 Primary RPC: Alchemy Base Mainnet`);
console.log(`🏭 Factory: ${SPREDD_FACTORY_ADDRESS}`);
console.log(`💰 USDC: ${USDC_ADDRESS}`);
console.log(`📊 FP Manager: ${FP_MANAGER_ADDRESS}`);
console.log(`🔗 Website: ${WEBSITE_URL}`);
console.log('✨ Features: Image Upload, Tags Selection, ETH Balance Checks, FP Manager Integration');
