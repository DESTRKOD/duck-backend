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

// Переменные окружения
const SHOP_ID = Number(process.env.shop_id);
const BILEE_PASSWORD = process.env.password;
const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);
const RENDER_URL = process.env.RENDER_URL || "https://duck-backend-by9a.onrender.com";
const FRONTEND_URL = "https://destrkod.github.io/duck";

// =========== БАЗА ДАННЫХ ===========
const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const defaultData = { products: [], orders: [] };
const db = new Low(adapter, defaultData);

// Загружаем данные
await db.read();

// =========== ПРОВЕРКА ===========
console.log("=== НАСТРОЙКИ ===");
console.log("Shop ID:", SHOP_ID);
console.log("Password:", BILEE_PASSWORD ? "***" + BILEE_PASSWORD.slice(-4) : "НЕТ");
console.log("Database:", dbFile);
console.log("==================");

// =========== ПРИЛОЖЕНИЕ ===========
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// =========== ПРОДУКТЫ API ===========

// Получить все товары для сайта
app.get("/api/products", async (req, res) => {
  try {
    await db.read();
    res.json({
      success: true,
      products: db.data.products,
      count: db.data.products.length
    });
  } catch (error) {
    console.error("Ошибка получения товаров:", error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Добавить товар (используется ботом)
app.post("/api/add-product", async (req, res) => {
  try {
    const { id, name, price, image, gift = false, secret } = req.body;
    
    // Простая проверка секретного ключа
    if (secret !== process.env.API_SECRET) {
      return res.status(401).json({ error: "Неавторизовано" });
    }
    
    if (!id || !name || !price || !image) {
      return res.status(400).json({ error: "Не все поля заполнены" });
    }
    
    await db.read();
    
    // Проверяем, нет ли уже товара с таким ID
    const existing = db.data.products.find(p => p.id === id);
    if (existing) {
      return res.status(400).json({ error: "Товар с таким ID уже существует" });
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
    
    console.log("✅ Товар добавлен:", newProduct);
    
    res.json({
      success: true,
      product: newProduct,
      count: db.data.products.length
    });
    
  } catch (error) {
    console.error("Ошибка добавления товара:", error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Удалить товар
app.post("/api/delete-product", async (req, res) => {
  try {
    const { id, secret } = req.body;
    
    if (secret !== process.env.API_SECRET) {
      return res.status(401).json({ error: "Неавторизовано" });
    }
    
    await db.read();
    
    const initialCount = db.data.products.length;
    db.data.products = db.data.products.filter(p => p.id !== id);
    
    if (db.data.products.length === initialCount) {
      return res.status(404).json({ error: "Товар не найден" });
    }
    
    await db.write();
    
    res.json({
      success: true,
      deleted: id,
      count: db.data.products.length
    });
    
  } catch (error) {
    console.error("Ошибка удаления товара:", error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Получить список товаров для бота
app.get("/api/admin/products", async (req, res) => {
  try {
    const { secret } = req.query;
    
    if (secret !== process.env.API_SECRET) {
      return res.status(401).json({ error: "Неавторизовано" });
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
    res.status(500).json({ error: "Ошибка сервера" });
  }
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

// =========== ОСНОВНЫЕ ЭНДПОИНТЫ ===========

// Главная
app.get("/", (req, res) => {
  res.send(`
    <h1>🦆 Duck Shop Backend</h1>
    <p><strong>Статус:</strong> Работает ✅</p>
    <p><strong>Товаров в базе:</strong> ${db.data.products.length}</p>
    <p><strong>API Endpoints:</strong></p>
    <ul>
      <li><a href="/api/products">/api/products</a> - Получить все товары (для сайта)</li>
      <li><a href="/test-signature">/test-signature</a> - Проверить подпись</li>
      <li><a href="/check">/check</a> - Статус сервера</li>
    </ul>
  `);
});

// Статус
app.get("/check", async (req, res) => {
  await db.read();
  res.json({
    status: "ok",
    shop_id: SHOP_ID,
    password_set: !!BILEE_PASSWORD,
    products_count: db.data.products.length,
    time: new Date().toISOString()
  });
});

// Создание платежа (ВАШ СУЩЕСТВУЮЩИЙ КОД)
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
    
    // Загружаем актуальные цены из базы
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
    
    // Формируем запрос к BileePay
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
    
    // Генерируем подпись
    payload.signature = generateSignatureNode(payload, BILEE_PASSWORD);
    
    // Отправляем в BileePay
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

// Отправка email (оставляем ваш существующий код)
app.post("/submit-email", async (req, res) => {
  try {
    const { order_id, email } = req.body;
    
    // Здесь логика отправки email или сохранения
    console.log(`📧 Email для заказа ${order_id}: ${email}`);
    
    res.json({ success: true, message: "Email сохранен" });
    
  } catch (error) {
    console.error("Ошибка сохранения email:", error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Уведомление от BileePay (оставляем ваш существующий код)
app.post("/bilee-notify", (req, res) => {
  console.log("📦 Уведомление от BileePay:", req.body);
  res.status(200).send("OK");
});

// =========== ЗАПУСК ===========
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`🛒 Shop ID: ${SHOP_ID}`);
  console.log(`🗄️ Товаров в базе: ${db.data.products.length}`);
  console.log(`🌐 URL: ${RENDER_URL}`);
  console.log(`🛍️ API товаров: ${RENDER_URL}/api/products`);
});