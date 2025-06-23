// Bitrix Deal & Task Copier – standalone utility
// ------------------------------------------------------
// Копирует сделку в новую воронку и переносит все её открытые задачи.
// Запуск:
//   node bitrix_deal_task_copier.js <SOURCE_DEAL_ID> <TARGET_CATEGORY_ID>
// Параметры в .env:
//   BITRIX_URL           – https://your-domain.bitrix24.ru/rest/1/xxx
//   TARGET_CATEGORY_ID   – ID воронки (если не передан CLI)

require('dotenv').config();
const axios   = require('axios');
const winston = require('winston');

//──────────────────────────────────────────────────────────────────────────────
// Настройки
//──────────────────────────────────────────────────────────────────────────────
const BITRIX_URL         = process.env.BITRIX_URL;
const DEFAULT_CATEGORY_ID = Number(process.env.TARGET_CATEGORY_ID || 0);
if (!BITRIX_URL) {
  console.error('❌ BITRIX_URL не задан в .env');
  process.exit(1);
}

//──────────────────────────────────────────────────────────────────────────────
// Логгер
//──────────────────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'DD-MM-YYYY HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [ new winston.transports.Console() ]
});

// Обработчики неожиданных ошибок
process.on('unhandledRejection', err => logger.error(`UNHANDLED: ${err.stack || err}`));
process.on('uncaughtException',  err => { logger.error(`UNCAUGHT: ${err.stack || err}`); process.exit(1); });

//──────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции Bitrix REST
//──────────────────────────────────────────────────────────────────────────────
async function btrx(method, params = {}, asQuery = true) {
  const url = `${BITRIX_URL}/${method}`;
  const cfg = asQuery ? { params } : {};
  const body = asQuery ? null : params;
  const { data } = await axios.post(url, body, cfg);
  if (data.error) throw new Error(`${method}: ${data.error_description || data.error}`);
  return data.result;
}

async function btrxPaged(method, params = {}, key = 'tasks') {
  let start = 0, all = [];
  while (true) {
    const chunk = await btrx(method, { ...params, start }, true);
    all = all.concat(key ? chunk[key] || [] : chunk);
    if (!chunk.next) break;
    start = chunk.next;
  }
  return all;
}

//──────────────────────────────────────────────────────────────────────────────
// Копирование сделки
//──────────────────────────────────────────────────────────────────────────────
async function copyDeal(srcDealId, targetCategoryId) {
  logger.info(`▶️ Копирование сделки ${srcDealId} → воронка ${targetCategoryId}`);

  // Получаем исходную сделку
  const deal = await btrx('crm.deal.get', { id: srcDealId });
  if (!deal) throw new Error(`Сделка ${srcDealId} не найдена`);

  // Формируем поля для новой сделки, копируя все кроме ID, CATEGORY_ID, STAGE_ID, DATE_CREATE
  const { ID, CATEGORY_ID, STAGE_ID, DATE_CREATE, ...fields } = deal;
  fields.CATEGORY_ID = targetCategoryId;
  // При необходимости можно задать STAGE_ID = default или из .env

  // Создаём новую сделку
  const res = await btrx('crm.deal.add', { fields }, false);
  const newDealId = typeof res === 'object' ? res.result || res.id || res : res;
  logger.info(`✅ Создана новая сделка ${newDealId}`);
  return newDealId;
}

//──────────────────────────────────────────────────────────────────────────────
// Копирование задач
//──────────────────────────────────────────────────────────────────────────────
async function copyTasks(srcDealId, dstDealId) {
  logger.info(`▶️ Копируем задачи из D_${srcDealId} → D_${dstDealId}`);

  // Получаем открытые задачи по привязке UF_CRM_TASK
  const tasks = await btrxPaged('tasks.task.list', {
    filter: {
      'UF_CRM_TASK': `D_${srcDealId}`,
    },
    select: ['ID','TITLE','RESPONSIBLE_ID','DESCRIPTION','DEADLINE','PRIORITY','START_DATE_PLAN','END_DATE_PLAN']
  });

  if (!tasks.length) {
    logger.warn('   • Задач не найдено. Проверьте UF_CRM_TASK.');
    return 0;
  }
  logger.info(`📌 Найдено задач: ${tasks.length}`);

  let copied = 0;
  for (const t of tasks) {
    try {
      const r = await btrx('tasks.task.add', {
        fields: {
          TITLE: t.TITLE,
          RESPONSIBLE_ID: t.RESPONSIBLE_ID,
          DESCRIPTION: t.DESCRIPTION || '',
          DEADLINE: t.DEADLINE,
          PRIORITY: t.PRIORITY,
          START_DATE_PLAN: t.START_DATE_PLAN,
          END_DATE_PLAN: t.END_DATE_PLAN,
          UF_CRM_TASK: [`D_${dstDealId}`]
          STATUS: 2 // статус "Открыта"
        }
      }, false);
      const newId = typeof r === 'object' ? r.task?.id || r.id || r : r;
      logger.info(`   • Задача ${newId} скопирована`);
      copied++;
    } catch (e) {
      logger.error(`   • Ошибка копии задачи ${t.ID}: ${e.message}`);
    }
  }

  logger.info(`✅ Скопировано задач: ${copied}`);
  return copied;
}
async function copyActivities(srcDealId, dstDealId) {
  logger.info(`▶️ Копируем активности из сделки ${srcDealId} → ${dstDealId}`);
const activities = await btrxPaged('crm.activity.list', {
  filter: {
    'OWNER_TYPE_ID': 2, // 2 = сделка
    'OWNER_ID': srcDealId
  }
});
for (const act of activities) {
  try {
    const copy = await btrx('crm.activity.add', {
      fields: {
        SUBJECT: act.SUBJECT,
        TYPE_ID: act.TYPE_ID,                 // Тип (звонок, встреча, и т.д.)
        DIRECTION: act.DIRECTION,             // Входящий / исходящий
        START_TIME: act.START_TIME,
        END_TIME: act.END_TIME,
        RESPONSIBLE_ID: act.RESPONSIBLE_ID,
        DESCRIPTION: act.DESCRIPTION,
        COMMUNICATIONS: act.COMMUNICATIONS || [],
        OWNER_ID: dstDealId,
        OWNER_TYPE_ID: 2                     // Сделка
      }
    }, false);

    logger.info(`   • Скопировано дело: ${act.SUBJECT}`);
  } catch (err) {
    logger.warn(`   ⚠️ Ошибка при копировании дела "${act.SUBJECT}": ${err.message}`);
  }
}
//──────────────────────────────────────────────────────────────────────────────
// Основная логика CLI
//──────────────────────────────────────────────────────────────────────────────
(async () => {
  const [srcId, cliCategory] = process.argv.slice(2);
  if (!srcId) {
    console.log('Usage: node bitrix_deal_task_copier.js <SOURCE_DEAL_ID> [TARGET_CATEGORY_ID]');
    process.exit(0);
  }
  const targetCat = Number(cliCategory) || DEFAULT_CATEGORY_ID;
  if (!targetCat) {
    console.error('❌ Не указан TARGET_CATEGORY_ID в .env или параметрах CLI');
    process.exit(1);
  }

  try {
    const newDeal = await copyDeal(srcId, targetCat);
    await copyTasks(srcId, newDeal);
  } catch (err) {
    logger.error(err.stack || err.message);
    process.exit(1);
  }
})();
