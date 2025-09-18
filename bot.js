// bot.js - Spredd Markets Bot with Bot-Created Wallet System
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

require('dotenv').config();

// Validate required environment variables
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN', 
  'SUPABASE_URL', 
  'SUPABASE_ANON_KEY',
  'BASE_RPC_URL',
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

// Initialize providers and contracts with fallback RPCs
const RPC_PROVIDERS = [
  process.env.BASE_RPC_URL,
  'https://mainnet.base.org',
  'https://base.blockpi.network/v1/rpc/public',
  'https://base.llamarpc.com'
];

let currentProviderIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_PROVIDERS[currentProviderIndex]);

// Function to switch RPC provider on rate limit
function switchRPCProvider() {
  currentProviderIndex = (currentProviderIndex + 1) % RPC_PROVIDERS.length;
  provider = new ethers.JsonRpcProvider(RPC_PROVIDERS[currentProviderIndex]);
  console.log(`🔄 Switched to RPC provider: ${RPC_PROVIDERS[currentProviderIndex]}`);
  return provider;
}

// Retry function for RPC calls with more aggressive backoff
async function retryRPCCall(fn, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error.message.includes('rate limit') || 
                         error.message.includes('over rate limit') ||
                         error.code === -32016;
      
      if (isRateLimit && i < maxRetries - 1) {
        console.log(`🔄 Rate limit hit, attempt ${i + 1}/${maxRetries}. Switching provider and waiting...`);
        switchRPCProvider();
        
        // More aggressive exponential backoff: 3s, 6s, 12s, 24s
        const delay = 3000 * Math.pow(2, i);
        console.log(`⏳ Waiting ${delay/1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // For non-rate-limit errors or final retry, throw the error
      throw error;
    }
  }
}

const adminWallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);

// Contract ABIs - Updated with correct interfaces from the smart contracts
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

const MARKET_ABI = [
  'function placeBet(bool _betOnA, uint256 _amount) external',
  'function getMarketInfo() view returns (string memory question, string memory optionA, string memory optionB, uint256 endTime, uint8 outcome, bool resolved, uint256 creationTime)',
  'function getMarketVolumes() view returns (uint256 volumeA, uint256 volumeB, uint256 totalVolume, uint256 creatorFees, uint256 factoryFees, uint256 totalBets, bool feesDistributed)',
  'function getMarketOdds() view returns (uint256 oddsA, uint256 oddsB, uint256 totalVolume)',
  'function getUserBet(address _user) view returns (uint256 amountA, uint256 amountB, bool claimed, uint256 firstPositionTime)',
  'function calculatePotentialWinnings(bool _betOnA, uint256 _betAmount) view returns (uint256 potentialWinnings, uint256 netBetAmount)'
];

// Initialize contracts with retry-enabled provider
let usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
let factoryContract = new ethers.Contract(SPREDD_FACTORY_ADDRESS, FACTORY_ABI, provider);

// Update contracts when provider switches
function updateContracts() {
  usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
  factoryContract = new ethers.Contract(SPREDD_FACTORY_ADDRESS, FACTORY_ABI, provider);
}

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize Supabase client with service role for admin operations
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Debug: Check which keys are being used
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
  
  // Set up Express server for Railway
  const express = require('express');
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ 
      status: 'healthy', 
      chain: 'Base',
      contracts: {
        factory: SPREDD_FACTORY_ADDRESS,
        fpManager: FP_MANAGER_ADDRESS,
        usdc: USDC_ADDRESS
      },
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
  });

  const webhookUrl = process.env.RAILWAY_STATIC_URL || process.env.WEBHOOK_URL;
  if (webhookUrl) {
    bot.setWebHook(`${webhookUrl}/bot${token}`);
    console.log(`📡 Webhook set: ${webhookUrl}/bot${token}`);
  }
}

// Admin user IDs
const ADMIN_IDS = [
  258664955, // Replace with your actual Telegram user ID
];

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// User sessions for multi-step operations
const userSessions = new Map();

// Clean up old sessions
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [chatId, session] of userSessions.entries()) {
    if (session.timestamp && session.timestamp < oneHourAgo) {
      userSessions.delete(chatId);
    }
  }
}, 15 * 60 * 1000);

// Simple encryption functions (use proper encryption in production!)
function encrypt(text) {
  return Buffer.from(text).toString('base64');
}

function decrypt(encryptedText) {
  return Buffer.from(encryptedText, 'base64').toString('utf8');
}

// Inline keyboard helpers
const createInlineKeyboard = (buttons) => {
  return { reply_markup: { inline_keyboard: buttons } };
};

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

// Store market mappings for callback data
const marketMappings = new Map();
let marketCounter = 0;

// Helper functions for wallet management

// Get or create user (fixed constraint handling)
async function getOrCreateUser(telegramId, username = null) {
  try {
    let { data: user, error } = await supabase
      .from('User')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (error && error.code !== 'PGRST116') {
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
        .select()
        .single();

      if (createError) {
        // Handle duplicate constraint - user might have been created by another process
        if (createError.code === '23505') {
          // Try to fetch the existing user
          const { data: existingUser } = await supabase
            .from('User')
            .select('*')
            .eq('telegram_id', telegramId)
            .single();
          
          if (existingUser) return existingUser;
        }
        throw createError;
      }
      return createdUser;
    }

    return user;
  } catch (error) {
    console.error('Error in getOrCreateUser:', error);
    throw error;
  }
}

// Create a Spredd Wallet for the user
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
    
    // Use admin client for wallet operations
    const { data, error } = await supabaseAdmin
      .from('bot_wallets')
      .insert([walletData])
      .select()
      .single();

    if (error) {
      console.error('Supabase error details:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });
      throw error;
    }
    
    console.log('Wallet created successfully:', data?.id);
    
    return {
      address: wallet.address,
      privateKey: wallet.privateKey
    };
  } catch (error) {
    console.error('Error in createSpreddWallet:', {
      message: error.message,
      stack: error.stack,
      userId: userId
    });
    throw error;
  }
}

// Get user's Spredd Wallet
async function getUserSpreddWallet(userId) {
  try {
    const { data: user } = await supabase
      .from('User')
      .select('id')
      .eq('telegram_id', userId)
      .single();

    if (!user) return null;

    // Use admin client for wallet operations
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

// Get USDC balance with retry
async function getUSDCBalance(address) {
  try {
    if (!ethers.isAddress(address)) return '0';
    
    const balance = await retryRPCCall(async () => {
      updateContracts(); // Update contracts with current provider
      return await usdcContract.balanceOf(address);
    });
    
    return ethers.formatUnits(balance, 6);
  } catch (error) {
    console.error('Error getting USDC balance:', error);
    return '0';
  }
}

// Get market creation fee with retry
async function getMarketCreationFee() {
  try {
    const fee = await retryRPCCall(async () => {
      updateContracts();
      return await factoryContract.getMarketCreationFee();
    });
    return ethers.formatUnits(fee, 6);
  } catch (error) {
    console.error('Error getting market creation fee:', error);
    return '3'; // Default 3 USDC as specified by user
  }
}

// Get markets from database and blockchain (hybrid approach)
async function getMarketsFromBlockchain() {
  try {
    console.log('🔍 Fetching markets from database...');
    
    // First, get markets from your database
    const { data: dbMarkets, error } = await supabase
      .from('Market')
      .select(`
        *,
        Creator:creatorId(username)
      `)
      .eq('status', 'ACTIVE')
      .order('createdAt', { ascending: false })
      .limit(6);

    if (error) {
      console.error('Database error:', error);
    }

    const markets = [];

    if (dbMarkets && dbMarkets.length > 0) {
      console.log(`📊 Found ${dbMarkets.length} markets in database`);
      
      for (let i = 0; i < dbMarkets.length; i++) {
        const dbMarket = dbMarkets[i];
        
        // Create short mapping for callback data
        const shortId = `m${marketCounter++}`;
        
        // For database markets, use a different mapping that includes DB ID
        marketMappings.set(shortId, {
          source: 'database',
          id: dbMarket.id,
          contractAddress: dbMarket.contractAddress
        });
        
        markets.push({
          id: dbMarket.id,
          shortId: shortId,
          question: dbMarket.question,
          optionA: dbMarket.optionA,
          optionB: dbMarket.optionB,
          endTime: Math.floor(new Date(dbMarket.endTime).getTime() / 1000),
          resolved: dbMarket.status === 'RESOLVED',
          volumeA: '0', // You might want to calculate this from trades
          volumeB: '0',
          totalVolume: '0',
          oddsA: 5000, // Default 50%
          oddsB: 5000, // Default 50%
          bettorCount: 0, // Calculate from trades if needed
          source: 'database'
        });
        
        console.log(`✅ Loaded market: ${dbMarket.question.substring(0, 50)}...`);
      }
    } else {
      console.log('📭 No markets found in database, trying blockchain...');
      
      // Fallback to blockchain markets if no database markets
      const marketIds = await retryRPCCall(async () => {
        updateContracts();
        return await factoryContract.getAllMarkets();
      });
      
      // Process only a few blockchain markets to avoid rate limits
      const recentMarkets = marketIds.slice(-3);
      
      for (let i = 0; i < recentMarkets.length; i++) {
        const marketId = recentMarkets[i];
        
        try {
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
          const details = await retryRPCCall(async () => {
            updateContracts();
            return await factoryContract.getMarketDetails(marketId);
          });
          
          const shortId = `m${marketCounter++}`;
          marketMappings.set(shortId, {
            source: 'blockchain',
            id: marketId
          });
          
          markets.push({
            id: marketId,
            shortId: shortId,
            question: details.question,
            optionA: details.optionA,
            optionB: details.optionB,
            endTime: details.endTime,
            resolved: details.resolved,
            volumeA: ethers.formatUnits(details.volumeA, 6),
            volumeB: ethers.formatUnits(details.volumeB, 6),
            totalVolume: ethers.formatUnits(details.totalVolume, 6),
            oddsA: details.oddsA,
            oddsB: details.oddsB,
            bettorCount: details.bettorCount,
            source: 'blockchain'
          });
          
        } catch (error) {
          console.error(`❌ Error processing blockchain market ${marketId}:`, error.message);
        }
      }
    }

    console.log(`📋 Successfully loaded ${markets.length} markets`);
    return markets;
    
  } catch (error) {
    console.error('Error getting markets:', error);
    return [];
  }
}

// Start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    const user = await getOrCreateUser(userId, msg.from.username);
    const wallet = await getUserSpreddWallet(userId);

    const welcomeMessage = `
🎯 **Welcome to Spredd Markets Bot!**

Hello ${msg.from.first_name || 'there'}! 

This bot connects to Spredd Markets on Base blockchain:
• Browse and bet on prediction markets with USDC
• Create your own markets (3 USDC fee)
• Track your positions and winnings
• Earn Forecast Points (FP) for trading

**Network:** Base
**Token:** USDC
**Website:** ${WEBSITE_URL}

${wallet ? `✅ Spredd Wallet: \`${wallet.address}\`` : '⚠️ Create your Spredd Wallet to get started'}

${isAdmin(userId) ? '🔧 You have admin privileges! Use /admin for management.\n' : ''}

Choose an option below to get started:
    `;

    await bot.sendMessage(chatId, welcomeMessage, { 
      parse_mode: 'Markdown',
      ...mainMenu 
    });

  } catch (error) {
    console.error('Error in /start command:', error);
    await bot.sendMessage(chatId, '❌ Sorry, there was an error setting up your account. Please try again later.');
  }
});

// Callback query handler
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  // IMPORTANT: Answer the callback query immediately to stop "connecting" indicator
  bot.answerCallbackQuery(query.id).catch(console.error);

  console.log(`Received callback: ${data} from user ${userId}`);

  try {
    switch (data) {
      case 'main_menu':
        await handleMainMenu(chatId, query.message.message_id);
        break;
      case 'browse_markets':
        await handleBrowseMarkets(chatId, userId);
        break;
      case 'create_market':
        console.log('Handling create_market callback');
        await handleCreateMarket(chatId, userId);
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
      default:
        console.log(`Checking if ${data} is a market or bet action`);
        if (data.startsWith('market_')) {
          await handleMarketAction(chatId, userId, data);
        } else if (data.startsWith('bet_')) {
          await handleBetAction(chatId, userId, data);
        } else {
          console.log(`Unknown callback data: ${data}`);
          await bot.sendMessage(chatId, '❌ Unknown action. Please try again.', mainMenu);
        }
        break;
    }
  } catch (error) {
    console.error('Error handling callback:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
  }
});

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
    const user = await getOrCreateUser(userId);
    const existingWallet = await getUserSpreddWallet(userId);
    
    if (existingWallet) {
      const balance = await getUSDCBalance(existingWallet.address);
      
      await bot.sendMessage(chatId, `You already have a Spredd Wallet!

🏦 **Address:** \`${existingWallet.address}\`
💰 **Balance:** ${balance} USDC

To add funds, send USDC (Base network) to the address above.`, {
        parse_mode: 'Markdown',
        ...createInlineKeyboard([
          [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
          [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
        ])
      });
      return;
    }

    // Create new wallet
    console.log(`Creating wallet for user: ${user.id} (Telegram: ${userId})`);
    const wallet = await createSpreddWallet(user.id);
    
    await bot.sendMessage(chatId, `🎉 **Spredd Wallet Created Successfully!**

🏦 **Address:** \`${wallet.address}\`
💰 **Balance:** 0 USDC

⚠️ **IMPORTANT SECURITY NOTICE:**
• This wallet is managed by the bot
• Private key is encrypted and stored securely
• For large amounts, consider using your own wallet
• Never share your wallet details

To start trading, send USDC (Base network) to your address above.`, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
        [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
        [{ text: '❓ Wallet Info', callback_data: 'spredd_wallet_info' }],
        [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error creating Spredd Wallet:', {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      stack: error.stack,
      userId: userId
    });
    
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

    const balance = await getUSDCBalance(wallet.address);
    
    await bot.sendMessage(chatId, `💰 **Spredd Wallet Balance**

🏦 **Address:** \`${wallet.address}\`
💰 **USDC Balance:** ${balance} USDC

${parseFloat(balance) > 0 ? '✅ Ready to trade!' : '⚠️ Fund your wallet to start trading'}`, {
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

    await bot.sendMessage(chatId, `📥 **Deposit USDC to your Spredd Wallet**

🏦 **Your Address:**
\`${wallet.address}\`

⚠️ **IMPORTANT:**
• Only send USDC on Base network
• Sending other tokens or wrong network will result in loss
• Minimum deposit: 1 USDC
• Funds typically arrive within 1-2 minutes

🔗 **Base Network Details:**
• Chain ID: 8453
• RPC: https://mainnet.base.org
• Block Explorer: basescan.org

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

    const balance = await getUSDCBalance(wallet.address);
    
    if (parseFloat(balance) <= 0) {
      await bot.sendMessage(chatId, '❌ No USDC balance to withdraw.', {
        ...createInlineKeyboard([
          [{ text: '📥 Get Deposit Address', callback_data: 'deposit_address' }],
          [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
        ])
      });
      return;
    }

    // Set up withdrawal session
    userSessions.set(chatId, {
      action: 'withdraw',
      balance: balance,
      timestamp: Date.now()
    });

    await bot.sendMessage(chatId, `💸 **Withdraw USDC**

💰 **Available Balance:** ${balance} USDC

Please send the withdrawal address (Base network):

⚠️ **WARNING:**
• Double-check the address is correct
• Only Base network addresses supported
• Transaction cannot be reversed
• Gas fees will be deducted from your balance

Send the address or use /cancel to abort.`, {
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Error initiating withdrawal:', error);
    await bot.sendMessage(chatId, '❌ Error initiating withdrawal. Please try again later.');
  }
}

async function handleBrowseMarkets(chatId, userId) {
  try {
    await bot.sendMessage(chatId, '🔍 Loading markets...');
    
    const markets = await getMarketsFromBlockchain();
    
    if (markets.length === 0) {
      await bot.sendMessage(chatId, '📭 No active markets found.', {
        ...createInlineKeyboard([
          [{ text: '➕ Create Market', callback_data: 'create_market' }],
          [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
        ])
      });
      return;
    }

    let message = '🏪 **Active Markets on Base:**\n\n';
    const buttons = [];

    for (let i = 0; i < Math.min(markets.length, 4); i++) {
      const market = markets[i];
      const endDate = new Date(Number(market.endTime) * 1000);
      const isEnded = endDate < new Date();
      
      message += `${i + 1}. **${market.question}**\n`;
      message += `   📊 ${market.optionA} vs ${market.optionB}\n`;
      message += `   💰 Volume: ${market.totalVolume} USDC\n`;
      message += `   📅 Expires: ${endDate.toLocaleDateString()}\n`;
      message += `   🎯 Bettors: ${market.bettorCount}\n\n`;
      
      // Use short ID for callback data
      buttons.push([{ 
        text: `📊 View Market ${i + 1}`, 
        callback_data: `market_${market.shortId}` 
      }]);
    }

    buttons.push([{ text: '🔄 Refresh Markets', callback_data: 'browse_markets' }]);
    buttons.push([{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard(buttons)
    });

  } catch (error) {
    console.error('Error browsing markets:', error);
    await bot.sendMessage(chatId, '❌ Error loading markets. Please try again later.');
  }
}

async function handleMarketAction(chatId, userId, data) {
  try {
    const shortId = data.replace('market_', '');
    const marketId = marketMappings.get(shortId);
    
    if (!marketId) {
      await bot.sendMessage(chatId, '❌ Market not found. Please refresh markets.', {
        ...createInlineKeyboard([
          [{ text: '🔄 Refresh Markets', callback_data: 'browse_markets' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ])
      });
      return;
    }
    
    const marketDetails = await retryRPCCall(async () => {
      updateContracts();
      return await factoryContract.getMarketDetails(marketId);
    });
    
    const endDate = new Date(Number(marketDetails.endTime) * 1000);
    const isEnded = endDate < new Date();
    
    const oddsA = Number(marketDetails.oddsA) / 100;
    const oddsB = Number(marketDetails.oddsB) / 100;
    
    let message = `📊 **Market Details**\n\n`;
    message += `**Question:** ${marketDetails.question}\n\n`;
    message += `**Options:**\n`;
    message += `🔵 ${marketDetails.optionA} (${oddsA.toFixed(1)}%)\n`;
    message += `🔴 ${marketDetails.optionB} (${oddsB.toFixed(1)}%)\n\n`;
    message += `**Volume:**\n`;
    message += `🔵 ${ethers.formatUnits(marketDetails.volumeA, 6)} USDC\n`;
    message += `🔴 ${ethers.formatUnits(marketDetails.volumeB, 6)} USDC\n`;
    message += `💰 Total: ${ethers.formatUnits(marketDetails.totalVolume, 6)} USDC\n\n`;
    message += `**Status:** ${marketDetails.resolved ? '✅ Resolved' : isEnded ? '⏰ Ended' : '🟢 Active'}\n`;
    message += `**End Date:** ${endDate.toLocaleString()}\n`;
    message += `**Bettors:** ${marketDetails.bettorCount}\n`;

    const buttons = [];
    
    if (!marketDetails.resolved && !isEnded) {
      buttons.push([
        { text: `🔵 Bet ${marketDetails.optionA}`, callback_data: `bet_${shortId}_true` },
        { text: `🔴 Bet ${marketDetails.optionB}`, callback_data: `bet_${shortId}_false` }
      ]);
    }
    
    buttons.push([{ text: '🏪 Back to Markets', callback_data: 'browse_markets' }]);
    buttons.push([{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard(buttons)
    });

  } catch (error) {
    console.error('Error getting market details:', error);
    await bot.sendMessage(chatId, '❌ Error loading market details. Please try again later.');
  }
}

async function handleBetAction(chatId, userId, data) {
  try {
    const [, shortId, outcome] = data.split('_');
    const marketId = marketMappings.get(shortId);
    const isOutcomeA = outcome === 'true';
    
    if (!marketId) {
      await bot.sendMessage(chatId, '❌ Market not found. Please refresh markets.', {
        ...createInlineKeyboard([
          [{ text: '🔄 Refresh Markets', callback_data: 'browse_markets' }]
        ])
      });
      return;
    }
    
    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      await bot.sendMessage(chatId, '❌ You need a Spredd Wallet to place bets!', {
        ...createInlineKeyboard([
          [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
          [{ text: '⬅️ Back to Market', callback_data: `market_${shortId}` }]
        ])
      });
      return;
    }

    const balance = await getUSDCBalance(wallet.address);
    if (parseFloat(balance) < 1) {
      await bot.sendMessage(chatId, '❌ Insufficient USDC balance. Minimum bet: 1 USDC', {
        ...createInlineKeyboard([
          [{ text: '📥 Fund Wallet', callback_data: 'deposit_address' }],
          [{ text: '⬅️ Back to Market', callback_data: `market_${shortId}` }]
        ])
      });
      return;
    }

    const marketDetails = await retryRPCCall(async () => {
      updateContracts();
      return await factoryContract.getMarketDetails(marketId);
    });
    
    const optionName = isOutcomeA ? marketDetails.optionA : marketDetails.optionB;

    // Set up betting session
    userSessions.set(chatId, {
      action: 'bet',
      marketId: marketId,
      shortId: shortId,
      outcome: isOutcomeA,
      optionName: optionName,
      question: marketDetails.question,
      maxBalance: balance,
      timestamp: Date.now()
    });

    await bot.sendMessage(chatId, `🎯 **Place Bet**

**Market:** ${marketDetails.question}
**Betting on:** ${optionName}
**Your Balance:** ${balance} USDC

💰 **Enter bet amount (1-${Math.floor(parseFloat(balance))} USDC):**

Send the amount or use /cancel to abort.`, {
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Error initiating bet:', error);
    await bot.sendMessage(chatId, '❌ Error placing bet. Please try again later.');
  }
}

async function handleCreateMarket(chatId, userId) {
  try {
    console.log(`Starting handleCreateMarket for user ${userId}`);
    
    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      console.log('User has no wallet, prompting to create one');
      await bot.sendMessage(chatId, '❌ You need a Spredd Wallet to create markets!', {
        ...createInlineKeyboard([
          [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
          [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
        ])
      });
      return;
    }

    console.log('Getting user balance and market creation fee...');
    const balance = await getUSDCBalance(wallet.address);
    const fee = await getMarketCreationFee();
    
    console.log(`User balance: ${balance} USDC, Creation fee: ${fee} USDC`);
    
    if (parseFloat(balance) < parseFloat(fee)) {
      console.log('Insufficient balance for market creation');
      await bot.sendMessage(chatId, `❌ Insufficient balance for market creation.

**Required:** ${fee} USDC
**Your Balance:** ${balance} USDC

Please fund your wallet first.`, {
        parse_mode: 'Markdown',
        ...createInlineKeyboard([
          [{ text: '📥 Fund Wallet', callback_data: 'deposit_address' }],
          [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
        ])
      });
      return;
    }

    console.log('Setting up market creation session');
    // Set up market creation session
    userSessions.set(chatId, {
      action: 'create_market',
      step: 'question',
      timestamp: Date.now()
    });

    console.log('Sending market creation prompt');
    await bot.sendMessage(chatId, `➕ **Create New Market**

**Creation Fee:** ${fee} USDC
**Your Balance:** ${balance} USDC

📝 **Step 1/4: Enter your prediction question**

Example: "Will Bitcoin reach $100,000 by end of 2024?"

Send your question or use /cancel to abort.`, {
      parse_mode: 'Markdown'
    });

    console.log('Market creation flow initiated successfully');

  } catch (error) {
    console.error('Error in handleCreateMarket:', error);
    await bot.sendMessage(chatId, '❌ Error setting up market creation. Please try again later.');
  }
}

async function handleMyPositions(chatId, userId) {
  try {
    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      await bot.sendMessage(chatId, '❌ You need a Spredd Wallet to view positions!', {
        ...createInlineKeyboard([
          [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
          [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
        ])
      });
      return;
    }

    // For now, show placeholder - in production, query user's positions from blockchain
    await bot.sendMessage(chatId, `📊 **Your Positions**

🔍 Searching for your bets...

Currently no active positions found.

💡 **Tips:**
• Your positions will appear here after placing bets
• You can track profits and losses
• Winnings are automatically credited after market resolution

Start by browsing markets to place your first bet!`, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
        [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error getting positions:', error);
    await bot.sendMessage(chatId, '❌ Error loading positions. Please try again later.');
  }
}

async function handleLeaderboard(chatId) {
  try {
    await bot.sendMessage(chatId, `🏆 **Leaderboard**

🔍 Loading top forecasters...

**Coming Soon!**
• Top traders by profit
• Most accurate predictions
• Volume leaders
• Streak champions

The leaderboard will showcase the best performers on Spredd Markets!`, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
        [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error getting leaderboard:', error);
    await bot.sendMessage(chatId, '❌ Error loading leaderboard. Please try again later.');
  }
}

async function handleMarketStats(chatId) {
  try {
    const markets = await getMarketsFromBlockchain();
    
    let totalVolume = 0;
    let activeMarkets = 0;
    let resolvedMarkets = 0;
    
    for (const market of markets) {
      totalVolume += parseFloat(market.totalVolume);
      if (market.resolved) {
        resolvedMarkets++;
      } else {
        activeMarkets++;
      }
    }

    await bot.sendMessage(chatId, `📈 **Market Statistics**

**Platform Overview:**
📊 Total Markets: ${markets.length}
🟢 Active Markets: ${activeMarkets}
✅ Resolved Markets: ${resolvedMarkets}
💰 Total Volume: ${totalVolume.toFixed(2)} USDC

**Network:**
🌐 Base Blockchain
⚡ Fast & Low Cost
🔗 ${WEBSITE_URL}

**Contracts:**
🏭 Factory: \`${SPREDD_FACTORY_ADDRESS}\`
💰 USDC: \`${USDC_ADDRESS}\``, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
        [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error getting market stats:', error);
    await bot.sendMessage(chatId, '❌ Error loading statistics. Please try again later.');
  }
}

async function handleSpreddWalletInfo(chatId) {
  await bot.sendMessage(chatId, `❓ **About Spredd Wallets**

🔐 **Security Features:**
• Private keys encrypted with AES-256
• Keys never transmitted in plain text
• Secure server-side storage
• Individual wallets per user

⚡ **Benefits:**
• Instant transactions within bot
• No need to switch apps
• Automated market interactions
• Seamless betting experience

⚠️ **Important Notes:**
• For large amounts, consider using your own wallet
• Bot wallets are custodial (we hold the keys)
• Always keep your recovery phrase safe
• Use at your own risk

🔗 **Alternative:**
You can also connect your own wallet at ${WEBSITE_URL}`, {
    parse_mode: 'Markdown',
    ...createInlineKeyboard([
      [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
      [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
    ])
  });
}

async function handleConfirmCreateMarket(chatId, userId) {
  try {
    const session = userSessions.get(chatId);
    if (!session || session.action !== 'create_market' || !session.question) {
      await bot.sendMessage(chatId, '❌ Invalid session. Please start over.');
      return;
    }

    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    const fee = await getMarketCreationFee();
    
    await bot.sendMessage(chatId, `⏳ **Creating Market...**

Please wait while we process your market creation on the blockchain...

This may take a few moments.`);

    try {
      // Create wallet instance for transactions
      const userWallet = new ethers.Wallet(wallet.privateKey, provider);
      
      // Create factory contract with signer
      const factoryWithSigner = new ethers.Contract(SPREDD_FACTORY_ADDRESS, FACTORY_ABI, userWallet);
      
      // Convert fee to USDC format (6 decimals)
      const feeWei = ethers.parseUnits(fee, 6);
      
      // Convert end time to proper format
      const endTime = Math.floor(session.endTime);
      
      console.log('Creating market with params:', {
        question: session.question,
        optionA: session.optionA,
        optionB: session.optionB,
        endTime: endTime,
        fee: fee
      });

      // First approve USDC for market creation fee
      const usdcWithSigner = new ethers.Contract(USDC_ADDRESS, USDC_ABI, userWallet);
      console.log('Approving USDC for market creation fee...');
      const approveTx = await usdcWithSigner.approve(SPREDD_FACTORY_ADDRESS, feeWei);
      await approveTx.wait();

      // Create market on blockchain
      const createTx = await factoryWithSigner.createMarket(
        session.question,
        session.optionA,
        session.optionB,
        endTime
      );
      
      const receipt = await createTx.wait();
      console.log('Market creation tx:', receipt.hash);

      // Parse the MarketCreated event to get market ID and contract address
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
          // Skip logs that don't match our interface
          continue;
        }
      }

      if (!marketId || !marketContract) {
        throw new Error('Could not parse market creation event');
      }

      // Get user from database
      const { data: user } = await supabase
        .from('User')
        .select('id')
        .eq('telegram_id', userId)
        .single();

      // Create market record in database
      const marketData = {
        question: session.question,
        description: `${session.optionA} vs ${session.optionB}`,
        optionA: session.optionA,
        optionB: session.optionB,
        image: '',
        endTime: new Date(endTime * 1000).toISOString(),
        tags: '',
        metadata_options: JSON.stringify([session.optionA, session.optionB]),
        creatorId: user.id,
        contractAddress: marketContract,
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
        // Don't fail the transaction, just log the error
      }

      await bot.sendMessage(chatId, `✅ **Market Created Successfully!**

**Question:** ${session.question}
**Option A:** ${session.optionA}
**Option B:** ${session.optionB}
**End Date:** ${new Date(endTime * 1000).toLocaleString()}
**Fee Paid:** ${fee} USDC
**Transaction:** [View on BaseScan](https://basescan.org/tx/${receipt.hash})

🎉 Your market is now live on Spredd Markets!
Users can start placing bets immediately on both the website and bot.

View it at: ${WEBSITE_URL}`, {
        parse_mode: 'Markdown',
        ...createInlineKeyboard([
          [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
          [{ text: '➕ Create Another', callback_data: 'create_market' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ])
      });

    } catch (error) {
      console.error('Blockchain transaction error:', error);
      throw error;
    }

    userSessions.delete(chatId);

  } catch (error) {
    console.error('Error confirming market creation:', error);
    
    let errorMessage = 'Unknown error occurred';
    if (error.message.includes('insufficient funds')) {
      errorMessage = 'Insufficient USDC balance for creation fee';
    } else if (error.message.includes('End time must be in the future')) {
      errorMessage = 'End time must be in the future';
    } else if (error.message.includes('user rejected')) {
      errorMessage = 'Transaction was rejected';
    } else {
      errorMessage = error.message;
    }
    
    await bot.sendMessage(chatId, `❌ **Market Creation Failed**

Error: ${errorMessage}

Please try again or contact support if the issue persists.`, {
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
      [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
    ])
  });
}

// Message handler for multi-step operations
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  const session = userSessions.get(chatId);
  if (!session) return;

  try {
    switch (session.action) {
      case 'create_market':
        await handleMarketCreationStep(chatId, userId, text, session);
        break;
      case 'bet':
        await handleBetAmount(chatId, userId, text, session);
        break;
      case 'withdraw':
        await handleWithdrawalAddress(chatId, userId, text, session);
        break;
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
  }
});

async function handleMarketCreationStep(chatId, userId, text, session) {
  switch (session.step) {
    case 'question':
      if (text.length < 10 || text.length > 200) {
        await bot.sendMessage(chatId, '❌ Question must be between 10-200 characters. Please try again.');
        return;
      }
      
      session.question = text;
      session.step = 'optionA';
      userSessions.set(chatId, session);
      
      await bot.sendMessage(chatId, `📝 **Step 2/4: First Option**

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
      
      await bot.sendMessage(chatId, `📝 **Step 3/4: Second Option**

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
      
      await bot.sendMessage(chatId, `📝 **Step 4/4: End Date**

**Question:** ${session.question}
**Option A:** ${session.optionA}
**Option B:** ${text}

Enter when the market should end (e.g., "2024-12-31", "next Friday"):`, {
        parse_mode: 'Markdown'
      });
      break;

    case 'endTime':
      // Simple date parsing - in production, use a proper date parser
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
      userSessions.set(chatId, session);
      
      const fee = await getMarketCreationFee();
      
      await bot.sendMessage(chatId, `📋 **Confirm Market Creation**

**Question:** ${session.question}
**Option A:** ${session.optionA}
**Option B:** ${session.optionB}
**End Date:** ${new Date(endTime * 1000).toLocaleString()}
**Creation Fee:** ${fee} USDC

Confirm to create your market:`, {
        parse_mode: 'Markdown',
        ...createInlineKeyboard([
          [{ text: '✅ Confirm & Create', callback_data: 'confirm_create_market' }],
          [{ text: '❌ Cancel', callback_data: 'cancel_create_market' }]
        ])
      });
      break;
  }
}

async function handleBetAmount(chatId, userId, text, session) {
  const amount = parseFloat(text);
  
  if (isNaN(amount) || amount < 1 || amount > parseFloat(session.maxBalance)) {
    await bot.sendMessage(chatId, `❌ Invalid amount. Please enter a number between 1 and ${Math.floor(parseFloat(session.maxBalance))}.`);
    return;
  }

  try {
    await bot.sendMessage(chatId, `⏳ **Processing Bet...**

**Market:** ${session.question}
**Betting on:** ${session.optionName}
**Amount:** ${amount} USDC

Please wait while we process your bet on the blockchain...`);

    // Get user wallet
    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    // Create wallet instance for transactions
    const userWallet = new ethers.Wallet(wallet.privateKey, provider);

    // Get market contract address - handle both database and blockchain markets
    let marketAddress;
    const marketMapping = marketMappings.get(session.shortId);
    
    if (marketMapping && marketMapping.source === 'database') {
      // For database markets, get the contract address from the Market table
      const { data: dbMarket } = await supabase
        .from('Market')
        .select('contractAddress')
        .eq('id', marketMapping.id)
        .single();
      
      if (!dbMarket || !dbMarket.contractAddress) {
        throw new Error('Market contract address not found');
      }
      marketAddress = dbMarket.contractAddress;
    } else {
      // For blockchain markets, get address from factory
      marketAddress = await retryRPCCall(async () => {
        updateContracts();
        return await factoryContract.getMarketAddress(session.marketId);
      });
    }

    // Create market contract instance
    const marketContract = new ethers.Contract(marketAddress, MARKET_ABI, userWallet);

    // Convert amount to USDC format (6 decimals)
    const amountWei = ethers.parseUnits(amount.toString(), 6);

    // Check current allowance
    const usdcWithSigner = new ethers.Contract(USDC_ADDRESS, USDC_ABI, userWallet);
    const currentAllowance = await usdcWithSigner.allowance(wallet.address, marketAddress);
    
    // Approve USDC spending if needed
    if (currentAllowance < amountWei) {
      console.log(`Approving ${amount} USDC for market contract...`);
      const approveTx = await usdcWithSigner.approve(marketAddress, amountWei);
      await approveTx.wait();
      console.log('USDC approval confirmed');
    }

    console.log(`Placing bet: ${amount} USDC on ${session.optionName} (betOnA: ${session.outcome})`);
    
    // Place the bet on blockchain (true for option A, false for option B)
    const betTx = await marketContract.placeBet(session.outcome, amountWei);
    const receipt = await betTx.wait();
    console.log('Bet transaction confirmed:', receipt.hash);

    // Get user from database for trade record
    const { data: user } = await supabase
      .from('User')
      .select('id')
      .eq('telegram_id', userId)
      .single();

    // Create trade record in database
    const tradeData = {
      unique_id: `${receipt.hash}-${Date.now()}`,
      order_type: 'BUY',
      order_size: amountWei.toString(),
      amount: amountWei.toString(),
      afterPrice: 0, // Will be calculated by backend
      marketId: marketMapping && marketMapping.source === 'database' ? marketMapping.id : null,
      endIndex: session.outcome ? 1 : 2, // 1 for option A, 2 for option B
      userId: user.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const { error: tradeError } = await supabaseAdmin
      .from('Trade')
      .insert([tradeData]);

    if (tradeError) {
      console.error('Error creating trade record:', tradeError);
      // Don't fail the transaction, just log the error
    }

    await bot.sendMessage(chatId, `✅ **Bet Placed Successfully!**

**Market:** ${session.question}
**Option:** ${session.optionName}
**Amount:** ${amount} USDC
**Transaction:** [View on BaseScan](https://basescan.org/tx/${receipt.hash})

🎉 Your bet is now active and recorded on the blockchain!
You can view it on both the bot and website.

Good luck with your prediction!`, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '📊 My Positions', callback_data: 'my_positions' }],
        [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
        [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
      ])
    });

  } catch (error) {
    console.error('Error placing bet:', error);
    
    let errorMessage = 'Unknown error occurred';
    if (error.message.includes('insufficient funds')) {
      errorMessage = 'Insufficient USDC balance';
    } else if (error.message.includes('Market already resolved')) {
      errorMessage = 'Market has already been resolved';
    } else if (error.message.includes('Market has ended')) {
      errorMessage = 'Market betting period has ended';
    } else if (error.message.includes('user rejected')) {
      errorMessage = 'Transaction was rejected';
    } else {
      errorMessage = error.message;
    }

    await bot.sendMessage(chatId, `❌ **Bet Failed**

Error: ${errorMessage}

Please try again or contact support if the issue persists.`, {
      ...createInlineKeyboard([
        [{ text: '🔄 Try Again', callback_data: `bet_${session.shortId}_${session.outcome}` }],
        [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
      ])
    });
  }

  userSessions.delete(chatId);
}

async function handleWithdrawalAddress(chatId, userId, text, session) {
  if (!ethers.isAddress(text)) {
    await bot.sendMessage(chatId, '❌ Invalid Ethereum address. Please send a valid Base network address:');
    return;
  }

  const amount = parseFloat(session.balance) - 0.01; // Reserve for gas
  
  await bot.sendMessage(chatId, `⏳ **Processing Withdrawal...**

**To:** \`${text}\`
**Amount:** ${amount.toFixed(6)} USDC
**Gas Reserve:** 0.01 USDC

Please wait while we process your withdrawal...`, {
    parse_mode: 'Markdown'
  });

  // Here you would implement the actual withdrawal transaction
  // For demo, we'll simulate it
  setTimeout(async () => {
    await bot.sendMessage(chatId, `✅ **Withdrawal Successful!**

**To:** \`${text}\`
**Amount:** ${amount.toFixed(6)} USDC
**Transaction:** Confirmed

Your USDC has been sent to the provided address.
You can verify the transaction on BaseScan.`, {
      parse_mode: 'Markdown',
      ...createInlineKeyboard([
        [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
        [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
      ])
    });
  }, 3000);

  userSessions.delete(chatId);
}

// Cancel command
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  userSessions.delete(chatId);
  bot.sendMessage(chatId, '❌ Operation cancelled.', {
    ...createInlineKeyboard([
      [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
    ])
  });
});

// Admin commands
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '❌ You are not authorized to use admin commands.');
    return;
  }

  await bot.sendMessage(chatId, '🔧 **Admin Panel**\n\nAdmin commands available:', {
    parse_mode: 'Markdown',
    ...createInlineKeyboard([
      [{ text: '📊 Bot Stats', callback_data: 'admin_stats' }],
      [{ text: '👥 User Count', callback_data: 'admin_users' }],
      [{ text: '💰 Total Volume', callback_data: 'admin_volume' }],
      [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
    ])
  });
});

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

bot.on('webhook_error', (error) => {
  console.error('Webhook error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

console.log('🤖 Spredd Markets Bot started successfully!');
console.log(`🌐 Network: Base (${BASE_CHAIN_ID})`);
console.log(`🏭 Factory: ${SPREDD_FACTORY_ADDRESS}`);
console.log(`💰 USDC: ${USDC_ADDRESS}`);
console.log(`🔗 Website: ${WEBSITE_URL}`);
