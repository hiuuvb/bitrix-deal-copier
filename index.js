// Bitrix Deal Copier – полноценный рабочий файл
// ---------------------------------------------
// • Копирует сделку и все её открытые задачи в новую сделку
// • Обрабатывает пагинацию Bitrix24, выводит подробный лог
// • Запускается как Express‑сервис (POST /  { deal_id: 123 | [123,456] })
// • .env: BITRIX_URL, CATEGORY_ID, STAGE_ID, PORT, LOG_LEVEL

require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const winston  = require('winston');
const qs       = require('qs');

//--------------------------------------------------
// ─── НАСТРОЙКИ ───────────────────────────────────
//--------------------------------------------------
const BITRIX_URL  = process.env.BITRIX_URL;                      // https://example.bitrix24.ru/rest/1/xyz/
const CATEGORY_ID = Number(process.env.CATEGORY_ID || 14);      // «0» = первая воронка
const STAGE_ID    = process.env.STAGE_ID || 'РД_выдан';          // стадия новой сделки
const PORT        = process.env.PORT || 3000;                   // порт Express
const LOG_LEVEL   = process.env.LOG_LEVEL || 'info';            // info / debug / error

if (!BITRIX_URL) {
  console.error('❌ BITRIX_URL не задан в переменных окружения');
  process.exit(1);
}

//--------------------------------------------------
// ─── ЛОГГЕР ──────────────────────────────────────
//--------------------------------------------------
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'DD-MM-YYYY HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [ new winston.transports.Console() ]
});

// Глобальные ловцы ошибок
process.on('unhandledRejection', err => logger.error(`unhandledRejection: ${err.message}`));
process.on('uncaughtException', err => {
  logger.error(`uncaughtException: ${err.message}`);
  process.exit(1);
});

//--------------------------------------------------
// ─── ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ BITRIX ──────────
//--------------------------------------------------
async function btrx(method, params = {}) {
  try {
    const { data } = await axios.post(
      `${BITRIX_URL}/${method}`,
      qs.stringify(params),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (data.error) throw new Error(`${method}: ${data.error_description || data.error}`);
    return data.result;
  } catch (err) {
    logger.error(`${method}: ${err.message}`);
    throw err;
  }
}

// Пагинация Bitrix24 («start» / «next»)
async function btrxPaged(method, params = {}, key = 'tasks') {
  let start = 0;
  let all   = [];
  while (true) {
    const chunk = await btrx(method, { ...params, start });
    all = all.concat(key ? chunk[key] || [] : chunk);
    if (!chunk.next) break;
    start = chunk.next;
  }
  return all;
}

//--------------------------------------------------
// ─── BUSINESS‑LOGIC ──────────────────────────────
//--------------------------------------------------
async function copyDeal(dealId) {
  logger.info(`▶️  Копирование сделки ${dealId}`);

  // 1️⃣ Получаем исходную сделку
  const deal = await btrx('crm.deal.get', { id: dealId });
  if (!deal) throw new Error(`Сделка ${dealId} не найдена`);

  // 2️⃣ Создаём новую сделку
  const { id: newDealId } = await btrx('crm.deal.add', {
    fields: {
      TITLE: deal.TITLE,
      CATEGORY_ID,
      STAGE_ID,
      ASSIGNED_BY_ID: deal.ASSIGNED_BY_ID
      // при необходимости добавьте свои поля ↓↓↓
      // UF_CRM_XYZ: deal.UF_CRM_XYZ
    }
  });
  logger.info(`✅ Создана новая сделка ${newDealId}`);

  // 3️⃣ Получаем все открытые задачи, привязанные к исходной сделке
  const tasks = await btrxPaged('tasks.task.list', {
    filter: {
      '!=STATUS': 5,                       // исключаем завершённые
      UF_CRM_TASK: [`D_${dealId}`]         // связь с «старой» сделкой
    },
    select: ['ID', 'TITLE', 'RESPONSIBLE_ID', 'DESCRIPTION']
  });
  logger.info(`📌 Найдено задач: ${tasks.length}`);

  // 4️⃣ Копируем задачи последовательно (избегаем 502 от Bitrix)
  let copied = 0;
  for (const t of tasks) {
    try {
      const { task } = await btrx('tasks.task.add', {
        fields: {
          TITLE: t.TITLE,
          RESPONSIBLE_ID: t.RESPONSIBLE_ID,
          DESCRIPTION: t.DESCRIPTION || '',
          UF_CRM_TASK: [`D_${newDealId}`]
        }
      });
      logger.info(`   • Задача ${task.id} скопирована`);
      copied += 1;
    } catch (e) {
      logger.error(`   • Ошибка копирования ${t.ID}: ${e.message}`);
    }
  }

  return { oldDeal: dealId, newDeal: newDealId, tasksCopied: copied };
}

//--------------------------------------------------
// ─── EXPRESS ─────────────────────────────────────
//--------------------------------------------------
const app = express();
app.use(express.json());

// Healthcheck
app.get('/healthcheck', (req, res) => res.json({ status: 'ok' }));

// Основной роут
app.post('/', async (req, res) => {
  const { deal_id } = req.body;
  if (!deal_id) return res.status(400).send('Параметр deal_id обязателен');

  try {
    const ids     = Array.isArray(deal_id) ? deal_id : [deal_id];
    const results = [];

    for (const id of ids) {
      const result = await copyDeal(id);
      results.push(result);
    }

    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

//--------------------------------------------------
// ─── СТАРТ СЕРВЕРА ───────────────────────────────
//--------------------------------------------------
app.listen(PORT, () => logger.info(`🚀 Сервер запущен на порту ${PORT}`));
