const { copyDeal, copyTasks, copyActivities } = require('./bitrix_deal_task_transfer');
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const winston = require('winston');

// ✅ Сначала создаём app
const app = express();

const { copyDeal, copyTasks, copyActivities } = require('./bitrix_deal_task_transfer');

// Затем всё остальное:
const PORT = process.env.PORT || 10000;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'DD-MM-YYYY HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [ new winston.transports.Console() ]
});

// Миддлвары
app.use(bodyParser.json());

// Роуты
app.get('/', (req, res) => res.send('Bitrix transfer server OK'));

app.post('/webhook', async (req, res) => {
  logger.info('▶️  Пришёл запрос на копирование сделки');
  logger.info(`Request body: ${JSON.stringify(req.body)}`);

  let deal_id = req.body?.deal_id || req.body?.ID || req.body?.id || null;
  if (!deal_id) {
    logger.error('Нужно передать ID сделки!');
    return res.status(400).json({ error: 'Нужно передать ID сделки!' });
  }
  deal_id = Number(deal_id);

  try {
    logger.info(`🚀 Копируем сделку с id ${deal_id}`);
    const newDealId = await copyDeal(deal_id, Number(process.env.TARGET_CATEGORY_ID || 14));
    logger.info(`✅ Новая сделка создана: ${newDealId}`);
    await copyTasks(deal_id, newDealId);
    await copyActivities(deal_id, newDealId);
    res.json({ status: 'ok', newDealId });
  } catch (err) {
    logger.error(err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ⬅️ В конце запускаем сервер
app.listen(PORT, () => logger.info(`🚀 Сервер запущен на порту ${PORT}`));
