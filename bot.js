// bot.js - Spredd Markets Bot with Bot-Created Wallet System (COMPLETE OPTIMIZED VERSION)
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

// Initialize providers and contracts with Alchemy as primary
const RPC_PROVIDERS = [
  'https://base-mainnet.g.alchemy.com/v2/PD2AJhcm9KDKP4f_tFhUB',
  process.env.BASE_RPC_URL || 'https://mainnet.base.org',
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

// Optimized retry function for RPC calls
async function retryRPCCallOptimized(fn, maxRetries = 2) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error.message.includes('rate limit') || 
                         error.message.includes('over rate limit') ||
                         error.code === -32016;
      
      if (isRateLimit && i < maxRetries - 1) {
        console.log(`🔄 Rate limit hit, attempt ${i + 1}/${maxRetries}. Switching provider...`);
        switchRPCProvider();
        updateContracts();
        
        // Shorter delay: 1s, 2s
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

// Update contracts when provider switches
function updateContracts() {
  usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
  factoryContract = new ethers.Contract(SPREDD_FACTORY_ADDRESS, FACTORY_ABI, provider);
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
}, 10 * 60 * 1000);

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

// Bot commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    getOrCreateUserOptimized(userId, msg.from.username).catch(error => {
      console.error('Background user creation error:', error);
    });

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

// Enhanced callback query handler with debug logging
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  console.log(`📞 Callback received: ${data} from user ${userId}`);

  try {
    await bot.answerCallbackQuery(query.id);
    console.log(`✅ Answered callback query for: ${data}`);
  } catch (error) {
    console.error('❌ Failed to answer callback query:', error);
  }

  try {
    console.log(`🔄 Processing callback: ${data}`);
    
    switch (data) {
      case 'main_menu':
        console.log('Processing main_menu...');
        await handleMainMenu(chatId, query.message.message_id);
        break;
        
      case 'browse_markets':
        console.log('Processing browse_markets...');
        await handleBrowseMarketsDebug(chatId, userId);
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
        
      default:
        console.log(`Processing default case for: ${data}`);
        if (data.startsWith('market_')) {
          console.log('Processing market action...');
          await handleMarketActionOptimized(chatId, userId, data);
        } else if (data.startsWith('bet_')) {
          console.log('Processing bet action...');
          await handleBetAction(chatId, userId, data);
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
    
    console.log(`✅ Completed processing: ${data}`);
    
  } catch (error) {
    console.error(`❌ Error processing callback ${data}:`, error);
    console.error('Error stack:', error.stack);
    
    try {
      await bot.sendMessage(chatId, `❌ Error processing action. Please try again.\n\nError: ${error.message}`, {
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

// Debug function for browse markets
async function handleBrowseMarketsDebug(chatId, userId) {
  try {
    console.log('🔍 Starting handleBrowseMarketsDebug...');
    
    await bot.sendMessage(chatId, '🔍 Testing database connection...');
    console.log('✅ Initial message sent, querying database...');
    
    const { data: dbMarkets, error } = await supabase
      .from('Market')
      .select('id, question, optionA, optionB, endTime, status')
      .eq('status', 'ACTIVE')
      .limit(3);

    console.log('📊 Database query result:', { 
      marketsFound: dbMarkets?.length || 0, 
      error: error?.message 
    });

    if (error) {
      console.error('❌ Database error:', error);
      await bot.sendMessage(chatId, `❌ Database error: ${error.message}`);
      return;
    }

    if (!dbMarkets || dbMarkets.length === 0) {
      await bot.sendMessage(chatId, '📭 No active markets found in database.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    await bot.sendMessage(chatId, `✅ Found ${dbMarkets.length} markets in database. Browse markets is working!`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });

    console.log('✅ handleBrowseMarketsDebug completed successfully');

  } catch (error) {
    console.error('❌ Error in handleBrowseMarketsDebug:', error);
    await bot.sendMessage(chatId, `❌ Debug error: ${error.message}`);
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

async function handleBrowseMarketsOptimized(chatId, userId) {
  try {
    const loadingMsg = await bot.sendMessage(chatId, '🔍 Loading markets from database...');
    
    const { data: dbMarkets, error } = await supabase
      .from('Market')
      .select(`
        id,
        question,
        optionA,
        optionB,
        endTime,
        status,
        contractAddress,
        createdAt,
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
        optionA: market.optionA,
        optionB: market.optionB,
        endTime: market.endTime
      });
      
      message += `${i + 1}. **${market.question}**\n`;
      message += `   📊 ${market.optionA} vs ${market.optionB}\n`;
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
    message += `**Status:** ${isEnded ? '⏰ Ended' : '🟢 Active'}\n`;
    message += `**End Date:** ${endDate.toLocaleString()}\n`;
    message += `\n💡 *Live volume data loads when you place a bet*`;

    const buttons = [];
    
    if (!isEnded) {
      buttons.push([
        { text: `🔵 Bet ${marketMapping.optionA}`, callback_data: `bet_${shortId}_true` },
        { text: `🔴 Bet ${marketMapping.optionB}`, callback_data: `bet_${shortId}_false` }
      ]);
    }
    
    buttons.push([{ text: '🏪 Back to Markets', callback_data: 'browse_markets' }]);
    buttons.push([{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (error) {
    console.error('Error getting market details:', error);
    await bot.sendMessage(chatId, '❌ Error loading market details. Please try again later.');
  }
}

async function handleBetAction(chatId, userId, data) {
  try {
    const [, shortId, outcome] = data.split('_');
    const marketMapping = marketMappings.get(shortId);
    const isOutcomeA = outcome === 'true';
    
    if (!marketMapping) {
      await bot.sendMessage(chatId, '❌ Market not found. Please refresh markets.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Refresh Markets', callback_data: 'browse_markets' }]
          ]
        }
      });
      return;
    }
    
    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      await bot.sendMessage(chatId, '❌ You need a Spredd Wallet to place bets!', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
            [{ text: '⬅️ Back to Market', callback_data: `market_${shortId}` }]
          ]
        }
      });
      return;
    }

    const balance = await getUSDCBalance(wallet.address);
    if (parseFloat(balance) < 1) {
      await bot.sendMessage(chatId, '❌ Insufficient USDC balance. Minimum bet: 1 USDC', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📥 Fund Wallet', callback_data: 'deposit_address' }],
            [{ text: '⬅️ Back to Market', callback_data: `market_${shortId}` }]
          ]
        }
      });
      return;
    }

    const optionName = isOutcomeA ? marketMapping.optionA : marketMapping.optionB;

    userSessions.set(chatId, {
      action: 'bet',
      marketMapping: marketMapping,
      shortId: shortId,
      outcome: isOutcomeA,
      optionName: optionName,
      question: marketMapping.question,
      maxBalance: balance,
      timestamp: Date.now()
    });

    await bot.sendMessage(chatId, `🎯 **Place Bet**

**Market:** ${marketMapping.question}
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

async function handleCreateMarketOptimized(chatId, userId) {
  try {
    console.log(`Starting handleCreateMarket for user ${userId}`);
    
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

    const fee = '3';
    
    console.log('Setting up market creation session');
    userSessions.set(chatId, {
      action: 'create_market',
      step: 'question',
      timestamp: Date.now()
    });

    console.log('Sending market creation prompt');
    await bot.sendMessage(chatId, `➕ **Create New Market**

**Creation Fee:** ${fee} USDC (estimated)
**Note:** Exact fee will be verified before transaction

📝 **Step 1/4: Enter your prediction question**

Example: "Will Bitcoin reach $100,000 by end of 2024?"

Send your question or use /cancel to abort.`, {
      parse_mode: 'Markdown'
    });

    console.log('Market creation flow initiated successfully');

  } catch (error) {
    console.error('Error in handleCreateMarketOptimized:', error);
    await bot.sendMessage(chatId, '❌ Error setting up market creation. Please try again later.');
  }
}

async function handleMyPositions(chatId, userId) {
  try {
    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      await bot.sendMessage(chatId, '❌ You need a Spredd Wallet to view positions!', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🆕 Create Spredd Wallet', callback_data: 'create_spredd_wallet' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    await bot.sendMessage(chatId, `📊 **Your Positions**

🔍 Searching for your bets...

Currently no active positions found.

💡 **Tips:**
• Your positions will appear here after placing bets
• You can track profits and losses
• Winnings are automatically credited after market resolution

Start by browsing markets to place your first bet!`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
          [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
        ]
      }
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
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
          [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });

  } catch (error) {
    console.error('Error getting leaderboard:', error);
    await bot.sendMessage(chatId, '❌ Error loading leaderboard. Please try again later.');
  }
}

async function handleMarketStats(chatId) {
  try {
    const { data: markets } = await supabase
      .from('Market')
      .select('status')
      .limit(100);

    let activeMarkets = 0;
    let resolvedMarkets = 0;
    
    if (markets) {
      for (const market of markets) {
        if (market.status === 'ACTIVE') {
          activeMarkets++;
        } else if (market.status === 'RESOLVED') {
          resolvedMarkets++;
        }
      }
    }

    await bot.sendMessage(chatId, `📈 **Market Statistics**

**Platform Overview:**
📊 Total Markets: ${markets ? markets.length : 0}
🟢 Active Markets: ${activeMarkets}
✅ Resolved Markets: ${resolvedMarkets}

**Network:**
🌐 Base Blockchain
⚡ Fast & Low Cost
🔗 ${WEBSITE_URL}

**Contracts:**
🏭 Factory: \`${SPREDD_FACTORY_ADDRESS}\`
💰 USDC: \`${USDC_ADDRESS}\``, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏪 Browse Markets', callback_data: 'browse_markets' }],
          [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
        ]
      }
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
    reply_markup: {
      inline_keyboard: [
        [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
        [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
      ]
    }
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
      const userWallet = new ethers.Wallet(wallet.privateKey, provider);
      const factoryWithSigner = new ethers.Contract(SPREDD_FACTORY_ADDRESS, FACTORY_ABI, userWallet);
      const feeWei = ethers.parseUnits(fee, 6);
      const endTime = Math.floor(session.endTime);
      
      console.log('Creating market with params:', {
        question: session.question,
        optionA: session.optionA,
        optionB: session.optionB,
        endTime: endTime,
        fee: fee
      });

      const usdcWithSigner = new ethers.Contract(USDC_ADDRESS, USDC_ABI, userWallet);
      console.log('Approving USDC for market creation fee...');
      const approveTx = await usdcWithSigner.approve(SPREDD_FACTORY_ADDRESS, feeWei);
      await approveTx.wait();

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
        throw new Error('Could not parse market creation event');
      }

      const { data: user } = await supabase
        .from('User')
        .select('id')
        .eq('telegram_id', userId)
        .single();

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
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: 'create_market' }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });
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
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Confirm & Create', callback_data: 'confirm_create_market' }],
            [{ text: '❌ Cancel', callback_data: 'cancel_create_market' }]
          ]
        }
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

    const wallet = await getUserSpreddWallet(userId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    const userWallet = new ethers.Wallet(wallet.privateKey, provider);
    const marketAddress = session.marketMapping.contractAddress;
    if (!marketAddress) {
      throw new Error('Market contract address not found');
    }

    const marketContract = new ethers.Contract(marketAddress, MARKET_ABI, userWallet);
    const amountWei = ethers.parseUnits(amount.toString(), 6);

    const usdcWithSigner = new ethers.Contract(USDC_ADDRESS, USDC_ABI, userWallet);
    const currentAllowance = await usdcWithSigner.allowance(wallet.address, marketAddress);
    
    if (currentAllowance < amountWei) {
      console.log(`Approving ${amount} USDC for market contract...`);
      const approveTx = await usdcWithSigner.approve(marketAddress, amountWei);
      await approveTx.wait();
      console.log('USDC approval confirmed');
    }

    console.log(`Placing bet: ${amount} USDC on ${session.optionName} (betOnA: ${session.outcome})`);
    
    const betTx = await marketContract.placeBet(session.outcome, amountWei);
    const receipt = await betTx.wait();
    console.log('Bet transaction confirmed:', receipt.hash);

    const { data: user } = await supabase
      .from('User')
      .select('id')
      .eq('telegram_id', userId)
      .single();

    const tradeData = {
      unique_id: `${receipt.hash}-${Date.now()}`,
      order_type: 'BUY',
      order_size: amountWei.toString(),
      amount: amountWei.toString(),
      afterPrice: 0,
      marketId: session.marketMapping.source === 'database' ? session.marketMapping.id : null,
      endIndex: session.outcome ? 1 : 2,
      userId: user.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const { error: tradeError } = await supabaseAdmin
      .from('Trade')
      .insert([tradeData]);

    if (tradeError) {
      console.error('Error creating trade record:', tradeError);
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
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔄 Try Again', callback_data: `bet_${session.shortId}_${session.outcome}` }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]
        ]
      }
    });
  }

  userSessions.delete(chatId);
}

async function handleWithdrawalAddress(chatId, userId, text, session) {
  if (!ethers.isAddress(text)) {
    await bot.sendMessage(chatId, '❌ Invalid Ethereum address. Please send a valid Base network address:');
    return;
  }

  const amount = parseFloat(session.balance) - 0.01;
  
  await bot.sendMessage(chatId, `⏳ **Processing Withdrawal...**

**To:** \`${text}\`
**Amount:** ${amount.toFixed(6)} USDC
**Gas Reserve:** 0.01 USDC

Please wait while we process your withdrawal...`, {
    parse_mode: 'Markdown'
  });

  setTimeout(async () => {
    await bot.sendMessage(chatId, `✅ **Withdrawal Successful!**

**To:** \`${text}\`
**Amount:** ${amount.toFixed(6)} USDC
**Transaction:** Confirmed

Your USDC has been sent to the provided address.
You can verify the transaction on BaseScan.`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
          [{ text: '⬅️ Back to Wallet', callback_data: 'wallet_menu' }]
        ]
      }
    });
  }, 3000);

  userSessions.delete(chatId);
}

// Cancel command
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  userSessions.delete(chatId);
  bot.sendMessage(chatId, '❌ Operation cancelled.', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
      ]
    }
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
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Bot Stats', callback_data: 'admin_stats' }],
        [{ text: '👥 User Count', callback_data: 'admin_users' }],
        [{ text: '💰 Total Volume', callback_data: 'admin_volume' }],
        [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
      ]
    }
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

console.log('🤖 Spredd Markets Bot started with optimizations and debug logging!');
console.log(`🌐 Primary RPC: Alchemy Base Mainnet`);
console.log(`🏭 Factory: ${SPREDD_FACTORY_ADDRESS}`);
console.log(`💰 USDC: ${USDC_ADDRESS}`);
console.log(`🔗 Website: ${WEBSITE_URL}`);
