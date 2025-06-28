require('dotenv').config();
const axios = require('axios');
const winston = require('winston');

const BITRIX_URL          = process.env.BITRIX_URL;
const DEFAULT_CATEGORY_ID = Number(process.env.TARGET_CATEGORY_ID || 14);
const DEFAULT_RESPONSIBLE = Number(process.env.DEFAULT_RESPONSIBLE_ID || 1);

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

// Получение всех задач сделки
async function getDealTasks(dealId) {
  const tasks = [];
  let start = 0;
  while (true) {
    const res = await btrx('tasks.task.list', {
      filter: { 'UF_CRM_TASK': `D_${dealId}` },
      select: [
        'ID','TITLE','RESPONSIBLE_ID','DESCRIPTION',
        'START_DATE_PLAN','END_DATE_PLAN','DEADLINE','PRIORITY','STATUS'
      ],
      start
    });
    tasks.push(...(res.tasks || []));
    if (!res.next) break;
    start = res.next;
  }
  return tasks;
}

// Получение всех активностей сделки
async function getDealActivities(dealId) {
  const acts = [];
  let start = 0;
  while (true) {
    const res = await btrx('crm.activity.list', {
      filter: { OWNER_TYPE_ID: 2, OWNER_ID: dealId },
      start
    });
    acts.push(...(res.activities || []));
    if (!res.next) break;
    start = res.next;
  }
  return acts;
}

// Копировать задачи (все открыть)
async function copyTasksOpen(srcDealId, dstDealId) {
  const tasks = await getDealTasks(srcDealId);
  for (const t of tasks) {
    const title = t.TITLE?.trim() || `Задача #${t.ID}`;
    const responsible = t.RESPONSIBLE_ID > 0 ? t.RESPONSIBLE_ID : DEFAULT_RESPONSIBLE;

    const fields = {
      TITLE:           title,
      RESPONSIBLE_ID:  responsible,
      DESCRIPTION:     t.DESCRIPTION || '',
      START_DATE_PLAN: t.START_DATE_PLAN || undefined,
      END_DATE_PLAN:   t.END_DATE_PLAN || undefined,
      DEADLINE:        t.DEADLINE || undefined,
      PRIORITY:        t.PRIORITY || 1,
      UF_CRM_TASK:     [`D_${dstDealId}`],
      STATUS:          2 // всегда "В работе"
    };
    try {
      logger.info(`Копируем задачу "${title}" → новой сделке ${dstDealId}`);
      await btrx('tasks.task.add', { fields }, false);
    } catch (e) {
      logger.error(`Ошибка копирования задачи ${t.ID}: ${e.message}`);
    }
  }
}

// Копировать активности (все сделать незавершенными)
async function copyActivitiesOpen(srcDealId, dstDealId) {
  const acts = await getDealActivities(srcDealId);
  for (const a of acts) {
    const subject = a.SUBJECT?.trim() || `Дело #${a.ID}`;
    const responsible = a.RESPONSIBLE_ID > 0 ? a.RESPONSIBLE_ID : DEFAULT_RESPONSIBLE;
    const fields = {
      SUBJECT:        subject,
      TYPE_ID:        a.TYPE_ID,
      DIRECTION:      a.DIRECTION,
      START_TIME:     a.START_TIME,
      END_TIME:       a.END_TIME,
      RESPONSIBLE_ID: responsible,
      DESCRIPTION:    a.DESCRIPTION || '',
      COMMUNICATIONS: a.COMMUNICATIONS || [],
      OWNER_ID:       dstDealId,
      OWNER_TYPE_ID:  2,
      COMPLETED:      'N'
    };
    try {
      logger.info(`Копируем дело "${subject}" → новой сделке ${dstDealId}`);
      await btrx('crm.activity.add', { fields }, false);
    } catch (e) {
      logger.error(`Ошибка копирования дела ${a.ID}: ${e.message}`);
    }
  }
}

module.exports = { copyTasksOpen, copyActivitiesOpen };
