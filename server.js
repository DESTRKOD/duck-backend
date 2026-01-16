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

// =========== БАЗА ДАННЫХ ===========
const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const defaultData = { products: [], orders: [] };
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
      count: db.data.products.length
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

// Добавить товар (используется ботом) - БЕЗ ПРОВЕРКИ SECRET
app.post("/api/add-product", async (req, res) => {
  try {
    const { id, name, price, image, gift = false, secret } = req.body;
    
    // ВРЕМЕННО ОТКЛЮЧАЕМ ПРОВЕРКУ SECRET
    console.log(`📦 Попытка добавить товар: "${name}" за ${price}₽`);
    console.log(`🔐 Получен secret: ${secret || 'не указан'}`);
    console.log(`🌐 IP: ${req.ip}, User-Agent: ${req.headers['user-agent']?.substring(0, 50)}...`);
    
    // TODO: Включить проверку когда настроим переменные окружения
    // const API_SECRET = process.env.API_SECRET || "duck_shop_secret_2024";
    // if (secret !== API_SECRET) {
    //   console.log("Неверный секретный ключ:", secret);
    //   return res.status(401).json({ 
    //     success: false,
    //     error: "Неавторизовано" 
    //   });
    // }
    
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

// Удалить товар - БЕЗ ПРОВЕРКИ SECRET
app.post("/api/delete-product", async (req, res) => {
  try {
    const { id, secret } = req.body;
    
    console.log(`🗑️  Попытка удалить товар ID: ${id}`);
    console.log(`🔐 Получен secret: ${secret || 'не указан'}`);
    
    // ВРЕМЕННО ОТКЛЮЧАЕМ ПРОВЕРКУ
    // const API_SECRET = process.env.API_SECRET || "duck_shop_secret_2024";
    // if (secret !== API_SECRET) {
    //   return res.status(401).json({ 
    //     success: false,
    //     error: "Неавторизовано" 
    //   });
    // }
    
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
    
    console.log(`📋 Запрос списка товаров для админа`);
    console.log(`🔐 Получен secret: ${secret || 'не указан'}`);
    
    // ВРЕМЕННО ОТКЛЮЧАЕМ ПРОВЕРКУ
    // const API_SECRET = process.env.API_SECRET || "duck_shop_secret_2024";
    // if (secret !== API_SECRET) {
    //   return res.status(401).json({ 
    //     success: false,
    //     error: "Неавторизовано" 
    //   });
    // }
    
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
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🦆 Duck Shop Backend</h1>
        <div class="status">✅ Статус: Работает</div>
        
        <div class="card">
          <h3>📊 Информация о сервере:</h3>
          <p><strong>🛒 Товаров в базе:</strong> ${db.data.products.length}</p>
          <p><strong>🌐 URL:</strong> ${RENDER_URL}</p>
          <p><strong>🔧 Версия API:</strong> 2.0.0</p>
          <p><strong>⏰ Время:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>🔓 Безопасность:</strong> Проверка secret временно отключена</p>
        </div>
        
        <div class="card">
          <h3>📡 API Endpoints:</h3>
          <div class="api-list">
            <div>
              <h4>🛍️ Для сайта:</h4>
              <ul>
                <li><a href="/api/products" target="_blank">/api/products</a> - Все товары (JSON)</li>
                <li><a href="/check" target="_blank">/check</a> - Статус сервера</li>
                <li><a href="/test" target="_blank">/test</a> - Тест соединения</li>
              </ul>
            </div>
            <div>
              <h4>🤖 Для бота:</h4>
              <ul>
                <li>POST /api/add-product - Добавить товар</li>
                <li>POST /api/delete-product - Удалить товар</li>
                <li>GET /api/admin/products - Список товаров</li>
              </ul>
            </div>
          </div>
        </div>
        
        <div class="card">
          <h3>🚀 Быстрые ссылки:</h3>
          <ul>
            <li><a href="https://destrkod.github.io/duck" target="_blank">🛒 Магазин (Сайт)</a></li>
            <li><a href="https://render.com" target="_blank">⚙️ Render Dashboard</a></li>
            <li><a href="https://github.com/DESTRKOD/duck-backend" target="_blank">📦 GitHub репозиторий</a></li>
          </ul>
        </div>
        
        <p style="margin-top: 30px; color: rgba(255,255,255,0.7); font-size: 14px;">
          🤖 Бот может добавлять товары без проверки secret (временно)<br>
          ⚠️ Для продакшена включите проверку в настройках Render
        </p>
      </div>
    </body>
    </html>
  `);
});

// =========== СТАТУС СЕРВЕРА ===========
app.get("/check", async (req, res) => {
  await db.read();
  res.json({
    status: "ok",
    server: "Duck Shop Backend",
    shop_id: SHOP_ID,
    password_set: !!BILEE_PASSWORD,
    products_count: db.data.products.length,
    security: "check_disabled_temporarily",
    time: new Date().toISOString(),
    url: RENDER_URL,
    endpoints: {
      products: `${RENDER_URL}/api/products`,
      add_product: `${RENDER_URL}/api/add-product`,
      status: `${RENDER_URL}/check`
    }
  });
});

// =========== ТЕСТ СОЕДИНЕНИЯ ===========
app.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "✅ Сервер работает корректно",
    timestamp: new Date().toISOString(),
    version: "2.0.0",
    features: {
      products_api: true,
      bot_integration: true,
      payment_system: SHOP_ID > 0,
      security_check: false
    },
    links: {
      products: `${RENDER_URL}/api/products`,
      github: "https://github.com/DESTRKOD/duck-backend",
      frontend: "https://destrkod.github.io/duck"
    }
  });
});

// =========== ГЕНЕРАЦИЯ ПОДПИСИ ===========
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

// =========== ПЛАТЕЖНАЯ СИСТЕМА ===========
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
    
    // Загружаем актуальные цены
    await db.read();
    const PRICES = {};
    db.data.products.forEach(p => {
      PRICES[p.id] = p.price;
    });
    
    // Рассчитываем сумму
    let amountRub = 0;
    for (const [id, qty] of Object.entries(items)) {
      if (PRICES[id]) amountRub += PRICES[id] * qty;
    }
    
    if (amountRub === 0) {
      return res.status(400).json({ error: "Сумма заказа 0" });
    }
    
    const order_id = `duck_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
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

// Отправка email
app.post("/submit-email", async (req, res) => {
  try {
    const { order_id, email } = req.body;
    
    console.log(`📧 Email для заказа ${order_id}: ${email}`);
    
    res.json({ 
      success: true, 
      message: "Email сохранен",
      order_id,
      email 
    });
    
  } catch (error) {
    console.error("Ошибка сохранения email:", error);
    res.status(500).json({ 
      success: false,
      error: "Ошибка сервера" 
    });
  }
});

// Уведомление от BileePay
app.post("/bilee-notify", (req, res) => {
  console.log("📦 Уведомление от BileePay:", req.body);
  res.status(200).json({ 
    success: true,
    message: "OK" 
  });
});

// =========== ЗАПУСК СЕРВЕРА ===========
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`🛒 Shop ID: ${SHOP_ID}`);
  console.log(`🗄️ Товаров в базе: ${db.data.products.length}`);
  console.log(`🌐 URL: ${RENDER_URL}`);
  console.log(`🛍️ API товаров: ${RENDER_URL}/api/products`);
  console.log(`🔓 Безопасность: Проверка secret временно отключена`);
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