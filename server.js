import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import TelegramBot from "node-telegram-bot-api";

// =========== НАСТРОЙКИ ===========
const PORT = process.env.PORT || 10000;
const BILEE_API = "https://paymentgate.bilee.ru/api";

// ВАЖНО: названия переменных КАК В BILEEPAY
const SHOP_ID = Number(process.env.shop_id);  // именно "shop_id" 
const BILEE_PASSWORD = process.env.password;  // именно "password"

const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);
const RENDER_URL = "https://duck-backend-by9a.onrender.com";
const FRONTEND_URL = "https://destrkod.github.io/duck";

// =========== ПРОВЕРКА ===========
console.log("=== ПРОВЕРКА НАСТРОЕК ===");
console.log("Shop ID:", SHOP_ID);
console.log("Password установлен:", BILEE_PASSWORD ? "ДА" : "НЕТ");
console.log("Telegram Token:", TG_TOKEN ? "УСТАНОВЛЕН" : "НЕТ");
console.log("=========================");

// =========== ПРИЛОЖЕНИЕ ===========
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// =========== ТЕЛЕГРАМ БОТ ===========
let bot = null;
if (TG_TOKEN) {
  bot = new TelegramBot(TG_TOKEN);
  const WEBHOOK_URL = `${RENDER_URL}/telegram/${TG_TOKEN}`;
  
  app.post(`/telegram/${TG_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

// =========== ГЕНЕРАЦИЯ ПОДПИСИ ===========
function generateSignature(data) {
  const tokenData = { ...data, password: BILEE_PASSWORD };
  
  const excluded = ["metadata", "signature"];
  const sortedKeys = Object.keys(tokenData)
    .filter(k => !excluded.includes(k))
    .sort();
  
  const values = sortedKeys
    .map(k => String(tokenData[k] || ""))
    .join("");
  
  return crypto
    .createHash("sha256")
    .update(values, "utf8")
    .digest("hex");
}

// =========== ЭНДПОИНТЫ ===========

// 1. ГЛАВНАЯ
app.get("/", (req, res) => {
  res.send(`
    <h1>🦆 Duck Shop Backend</h1>
    <p>Status: <strong>ACTIVE</strong></p>
    <p>Shop ID: ${SHOP_ID}</p>
    <p>Mode: <strong>PRODUCTION</strong></p>
    <hr>
    <h3>Endpoints:</h3>
    <ul>
      <li><strong>POST /create-payment</strong> - Create BileePay payment</li>
      <li><strong>POST /submit-email</strong> - Submit email</li>
      <li><strong>GET /check</strong> - Check server status</li>
    </ul>
  `);
});

// 2. ПРОВЕРКА СЕРВЕРА
app.get("/check", (req, res) => {
  res.json({
    status: "ok",
    shop_id: SHOP_ID,
    password_set: !!BILEE_PASSWORD,
    bilee_api: BILEE_API,
    frontend: FRONTEND_URL,
    time: new Date().toISOString()
  });
});

// 3. СОЗДАНИЕ ПЛАТЕЖА (ОСНОВНОЙ)
app.post("/create-payment", async (req, res) => {
  try {
    const { items, method } = req.body;
    
    if (!items || !method) {
      return res.status(400).json({ error: "Требуются items и method" });
    }

    // Проверяем credentials
    if (!SHOP_ID || !BILEE_PASSWORD) {
      return res.status(500).json({ 
        error: "Не настроены shop_id или password в Render" 
      });
    }

    // Рассчитываем сумму
    const PRICES = {
      "c30": 200, "c80": 550, "c170": 950, "c360": 1900,
      "c950": 4600, "c2000": 9000, "bp": 900, "bpplus": 1200,
      "up": 550, "bp_g": 950, "bpp_g": 1250, "pro": 2200
    };

    let amountRub = 0;
    for (const [id, qty] of Object.entries(items)) {
      if (PRICES[id]) amountRub += PRICES[id] * qty;
    }

    if (amountRub === 0) {
      return res.status(400).json({ error: "Сумма заказа 0" });
    }

    const order_id = `duck_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Формируем запрос к BileePay
    const payload = {
      order_id,
      method_slug: method, // 'card' или 'sbp'
      amount: Math.round(amountRub * 100), // в копейках
      shop_id: SHOP_ID,
      success_url: `${FRONTEND_URL}/success-pay.html?order=${order_id}`,
      fail_url: `${FRONTEND_URL}/fail.html`,
      description: `Заказ #${order_id.substring(0, 8)}`,
      notify_url: `${RENDER_URL}/bilee-notify`
    };

    // Генерируем подпись
    payload.signature = generateSignature(payload);

    // Отправляем в BileePay
    const bileeResponse = await axios.post(
      `${BILEE_API}/payment/init`,
      payload,
      { 
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
      }
    );

    // Проверяем ответ
    if (bileeResponse.data && bileeResponse.data.url) {
      res.json({
        success: true,
        url: bileeResponse.data.url,
        order_id,
        amount: amountRub
      });
    } else {
      throw new Error("BileePay не вернул URL для оплаты");
    }

  } catch (error) {
    console.error("Ошибка создания платежа:", error.message);
    
    // Детальный лог ошибки
    if (error.response) {
      console.error("BileePay ответил:", error.response.status);
      console.error("BileePay данные:", error.response.data);
      
      res.status(500).json({
        error: `BileePay ошибка: ${error.response.status}`,
        details: error.response.data,
        message: "Проверьте shop_id и password в Render"
      });
    } else {
      res.status(500).json({
        error: "Ошибка сервера",
        details: error.message
      });
    }
  }
});

// 4. BILEEPAY УВЕДОМЛЕНИЯ
app.post("/bilee-notify", (req, res) => {
  console.log("BileePay notify:", req.body);
  res.sendStatus(200);
});

// 5. ОТПРАВКА EMAIL
app.post("/submit-email", async (req, res) => {
  try {
    const { order_id, email } = req.body;
    
    if (!order_id || !email) {
      return res.status(400).json({ error: "Требуются order_id и email" });
    }
    
    console.log(`📧 Email для заказа ${order_id}: ${email}`);
    
    // Отправляем в Telegram если настроен бот
    if (bot && ADMIN_CHAT_ID) {
      await bot.sendMessage(
        ADMIN_CHAT_ID,
        `📦 НОВЫЙ ЗАКАЗ\n\n` +
        `🆔: ${order_id}\n` +
        `📧: ${email}\n` +
        `⏰: ${new Date().toLocaleString('ru-RU')}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "🔢 Запросить код", callback_data: `code_${order_id}` }
            ]]
          }
        }
      );
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error("Ошибка отправки email:", error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// 6. TELEGRAM ОБРАБОТЧИКИ
if (bot) {
  bot.on("callback_query", async (query) => {
    if (query.data.startsWith("code_")) {
      const order_id = query.data.split("_")[1];
      
      await bot.sendMessage(
        ADMIN_CHAT_ID,
        `Введите 6-значный код для заказа ${order_id}`
      );
      
      await bot.answerCallbackQuery(query.id, {
        text: "Теперь введите код в чат"
      });
    }
  });
}

// =========== ЗАПУСК ===========
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`🛒 Shop ID: ${SHOP_ID}`);
  console.log(`🔑 Password: ${BILEE_PASSWORD ? "УСТАНОВЛЕН" : "НЕТ!"}`);
  console.log(`🌐 URL: ${RENDER_URL}`);
  
  // Настраиваем Telegram webhook
  if (bot && TG_TOKEN) {
    try {
      await bot.setWebHook(`${RENDER_URL}/telegram/${TG_TOKEN}`);
      console.log("🤖 Telegram webhook установлен");
    } catch (error) {
      console.error("Ошибка webhook:", error.message);
    }
  }
});