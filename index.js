rrequire('dotenv').config();
const axios   = require('axios');
const winston = require('winston');

//--------------------------------------------------
// ─── НАСТРОЙКИ ───────────────────────────────────
//--------------------------------------------------
const BITRIX_URL = process.env.BITRIX_URL;
if (!BITRIX_URL) {
  console.error('❌ BITRIX_URL не задан в .env');
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
// ─── BITRIX REST HELPERS ─────────────────────────
//--------------------------------------------------
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
    const part = await btrx(method, { ...params, start }, true);
    all = all.concat(key ? part[key] || [] : part);
    if (!part.next) break;
    start = part.next;
  }
  return all;
}

//--------------------------------------------------
// ─── COPY TASKS ──────────────────────────────────
//--------------------------------------------------
async function copyTasks(srcDealId, dstDealId) {
  logger.info(`▶️  Копируем задачи из D_${srcDealId} → D_${dstDealId}`);

  // 1️⃣ Получаем все открытые задачи исходной сделки
  const tasks = await btrxPaged('tasks.task.list', {
    filter: {
      'UF_CRM_TASK': `D_${srcDealId}`,
      '!STATUS': 5 // исключаем завершённые
    },
    select: [
      'ID','TITLE','RESPONSIBLE_ID','DESCRIPTION',
      'DEADLINE','PRIORITY','START_DATE_PLAN','END_DATE_PLAN'
    ]
  });

  if (!tasks.length) {
    logger.warn('   • Задач не найдено. Проверяйте привязку UF_CRM_TASK.');
    return;
  }
  logger.info(`📌 Найдено задач: ${tasks.length}`);

  let copied = 0;
  for (const t of tasks) {
    try {
      const res = await btrx('tasks.task.add', {
        fields: {
          TITLE: t.TITLE,
          RESPONSIBLE_ID: t.RESPONSIBLE_ID,
          DESCRIPTION: t.DESCRIPTION || '',
          DEADLINE: t.DEADLINE,
          PRIORITY: t.PRIORITY,
          START_DATE_PLAN: t.START_DATE_PLAN,
          END_DATE_PLAN: t.END_DATE_PLAN,
          UF_CRM_TASK: [`D_${dstDealId}`]
        }
      }, false);
      const id = res.task?.id || res.id || res;
      logger.info(`   • Задача ${id} скопирована`);
      copied++;
    } catch (err) {
      logger.error(`   • Ошибка копирования ${t.ID}: ${err.message}`);
    }
  }

  logger.info(`✅ Скопировано задач: ${copied}`);
}

//--------------------------------------------------
// ─── CLI ─────────────────────────────────────────
//--------------------------------------------------
(async () => {
  const [src, dst] = process.argv.slice(2);
  if (!src || !dst) {
    console.log('Usage: node bitrix_task_copier.js <SOURCE_DEAL_ID> <TARGET_DEAL_ID>');
    process.exit(0);
  }
  try {
    await copyTasks(src, dst);
  } catch (e) {
    logger.error(e.message);
  }
})();
