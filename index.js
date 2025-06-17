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
const PARALLEL_TASKS = Number(process.env.PARALLEL_TASKS || 3);

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
// ─── BITRIX REST ─────────────────────────────────
//--------------------------------------------------
async function btrx(method, params = {}, useQuery = false) {
  try {
    const axiosConfig = useQuery
      ? { params }                              // query‑string (tasks.task.list)
      : params;                                 // JSON‑body
    const { data } = useQuery
      ? await axios.post(`${BITRIX_URL}/${method}`, null, axiosConfig)
      : await axios.post(`${BITRIX_URL}/${method}`, axiosConfig);

    if (data.error) throw new Error(`${method}: ${data.error_description || data.error}`);
    return data.result;
  } catch (err) {
    logger.error(`${method}: ${err.message}`);
    throw err;
  }
}

async function btrxPaged(method, params = {}, key = 'tasks') {
  let start = 0, items = [];
  while (true) {
    const chunk = await btrx(method, { ...params, start }, true); // query‑string
    const list  = key ? chunk[key] || [] : chunk;
    items = items.concat(list);
    if (!chunk.next) break;
    start = chunk.next;
  }
  return items;
}

//--------------------------------------------------
// ─── КОПИРОВАНИЕ СДЕЛКИ ──────────────────────────
//--------------------------------------------------
const DEAL_FIELD_BLACKLIST = [
  'ID','CATEGORY_ID','STAGE_ID','STAGE_SEMANTIC_ID','DATE_CREATE','DATE_MODIFY','CREATED_BY_ID',
  'MODIFY_BY_ID','BEGINDATE','CLOSEDATE','DATE_CLOSED','ORIGIN_ID','ORIGIN_VERSION',
  'IS_NEW','IS_RETURN_CUSTOMER','IS_REPEATED_APPROACH','LEAD_ID','WEBFORM_ID'
];

function cloneDealFields(src) {
  const fields = { CATEGORY_ID, STAGE_ID };
  let uf = 0;
  for (const [k,v] of Object.entries(src)) {
    if (DEAL_FIELD_BLACKLIST.includes(k)) continue;
    fields[k] = v;
    if (k.startsWith('UF_')) uf++;
  }
  logger.info(`   • Копируем UF‑полей: ${uf}`);
  return fields;
}

async function copyDeal(dealId) {
  logger.info(`▶️  Копируем сделку ${dealId}`);
  const deal = await btrx('crm.deal.get', { id: dealId }, true);
  if (!deal) throw new Error(`Сделка ${dealId} не найдена`);
  logger.debug(`DEAL:\n${JSON.stringify(deal, null, 2)}`);

  const newDealId = await btrx('crm.deal.add', { fields: cloneDealFields(deal) });
  logger.info(`✅ Создана сделка‑копия ${newDealId}`);

  const tasks = await btrxPaged('tasks.task.list', {
    filter: {
      'UF_CRM_TASK': [`D_${dealId}`], // множественное поле → массив
      '!=STATUS': 5
    },
    select: ['ID','TITLE','RESPONSIBLE_ID','DESCRIPTION','DEADLINE','PRIORITY','START_DATE_PLAN','END_DATE_PLAN']
  });
  logger.info(`📌 Задач к копированию: ${tasks.length}`);

  let copied = 0;
  for (let i = 0; i < tasks.length; i += PARALLEL_TASKS) {
    const chunk = tasks.slice(i, i + PARALLEL_TASKS);
    await Promise.allSettled(chunk.map(t =>
      btrx('tasks.task.add', {
        fields: {
          TITLE: t.TITLE,
          RESPONSIBLE_ID: t.RESPONSIBLE_ID,
          DESCRIPTION: t.DESCRIPTION || '',
          DEADLINE: t.DEADLINE,
          PRIORITY: t.PRIORITY,
          START_DATE_PLAN: t.START_DATE_PLAN,
          END_DATE_PLAN: t.END_DATE_PLAN,
          UF_CRM_TASK: [`D_${newDealId}`]
        }
      })
      .then(r => { const id = r.task?.id || r.id || r; logger.info(`   • Задача ${id} скопирована`); copied++; })
      .catch(e => logger.error(`   • Ошибка задачи ${t.ID}: ${e.message}`))
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

app.post('/', async (req,res) => {
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
// ─── ЗАПУСК ──────────────────────────────────────
//--------------------------------------------------
app.listen(PORT, () => logger.info(`🚀 Сервер запущен на порту ${PORT}`));
