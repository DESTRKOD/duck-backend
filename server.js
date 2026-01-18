import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 10000;

// ========== КОНФИГУРАЦИЯ ИЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ==========
// ВСЕ данные берутся ТОЛЬКО из переменных окружения
const CONFIG = {
  API_SECRET: process.env.API_SECRET,                    // Обязательно
  SHOP_ID: process.env.SHOP_ID,                         // Обязательно
  BILEEPAY_API_KEY: process.env.BILEEPAY_API_KEY,       // Обязательно
  BOT_URL: process.env.BOT_URL,                         // Для уведомлений
  MONGODB_URI: process.env.MONGODB_URI,                 // Обязательно
  SERVER_URL: process.env.SERVER_URL || `https://your-backend.onrender.com`,
  CREATE_TEST_DATA: process.env.CREATE_TEST_DATA === 'true'
};

// ========== ПРОВЕРКА КОНФИГУРАЦИИ ==========
const validateConfig = () => {
  const required = ['API_SECRET', 'SHOP_ID', 'BILEEPAY_API_KEY', 'MONGODB_URI'];
  const missing = required.filter(key => !CONFIG[key]);
  
  if (missing.length > 0) {
    console.error('❌ ОШИБКА: Отсутствуют обязательные переменные окружения:');
    missing.forEach(key => console.error(`   - ${key}`));
    process.exit(1);
  }
  
  console.log('✅ Все обязательные переменные окружения установлены');
};

// ========== МОДЕЛИ БД ==========
// Схема товара
const productSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: String,
  price: { type: Number, required: true, min: 0 },
  category: String,
  imageUrl: String,
  stock: { type: Number, default: 999 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// Схема заказа
const orderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  customer: {
    telegramId: String,
    username: String,
    firstName: String,
    lastName: String
  },
  items: [{
    productId: String,
    name: String,
    price: Number,
    quantity: Number
  }],
  totalAmount: { type: Number, required: true },
  status: { 
    type: String, 
    enum: ['pending', 'paid', 'failed', 'cancelled'],
    default: 'pending'
  },
  paymentId: String,
  paymentUrl: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);
const Order = mongoose.model('Order', orderSchema);

// ========== MIDDLEWARE ==========
app.use(helmet());
app.use(cors());
app.use(express.json());

// Middleware проверки API секрета
const verifyApiSecret = (req, res, next) => {
  const clientSecret = req.headers['x-api-secret'] || req.query.secret;
  
  if (!clientSecret || clientSecret !== CONFIG.API_SECRET) {
    return res.status(403).json({ 
      success: false,
      error: 'Invalid API secret' 
    });
  }
  next();
};

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
const generateOrderId = () => {
  return `ORD${Date.now()}${crypto.randomInt(1000, 9999)}`;
};

const sendTelegramNotification = async (orderData) => {
  if (!CONFIG.BOT_URL) return;
  
  try {
    const response = await fetch(`${CONFIG.BOT_URL}/order-notification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: CONFIG.API_SECRET,
        order: orderData
      })
    });
    
    if (!response.ok) {
      console.warn('⚠️ Не удалось отправить уведомление боту');
    }
  } catch (error) {
    console.error('❌ Ошибка отправки уведомления:', error.message);
  }
};

// ========== ПОДКЛЮЧЕНИЕ БАЗЫ ДАННЫХ ==========
const connectDB = async () => {
  try {
    await mongoose.connect(CONFIG.MONGODB_URI);
    console.log('✅ MongoDB подключена');
    
    // Создание тестовых товаров если нужно
    if (CONFIG.CREATE_TEST_DATA) {
      await createTestProducts();
    }
    
    // Статистика
    const productCount = await Product.countDocuments();
    const orderCount = await Order.countDocuments();
    console.log(`🗄️ Товаров в базе: ${productCount}`);
    console.log(`📦 Заказов в базе: ${orderCount}`);
  } catch (error) {
    console.error('❌ Ошибка подключения к MongoDB:', error.message);
    process.exit(1);
  }
};

const createTestProducts = async () => {
  try {
    const count = await Product.countDocuments();
    if (count === 0) {
      await Product.insertMany([
        {
          id: 'prod_001',
          name: 'Тестовый товар 1',
          description: 'Описание тестового товара 1',
          price: 100,
          category: 'test',
          imageUrl: 'https://via.placeholder.com/300',
          stock: 50
        },
        {
          id: 'prod_002',
          name: 'Тестовый товар 2',
          description: 'Описание тестового товара 2',
          price: 200,
          category: 'test',
          imageUrl: 'https://via.placeholder.com/300',
          stock: 30
        }
      ]);
      console.log('✅ Создано 2 тестовых товара');
    }
  } catch (error) {
    console.error('❌ Ошибка создания тестовых товаров:', error.message);
  }
};

// ========== РОУТЫ API ==========

// 1. Получить все товары (публичный)
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find({ isActive: true });
    res.json({ success: true, products });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка получения товаров' 
    });
  }
});

// 2. Создать платеж (защищенный)
app.post('/api/create-payment', verifyApiSecret, async (req, res) => {
  try {
    const { products, customer } = req.body;
    
    // Валидация
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Не указаны товары' 
      });
    }
    
    // Проверяем наличие товаров и рассчитываем сумму
    let totalAmount = 0;
    const orderItems = [];
    
    for (const item of products) {
      const product = await Product.findOne({ 
        id: item.productId, 
        isActive: true 
      });
      
      if (!product) {
        return res.status(400).json({ 
          success: false, 
          error: `Товар ${item.productId} не найден` 
        });
      }
      
      if (product.stock < item.quantity) {
        return res.status(400).json({ 
          success: false, 
          error: `Недостаточно товара: ${product.name}` 
        });
      }
      
      totalAmount += product.price * item.quantity;
      orderItems.push({
        productId: product.id,
        name: product.name,
        price: product.price,
        quantity: item.quantity
      });
    }
    
    // Генерируем ID заказа
    const orderId = generateOrderId();
    
    // Создаем запись заказа
    const order = new Order({
      orderId,
      customer: {
        telegramId: customer?.telegramId,
        username: customer?.username,
        firstName: customer?.firstName,
        lastName: customer?.lastName
      },
      items: orderItems,
      totalAmount,
      status: 'pending'
    });
    
    await order.save();
    
    // Создаем платеж в BileePay (без хардкода URL)
    const paymentResponse = await fetch('https://pay.bileepay.com/api/v2/invoice/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.BILEEPAY_API_KEY}`
      },
      body: JSON.stringify({
        shop_id: CONFIG.SHOP_ID,
        amount: totalAmount,
        order_id: orderId,
        description: `Заказ #${orderId}`,
        success_url: `${CONFIG.SERVER_URL}/payment-success`,
        fail_url: `${CONFIG.SERVER_URL}/payment-failed`
      })
    });
    
    const paymentData = await paymentResponse.json();
    
    if (!paymentData.success) {
      order.status = 'failed';
      await order.save();
      
      return res.status(400).json({ 
        success: false, 
        error: 'Ошибка создания платежа' 
      });
    }
    
    // Обновляем заказ с paymentId и ссылкой на оплату
    order.paymentId = paymentData.data.id;
    order.paymentUrl = paymentData.data.pay_url;
    await order.save();
    
    // Отправляем уведомление боту
    await sendTelegramNotification({
      orderId,
      customer: order.customer,
      totalAmount,
      items: orderItems
    });
    
    res.json({
      success: true,
      orderId,
      paymentUrl: paymentData.data.pay_url,
      paymentId: paymentData.data.id,
      amount: totalAmount
    });
    
  } catch (error) {
    console.error('❌ Ошибка создания платежа:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Внутренняя ошибка сервера' 
    });
  }
});

// 3. Вебхук от платежной системы
app.post('/api/payment-webhook', async (req, res) => {
  try {
    const { order_id, status, amount } = req.body;
    
    // Находим заказ
    const order = await Order.findOne({ orderId: order_id });
    if (!order) {
      return res.status(404).json({ success: false, error: 'Заказ не найден' });
    }
    
    // Обновляем статус
    if (status === 'success') {
      order.status = 'paid';
      
      // Уменьшаем количество товаров на складе
      for (const item of order.items) {
        await Product.findOneAndUpdate(
          { id: item.productId },
          { $inc: { stock: -item.quantity } }
        );
      }
      
      // Отправляем уведомление об успешной оплате
      await sendTelegramNotification({
        type: 'payment_success',
        orderId: order.orderId,
        amount: amount
      });
      
    } else if (status === 'failed') {
      order.status = 'failed';
    }
    
    order.updatedAt = new Date();
    await order.save();
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Ошибка обработки вебхука:', error);
    res.status(500).json({ success: false, error: 'Ошибка обработки' });
  }
});

// 4. Получить статус заказа
app.get('/api/order/:orderId', verifyApiSecret, async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) {
      return res.status(404).json({ 
        success: false, 
        error: 'Заказ не найден' 
      });
    }
    
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка получения заказа' 
    });
  }
});

// 5. Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'duck-backend'
  });
});

// 6. Информация о сервере
app.get('/', (req, res) => {
  res.json({
    service: 'Duck Shop Backend',
    endpoints: {
      products: '/api/products',
      createPayment: '/api/create-payment',
      webhook: '/api/payment-webhook',
      orderStatus: '/api/order/:orderId',
      health: '/health'
    },
    note: 'Все данные хранятся в переменных окружения'
  });
});

// ========== ЗАПУСК СЕРВЕРА ==========
const startServer = async () => {
  try {
    // Проверяем конфигурацию
    validateConfig();
    
    // Подключаем БД
    await connectDB();
    
    // Запускаем сервер
    app.listen(PORT, () => {
      console.log(`✅ Сервер запущен на порту ${PORT}`);
      console.log('🔧 =========== НАСТРОЙКИ СЕРВЕРА ===========');
      console.log(`🛒 Shop ID: ${CONFIG.SHOP_ID ? '✅' : '❌'} ${CONFIG.SHOP_ID}`);
      console.log(`💳 BileePay: ${CONFIG.BILEEPAY_API_KEY ? '✅ Настроен' : '❌ Не настроен'}`);
      console.log(`🤖 Бот URL: ${CONFIG.BOT_URL ? '✅' : '❌'} ${CONFIG.BOT_URL || 'Не указан'}`);
      console.log(`🔐 API Secret: ${CONFIG.API_SECRET ? '✅ Установлен' : '❌ Не установлен'}`);
      console.log(`🌐 URL: ${CONFIG.SERVER_URL}`);
      console.log(`🛍️ API товаров: ${CONFIG.SERVER_URL}/api/products`);
      console.log(`💸 Платежный API: ${CONFIG.SERVER_URL}/api/create-payment`);
      console.log('============================================');
    });
    
  } catch (error) {
    console.error('❌ Ошибка запуска сервера:', error);
    process.exit(1);
  }
};

startServer();

export default app;
