require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const winston = require('winston');
const { copyDeal, copyTasks, copyActivities } = require('./bitrix_deal_task_transfer');

const PORT = process.env.PORT || 10000;

// Логгер
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'DD-MM-YYYY HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

const app = express();
app.use(bodyParser.json());

// healthcheck
app.get('/', (req, res) => res.send('Bitrix transfer server OK'));

// Основной вебхук
app.post('/webhook', async (req, res) => {
  logger.info('▶️  Пришёл запрос на копирование сделки');
  logger.info(`Request body: ${JSON.stringify(req.body)}`);

  let deal_id = req.body?.deal_id || req.body?.ID || req.body?.id || null;
  if (!deal_id) {
    logger.error('❌ Нужно передать ID сделки!');
    return res.status(400).json({ error: 'Нужно передать ID сделки!' });
  }

  deal_id = Number(deal_id);
  if (isNaN(deal_id)) {
    logger.error('❌ ID сделки должен быть числом!');
    return res.status(400).json({ error: 'ID сделки должен быть числом!' });
  }

  try {
    logger.info(`🚀 Копируем сделку с ID ${deal_id} в категорию ${process.env.TARGET_CATEGORY_ID}`);
    const newDealId = await copyDeal(deal_id, Number(process.env.TARGET_CATEGORY_ID || 14));
    logger.info(`✅ Сделка скопирована. Новый ID: ${newDealId}`);

    await copyTasks(deal_id, newDealId);
    logger.info(`✅ Задачи скопированы`);

    await copyActivities(deal_id, newDealId);
    logger.info(`✅ Активности скопированы`);

    res.json({ status: 'ok', newDealId });
  } catch (err) {
    logger.error(`❌ Ошибка при копировании: ${err.stack || err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  logger.info(`🚀 Сервер запущен на порту ${PORT}`);
});
