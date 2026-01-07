import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import TelegramBot from "node-telegram-bot-api";

/* ================== CONFIG ================== */
const PORT = process.env.PORT || 3000;
const BILEE_API = "https://paymentgate.bilee.ru/api";

const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID);
const SHOP_ID = Number(process.env.SHOP_ID);
const BILEE_PASSWORD = process.env.BILEE_PASSWORD;

// ❗ ОБЯЗАТЕЛЬНО ваш render-домен
const RENDER_URL = "https://duck-backend.onrender.com";

/* ================== APP ================== */
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

/* ===== ROOT ENDPOINT (RENDER HEALTH) ===== */
app.get("/", (req, res) => {
  res.send("OK");
});

/* ================== TELEGRAM BOT ================== */
const bot = new TelegramBot(TG_TOKEN);

/* webhook path */
const WEBHOOK_PATH = `/telegram/${TG_TOKEN}`;
const WEBHOOK_URL = `${RENDER_URL}${WEBHOOK_PATH}`;

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

/* ================== STORAGE (MVP) ================== */
const orders = {};
const awaitingCode = {};

/* ================== BILEEPAY SIGN ================== */
function sign(data) {
  const tokenData = {
    ...data,
    password: BILEE_PASSWORD
  };

  const excluded = ["metadata", "signature"];

  const values = Object.keys(tokenData)
    .filter(k => !excluded.includes(k))
    .sort()
    .map(k => String(tokenData[k] ?? ""))
    .join("");

  return crypto
    .createHash("sha256")
    .update(values, "utf8")
    .digest("hex");
}

/* ================== CREATE PAYMENT ================== */
app.post("/create-payment", async (req, res) => {
  try {
    const { items, method } = req.body;
    if (!items || !method) {
      return res.status(400).json({ error: "Bad request" });
    }

    const amount = Object.values(items).reduce((a, b) => a + b, 0);
    const order_id = crypto.randomUUID();

    orders[order_id] = {
      items,
      status: "new"
    };

    const payload = {
      order_id,
      method_slug: method, // card | sbp
      amount,
      shop_id: SHOP_ID,
      success_url: `https://destrkod.github.io/duck/success-pay.html?order=${order_id}`,
      fail_url: `https://destrkod.github.io/duck/fail.html`
    };

    payload.signature = sign(payload);

    const r = await axios.post(
      `${BILEE_API}/payment/init`,
      payload,
      { timeout: 15000 }
    );

    res.json({
      url: r.data.url,
      order_id
    });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: "Payment init failed" });
  }
});

/* ================== BILEEPAY NOTIFY ================== */
app.post("/bilee-notify", (req, res) => {
  if (sign(req.body) !== req.body.signature) {
    return res.sendStatus(403);
  }

  const { order_id, status } = req.body;
  if (orders[order_id]) {
    orders[order_id].status = status;
  }

  res.sendStatus(200);
});

/* ================== SUBMIT EMAIL ================== */
app.post("/submit-email", async (req, res) => {
  const { order_id, email } = req.body;
  if (!orders[order_id]) return res.sendStatus(404);

  orders[order_id].email = email;

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `📦 Запрос кода\n\nПочта: ${email}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "Запрос кода", callback_data: `code_${order_id}` }
        ]]
      }
    }
  );

  res.sendStatus(200);
});

/* ================== CALLBACK: REQUEST CODE ================== */
bot.on("callback_query", async q => {
  if (!q.data.startsWith("code_")) return;

  const order_id = q.data.split("_")[1];
  awaitingCode[ADMIN_CHAT_ID] = order_id;

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `Введите код для заказа ${order_id}`
  );
});

/* ================== ADMIN SENDS CODE ================== */
bot.on("message", async msg => {
  if (msg.chat.id !== ADMIN_CHAT_ID) return;

  const order_id = awaitingCode[msg.chat.id];
  if (!order_id) return;

  const code = msg.text.trim();
  delete awaitingCode[msg.chat.id];

  orders[order_id].code = code;

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `Заказ №${order_id}
Состав: ${JSON.stringify(orders[order_id].items)}
Почта: ${orders[order_id].email}
Код: ${code}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "Готово", callback_data: `ok_${order_id}` },
          { text: "Ошибка", callback_data: `err_${order_id}` }
        ]]
      }
    }
  );
});

/* ================== DONE / ERROR ================== */
bot.on("callback_query", async q => {
  if (q.data.startsWith("ok_")) {
    orders[q.data.slice(3)].status = "done";
  }

  if (q.data.startsWith("err_")) {
    orders[q.data.slice(4)].status = "error";
  }
});

/* ================== START ================== */
app.listen(PORT, "0.0.0.0", async () => {
  console.log("Server running on port", PORT);

  try {
    await bot.setWebHook(WEBHOOK_URL);
    console.log("Telegram webhook set");
  } catch (e) {
    console.error("Webhook error:", e.message);
  }
});
