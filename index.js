const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Initialize Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Initialize Telegram Bot
const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Store conversations and mappings
const conversations = new Map();
const telegramToWhatsAppMap = new Map(); // Maps Telegram message ID -> WhatsApp number

// ===== 1. FORWARD WHATSAPP MESSAGES TO TELEGRAM =====
app.post('/whatsapp', async (req, res) => {
  const customerMessage = req.body.Body;
  const customerNumber = req.body.From; // whatsapp:+254712345678
  const messageSid = req.body.MessageSid;
  
  console.log('\n📨 NEW WHATSAPP MESSAGE:');
  console.log(`From: ${customerNumber}`);
  console.log(`Message: ${customerMessage}`);
  
  // Extract clean phone number
  const cleanPhone = customerNumber.replace('whatsapp:', '');
  const phoneDigits = cleanPhone.replace('+', '');
  
  // Store message locally
  if (!conversations.has(phoneDigits)) {
    conversations.set(phoneDigits, []);
  }
  
  conversations.get(phoneDigits).push({
    type: 'customer',
    message: customerMessage,
    time: new Date(),
    messageId: messageSid
  });
  
  // Forward to Telegram
  try {
    const telegramMessage = await telegramBot.sendMessage(
      process.env.TELEGRAM_CHAT_ID,
      `📱 *New WhatsApp Message*\n\n` +
      `*From:* +${phoneDigits}\n` +
      `*Message:* ${customerMessage}\n\n` +
      `_Reply to this message to respond_`,
      { parse_mode: 'Markdown' }
    );
    
    // Store mapping: Telegram message ID -> WhatsApp number
    telegramToWhatsAppMap.set(telegramMessage.message_id, cleanPhone);
    
    console.log(`✅ Forwarded to Telegram (Message ID: ${telegramMessage.message_id})`);
  } catch (error) {
    console.error('❌ Failed to forward to Telegram:', error.message);
  }
  
  // Send auto-reply to WhatsApp
  const twiml = new twilio.twiml.MessagingResponse();
  
  const lowerMessage = customerMessage.toLowerCase();
  if (lowerMessage.includes('hello') || lowerMessage.includes('hi')) {
    twiml.message(`Hello! 👋 Our agent will reply shortly via Telegram.`);
  } else {
    twiml.message(`Thanks for your message! Our support team has been notified and will reply shortly.`);
  }
  
  res.type('text/xml').send(twiml.toString());
});

// ===== 2. LISTEN FOR TELEGRAM REPLIES =====
telegramBot.on('message', async (msg) => {
  // Check if this is a reply to a forwarded WhatsApp message
  if (msg.reply_to_message) {
    const originalMessageId = msg.reply_to_message.message_id;
    const whatsappNumber = telegramToWhatsAppMap.get(originalMessageId);
    
    if (whatsappNumber && msg.text) {
      console.log(`\n📨 TELEGRAM REPLY DETECTED:`);
      console.log(`To WhatsApp: +${whatsappNumber}`);
      console.log(`Message: ${msg.text}`);
      
      try {
        // Send reply via Twilio WhatsApp
        const result = await client.messages.create({
          body: msg.text,
          from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
          to: `whatsapp:+${whatsappNumber}`
        });
        
        // Store in conversations
        const phoneDigits = whatsappNumber.replace('+', '');
        if (!conversations.has(phoneDigits)) {
          conversations.set(phoneDigits, []);
        }
        
        conversations.get(phoneDigits).push({
          type: 'agent',
          message: msg.text,
          time: new Date(),
          messageId: result.sid,
          via: 'telegram'
        });
        
        console.log(`✅ Reply sent via WhatsApp (SID: ${result.sid})`);
        
        // Confirm in Telegram
        await telegramBot.sendMessage(
          msg.chat.id,
          `✅ Reply sent to +${whatsappNumber}`,
          { reply_to_message_id: msg.message_id }
        );
        
      } catch (error) {
        console.error('❌ Failed to send WhatsApp reply:', error);
        await telegramBot.sendMessage(
          msg.chat.id,
          `❌ Failed to send: ${error.message}`
        );
      }
    }
  }
  
  // Handle commands
  if (msg.text === '/start') {
    await telegramBot.sendMessage(
      msg.chat.id,
      `🤖 *WhatsApp Support Bot*\n\n` +
      `I forward WhatsApp messages here and let you reply via Telegram.\n\n` +
      `*How to use:*\n` +
      `1. Customers message your WhatsApp number\n` +
      `2. Messages appear here\n` +
      `3. Reply to any message to respond\n` +
      `4. Your reply goes back to WhatsApp\n\n` +
      `Active conversations: ${conversations.size}`,
      { parse_mode: 'Markdown' }
    );
  }
  
  if (msg.text === '/status') {
    await telegramBot.sendMessage(
      msg.chat.id,
      `📊 *Bot Status*\n\n` +
      `Active conversations: ${conversations.size}\n` +
      `WhatsApp number: ${process.env.TWILIO_WHATSAPP_NUMBER}\n` +
      `Mappings stored: ${telegramToWhatsAppMap.size}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ===== 3. KEEP EXISTING API ENDPOINTS =====
app.post('/send', async (req, res) => {
  // ... keep your existing send endpoint ...
  try {
    const { to, message } = req.body;
    
    if (!to || !message) {
      return res.status(400).json({ error: 'Missing "to" or "message"' });
    }
    
    const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    
    console.log(`\n📤 MANUAL SEND TO: ${formattedTo}`);
    console.log(`Message: ${message}`);
    
    const result = await client.messages.create({
      body: message,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: formattedTo
    });
    
    // Store sent message
    const phoneDigits = to.replace('+', '').replace('whatsapp:', '');
    if (!conversations.has(phoneDigits)) {
      conversations.set(phoneDigits, []);
    }
    
    conversations.get(phoneDigits).push({
      type: 'agent',
      message: message,
      time: new Date(),
      messageId: result.sid,
      via: 'dashboard'
    });
    
    console.log(`✅ Message sent! SID: ${result.sid}`);
    
    res.json({
      success: true,
      messageId: result.sid,
      status: result.status,
      conversationId: phoneDigits
    });
    
  } catch (error) {
    console.error('❌ Send error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/conversations', (req, res) => {
  const allConversations = {};
  
  conversations.forEach((messages, phone) => {
    allConversations[phone] = messages;
  });
  
  res.json({
    total: conversations.size,
    conversations: allConversations
  });
});

// ===== 4. UPDATED DASHBOARD (VIEW ONLY) =====
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp + Telegram Bot</title>
      <style>
        body { font-family: Arial; padding: 20px; max-width: 800px; margin: 0 auto; }
        h1 { color: #25D366; }
        .telegram-info { background: #0088cc; color: white; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .telegram-info a { color: white; text-decoration: underline; }
        .conversation { border: 1px solid #ddd; padding: 15px; margin: 10px 0; border-radius: 8px; }
        .customer { background: #f8f9fa; padding: 8px; margin: 5px 0; border-radius: 5px; }
        .agent { background: #e7f3ff; padding: 8px; margin: 5px 0; border-radius: 5px; }
        .customer strong { color: #d63384; }
        .agent strong { color: #0d6efd; }
        .via { font-size: 12px; color: #666; margin-left: 10px; }
      </style>
    </head>
    <body>
      <h1>📱 WhatsApp + Telegram Bot</h1>
      <p>Using Twilio Number: ${process.env.TWILIO_WHATSAPP_NUMBER}</p>
      
      <div class="telegram-info">
        <h3>🤖 Telegram Integration Active</h3>
        <p><strong>How to reply:</strong></p>
        <ol>
          <li>Open Telegram app</li>
          <li>Go to your bot: <strong>@${process.env.TELEGRAM_BOT_USERNAME || 'YourBot'}</strong></li>
          <li>Reply to any forwarded message</li>
          <li>Your reply will be sent to WhatsApp automatically</li>
        </ol>
        <p>Commands: /start, /status</p>
      </div>
      
      <h2>Recent Conversations (<span id="count">0</span>)</h2>
      <div id="conversations">Loading...</div>
      
      <script>
        async function loadConversations() {
          try {
            const response = await fetch('/conversations');
            const data = await response.json();
            
            const container = document.getElementById('conversations');
            const countSpan = document.getElementById('count');
            
            countSpan.textContent = data.total || 0;
            
            if (data.total === 0) {
              container.innerHTML = '<p>No conversations yet.</p>';
              return;
            }
            
            let html = '';
            
            for (const [phone, messages] of Object.entries(data.conversations)) {
              html += \`
                <div class="conversation">
                  <h3>📞 +<span>\${phone}</span></h3>
                  \${messages.map(msg => \`
                    <div class="\${msg.type}">
                      <strong>\${msg.type.toUpperCase()}:</strong> 
                      \${msg.message}
                      \${msg.via ? '<span class="via">(via ' + msg.via + ')</span>' : ''}<br>
                      <small>\${new Date(msg.time).toLocaleString()}</small>
                    </div>
                  \`).join('')}
                </div>
              \`;
            }
            
            container.innerHTML = html;
          } catch (error) {
            console.error('Error loading conversations:', error);
          }
        }
        
        // Auto-refresh every 5 seconds
        loadConversations();
        setInterval(loadConversations, 5000);
      </script>
    </body>
    </html>
  `);
});

// ===== 5. START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const herokuUrl = process.env.HEROKU_APP_NAME 
    ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com`
    : `http://localhost:${PORT}`;
  
  console.log(`
🚀 WhatsApp + Telegram Bot Started!
📞 Twilio Number: ${process.env.TWILIO_WHATSAPP_NUMBER}
🤖 Telegram Bot: Active
🌐 Dashboard: ${herokuUrl}
📨 Webhook: ${herokuUrl}/whatsapp

✅ Setup Instructions:
1. Message your WhatsApp sandbox number
2. Check Telegram for the forwarded message
3. Reply in Telegram (to the specific message)
4. Reply goes back to WhatsApp automatically

📋 Telegram Commands:
/start - Show help
/status - Check bot status
  `);
});

// Handle errors
telegramBot.on('error', (error) => {
  console.error('Telegram Bot Error:', error);
});
