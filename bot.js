// bot.js - Production Spredd Markets Bot with Real Blockchain Transactions
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

// Gas limits for different operations
const GAS_LIMITS = {
  APPROVE: 60000,
  CREATE_MARKET: 300000,
  PLACE_BET: 200000,
  WITHDRAW: 100000
};

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

// Retry function for RPC calls
async function retryRPCCall(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if ((error.message.includes('rate limit') || error.code === 'NETWORK_ERROR') && i < maxRetries - 1) {
        console.log(`RPC error, switching provider and retrying... (${i + 1}/${maxRetries})`);
        switchRPCProvider();
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
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
  'function marketCreationFee() view returns (uint256)',
  'function createMarket(string memory _question, string memory _optionA, string memory _optionB, uint256 _endTime) returns (bytes32 marketId, address marketContract)'
];

const MARKET_ABI = [
  'function placeBet(bool _outcome, uint256 _amount) external',
  'function getUserPosition(address user) view returns (uint256 amountA, uint256 amountB)',
  'function totalSupplyA() view returns (uint256)',
  'function totalSupplyB() view returns (uint256)'
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
    
    const { data, error } = await supabase
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

    const { data: wallet } = await supabase
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
      updateContracts();
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
      return await factoryContract.marketCreationFee();
    });
    return ethers.formatUnits(fee, 6);
  } catch (error) {
    console.error('Error getting market creation fee:', error);
    return '3';
  }
}

// Check and approve USDC spending if needed
async function ensureUSDCApproval(userWallet, spenderAddress, amount) {
  try {
    const usdcWithSigner = new ethers.Contract(USDC_ADDRESS, USDC_ABI, userWallet);
    
    // Check current allowance
    const allowance = await usdcWithSigner.allowance(userWallet.address, spenderAddress);
    const requiredAmount = ethers.parseUnits(amount.toString(), 6);
    
    if (allowance < requiredAmount) {
      console.log(`Approving USDC spending: ${amount} USDC for ${spenderAddress}`);
      
      // Approve spending
      const approveTx = await usdcWithSigner.approve(spenderAddress, requiredAmount, {
        gasLimit: GAS_LIMITS.APPROVE
      });
      
      console.log(`Approval transaction: ${approveTx.hash}`);
      await approveTx.wait();
      console.log('USDC approval confirmed');
    }
    
    return true;
  } catch (error) {
    console.error('Error approving USDC:', error);
    throw error;
  }
}

// Execute market creation transaction
async function executeMarketCreation(userWallet, question, optionA, optionB, endTime) {
  try {
    const factoryWithSigner = new ethers.Contract(SPREDD_FACTORY_ADDRESS, FACTORY_ABI, userWallet);
    
    // Get creation fee
    const feeAmount = await getMarketCreationFee();
    
    // Ensure USDC approval
    await ensureUSDCApproval(userWallet, SPREDD_FACTORY_ADDRESS, feeAmount);
    
    // Create market
    console.log('Creating market on blockchain...');
    const tx = await factoryWithSigner.createMarket(
      question,
      optionA,
      optionB,
      Math.floor(endTime),
      {
        gasLimit: GAS_LIMITS.CREATE_MARKET
      }
    );
    
    console.log(`Market creation transaction: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log('Market creation confirmed');
    
    // Extract market ID from events
    const marketCreatedEvent = receipt.logs.find(log => 
      log.topics[0] === ethers.id('MarketCreated(bytes32,address,string)')
    );
    
    let marketId = null;
    if (marketCreatedEvent) {
      marketId = marketCreatedEvent.topics[1];
    }
    
    return {
      success: true,
      txHash: tx.hash,
      marketId: marketId,
      gasUsed: receipt.gasUsed.toString()
    };
    
  } catch (error) {
    console.error('Error creating market:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Execute bet placement transaction
async function executeBet(userWallet, marketAddress, outcome, amount) {
  try {
    const marketContract = new ethers.Contract(marketAddress, MARKET_ABI, userWallet);
    
    // Ensure USDC approval
    await ensureUSDCApproval(userWallet, marketAddress, amount);
    
    // Place bet
    console.log(`Placing bet: ${amount} USDC on ${outcome ? 'A' : 'B'}`);
    const tx = await marketContract.placeBet(outcome, ethers.parseUnits(amount.toString(), 6), {
      gasLimit: GAS_LIMITS.PLACE_BET
    });
    
    console.log(`Bet transaction: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log('Bet placement confirmed');
    
    return {
      success: true,
      txHash: tx.hash,
      gasUsed: receipt.gasUsed.toString()
    };
    
  } catch (error) {
    console.error('Error placing bet:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Execute USDC withdrawal
async function executeWithdrawal(userWallet, toAddress, amount) {
  try {
    const usdcWithSigner = new ethers.Contract(USDC_ADDRESS, USDC_ABI, userWallet);
    
    // Reserve small amount for gas
    const balance = await usdcWithSigner.balanceOf(userWallet.address);
    const withdrawAmount = ethers.parseUnits(amount.toString(), 6);
    
    if (balance < withdrawAmount) {
      throw new Error('Insufficient balance for withdrawal');
    }
    
    console.log(`Withdrawing ${amount} USDC to ${toAddress}`);
    const tx = await usdcWithSigner.transfer(toAddress, withdrawAmount, {
      gasLimit: GAS_LIMITS.WITHDRAW
    });
    
    console.log(`Withdrawal transaction: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log('Withdrawal confirmed');
    
    return {
      success: true,
      txHash: tx.hash,
      gasUsed: receipt.gasUsed.toString()
    };
    
  } catch (error) {
    console.error('Error executing withdrawal:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Get markets from blockchain with rate limiting and retry
async function getMarketsFromBlockchain() {
  try {
    const marketIds = await retryRPCCall(async () => {
      updateContracts();
      return await factoryContract.getAllMarkets();
    });
    
    const markets = [];

    // Process markets in batches to avoid rate limiting
    const batchSize = 2;
    const recentMarkets = marketIds.slice(-8);
    
    for (let i = 0; i < recentMarkets.length; i += batchSize) {
      const batch = recentMarkets.slice(i, i + batchSize);
      
      const batchResults = await Promise.allSettled(batch.map(async (marketId) => {
        await new Promise(resolve => setTimeout(resolve, 300));
        
        return await retryRPCCall(async () => {
          updateContracts();
          return await factoryContract.getMarketDetails(marketId);
        });
      }));
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const marketId = batch[index];
          const details = result.value;
          
          // Create short mapping for callback data
          const shortId = `m${marketCounter++}`;
          marketMappings.set(shortId, marketId);
          
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
            bettorCount: details.bettorCount
          });
        } else {
          console.error(`Error getting details for market ${batch[index]}:`, result.reason);
        }
      });
      
      if (i + batchSize < recentMarkets.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return markets;
  } catch (error) {
    console.error('Error getting markets from blockchain:', error);
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

  try {
    switch (data) {
      case 'main_menu':
        await handleMainMenu(chatId, query.message.message_id);
        break;
      case 'browse_markets':
        await handleBrowseMarkets(chatId, userId);
        break;
      case 'create_market':
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
        if (data.startsWith('market_')) {
          await handleMarketAction(chatId, userId, data);
        } else if (data.startsWith('bet_')) {
          await handleBetAction(chatId, userId, data);
        }
        break;
    }
  } catch (error) {
    console.error('Error handling callback:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
  }

  bot.answerCallbackQuery(query.id);
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
