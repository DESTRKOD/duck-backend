import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';

// =========== НАСТРОЙКИ ИЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ===========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10000;

// ВСЕ КЛЮЧИ И СЕКРЕТЫ ТОЛЬКО ИЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ
const CONFIG = {
  // Платежная система BileePay
  SHOP_ID: Number(process.env.SHOP_ID),
  BILEE_PASSWORD: process.env.BILEE_PASSWORD,
  BILEE_API: process.env.BILEE_API_URL,
  
  // Безопасность API
  API_SECRET: process.env.API_SECRET,
  
  // URL серверов
  SERVER_URL: process.env.SERVER_URL,
  FRONTEND_URL: process.env.FRONTEND_URL,
  BOT_URL: process.env.BOT_URL,
  
  // Безопасность CORS
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || "https://destrkod.github.io").split(","),
  
  // Настройки приложения
  CREATE_TEST_PRODUCTS: process.env.CREATE_TEST_PRODUCTS === 'true',
  MAX_CART_TOTAL: Number(process.env.MAX_CART_TOTAL) || 10000
};

// =========== ПРОВЕРКА ОБЯЗАТЕЛЬНЫХ ПЕРЕМЕННЫХ ===========
const validateConfig = () => {
  const errors = [];
  
  if (!CONFIG.API_SECRET) {
    errors.push("API_SECRET - обязательный параметр");
  }
  
  if (CONFIG.SHOP_ID === 0) {
    errors.push("SHOP_ID - обязательный параметр");
  }
  
  if (!CONFIG.BILEE_PASSWORD) {
    errors.push("BILEE_PASSWORD - обязательный параметр");
  }
  
  if (errors.length > 0) {
    console.error("❌ ОШИБКА КОНФИГУРАЦИИ:");
    errors.forEach(error => console.error(`   - ${error}`));
    console.error("⚠️  Установите переменные окружения в Render Dashboard");
    process.exit(1);
  }
  
  console.log("✅ Все обязательные переменные окружения установлены");
};

// =========== БАЗА ДАННЫХ ===========
const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const defaultData = { 
  products: [], 
  orders: [],
  settings: {
    max_cart_total: CONFIG.MAX_CART_TOTAL,
    created_at: new Date().toISOString(),
    config_hash: crypto.createHash('md5').update(JSON.stringify(CONFIG)).digest('hex')
  }
};
const db = new Low(adapter, defaultData);

// =========== ПРИЛОЖЕНИЕ ===========
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Безопасный CORS
app.use(cors({ 
  origin: function(origin, callback) {
    // Разрешаем запросы без origin (например, из curl)
    if (!origin) return callback(null, true);
    
    if (CONFIG.ALLOWED_ORIGINS.includes('*') || CONFIG.ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`🚫 CORS блокирован: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-secret', 'X-API-Secret']
}));

// Базовые заголовки безопасности
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

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

// =========== МИДЛВЭРЫ ДЛЯ БЕЗОПАСНОСТИ ===========

// Проверка API ключа для защищенных эндпоинтов
const verifyApiSecret = (req, res, next) => {
  const clientSecret = req.headers['x-api-secret'] || 
                      req.headers['X-API-Secret'] || 
                      req.query.secret || 
                      req.body.secret;
  
  if (!clientSecret || clientSecret !== CONFIG.API_SECRET) {
    console.warn(`🚫 Неавторизованный доступ к ${req.path} с IP: ${req.ip}`);
    return res.status(403).json({ 
      success: false,
      error: "Invalid API secret",
      code: "UNAUTHORIZED"
    });
  }
  next();
};

// Логирование запросов
const requestLogger = (req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logMessage = `${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${duration}ms`;
    
    if (res.statusCode >= 400) {
      console.warn(`⚠️ ${logMessage}`);
    } else if (req.path.includes('/api/')) {
      console.log(`📡 ${logMessage}`);
    }
  });
  
  next();
};

app.use(requestLogger);

// =========== УЛУЧШЕННАЯ ФУНКЦИЯ ОТПРАВКИ УВЕДОМЛЕНИЙ БОТУ ===========
async function notifyBot(orderData) {
  try {
    if (!CONFIG.BOT_URL || !CONFIG.API_SECRET) {
      console.log('⚠️ BOT_URL или API_SECRET не настроены, уведомление не отправлено');
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
      timestamp: new Date().toISOString(),
      server_url: CONFIG.SERVER_URL
    };
    
    const response = await axios.post(`${CONFIG.BOT_URL}/api/order-notify`, requestData, {
      timeout: 10000,
      headers: { 
        'Content-Type': 'application/json',
        'X-API-Secret': CONFIG.API_SECRET
      },
      validateStatus: () => true // Принимаем любой статус
    });
    
    if (response.status >= 200 && response.status < 300) {
      console.log(`✅ Уведомление отправлено для заказа ${orderData.order_id}`);
      return true;
    } else {
      console.warn(`⚠️ Бот вернул ошибку: ${response.status}`, response.data);
      return false;
    }
    
  } catch (error) {
    console.error('❌ Ошибка отправки уведомления:', error.message);
    return false;
  }
}

// =========== ПРОВЕРКА СОЕДИНЕНИЯ С БОТОМ ПРИ ЗАПУСКЕ ===========
async function checkBotConnection() {
  console.log('🔍 Проверка соединения с ботом...');
  
  if (!CONFIG.BOT_URL || !CONFIG.API_SECRET) {
    console.log('❌ BOT_URL или API_SECRET не настроены');
    return false;
  }
  
  try {
    const response = await axios.get(`${CONFIG.BOT_URL}/health`, { 
      timeout: 5000,
      validateStatus: () => true 
    });
    
    if (response.status === 200) {
      console.log(`✅ Бот доступен: ${CONFIG.BOT_URL}`);
      return true;
    } else {
      console.warn(`⚠️ Бот недоступен (статус: ${response.status})`);
      return false;
    }
  } catch (error) {
    console.error('❌ Ошибка соединения с ботом:', error.message);
    return false;
  }
}

// =========== ГЕНЕРАЦИЯ ПОДПИСИ ДЛЯ BILEEPAY ===========
function generateSignature(data) {
  const tokenData = {
    ...data,
    password: CONFIG.BILEE_PASSWORD
  };
  
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
}

// =========== ПРОДУКТЫ API ===========

// Получить все товары (публичный доступ)
app.get("/api/products", async (req, res) => {
  try {
    await db.read();
    
    // Создание тестовых товаров при первом запуске
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
      max_cart_total: db.data.settings.max_cart_total || CONFIG.MAX_CART_TOTAL
    });
  } catch (error) {
    console.error("Ошибка получения товаров:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error",
      code: "INTERNAL_ERROR"
    });
  }
});

// Добавить товар (защищенный)
app.post("/api/add-product", verifyApiSecret, async (req, res) => {
  try {
    const { id, name, price, image, gift = false } = req.body;
    
    if (!id || !name || !price || !image) {
      return res.status(400).json({ 
        success: false,
        error: "Missing required fields",
        code: "VALIDATION_ERROR"
      });
    }
    
    await db.read();
    
    // Проверка существования товара
    if (db.data.products.find(p => p.id === id)) {
      return res.status(409).json({ 
        success: false,
        error: "Product already exists",
        code: "DUPLICATE_PRODUCT"
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
    console.error("Ошибка добавления товара:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error",
      code: "INTERNAL_ERROR"
    });
  }
});

// Удалить товар (защищенный)
app.post("/api/delete-product", verifyApiSecret, async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.status(400).json({ 
        success: false,
        error: "Product ID required",
        code: "VALIDATION_ERROR"
      });
    }
    
    await db.read();
    
    const initialCount = db.data.products.length;
    db.data.products = db.data.products.filter(p => p.id !== id);
    
    if (db.data.products.length === initialCount) {
      return res.status(404).json({ 
        success: false,
        error: "Product not found",
        code: "NOT_FOUND"
      });
    }
    
    await db.write();
    
    res.json({
      success: true,
      deleted: id,
      count: db.data.products.length
    });
    
  } catch (error) {
    console.error("Ошибка удаления товара:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error",
      code: "INTERNAL_ERROR"
    });
  }
});

// Получить список товаров для админа (защищенный)
app.get("/api/admin/products", verifyApiSecret, async (req, res) => {
  try {
    await db.read();
    
    res.json({
      success: true,
      products: db.data.products,
      count: db.data.products.length,
      total_value: db.data.products.reduce((sum, p) => sum + p.price, 0)
    });
    
  } catch (error) {
    console.error("Ошибка получения товаров:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error",
      code: "INTERNAL_ERROR"
    });
  }
});

// =========== ЗАКАЗЫ API ===========

// Отправка email (публичный)
app.post("/submit-email", async (req, res) => {
  try {
    const { order_id, email, cart } = req.body;
    
    if (!order_id || !email || !cart) {
      return res.status(400).json({ 
        success: false, 
        error: "Missing required fields",
        code: "VALIDATION_ERROR"
      });
    }
    
    // Валидация email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid email format",
        code: "INVALID_EMAIL"
      });
    }
    
    await db.read();
    
    const amount = calculateOrderTotal(cart);
    
    // Проверка лимита корзины
    if (amount > CONFIG.MAX_CART_TOTAL) {
      return res.status(400).json({ 
        success: false, 
        error: `Cart total exceeds limit of ${CONFIG.MAX_CART_TOTAL}₽`,
        code: "CART_LIMIT_EXCEEDED"
      });
    }
    
    let orderIndex = db.data.orders.findIndex(o => o.id === order_id);
    
    if (orderIndex === -1) {
      const newOrder = {
        id: order_id,
        email: email,
        cart: cart,
        amount: amount,
        status: "pending_email",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ip_address: req.ip
      };
      
      db.data.orders.push(newOrder);
      orderIndex = db.data.orders.length - 1;
    } else {
      db.data.orders[orderIndex].email = email;
      db.data.orders[orderIndex].cart = cart;
      db.data.orders[orderIndex].amount = amount;
      db.data.orders[orderIndex].status = "pending_email";
      db.data.orders[orderIndex].updated_at = new Date().toISOString();
      db.data.orders[orderIndex].ip_address = req.ip;
    }
    
    await db.write();
    
    // Отправка уведомления боту
    const botNotified = await notifyBot({
      order_id,
      email,
      cart,
      amount,
      stage: "email_submitted"
    });
    
    res.json({ 
      success: true, 
      order_id,
      email,
      amount,
      bot_notified: botNotified
    });
    
  } catch (error) {
    console.error("Ошибка сохранения email:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error",
      code: "INTERNAL_ERROR"
    });
  }
});

// Отправка кода (публичный)
app.post("/api/submit-code", async (req, res) => {
  try {
    const { order_id, email, code } = req.body;
    
    if (!order_id || !email || !code) {
      return res.status(400).json({ 
        success: false, 
        error: "Missing required fields",
        code: "VALIDATION_ERROR"
      });
    }
    
    await db.read();
    
    const orderIndex = db.data.orders.findIndex(o => o.id === order_id);
    
    if (orderIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        error: "Order not found",
        code: "ORDER_NOT_FOUND"
      });
    }
    
    // Проверка email
    if (db.data.orders[orderIndex].email !== email) {
      return res.status(400).json({ 
        success: false, 
        error: "Email mismatch",
        code: "EMAIL_MISMATCH"
      });
    }
    
    // Обновление заказа
    db.data.orders[orderIndex].code = code;
    db.data.orders[orderIndex].status = "pending_code";
    db.data.orders[orderIndex].code_submitted_at = new Date().toISOString();
    db.data.orders[orderIndex].updated_at = new Date().toISOString();
    
    await db.write();
    
    // Отправка уведомления боту
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
      order_id,
      status: "pending",
      next_check: Date.now() + 5000,
      bot_notified: botNotified
    });
    
  } catch (error) {
    console.error("Ошибка сохранения кода:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error",
      code: "INTERNAL_ERROR"
    });
  }
});

// Проверка статуса заказа (публичный)
app.get("/api/order-status/:order_id", async (req, res) => {
  try {
    const { order_id } = req.params;
    
    await db.read();
    
    const order = db.data.orders.find(o => o.id === order_id);
    
    if (!order) {
      return res.status(404).json({ 
        success: false, 
        error: "Order not found",
        code: "ORDER_NOT_FOUND"
      });
    }
    
    // Формирование информации о товарах
    const itemsInfo = [];
    if (order.cart && typeof order.cart === 'object') {
      for (const [itemId, quantity] of Object.entries(order.cart)) {
        const product = db.data.products.find(p => p.id === itemId);
        itemsInfo.push({
          id: itemId,
          name: product ? product.name : itemId,
          quantity: quantity,
          price: product ? product.price : 0,
          total: product ? product.price * quantity : 0
        });
      }
    }
    
    res.json({
      success: true,
      order_id,
      email: order.email,
      code: order.code,
      status: order.status || "unknown",
      amount: order.amount || 0,
      items: itemsInfo,
      created_at: order.created_at,
      updated_at: order.updated_at || order.created_at
    });
    
  } catch (error) {
    console.error("Ошибка проверки статуса:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error",
      code: "INTERNAL_ERROR"
    });
  }
});

// Обновление статуса заказа (защищенный)
app.post("/api/order-status-update", verifyApiSecret, async (req, res) => {
  try {
    const { order_id, status, admin_comment } = req.body;
    
    if (!order_id || !status) {
      return res.status(400).json({ 
        success: false, 
        error: "Missing required fields",
        code: "VALIDATION_ERROR"
      });
    }
    
    await db.read();
    
    const orderIndex = db.data.orders.findIndex(o => o.id === order_id);
    
    if (orderIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        error: "Order not found",
        code: "ORDER_NOT_FOUND"
      });
    }
    
    // Обновление статуса
    db.data.orders[orderIndex].status = status;
    db.data.orders[orderIndex].updated_at = new Date().toISOString();
    
    if (admin_comment) {
      db.data.orders[orderIndex].admin_comment = admin_comment;
    }
    
    if (status === "completed") {
      db.data.orders[orderIndex].completed_at = new Date().toISOString();
    } else if (status === "rejected") {
      db.data.orders[orderIndex].rejected_at = new Date().toISOString();
    }
    
    await db.write();
    
    res.json({ 
      success: true, 
      order_id,
      status,
      updated_at: db.data.orders[orderIndex].updated_at
    });
    
  } catch (error) {
    console.error("Ошибка обновления статуса:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error",
      code: "INTERNAL_ERROR"
    });
  }
});

// Список заказов для админа (защищенный)
app.get("/api/admin/orders", verifyApiSecret, async (req, res) => {
  try {
    const { limit = 50, status, offset = 0 } = req.query;
    
    await db.read();
    
    let orders = db.data.orders;
    
    // Фильтрация по статусу
    if (status) {
      orders = orders.filter(o => o.status === status);
    }
    
    // Сортировка
    orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    // Пагинация
    const total = orders.length;
    const start = parseInt(offset);
    const end = start + parseInt(limit);
    const paginatedOrders = orders.slice(start, end);
    
    // Форматирование
    const formattedOrders = paginatedOrders.map(order => ({
      id: order.id,
      email: order.email,
      code: order.code,
      status: order.status,
      amount: order.amount || 0,
      items_count: order.cart ? Object.keys(order.cart).length : 0,
      created_at: order.created_at,
      updated_at: order.updated_at,
      ip_address: order.ip_address,
      admin_comment: order.admin_comment
    }));
    
    res.json({
      success: true,
      orders: formattedOrders,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        has_more: end < total
      },
      stats: {
        total: db.data.orders.length,
        pending: db.data.orders.filter(o => o.status === 'pending_code').length,
        completed: db.data.orders.filter(o => o.status === 'completed').length,
        rejected: db.data.orders.filter(o => o.status === 'rejected').length
      }
    });
    
  } catch (error) {
    console.error("Ошибка получения списка заказов:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error",
      code: "INTERNAL_ERROR"
    });
  }
});

// =========== ПЛАТЕЖНАЯ СИСТЕМА BILEEPAY ===========
app.post("/create-payment", async (req, res) => {
  try {
    const { items, method } = req.body;
    
    if (!items || !method) {
      return res.status(400).json({ 
        success: false,
        error: "Items and method required",
        code: "VALIDATION_ERROR"
      });
    }
    
    if (CONFIG.SHOP_ID === 0 || !CONFIG.BILEE_PASSWORD) {
      return res.status(500).json({ 
        success: false,
        error: "Payment system not configured",
        code: "PAYMENT_NOT_CONFIGURED"
      });
    }
    
    const amountRub = calculateOrderTotal(items);
    
    if (amountRub === 0) {
      return res.status(400).json({ 
        success: false,
        error: "Cart total is zero",
        code: "EMPTY_CART"
      });
    }
    
    if (amountRub > CONFIG.MAX_CART_TOTAL) {
      return res.status(400).json({ 
        success: false,
        error: `Cart total exceeds limit of ${CONFIG.MAX_CART_TOTAL}₽`,
        code: "CART_LIMIT_EXCEEDED"
      });
    }
    
    const order_id = `duck_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    await db.read();
    
    const newOrder = {
      id: order_id,
      cart: items,
      amount: amountRub,
      status: "created",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payment_method: method
    };
    
    db.data.orders.push(newOrder);
    await db.write();
    
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
    
    payload.signature = generateSignature(payload);
    
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
        amount: amountRub,
        payment_id: response.data.id
      });
    } else {
      throw new Error("Payment gateway error");
    }
    
  } catch (error) {
    console.error("Ошибка создания платежа:", error.message);
    
    let statusCode = 500;
    let errorMessage = "Server error";
    let errorCode = "INTERNAL_ERROR";
    
    if (error.response) {
      statusCode = error.response.status;
      errorMessage = `Payment gateway error: ${error.response.status}`;
      errorCode = "PAYMENT_GATEWAY_ERROR";
    } else if (error.code === 'ECONNABORTED') {
      errorMessage = "Payment gateway timeout";
      errorCode = "TIMEOUT";
    }
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      code: errorCode
    });
  }
});

// Вебхук от BileePay
app.post("/bilee-notify", async (req, res) => {
  try {
    const { order_id, status, amount } = req.body;
    
    console.log("📦 Вебхук от BileePay:", { order_id, status, amount });
    
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
    
    res.status(200).json({ 
      success: true,
      received: true 
    });
  } catch (error) {
    console.error("Ошибка обработки вебхука:", error);
    res.status(200).json({ success: true }); // Всегда отвечаем успешно платежной системе
  }
});

// =========== СИСТЕМНЫЕ ЭНДПОИНТЫ ===========

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "duck-backend",
    version: "secure-4.0",
    time: new Date().toISOString(),
    config: {
      shop_configured: CONFIG.SHOP_ID > 0,
      bot_configured: !!(CONFIG.BOT_URL && CONFIG.API_SECRET),
      api_secret_set: !!CONFIG.API_SECRET
    }
  });
});

// Информация о сервере
app.get("/", (req, res) => {
  const info = {
    service: "Duck Shop Backend API",
    version: "secure-4.0",
    status: "operational",
    endpoints: {
      public: [
        "GET  /api/products",
        "POST /submit-email",
        "POST /api/submit-code",
        "GET  /api/order-status/:id",
        "POST /create-payment",
        "GET  /health"
      ],
      protected: [
        "POST /api/add-product",
        "POST /api/delete-product",
        "GET  /api/admin/products",
        "GET  /api/admin/orders",
        "POST /api/order-status-update"
      ]
    },
    security: {
      api_key_required: true,
      cors_enabled: true,
      data_encryption: "env_variables_only"
    },
    note: "All sensitive data is stored in environment variables"
  };
  
  res.json(info);
});

// =========== ЗАПУСК СЕРВЕРА ===========
const startServer = async () => {
  try {
    // Проверка конфигурации
    validateConfig();
    
    // Загрузка базы данных
    await db.read();
    console.log(`📁 База данных загружена: ${db.data.products.length} товаров, ${db.data.orders.length} заказов`);
    
    // Проверка соединения с ботом
    if (CONFIG.BOT_URL && CONFIG.API_SECRET) {
      setTimeout(async () => {
        const botConnected = await checkBotConnection();
        if (!botConnected) {
          console.warn("⚠️ Уведомления боту могут не работать!");
        }
      }, 2000);
    }
    
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Сервер запущен на порту ${PORT}`);
      console.log('🔧 =========== НАСТРОЙКИ СЕРВЕРА ===========');
      console.log(`🛒 Shop ID: ${CONFIG.SHOP_ID ? '✅ ' + CONFIG.SHOP_ID : '❌ Не настроен'}`);
      console.log(`💳 BileePay: ${CONFIG.SHOP_ID > 0 && CONFIG.BILEE_PASSWORD ? '✅ Настроен' : '❌ Требует настройки'}`);
      console.log(`🤖 Бот URL: ${CONFIG.BOT_URL ? '✅ ' + CONFIG.BOT_URL : '❌ Не настроен'}`);
      console.log(`🔐 API Secret: ${CONFIG.API_SECRET ? '✅ Установлен' : '❌ Не установлен'}`);
      console.log(`🌐 Server URL: ${CONFIG.SERVER_URL}`);
      console.log(`🌍 Frontend URL: ${CONFIG.FRONTEND_URL}`);
      console.log(`🛍️ API товаров: ${CONFIG.SERVER_URL}/api/products`);
      console.log(`💸 Платежный API: ${CONFIG.SERVER_URL}/create-payment`);
      console.log(`🔓 Безопасность: Проверка API ключа включена`);
      console.log(`🔄 Уведомления боту: ${CONFIG.BOT_URL && CONFIG.API_SECRET ? '✅ Будут работать' : '❌ НЕ БУДУТ работать'}`);
      console.log('============================================');
      console.log('🚀 СЕРВЕР ГОТОВ К РАБОТЕ!');
      console.log(`📊 Все данные защищены переменными окружения`);
    });
    
  } catch (error) {
    console.error('❌ Ошибка запуска сервера:', error);
    process.exit(1);
  }
};

startServer();
