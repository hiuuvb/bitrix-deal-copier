// index.js — API для копирования сделки в Bitrix24 по GET /copy
require('dotenv').config();
const axios = require('axios');
const winston = require('winston');
const express = require('express');
const app = express();

const BITRIX_URL          = process.env.BITRIX_URL;
const DEFAULT_CATEGORY_ID = Number(process.env.TARGET_CATEGORY_ID || 14);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'DD-MM-YYYY HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [ new winston.transports.Console() ]
});

// Универсальный вызов Bitrix REST API
async function btrx(method, params = {}, asQuery = true) {
  const url = `${BITRIX_URL}/${method}`;
  const cfg = asQuery ? { params } : {};
  const body = asQuery ? null : params;
  const { data } = await axios.post(url, body, cfg);
  if (data.error) throw new Error(`${method}: ${data.error_description || data.error}`);
  return data.result;
}

// Копирование сделки
async function copyDeal(srcId, catId) {
  const deal = await btrx('crm.deal.get', { id: srcId });
  if (!deal) throw new Error(`Сделка ${srcId} не найдена`);
  const { ID, CATEGORY_ID, STAGE_ID, DATE_CREATE, ...fields } = deal;
  fields.CATEGORY_ID = catId;
  const res = await btrx('crm.deal.add', { fields }, false);
  return (typeof res === 'object' ? (res.result || res.id) : res);
}

// Основная логика копирования последней сделки из исходной воронки
async function mainCopy() {
  logger.info(`🔍 Ищем последнюю сделку из воронки 70...`);
  const deals = await btrx('crm.deal.list', {
    order:  { ID: 'DESC' },
    filter: { CATEGORY_ID: 70 },
    select: ['ID','TITLE'],
    limit:  1
  });
  const srcId = deals[0]?.ID;
  if (!srcId) { logger.error('❌ Сделка не найдена'); throw new Error('Не найдено сделок'); }
  logger.info(`📎 Найдена сделка ${srcId}`);

  // Проверяем копию в целевой воронке
  const exists = await btrx('crm.deal.list', {
    filter:   { CATEGORY_ID: DEFAULT_CATEGORY_ID, TITLE: deals[0].TITLE },
    select:   ['ID'],
    limit:    1
  });
  if (exists.length) {
    logger.warn(`⚠️ Сделка уже скопирована (ID ${exists[0].ID})`);
    return { status: 'already_exists', deal_id: exists[0].ID };
  }

  const newId = await copyDeal(srcId, DEFAULT_CATEGORY_ID);
  logger.info(`✅ Сделка скопирована: ${newId}`);
  return { status: 'copied', deal_id: newId };
}

// API endpoint: GET /copy
app.get('/copy', async (req, res) => {
  try {
    const result = await mainCopy();
    res.json(result);
  } catch (err) {
    logger.error(err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Render требует, чтобы сервер слушал порт!
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`API сервер запущен на порту ${PORT}`));
