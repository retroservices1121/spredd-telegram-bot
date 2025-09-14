# Spredd Markets Telegram Bot

A Telegram bot that connects to Spredd Markets on Base blockchain, allowing users to create markets, place bets with USDC, and earn Forecast Points.

## 🏆 Advanced Features

### Forecast Points System:
- Earn FP for successful trading
- Weekly leaderboards with USDC rewards
- Creator bonuses for popular markets
- Complex FP calculation based on market factors

### Market Analytics:
- Real-time odds calculation
- Volume and liquidity tracking
- Bettor statistics
- Historical performance data

### Admin Functions:
- Contract interaction monitoring
- Treasury management
- Emergency controls
- User support tools

## 🚀 Ready to Launch!

Your Spredd Markets Telegram bot will:
- ✅ **Connect to Base blockchain** automatically
- ✅ **Work with existing database** (no changes needed)
- ✅ **Integrate with your contracts** seamlessly
- ✅ **Scale on Railway** as users grow
- ✅ **Handle USDC transactions** safely

Just update the admin ID, set environment variables, and deploy!

The bot provides a user-friendly interface to your Base blockchain markets while maintaining security by never handling private keys or user funds directly.

## 🛠 Development

### Local Development:
```bash
# Clone the repository
git clone https://github.com/yourusername/spredd-telegram-bot.git
cd spredd-telegram-bot

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your credentials
# Then run in development mode
npm run dev
```

### Testing:
```bash
npm test
```

### Deployment:
```bash
# Push to main branch triggers automatic deployment
git push origin main
```

## 📝 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 📞 Support

For support or questions:
- Create an issue on GitHub
- Check Railway logs for errors
- Verify environment variables are set correctly

---

**Important Security Note:** This bot is designed to be non-custodial. It never holds user funds or private keys. Users execute all transactions through their own wallets, ensuring maximum security.🌐 Base Blockchain Integration

### Smart Contracts on Base:
- **USDC Token:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **Spredd Factory:** `0x7910aEb89f4843457d90cb26161EebA34d39EB60`
- **FP Manager:** `0x377DdE21CF1d613DFB7Cec34a05232Eea77FAe7f`

### Features:
- ✅ **Create Markets** with 3 USDC fee
- ✅ **Place Bets** using USDC  
- ✅ **Real-time Data** from Base blockchain
- ✅ **Forecast Points** integration
- ✅ **No Database Changes** required

## 🚀 Quick Railway Deployment

### 1. Get Your Credentials

#### Telegram Bot Token:
1. Message @BotFather on Telegram
2. Create bot: `/newbot`
3. Copy the token

#### Base RPC URL (Free Options):
- **Public RPC:** `https://mainnet.base.org` (rate limited)
- **Alchemy:** `https://base-mainnet.g.alchemy.com/v2/YOUR-API-KEY`
- **Infura:** `https://base-mainnet.infura.io/v3/YOUR-PROJECT-ID`

#### Admin Private Key:
- Create a new wallet for admin functions
- **Never use your main wallet!**
- Fund with small amount of ETH for gas

#### Your Telegram User ID:
1. Message @userinfobot
2. Copy your user ID number

### 2. Deploy to Railway
1. Fork this repository on GitHub
2. Go to [railway.app](https://railway.app)
3. "Deploy from GitHub repo"  
4. Select your forked repository
5. Railway auto-deploys!

### 3. Configure Environment Variables
In Railway dashboard → Variables:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
BASE_RPC_URL=https://mainnet.base.org
ADMIN_PRIVATE_KEY=your_admin_wallet_private_key
NODE_ENV=production
```

### 4. Update Admin ID
Edit `bot.js` around line 65:
```javascript
const ADMIN_IDS = [
  YOUR_TELEGRAM_USER_ID, // Replace with your actual ID
];
```

Push the change:
```bash
git add .
git commit -m "Update admin ID"
git push origin main
```

## 🎯 Bot Features

### For Users:
- **🏪 Browse Markets** - View active markets from Base blockchain
- **➕ Create Markets** - Deploy new markets (3 USDC fee)
- **💰 Place Bets** - Bet with USDC on market outcomes
- **🔗 Connect Wallet** - Link Base wallet address  
- **📊 Track Positions** - View betting history and results
- **🏆 Leaderboard** - See Forecast Points rankings

### For Admins:
- **🔧 Contract Info** - View contract addresses and settings
- **📊 Blockchain Stats** - Live data from Base
- **💰 Treasury Status** - Monitor contract balances

## 🔐 Security & Limitations

### What the Bot CAN Do:
- ✅ Read blockchain data (markets, balances, odds)
- ✅ Show transaction parameters for users to execute
- ✅ Store user preferences in database
- ✅ Display leaderboards and statistics

### What the Bot CANNOT Do:
- ❌ **Execute transactions** (users must sign their own)
- ❌ **Hold user funds** (non-custodial design)  
- ❌ **Access private keys** (except admin key for emergencies)

### User Workflow:
1. **Connect Wallet** - User provides their Base wallet address
2. **Get Instructions** - Bot shows exact transaction parameters
3. **Execute in Wallet** - User signs transaction in their wallet app
4. **Confirmation** - Transaction appears on blockchain

## 📱 Supported Wallets

Users can interact with any Base-compatible wallet:
- **MetaMask** (with Base network added)
- **Coinbase Wallet**
- **Rainbow Wallet**
- **Any Web3 wallet** that supports Base

## 💰 Cost Breakdown

### Railway Hosting:
- **Free Tier:** $5/month credit
- **Usage:** ~$1-2/month for small bot
- **Scaling:** Automatic based on usage

### Base Network Costs:
- **Gas Fees:** ~$0.01-0.05 per transaction
- **Market Creation:** 3 USDC + gas
- **Betting:** Gas only (~$0.01)

### RPC Costs:
- **Public RPC:** Free (rate limited)
- **Alchemy:** 300M requests/month free
- **Infura:** 100K requests/day free

## 🔧 Troubleshooting

### Bot Not Responding:
1. Check Railway logs for errors
2. Verify `TELEGRAM_BOT_TOKEN` is correct
3. Ensure webhook URL is accessible
4. Test `/start` command

### Blockchain Connection Issues:
1. Verify `BASE_RPC_URL` is working
2. Test RPC endpoint manually
3. Check if rate limits are hit
4. Try alternative RPC provider

### Market Data Not Loading:
1. Confirm contract addresses are correct
2. Check if Base network is experiencing issues
3. Verify factory contract is accessible
4. Look for RPC timeout errors

### User Wallet Issues:
1. Ensure wallet is connected to Base network
2. Verify USDC balance is sufficient
3. Check wallet address format (0x...)
4. Confirm Base network is added to wallet

## 📊 Monitoring & Analytics

### Built-in Monitoring:
- Health check endpoint: `/health`
- Railway dashboard metrics
- Console logging for all operations
- Error tracking and recovery

### Blockchain Monitoring:
- Real-time market data from Base
- Contract balance tracking
- Gas price monitoring
- Transaction confirmation tracking

## 🎮 Usage Examples

### Creating a Market:
```
User: /start
Bot: Shows main menu
User: ➕ Create Market
Bot: "Enter market question"
User: "Will Bitcoin reach $100k by 2024?"
Bot: "Enter Option A"
User: "Yes"
Bot: "Enter Option B"
User: "No"
Bot: "Enter expiry date"
User: "2024-12-31 23:59"
Bot: Shows transaction parameters for wallet
```

### Placing a Bet:
```
User: 🏪 Browse Markets
Bot: Shows active markets
User: Clicks market
Bot: Shows market details with bet buttons
User: 🔵 Bet Yes
Bot: "Enter amount"
User: "10"
Bot: Shows transaction parameters for wallet
```

##
