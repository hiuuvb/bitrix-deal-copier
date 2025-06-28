require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const winston = require('winston');

const BITRIX_URL = process.env.BITRIX_URL;
const TARGET_CATEGORY_ID = Number(process.env.TARGET_CATEGORY_ID || 14);
const PORT = process.env.PORT || 10000;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'DD-MM-YYYY HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [ new winston.transports.Console() ]
});

const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => res.send('Bitrix copier server OK'));

app.post('/webhook', async (req, res) => {
  let deal_id = Number(req.body?.deal_id || req.body?.ID || req.body?.id || 0);
  if (!deal_id) {
    logger.error('Не указан deal_id!');
    return res.status(400).json({ error: 'Не указан deal_id!' });
  }
  logger.info(`Поступил запрос на копирование сделки: ${deal_id}`);

  try {
    // Получаем исходную сделку
    const { data: getResp } = await axios.post(`${BITRIX_URL}/crm.deal.get`, { id: deal_id });
    if (getResp.error) throw new Error(getResp.error_description || getResp.error);

    const deal = getResp.result;
    const dealTitle = deal.TITLE;

    // Проверяем — не скопирована ли уже такая сделка в нужную категорию
    const { data: listResp } = await axios.post(`${BITRIX_URL}/crm.deal.list`, {
      filter: { CATEGORY_ID: TARGET_CATEGORY_ID, TITLE: dealTitle },
      select: ['ID', 'TITLE'],
      order: { ID: 'DESC' },
      limit: 1
    });

    const exists = listResp.result && listResp.result.length > 0;
    if (exists) {
      logger.warn(`Сделка уже скопирована (ID ${listResp.result[0].ID})`);
      return res.status(200).json({ status: 'already_exists', newDealId: listResp.result[0].ID });
    }

    // Копируем
    const { ID, CATEGORY_ID, STAGE_ID, ...fields } = deal;
    fields.CATEGORY_ID = TARGET_CATEGORY_ID;

    const { data: addResp } = await axios.post(`${BITRIX_URL}/crm.deal.add`, { fields });
    if (addResp.error) throw new Error(addResp.error_description || addResp.error);

    logger.info(`Сделка ${deal_id} скопирована как новая ${addResp.result}`);
    res.json({ status: 'ok', newDealId: addResp.result });
  } catch (err) {
    logger.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => logger.info(`🚀 Сервер запущен на порту ${PORT}`));
