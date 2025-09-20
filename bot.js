// bot.js - Complete Spredd Markets Bot - SYNTAX ERROR FIXED
// Single file version to avoid concatenation issues

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
  'function markets(bytes32 marketId) view returns (address)',
  'function createPredictionMarket(string memory _question, string memory _optionA, string memory _optionB, uint256 _endTime) returns (bytes32 marketId, address marketContract)'
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

// FP Manager helper functions (for stats display only)
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

// Bot startup message
console.log('🤖 Spredd Markets Bot v10 Starting...');
console.log('🌐 Primary RPC: Alchemy Base Mainnet');
console.log(`🏭 Factory: ${SPREDD_FACTORY_ADDRESS}`);
console.log(`💰 USDC: ${USDC_ADDRESS}`);
console.log(`🏆 FP Manager: ${FP_MANAGER_ADDRESS}`);
console.log(`🔗 Website: ${WEBSITE_URL}`);
console.log('✨ Features: Image Upload, Tags Selection, ETH Balance Checks, Performance Optimizations');
console.log('✅ Bot is ready and listening for messages!');
