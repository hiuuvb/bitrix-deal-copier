// Bitrix Deal Copier – v3 (стабильная версия)
// ---------------------------------------------
// ↪ Исправлено «undefined» при создании сделки:
//    • Вернули query‑string вариант вызова Bitrix REST (axios.post(url, null, { params }))
// ↪ Корректный фильтр задач (UF_CRM_TASK как массив, STATUS != 5)
// ↪ Максимально совместимый парсинг ответов (dealId = num | obj.id)
// ↪ Опция PARALLEL_TASKS = 3 для мягкого лимита RPS

require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const winston  = require('winston');

//--------------------------------------------------
// ─── НАСТРОЙКИ ───────────────────────────────────
//--------------------------------------------------
const BITRIX_URL  = process.env.BITRIX_URL;
const CATEGORY_ID = Number(process.env.CATEGORY_ID || 14);
const STAGE_ID    = process.env.STAGE_ID || 'РД_выдан';
const PORT        = process.env.PORT || 3000;
const PARALLEL_TASKS = Number(process.env.PARALLEL_TASKS || 3); // одноврем. копий задач

if (!BITRIX_URL) {
  console.error('❌ BITRIX_URL не задан в переменных окружения');
  process.exit(1);
}

//--------------------------------------------------
// ─── ЛОГГЕР ──────────────────────────────────────
//--------------------------------------------------
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'DD-MM-YYYY HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [ new winston.transports.Console() ]
});

process.on('unhandledRejection', err => logger.error(`UNHANDLED: ${err.message}`));
process.on('uncaughtException', err => { logger.error(`UNCAUGHT: ${err.message}`); process.exit(1); });

//--------------------------------------------------
// ─── ФУНКЦИЯ ВЗАИМОДЕЙСТВИЯ С BITRIX ─────────────
//--------------------------------------------------
async function btrx(method, params = {}) {
  try {
    const { data } = await axios.post(`${BITRIX_URL}/${method}`, null, { params });
    if (data.error) throw new Error(`${method}: ${data.error_description || data.error}`);
    return data.result;
  } catch (err) {
    logger.error(`${method}: ${err.message}`);
    throw err;
  }
}

// Пагинация (tasks.task.list возвращает next)
async function btrxPaged(method, params = {}, key = 'tasks') {
  let start = 0, collected = [];
  while (true) {
    const chunk = await btrx(method, { ...params, start });
    collected = collected.concat(key ? chunk[key] || [] : chunk);
    if (!chunk.next) break;
    start = chunk.next;
  }
  return collected;
}

//--------------------------------------------------
// ─── BUSINESS‑LOGIC ──────────────────────────────
//--------------------------------------------------
async function copyDeal(dealId) {
  logger.info(`▶️  Копирование сделки ${dealId}`);

  // 1️⃣ Исходная сделка
  const deal = await btrx('crm.deal.get', { id: dealId });
  if (!deal) throw new Error(`Сделка ${dealId} не найдена`);

  // 2️⃣ Создаём новую сделку
  const newDealRes = await btrx('crm.deal.add', {
    fields: {
      TITLE: deal.TITLE,
      CATEGORY_ID,
      STAGE_ID,
      ASSIGNED_BY_ID: deal.ASSIGNED_BY_ID
    }
  });
  const newDealId = typeof newDealRes === 'object' ? newDealRes.id || newDealRes.ID : newDealRes;
  logger.info(`✅ Создана новая сделка ${newDealId}`);

  // 3️⃣ Все открытые задачи исходной сделки
  const tasks = await btrxPaged('tasks.task.list', {
    filter: {
      'UF_CRM_TASK': [`D_${dealId}`],
      '!=STATUS': 5 // исключаем завершённые
    },
    select: ['ID','TITLE','RESPONSIBLE_ID','DESCRIPTION']
  });
  logger.info(`📌 Найдено задач: ${tasks.length}`);

  // 4️⃣ Копируем задачи с ограничением параллелизма
  let copied = 0;
  for (let i = 0; i < tasks.length; i += PARALLEL_TASKS) {
    const slice = tasks.slice(i, i + PARALLEL_TASKS);
    const results = await Promise.allSettled(slice.map(t =>
      btrx('tasks.task.add', {
        fields: {
          TITLE: t.TITLE,
          RESPONSIBLE_ID: t.RESPONSIBLE_ID,
          DESCRIPTION: t.DESCRIPTION || '',
          UF_CRM_TASK: [`D_${newDealId}`]
        }
      })
      .then(r => {
        const id = typeof r === 'object' ? r.task?.id || r.id : r;
        logger.info(`   • Задача ${id} скопирована`);
        copied++;
      })
      .catch(e => logger.error(`   • Ошибка копии задачи ${t.ID}: ${e.message}`))
    ));
  }

  return { oldDeal: dealId, newDeal: newDealId, tasksCopied: copied };
}

//--------------------------------------------------
// ─── EXPRESS ─────────────────────────────────────
//--------------------------------------------------
const app = express();
app.use(express.json());

app.get('/healthcheck', (req,res) => res.json({ status: 'ok' }));

app.post('/', async (req, res) => {
  const { deal_id } = req.body;
  if (!deal_id) return res.status(400).send('Параметр deal_id обязателен');

  try {
    const ids = Array.isArray(deal_id) ? deal_id : [deal_id];
    const results = [];
    for (const id of ids) results.push(await copyDeal(id));
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

//--------------------------------------------------
// ─── СТАРТ СЕРВЕРА ───────────────────────────────
//--------------------------------------------------
app.listen(PORT, () => logger.info(`🚀 Сервер запущен на порту ${PORT}`));
