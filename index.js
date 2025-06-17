require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const winston  = require('winston');

//--------------------------------------------------
// ─── НАСТРОЙКИ ───────────────────────────────────
//--------------------------------------------------
const BITRIX_URL  = process.env.BITRIX_URL;
const CATEGORY_ID = Number(process.env.CATEGORY_ID || 0); // "0" = первая воронка
const STAGE_ID    = process.env.STAGE_ID || 'NEW';
const PORT        = process.env.PORT || 3000;

if (!BITRIX_URL) {
  console.error('❌ BITRIX_URL не задан в переменных окружения');
  process.exit(1);
}

//--------------------------------------------------
// ─── ЛОГГЕР ──────────────────────────────────────
//--------------------------------------------------
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'DD-MM-YYYY HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [ new winston.transports.Console() ]
});

//--------------------------------------------------
// ─── ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ BITRIX ──────────
//--------------------------------------------------
async function btrx(method, params = {}) {
  try {
    const { data } = await axios.post(`${BITRIX_URL}/${method}`, null, { params });
    if (data.error) {
      throw new Error(`${method}: ${data.error_description || data.error}`);
    }
    return data.result;
  } catch (err) {
    logger.error(`${method}: ${err.message}`);
    throw err;
  }
}

//--------------------------------------------------
// ─── BUSINESS‑LOGIC ──────────────────────────────
//--------------------------------------------------
async function copyDeal(dealId) {
  logger.info(`▶️  Пришёл запрос на копирование сделки ${dealId}`);

  // 1️⃣ Получаем исходную сделку
  const deal = await btrx('crm.deal.get', { id: dealId });
  if (!deal) throw new Error(`Сделка ${dealId} не найдена`);

  // 2️⃣ Создаём новую сделку
  const newDealId = await btrx('crm.deal.add', {
    fields: {
      TITLE: deal.TITLE,
      CATEGORY_ID,
      STAGE_ID,
      ASSIGNED_BY_ID: deal.ASSIGNED_BY_ID,
      // добавьте нужные поля ↓↓↓
      // UF_CRM_xxx: deal.UF_CRM_xxx
    }
  });
  logger.info(`✅ Создана новая сделка ${newDealId}`);

  // 3️⃣ Получаем список открытых задач исходной сделки
  const taskList = await btrx('tasks.task.list', {
    filter: {
      UF_CRM_TASK: `D_${dealId}`,
      STATUS: [1,2,3,4] // открытые / в работе
    },
    select: ['ID','TITLE','RESPONSIBLE_ID','DESCRIPTION']
  });
  const tasks = taskList.tasks || [];
  logger.info(`📌 Найдено задач: ${tasks.length}`);

  // 4️⃣ Копируем задачи параллельно
  await Promise.allSettled(
    tasks.map(t =>
      btrx('tasks.task.add', {
        fields: {
          TITLE: t.TITLE,
          RESPONSIBLE_ID: t.RESPONSIBLE_ID,
          DESCRIPTION: t.DESCRIPTION || '',
          UF_CRM_TASK: [`D_${newDealId}`]
        }
      })
      .then(id => logger.info(`   • Задача ${id} скопирована`))
      .catch(e => logger.error(`   • Ошибка копии задачи ${t.ID}: ${e.message}`))
    )
  );

  return { oldDeal: dealId, newDeal: newDealId, tasksCopied: tasks.length };
}

//--------------------------------------------------
// ─── EXPRESS ─────────────────────────────────────
//--------------------------------------------------
const app = express();
app.use(express.json());

// Healthcheck
app.get('/healthcheck', (req,res) => res.json({ status: 'ok' }));

// Основной роут
app.post('/', async (req, res) => {
  const { deal_id } = req.body;
  if (!deal_id) return res.status(400).send('Параметр deal_id обязателен');

  try {
    // поддержка массива id
    const ids = Array.isArray(deal_id) ? deal_id : [deal_id];
    const results = [];

    for (const id of ids) {
      // в цикле, чтобы логировать шаги последовательно
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
