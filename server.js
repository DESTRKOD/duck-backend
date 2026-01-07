import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

/* === НАСТРОЙКИ === */
const BILEE_API = "https://paymentgate.bilee.ru/api";
const TG_TOKEN = process.env.TG_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SHOP_ID = process.env.SHOP_ID;
const BILEE_PASSWORD = process.env.BILEE_PASSWORD;


/* === BOT === */
const bot = new TelegramBot(TG_TOKEN, { polling: true });

/* === ХРАНИЛИЩЕ (просто) === */
const orders = {};

/* === ПОДПИСЬ === */
function sign(data) {13:35 07.01.2026
  const values = Object.keys({ ...data, password: BILEE_PASSWORD })
    .filter(k => k !== "signature" && k !== "metadata")
    .sort()
    .map(k => String((data[k] ?? "")))
    .join("");

  return crypto.createHash("sha256").update(values).digest("hex");
}

/* === СОЗДАТЬ ПЛАТЁЖ === */
app.post("/create-payment", async (req, res) => {
  const { items, method } = req.body;

  const amount = Object.values(items).reduce((a, b) => a + b, 0);
  const order_id = crypto.randomUUID();

  orders[order_id] = { items, status: "paid" };

  const payload = {
    order_id,
    method_slug: method, // card или sbp
    amount,
    shop_id: SHOP_ID,
    success_url: `https://destrkod.github.io/duck/success-pay.html?order=${order_id}`,
    fail_url: `https://destrkod.github.io/duck/fail.html`
  };

  payload.signature = sign(payload);

  const r = await axios.post(`${BILEE_API}/payment/init`, payload);
  res.json({ url: r.data.url, order_id });
});

/* === NOTIFY === */
app.post("/bilee-notify", (req, res) => {
  if (sign(req.body) !== req.body.signature) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);
});

/* === EMAIL === */
app.post("/submit-email", async (req, res) => {
  const { order_id, email } = req.body;
  orders[order_id].email = email;

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `📦 Запрос кода\n\nПочта: ${email}`,
    {
      reply_markup: {
        inline_keyboard: [[
          {
            text: "Запрос кода",
            callback_data: `code_${order_id}`
          }
        ]]
      }
    }
  );

  res.sendStatus(200);
});

/* === CALLBACK КНОПОК === */
bot.on("callback_query", async q => {
  const order_id = q.data.split("_")[1];

  await bot.sendMessage(
    ADMIN_CHAT_ID,
    `Введите код для заказа ${order_id}`
  );

  bot.once("message", async msg => {
    const code = msg.text;
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
});

/* === ГОТОВО / ОШИБКА === */
bot.on("callback_query", async q => {
  if (q.data.startsWith("ok_")) {
    orders[q.data.slice(3)].done = true;
  }
});

app.listen(3000);
