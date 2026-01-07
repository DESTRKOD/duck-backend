import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import TelegramBot from "node-telegram-bot-api";

// =========== НАСТРОЙКИ ===========
const PORT = process.env.PORT || 10000;
const BILEE_API = "https://paymentgate.bilee.ru/api";

// Переменные окружения
const SHOP_ID = Number(process.env.shop_id);
const BILEE_PASSWORD = process.env.password;
const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);
const RENDER_URL = "https://duck-backend-by9a.onrender.com";
const FRONTEND_URL = "https://destrkod.github.io/duck";

// =========== ПРОВЕРКА ===========
console.log("=== НАСТРОЙКИ ===");
console.log("Shop ID:", SHOP_ID);
console.log("Password:", BILEE_PASSWORD ? "***" + BILEE_PASSWORD.slice(-4) : "НЕТ");
console.log("==================");

// =========== ПРИЛОЖЕНИЕ ===========
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// =========== ГЕНЕРАЦИЯ ПОДПИСИ (ИСПРАВЛЕННАЯ) ===========
async function generateSignature(data, password) {
  console.log("🔐 Генерация подписи...");
  
  // Копируем данные и добавляем пароль
  const tokenData = {
    ...data,
    password: password
  };
  
  console.log("Данные для подписи (без пароля):", { ...data, password: "***" });
  
  // Исключаем metadata и signature
  const excludedKeys = ["metadata", "signature"];
  
  // Получаем отсортированные ключи
  const sortedKeys = Object.keys(tokenData)
    .filter((key) => !excludedKeys.includes(key))
    .sort();
  
  console.log("Отсортированные ключи:", sortedKeys);
  
  // Собираем значения в строку (ВАЖНО: без String() конвертации!)
  const valuesString = sortedKeys
    .map((key) => tokenData[key])  // ← НЕ преобразовываем в String()!
    .join("");
  
  console.log("Строка для хеширования (первые 50 символов):", valuesString.substring(0, 50) + "...");
  
  // Создаем TextEncoder для UTF-8
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(valuesString);
  
  // Создаем SHA-256 хеш (браузерный API)
  const hashBuffer = await crypto.subtle.digest("SHA-256", encodedData);
  
  // Конвертируем в hex строку
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  
  console.log("Сгенерированная подпись:", hashHex.substring(0, 16) + "...");
  
  return hashHex;
}

// Альтернативная версия для Node.js (если crypto.subtle не работает)
function generateSignatureNode(data, password) {
  console.log("🔐 Генерация подписи (Node.js метод)...");
  
  const tokenData = {
    ...data,
    password: password
  };
  
  const excludedKeys = ["metadata", "signature"];
  
  const sortedKeys = Object.keys(tokenData)
    .filter((key) => !excludedKeys.includes(key))
    .sort();
  
  const valuesString = sortedKeys
    .map((key) => tokenData[key])  // ← БЕЗ String()!
    .join("");
  
  console.log("Строка для хеширования:", valuesString.substring(0, 50) + "...");
  
  // Используем crypto.createHash для Node.js
  const hash = crypto.createHash("sha256");
  hash.update(valuesString, "utf8");
  const signature = hash.digest("hex");
  
  console.log("Подпись (Node.js):", signature.substring(0, 16) + "...");
  
  return signature;
}

// =========== ТЕСТ ПОДПИСИ ===========
app.get("/test-signature", async (req, res) => {
  try {
    const testData = {
      order_id: "test_order_123",
      method_slug: "card",
      amount: 10000,
      shop_id: SHOP_ID,
      description: "Test signature"
    };
    
    console.log("🧪 Тестовые данные:", testData);
    console.log("Пароль для теста:", BILEE_PASSWORD ? "***" + BILEE_PASSWORD.slice(-4) : "НЕТ");
    
    // Генерируем подпись двумя способами для сравнения
    const signatureNode = generateSignatureNode(testData, BILEE_PASSWORD);
    let signatureWeb = "crypto.subtle not available";
    
    try {
      signatureWeb = await generateSignature(testData, BILEE_PASSWORD);
    } catch (e) {
      console.log("crypto.subtle не доступен:", e.message);
    }
    
    res.json({
      test_data: testData,
      signature_node: signatureNode,
      signature_web: signatureWeb,
      passwords_match: signatureNode === signatureWeb,
      password_length: BILEE_PASSWORD ? BILEE_PASSWORD.length : 0
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========== ЭНДПОИНТЫ ===========

// Главная
app.get("/", (req, res) => {
  res.send(`
    <h1>🦆 Duck Shop Backend</h1>
    <p><strong>Статус:</strong> Работает ✅</p>
    <p><strong>Shop ID:</strong> ${SHOP_ID}</p>
    <p><strong>Тесты:</strong></p>
    <ul>
      <li><a href="/test-signature">/test-signature</a> - Проверить подпись</li>
      <li><a href="/test-bilee">/test-bilee</a> - Тест BileePay</li>
      <li><a href="/check">/check</a> - Статус сервера</li>
    </ul>
  `);
});

// Статус
app.get("/check", (req, res) => {
  res.json({
    status: "ok",
    shop_id: SHOP_ID,
    password_set: !!BILEE_PASSWORD,
    password_length: BILEE_PASSWORD ? BILEE_PASSWORD.length : 0,
    time: new Date().toISOString()
  });
});

// Тест BileePay
app.get("/test-bilee", async (req, res) => {
  try {
    if (!SHOP_ID || !BILEE_PASSWORD) {
      return res.status(400).json({ 
        error: "Не установлены shop_id или password" 
      });
    }
    
    const testData = {
      order_id: "test_" + Date.now(),
      method_slug: "card",
      amount: 10000, // 100 руб в копейках
      shop_id: SHOP_ID,
      description: "Test connection"
    };
    
    // Используем Node.js метод для подписи
    testData.signature = generateSignatureNode(testData, BILEE_PASSWORD);
    
    console.log("📤 Отправка в BileePay:", {
      ...testData,
      signature: testData.signature.substring(0, 16) + "..."
    });
    
    const response = await axios.post(
      `${BILEE_API}/payment/init`,
      testData,
      { 
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    console.log("✅ Ответ BileePay:", response.data);
    
    res.json({
      success: true,
      message: "BileePay подключен",
      response: response.data
    });
    
  } catch (error) {
    console.error("❌ Ошибка BileePay:", error.message);
    
    if (error.response) {
      console.error("Статус:", error.response.status);
      console.error("Данные:", error.response.data);
      
      res.status(500).json({
        error: `BileePay ошибка: ${error.response.status}`,
        details: error.response.data,
        request_data: error.config?.data ? JSON.parse(error.config.data) : null
      });
    } else {
      res.status(500).json({
        error: error.message
      });
    }
  }
});

// Создание платежа
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
      method_slug: method,
      amount: amountRub, 
      shop_id: SHOP_ID,
      success_url: `${FRONTEND_URL}/success-pay.html?order=${order_id}`,
      fail_url: `${FRONTEND_URL}/fail.html`,
      description: `Заказ #${order_id.substring(0, 8)}`,
      notify_url: `${RENDER_URL}/bilee-notify`
    };
    
    console.log("📤 Данные для BileePay:", payload);
    
    // Генерируем подпись (исправленный метод)
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
    
    console.log("✅ Ответ BileePay получен");
    
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
      console.error("BileePay статус:", error.response.status);
      console.error("BileePay данные:", error.response.data);
      
      // Детальная информация для отладки
      res.status(500).json({
        error: `BileePay ошибка ${error.response.status}`,
        details: error.response.data,
        signature_issue: error.response.status === 403 ? "Возможно проблема с подписью" : null
      });
    } else {
      res.status(500).json({
        error: "Ошибка сервера",
        details: error.message
      });
    }
  }
});

// Остальные эндпоинты (submit-email, bilee-notify) остаются как были

// =========== ЗАПУСК ===========
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`🛒 Shop ID: ${SHOP_ID}`);
  console.log(`🔑 Password: ${BILEE_PASSWORD ? "УСТАНОВЛЕН" : "НЕТ!"}`);
  console.log(`🌐 URL: ${RENDER_URL}`);
  console.log(`📋 Тест подписи: ${RENDER_URL}/test-signature`);
});