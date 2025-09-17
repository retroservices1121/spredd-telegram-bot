// bot.js - Spredd Markets Telegram Bot for Base blockchain
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

// Initialize providers and contracts
const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
const adminWallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);

// Contract ABIs (minimal required functions)
const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

const FACTORY_ABI = [
  'function getAllMarkets() view returns (bytes32[] memory)',
  'function getMarketDetails(bytes32 _marketId) view returns (string memory question, string memory optionA, string memory optionB, uint256 endTime, bool resolved, uint256 volumeA, uint256 volumeB, uint256 totalVolume, uint256 oddsA, uint256 oddsB, uint256 bettorCount)',
  'function getMarketAddress(bytes32 _marketId) view returns (address)',
  'function marketCreationFee() view returns (uint256)',
  'function tradingToken() view returns (address)'
];

// Initialize contracts
const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
const factoryContract = new ethers.Contract(SPREDD_FACTORY_ADDRESS, FACTORY_ABI, provider);

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

  // Set webhook for Railway
  const webhookUrl = process.env.RAILWAY_STATIC_URL || process.env.WEBHOOK_URL;
  if (webhookUrl) {
    bot.setWebHook(`${webhookUrl}/bot${token}`);
    console.log(`📡 Webhook set: ${webhookUrl}/bot${token}`);
  }
}

// Admin user IDs - REPLACE WITH YOUR TELEGRAM USER ID
const ADMIN_IDS = [
  258664955, // Replace with your actual Telegram user ID from @userinfobot
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
  [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
  [{ text: '🔗 Connect Wallet', callback_data: 'connect_wallet' }],
  [{ text: '💸 Claim Winnings', callback_data: 'claim_winnings' }],
  [{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]
]);

// Helper functions for blockchain integration

// Get or create user with wallet address
async function getOrCreateUser(telegramId, username = null, walletAddress = null) {
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
        wallet_address: walletAddress,
        about: "Hey, I'm a forecaster!", // Add this line to match your existing data
        created_at: new Date().toISOString()
      };

      const { data: createdUser, error: createError } = await supabase
        .from('User')
        .insert([newUser])
        .select()
        .single();

      if (createError) throw createError;
      return createdUser;
    }

    // Update wallet address if provided
    if (walletAddress && user.wallet_address !== walletAddress) {
      const { data: updatedUser, error: updateError } = await supabase
        .from('User')
        .update({ wallet_address: walletAddress })
        .eq('id', user.id)
        .select()
        .single();

      if (updateError) throw updateError;
      return updatedUser;
    }

    return user;
  } catch (error) {
    console.error('Error in getOrCreateUser:', error);
    throw error;
  }
}

// Get USDC balance for an address
async function getUSDCBalance(address) {
  try {
    if (!ethers.isAddress(address)) return '0';
    const balance = await usdcContract.balanceOf(address);
    return ethers.formatUnits(balance, 6); // USDC has 6 decimals
  } catch (error) {
    console.error('Error getting USDC balance:', error);
    return '0';
  }
}

// Get market creation fee
async function getMarketCreationFee() {
  try {
    const fee = await factoryContract.marketCreationFee();
    return ethers.formatUnits(fee, 6); // Convert to USDC
  } catch (error) {
    console.error('Error getting market creation fee:', error);
    return '3'; // Default to 3 USDC
  }
}

// Get markets from blockchain
async function getMarketsFromBlockchain() {
  try {
    const marketIds = await factoryContract.getAllMarkets();
    const markets = [];

    for (const marketId of marketIds.slice(-10)) { // Get last 10 markets
      try {
        const details = await factoryContract.getMarketDetails(marketId);
        markets.push({
          id: marketId,
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
      } catch (error) {
        console.error(`Error getting details for market ${marketId}:`, error);
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
**Factory:** \`${SPREDD_FACTORY_ADDRESS}\`

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

// Admin command
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, '❌ Access denied. Admin privileges required.');
    return;
  }

  const adminMenu = createInlineKeyboard([
    [{ text: '🔧 Contract Info', callback_data: 'admin_contract_info' }],
    [{ text: '📊 Blockchain Stats', callback_data: 'admin_blockchain_stats' }],
    [{ text: '💰 Treasury Status', callback_data: 'admin_treasury' }]
  ]);

  bot.sendMessage(chatId, '🔧 **Admin Panel**\n\nChoose an action:', {
    parse_mode: 'Markdown',
    ...adminMenu
  });
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
      case 'check_balance':
        await handleCheckBalance(chatId, userId);
        break;
      case 'connect_wallet':
        await handleConnectWallet(chatId, userId);
        break;
      case 'claim_winnings':
        await handleClaimWinnings(chatId, userId);
        break;
      // Admin actions
      case 'admin_contract_info':
        await handleAdminContractInfo(chatId);
        break;
      case 'admin_blockchain_stats':
        await handleAdminBlockchainStats(chatId);
        break;
      case 'admin_treasury':
        await handleAdminTreasury(chatId);
        break;
      // Market creation confirmation
      case 'confirm_create_market':
        await handleConfirmCreateMarket(chatId, userId);
        break;
      case 'cancel_create_market':
        await handleCancelCreateMarket(chatId);
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

async function handleBrowseMarkets(chatId, userId) {
  try {
    await bot.sendMessage(chatId, '🔄 Loading markets from Base blockchain...');
    
    const markets = await getMarketsFromBlockchain();

    if (!markets.length) {
      bot.sendMessage(chatId, '📭 No active markets found on Base blockchain.');
      return;
    }

    let message = '🏪 **Active Markets on Base:**\n\n';
    const buttons = [];

    markets.forEach((market, index) => {
      const expiryDate = new Date(Number(market.endTime) * 1000).toLocaleDateString();
      message += `${index + 1}. **${market.question}**\n`;
      message += `   📊 ${market.optionA} vs ${market.optionB}\n`;
      message += `   💰 Volume: ${market.totalVolume} USDC\n`;
      message += `   📅 Expires: ${expiryDate}\n`;
      message += `   🎯 Bettors: ${market.bettorCount}\n\n`;
      
      buttons.push([{
        text: `📊 View Market ${index + 1}`,
        callback_data: `market_${market.id}`
      }]);
    });

    buttons.push([{ text: '⬅️ Back to Main Menu', callback_data: 'main_menu' }]);

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    console.error('Error browsing markets:', error);
    bot.sendMessage(chatId, '❌ Error loading markets from blockchain.');
  }
}

async function handleCreateMarket(chatId, userId) {
  try {
    const user = await getOrCreateUser(userId);
    
    if (!user.wallet_address) {
      bot.sendMessage(chatId, '❌ Please connect your wallet first using the wallet menu.');
      return;
    }

    const fee = await getMarketCreationFee();
    const balance = await getUSDCBalance(user.wallet_address);

    if (parseFloat(balance) < parseFloat(fee)) {
      bot.sendMessage(chatId, `❌ Insufficient USDC balance. You need ${fee} USDC to create a market.\n\nYour balance: ${balance} USDC`);
      return;
    }
    
    userSessions.set(chatId, { 
      action: 'creating_market', 
      step: 'question',
      marketData: {},
      userId: user.id,
      walletAddress: user.wallet_address,
      timestamp: Date.now()
    });

    bot.sendMessage(chatId, `➕ **Create New Market**\n\n💰 Creation fee: ${fee} USDC\n\nPlease enter the market question:`, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error starting market creation:', error);
    bot.sendMessage(chatId, '❌ Error starting market creation.');
  }
}

async function handleWalletMenu(chatId, messageId) {
  try {
    await bot.editMessageText('💰 **Wallet Management**\n\nConnect your Base wallet to start trading:', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      ...walletMenu
    });
  } catch (error) {
    await bot.sendMessage(chatId, '💰 **Wallet Management**\n\nConnect your Base wallet to start trading:', {
      parse_mode: 'Markdown',
      ...walletMenu
    });
  }
}

async function handleConnectWallet(chatId, userId) {
  userSessions.set(chatId, { 
    action: 'connecting_wallet',
    userId: userId,
    timestamp: Date.now()
  });

  bot.sendMessage(chatId, '🔗 **Connect Base Wallet**\n\nPlease enter your Base wallet address (0x...):\n\n⚠️ Make sure this wallet has USDC on Base network!', {
    parse_mode: 'Markdown'
  });
}

async function handleCheckBalance(chatId, userId) {
  try {
    const user = await getOrCreateUser(userId);

    if (!user.wallet_address) {
      bot.sendMessage(chatId, '❌ No wallet connected. Please connect your Base wallet first.');
      return;
    }

    const balance = await getUSDCBalance(user.wallet_address);
    const fee = await getMarketCreationFee();

    bot.sendMessage(chatId, `💰 **Your Base Wallet**\n\n🏦 Address: \`${user.wallet_address}\`\n💵 USDC Balance: ${balance}\n💳 Market Creation Fee: ${fee} USDC\n\n🌐 Network: Base`, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error checking balance:', error);
    bot.sendMessage(chatId, '❌ Error checking wallet balance.');
  }
}

async function handleMyPositions(chatId, userId) {
  try {
    const user = await getOrCreateUser(userId);
    
    if (!user.wallet_address) {
      bot.sendMessage(chatId, '❌ No wallet connected. Please connect your Base wallet first.');
      return;
    }

    // Get positions from database (synced from blockchain events)
    const { data: positions, error } = await supabase
      .from('positions')
      .select(`
        *,
        markets(
          description,
          question,
          status,
          winning_outcome,
          contract_address
        )
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error || !positions?.length) {
      bot.sendMessage(chatId, '📭 No positions found.\n\nStart by browsing markets and placing bets!');
      return;
    }

    let message = '📊 **Your Positions:**\n\n';
    let totalValue = 0;
    let winnings = 0;

    for (const position of positions) {
      const market = position.markets;
      const outcome = position.outcome ? 'YES' : 'NO';
      const marketText = market.description || market.question || 'Unknown Market';
      
      let status = '⏳ PENDING';
      if (market.status === 'resolved') {
        const won = position.outcome === market.winning_outcome;
        status = won ? '✅ WON' : '❌ LOST';
        if (won) winnings += position.amount * 2; // Simplified calculation
      }

      message += `**${marketText}**\n`;
      message += `🎯 Position: ${outcome}\n`;
      message += `💰 Amount: ${position.amount} USDC\n`;
      message += `📈 Status: ${status}\n\n`;
      
      totalValue += position.amount;
    }

    message += `📊 **Summary:**\n`;
    message += `💰 Total Invested: ${totalValue} USDC\n`;
    message += `🏆 Total Winnings: ${winnings} USDC\n`;

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error getting positions:', error);
    bot.sendMessage(chatId, '❌ Error loading positions.');
  }
}

async function handleClaimWinnings(chatId, userId) {
  try {
    const user = await getOrCreateUser(userId);
    
    if (!user.wallet_address) {
      bot.sendMessage(chatId, '❌ No wallet connected. Please connect your Base wallet first.');
      return;
    }

    bot.sendMessage(chatId, '💸 **Claim Winnings**\n\n⚠️ To claim winnings, you need to:\n\n1. Visit the markets directly on Base\n2. Connect your wallet to the dApp\n3. Click "Claim Winnings" on each winning position\n\nThis requires signing transactions with your private key, which cannot be done through the bot for security reasons.', {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error with claim winnings:', error);
    bot.sendMessage(chatId, '❌ Error checking claimable winnings.');
  }
}

async function handleLeaderboard(chatId) {
  try {
    // Get top users by total FP from database
    const { data: topUsers } = await supabase
      .from('User')
      .select('username, total_trader_fp, total_creator_fp, total_rewards_earned')
      .order('total_trader_fp', { ascending: false })
      .limit(10);

    if (!topUsers || topUsers.length === 0) {
      bot.sendMessage(chatId, '📊 **Leaderboard**\n\nNo users with Forecast Points yet.\n\nStart trading to earn FP and climb the rankings!');
      return;
    }

    let message = '🏆 **Forecast Points Leaderboard**\n\n';

    topUsers.forEach((user, index) => {
      const totalFP = (user.total_trader_fp || 0) + (user.total_creator_fp || 0);
      const rewards = user.total_rewards_earned || 0;
      
      message += `${index + 1}. **${user.username}**\n`;
      message += `   🎯 Total FP: ${totalFP}\n`;
      message += `   💰 Rewards: ${rewards} USDC\n\n`;
    });

    message += '💡 Earn Forecast Points by trading and creating markets!\n';
    message += 'Top traders win weekly USDC rewards.';

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error getting leaderboard:', error);
    bot.sendMessage(chatId, '❌ Error loading leaderboard.');
  }
}

async function handleMarketStats(chatId) {
  try {
    await bot.sendMessage(chatId, '📊 Loading stats from Base blockchain...');
    
    const markets = await getMarketsFromBlockchain();
    const totalVolume = markets.reduce((sum, market) => sum + parseFloat(market.totalVolume), 0);
    const activeMarkets = markets.filter(market => !market.resolved).length;
    const totalBettors = markets.reduce((sum, market) => sum + Number(market.bettorCount), 0);

    const message = `📈 **Spredd Markets Stats**\n\n📊 Total Markets: ${markets.length}\n🏃‍♂️ Active Markets: ${activeMarkets}\n💰 Total Volume: ${totalVolume.toFixed(2)} USDC\n👥 Total Bettors: ${totalBettors}\n\n🌐 **Network:** Base\n🏭 **Factory:** \`${SPREDD_FACTORY_ADDRESS}\`\n💰 **Token:** USDC`;

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    bot.sendMessage(chatId, '❌ Error loading statistics.');
  }
}

async function handleMarketAction(chatId, userId, data) {
  const marketId = data.split('_')[1];
  
  try {
    const details = await factoryContract.getMarketDetails(marketId);
    const marketAddress = await factoryContract.getMarketAddress(marketId);
    
    const expiryDate = new Date(Number(details.endTime) * 1000);
    const now = new Date();
    const isExpired = now > expiryDate;
    
    let message = `📊 **Market Details**\n\n**Question:** ${details.question}\n\n`;
    message += `🔵 **${details.optionA}**\n`;
    message += `🔴 **${details.optionB}**\n\n`;
    message += `💰 Total Volume: ${ethers.formatUnits(details.totalVolume, 6)} USDC\n`;
    message += `📊 Odds A: ${details.oddsA.toString()}%\n`;
    message += `📊 Odds B: ${details.oddsB.toString()}%\n`;
    message += `👥 Bettors: ${details.bettorCount.toString()}\n`;
    message += `📅 Expires: ${expiryDate.toLocaleString()}\n`;
    message += `🏭 Contract: \`${marketAddress}\`\n\n`;
    
    if (details.resolved) {
      message += `✅ **RESOLVED**\nWinner: ${details.winningOutcome ? details.optionA : details.optionB}`;
    } else if (isExpired) {
      message += `⏰ **EXPIRED** - Waiting for resolution`;
    } else {
      message += `🟢 **ACTIVE** - You can place bets`;
    }

    const buttons = [];
    
    if (!details.resolved && !isExpired) {
      buttons.push([
        { text: `🔵 Bet ${details.optionA}`, callback_data: `bet_yes_${marketId}` },
        { text: `🔴 Bet ${details.optionB}`, callback_data: `bet_no_${marketId}` }
      ]);
    }
    
    buttons.push([{ text: '⬅️ Back to Markets', callback_data: 'browse_markets' }]);

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    console.error('Error loading market:', error);
    bot.sendMessage(chatId, '❌ Error loading market details from blockchain.');
  }
}

async function handleBetAction(chatId, userId, data) {
  const [_, outcome, marketId] = data.split('_');
  
  try {
    const user = await getOrCreateUser(userId);
    
    if (!user.wallet_address) {
      bot.sendMessage(chatId, '❌ Please connect your wallet first using the wallet menu.');
      return;
    }

    const balance = await getUSDCBalance(user.wallet_address);
    
    if (parseFloat(balance) < 1) {
      bot.sendMessage(chatId, `❌ Insufficient USDC balance.\n\nYour balance: ${balance} USDC\n\nYou need USDC to place bets.`);
      return;
    }
  
    userSessions.set(chatId, {
      action: 'placing_bet',
      marketId: marketId,
      outcome: outcome === 'yes',
      userId: userId,
      walletAddress: user.wallet_address,
      timestamp: Date.now()
    });

    bot.sendMessage(chatId, `💰 **Place Bet**\n\nBetting **${outcome.toUpperCase()}**\n\nEnter the amount in USDC you want to bet:\n\n💰 Available: ${balance} USDC`, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error starting bet:', error);
    bot.sendMessage(chatId, '❌ Error preparing bet.');
  }
}

// Admin functions
async function handleAdminContractInfo(chatId) {
  try {
    const fee = await getMarketCreationFee();
    
    const message = `🔧 **Contract Information**\n\n🏭 **Factory:** \`${SPREDD_FACTORY_ADDRESS}\`\n📊 **FP Manager:** \`${FP_MANAGER_ADDRESS}\`\n💰 **USDC Token:** \`${USDC_ADDRESS}\`\n\n💳 **Market Creation Fee:** ${fee} USDC\n🌐 **Network:** Base (Chain ID: ${BASE_CHAIN_ID})\n🔗 **RPC:** ${process.env.BASE_RPC_URL}`;

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error getting contract info:', error);
    bot.sendMessage(chatId, '❌ Error loading contract information.');
  }
}

async function handleAdminBlockchainStats(chatId) {
  try {
    const markets = await getMarketsFromBlockchain();
    const totalVolume = markets.reduce((sum, market) => sum + parseFloat(market.totalVolume), 0);
    const activeMarkets = markets.filter(market => !market.resolved).length;
    
    // Get factory contract balance
    const factoryBalance = await usdcContract.balanceOf(SPREDD_FACTORY_ADDRESS);
    const formattedFactoryBalance = ethers.formatUnits(factoryBalance, 6);

    const message = `📊 **Blockchain Statistics**\n\n📈 **Markets:**\n  • Total: ${markets.length}\n  • Active: ${activeMarkets}\n  • Resolved: ${markets.length - activeMarkets}\n\n💰 **Volume:**\n  • Total: ${totalVolume.toFixed(2)} USDC\n  • Factory Balance: ${formattedFactoryBalance} USDC\n\n🌐 **Network:** Base`;

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error getting blockchain stats:', error);
    bot.sendMessage(chatId, '❌ Error loading blockchain statistics.');
  }
}

async function handleAdminTreasury(chatId) {
  try {
    const adminBalance = await usdcContract.balanceOf(adminWallet.address);
    const formattedAdminBalance = ethers.formatUnits(adminBalance, 6);
    
    const factoryBalance = await usdcContract.balanceOf(SPREDD_FACTORY_ADDRESS);
    const formattedFactoryBalance = ethers.formatUnits(factoryBalance, 6);

    const message = `💰 **Treasury Status**\n\n🔑 **Admin Wallet:**\n  • Address: \`${adminWallet.address}\`\n  • Balance: ${formattedAdminBalance} USDC\n\n🏭 **Factory Contract:**\n  • Balance: ${formattedFactoryBalance} USDC\n\n📊 **FP Manager:** \`${FP_MANAGER_ADDRESS}\`\n\n⚠️ Admin wallet is used for emergency transactions only.`;

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error getting treasury info:', error);
    bot.sendMessage(chatId, '❌ Error loading treasury information.');
  }
}

// Market creation confirmation handlers
async function handleConfirmCreateMarket(chatId, userId) {
  const session = userSessions.get(chatId);
  
  if (session && session.step === 'confirm') {
    try {
      const fee = await getMarketCreationFee();
      
      const createMessage = `🚀 **Create Your Market**\n\n**Transaction Details:**\n\n🏭 **Contract:** \`${SPREDD_FACTORY_ADDRESS}\`\n💰 **Fee:** ${fee} USDC\n\n**Call this function:**\n\`createMarket(\n  "${session.marketData.question}",\n  "${session.marketData.optionA}",\n  "${session.marketData.optionB}",\n  ${session.marketData.endTime}\n)\`\n\n**Steps:**\n1. Approve ${fee} USDC for factory contract\n2. Call createMarket function\n3. Wait for confirmation\n\n⛽ **Gas:** ~0.002 ETH\n🌐 **Network:** Base`;

      bot.sendMessage(chatId, createMessage, {
        parse_mode: 'Markdown'
      });
      
      userSessions.delete(chatId);
    } catch (error) {
      console.error('Error confirming market creation:', error);
      bot.sendMessage(chatId, '❌ Error preparing market creation.');
      userSessions.delete(chatId);
    }
  }
}

async function handleCancelCreateMarket(chatId) {
  bot.sendMessage(chatId, '❌ Market creation cancelled.');
  userSessions.delete(chatId);
}

// Message handler for multi-step operations
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const session = userSessions.get(chatId);
  
  if (!session) return;

  try {
    switch (session.action) {
      case 'creating_market':
        await handleCreateMarketStep(chatId, userId, msg.text, session);
        break;
      case 'connecting_wallet':
        await handleConnectWalletStep(chatId, userId, msg.text);
        break;
      case 'placing_bet':
        await handlePlaceBetStep(chatId, userId, msg.text, session);
        break;
    }
  } catch (error) {
    console.error('Error handling message:', error);
    bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
    userSessions.delete(chatId);
  }
});

// Multi-step handlers
async function handleCreateMarketStep(chatId, userId, text, session) {
  switch (session.step) {
    case 'question':
      if (text.length < 10 || text.length > 200) {
        bot.sendMessage(chatId, '❌ Question must be between 10-200 characters. Please try again:');
        return;
      }
      session.marketData.question = text;
      session.step = 'optionA';
      bot.sendMessage(chatId, '🔵 **Option A**\n\nEnter the first option (e.g., "Yes", "Trump", "Over"):');
      break;
      
    case 'optionA':
      if (text.length < 2 || text.length > 50) {
        bot.sendMessage(chatId, '❌ Option must be between 2-50 characters. Please try again:');
        return;
      }
      session.marketData.optionA = text;
      session.step = 'optionB';
      bot.sendMessage(chatId, '🔴 **Option B**\n\nEnter the second option (e.g., "No", "Biden", "Under"):');
      break;

    case 'optionB':
      if (text.length < 2 || text.length > 50) {
        bot.sendMessage(chatId, '❌ Option must be between 2-50 characters. Please try again:');
        return;
      }
      session.marketData.optionB = text;
      session.step = 'expiry';
      bot.sendMessage(chatId, '📅 **Expiry Date**\n\nEnter the expiry date and time (YYYY-MM-DD HH:MM):\n\nExample: 2024-12-31 23:59');
      break;
      
    case 'expiry':
      try {
        const expiryDate = new Date(text);
        if (isNaN(expiryDate.getTime()) || expiryDate <= new Date()) {
          bot.sendMessage(chatId, '❌ Invalid date or date is in the past. Please use format: YYYY-MM-DD HH:MM');
          return;
        }
        
        const endTime = Math.floor(expiryDate.getTime() / 1000);
        
        // Show confirmation
        const fee = await getMarketCreationFee();
        const confirmMessage = `📋 **Confirm Market Creation**\n\n❓ **Question:** ${session.marketData.question}\n\n🔵 **Option A:** ${session.marketData.optionA}\n🔴 **Option B:** ${session.marketData.optionB}\n\n📅 **Expires:** ${expiryDate.toLocaleString()}\n💰 **Fee:** ${fee} USDC\n\n⚠️ **Important:** You'll need to:\n1. Approve USDC spending\n2. Sign the transaction\n3. Pay gas fees\n\nThis requires using your wallet directly. The bot will provide transaction details.`;
        
        session.marketData.endTime = endTime;
        session.step = 'confirm';
        
        const buttons = [
          [
            { text: '✅ Create Market', callback_data: 'confirm_create_market' },
            { text: '❌ Cancel', callback_data: 'cancel_create_market' }
          ]
        ];
        
        bot.sendMessage(chatId, confirmMessage, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons }
        });
        
      } catch (error) {
        console.error('Error processing expiry date:', error);
        bot.sendMessage(chatId, '❌ Error processing date. Please use format: YYYY-MM-DD HH:MM');
      }
      break;
  }
}

async function handleConnectWalletStep(chatId, userId, text) {
  try {
    const address = text.trim();
    
    if (!ethers.isAddress(address)) {
      bot.sendMessage(chatId, '❌ Invalid Ethereum address format. Please enter a valid address starting with 0x...');
      return;
    }

    // Get balance to verify it's a Base address
    const balance = await getUSDCBalance(address);
    
    // Update user with wallet address
    const user = await getOrCreateUser(userId, null, address);
    
    bot.sendMessage(chatId, `✅ **Wallet Connected Successfully!**\n\n🏦 **Address:** \`${address}\`\n💰 **USDC Balance:** ${balance}\n🌐 **Network:** Base\n\nYou can now create markets and place bets!`, {
      parse_mode: 'Markdown'
    });
    
    userSessions.delete(chatId);
  } catch (error) {
    console.error('Error connecting wallet:', error);
    bot.sendMessage(chatId, '❌ Error connecting wallet. Please make sure the address is valid and on Base network.');
    userSessions.delete(chatId);
  }
}

async function handlePlaceBetStep(chatId, userId, text, session) {
  const amount = parseFloat(text);
  
  if (isNaN(amount) || amount <= 0) {
    bot.sendMessage(chatId, '❌ Invalid amount. Please enter a positive number:');
    return;
  }

  if (amount < 0.01) {
    bot.sendMessage(chatId, '❌ Minimum bet is 0.01 USDC. Please enter a larger amount:');
    return;
  }

  try {
    const balance = await getUSDCBalance(session.walletAddress);
    
    if (amount > parseFloat(balance)) {
      bot.sendMessage(chatId, `❌ Insufficient balance.\n\nAmount: ${amount} USDC\nAvailable: ${balance} USDC`);
      userSessions.delete(chatId);
      return;
    }

    // Get market details for confirmation
    const details = await factoryContract.getMarketDetails(session.marketId);
    const marketAddress = await factoryContract.getMarketAddress(session.marketId);
    
    const outcomeText = session.outcome ? details.optionA : details.optionB;
    const confirmMessage = `🎯 **Confirm Bet**\n\n❓ **Market:** ${details.question}\n\n${session.outcome ? '🔵' : '🔴'} **Betting on:** ${outcomeText}\n💰 **Amount:** ${amount} USDC\n\n🏭 **Market Contract:** \`${marketAddress}\`\n\n⚠️ **To place this bet:**\n1. Go to your Base wallet\n2. Approve USDC spending for the market contract\n3. Call \`placeBet(${session.outcome}, ${ethers.parseUnits(amount.toString(), 6)})\`\n4. Sign and send the transaction\n\n📱 **Or use a dApp browser to interact with the contract directly.**`;

    bot.sendMessage(chatId, confirmMessage, {
      parse_mode: 'Markdown'
    });
    
    userSessions.delete(chatId);
  } catch (error) {
    console.error('Error preparing bet:', error);
    bot.sendMessage(chatId, '❌ Error preparing bet transaction.');
    userSessions.delete(chatId);
  }
}

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  if (bot.isPolling()) bot.stopPolling();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');  
  if (bot.isPolling()) bot.stopPolling();
  process.exit(0);
});

// Bot error handling
bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error.message);
});

bot.on('webhook_error', (error) => {
  console.error('❌ Webhook error:', error.message);
});

console.log('🤖 Spredd Markets Telegram Bot is running...');
console.log(`🌐 Network: Base (Chain ID: ${BASE_CHAIN_ID})`);
console.log(`💰 USDC: ${USDC_ADDRESS}`);
console.log(`🏭 Factory: ${SPREDD_FACTORY_ADDRESS}`);
console.log(`📊 FP Manager: ${FP_MANAGER_ADDRESS}`);
console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);

module.exports = { bot, supabase };
