import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 10000;

// ========== КОНФИГУРАЦИЯ ==========
const CONFIG = {
  API_SECRET: process.env.API_SECRET,           
  SHOP_ID: process.env.SHOP_ID,        
  BILEEPAY_API_KEY: process.env.BILEEPAY_API_KEY, 
  BOT_URL: process.env.BOT_URL,                
  SERVER_URL: process.env.SERVER_URL 
};

// ========== ПРОВЕРКА КОНФИГУРАЦИИ ==========
const validateConfig = () => {
  const required = ['API_SECRET', 'SHOP_ID', 'BILEEPAY_API_KEY'];
  const missing = required.filter(key => !CONFIG[key]);
  
  if (missing.length > 0) {
    console.error('❌ ОШИБКА: Отсутствуют обязательные переменные окружения:');
    missing.forEach(key => console.error(`   - ${key}`));
    process.exit(1);
  }
  
  console.log('✅ Все обязательные переменные окружения установлены');
};

// ========== ХРАНИЛИЩЕ В ПАМЯТИ ==========
// Товары (можно расширить до файла JSON если нужно)
let products = [
  {
    id: 'prod_001',
    name: 'Duck Premium',
    description: 'Премиум доступ к боту',
    price: 100,
    category: 'subscription',
    imageUrl: 'https://via.placeholder.com/300',
    stock: 9999
  },
  {
    id: 'prod_002',
    name: 'Duck Pro',
    description: 'PRO доступ к боту',
    price: 200,
    category: 'subscription',
    imageUrl: 'https://via.placeholder.com/300',
    stock: 9999
  }
];

// Заказы в памяти (временно)
let orders = [];

// ========== MIDDLEWARE ==========
app.use(express.json());

// Проверка API ключа
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

// ========== РОУТЫ API ==========

// 1. Получить все товары
app.get('/api/products', (req, res) => {
  res.json({ success: true, products });
});

// 2. Создать платеж
app.post('/api/create-payment', verifyApiSecret, async (req, res) => {
  try {
    const { products: requestedProducts, customer } = req.body;
    
    // Валидация
    if (!requestedProducts || !Array.isArray(requestedProducts) || requestedProducts.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Не указаны товары' 
      });
    }
    
    // Рассчитываем сумму
    let totalAmount = 0;
    const orderItems = [];
    
    for (const item of requestedProducts) {
      const product = products.find(p => p.id === item.productId);
      
      if (!product) {
        return res.status(400).json({ 
          success: false, 
          error: `Товар ${item.productId} не найден` 
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
    
    // Сохраняем заказ
    const order = {
      orderId,
      customer: {
        telegramId: customer?.telegramId,
        username: customer?.username,
        firstName: customer?.firstName,
        lastName: customer?.lastName
      },
      items: orderItems,
      totalAmount,
      status: 'pending',
      createdAt: new Date()
    };
    
    orders.push(order);
    
    // Создаем платеж в BileePay
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
      return res.status(400).json({ 
        success: false, 
        error: 'Ошибка создания платежа' 
      });
    }
    
    // Обновляем заказ
    const orderIndex = orders.findIndex(o => o.orderId === orderId);
    if (orderIndex !== -1) {
      orders[orderIndex].paymentId = paymentData.data.id;
      orders[orderIndex].paymentUrl = paymentData.data.pay_url;
    }
    
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
    const { order_id, status } = req.body;
    
    // Находим заказ
    const orderIndex = orders.findIndex(o => o.orderId === order_id);
    if (orderIndex === -1) {
      return res.status(404).json({ success: false, error: 'Заказ не найден' });
    }
    
    // Обновляем статус
    if (status === 'success') {
      orders[orderIndex].status = 'paid';
      orders[orderIndex].updatedAt = new Date();
      
      // Отправляем уведомление об успешной оплате
      await sendTelegramNotification({
        type: 'payment_success',
        orderId: order_id,
        amount: orders[orderIndex].totalAmount
      });
      
    } else if (status === 'failed') {
      orders[orderIndex].status = 'failed';
      orders[orderIndex].updatedAt = new Date();
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Ошибка обработки вебхука:', error);
    res.status(500).json({ success: false, error: 'Ошибка обработки' });
  }
});

// 4. Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'duck-backend',
    stats: {
      products: products.length,
      orders: orders.length
    }
  });
});

// 5. Информация о сервере
app.get('/', (req, res) => {
  res.json({
    service: 'Duck Shop Backend',
    version: '2.0',
    endpoints: {
      products: '/api/products',
      createPayment: '/api/create-payment',
      webhook: '/api/payment-webhook',
      health: '/health'
    }
  });
});

// ========== ЗАПУСК СЕРВЕРА ==========
app.listen(PORT, () => {
  validateConfig();
  
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
