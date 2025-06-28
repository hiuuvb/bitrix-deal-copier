// bitrix_deal_transfer.js — копирует сделку в производство (воронка 14) с задачами и делами

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

// Пагинация
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

// Копирование сделки (все поля)
async function copyDeal(srcId, catId) {
  const deal = await btrx('crm.deal.get', { id: srcId });
  if (!deal) throw new Error(`Сделка ${srcId} не найдена`);
  const { ID, CATEGORY_ID, STAGE_ID, DATE_CREATE, ...fields } = deal;
  fields.CATEGORY_ID = catId;
  // Для новой сделки этап выставляем в "новая"
  fields.STAGE_ID = 'C14:NEW';
  const res = await btrx('crm.deal.add', { fields }, false);
  return (typeof res === 'object' ? (res.result || res.id) : res);
}

// Копирование задач (все задачи переносятся, последняя открытая — реально открыта)
async function copyTasks(srcDealId, dstDealId) {
  const tasks = await btrxPaged('tasks.task.list', {
    filter: { 'UF_CRM_TASK': `D_${srcDealId}` },
    select: [
      'ID','TITLE','RESPONSIBLE_ID','DESCRIPTION',
      'START_DATE_PLAN','END_DATE_PLAN','DEADLINE','PRIORITY','STATUS','CHANGED_DATE'
    ]
  }, 'tasks');

  // Находим последнюю не завершённую задачу
  const openTasks = tasks.filter(t => t.STATUS != 5);
  let reopenTaskIds = [];
  if (openTasks.length > 0) {
    let lastChanged = Math.max(...openTasks.map(t => new Date(t.CHANGED_DATE).getTime()));
    reopenTaskIds = openTasks
      .filter(t => new Date(t.CHANGED_DATE).getTime() === lastChanged)
      .map(t => t.ID);
  }

  for (const t of tasks) {
    const title = t.TITLE?.trim() || `Задача #${t.ID}`;
    const responsible = t.RESPONSIBLE_ID > 0 ? t.RESPONSIBLE_ID : DEFAULT_RESPONSIBLE;
    let status;
    if (reopenTaskIds.includes(t.ID)) {
      status = 2; // последняя открыта
    } else if (t.STATUS == 5) {
      status = 5; // завершена
    } else {
      status = 5; // все остальные как завершённые
    }

    const fields = {
      TITLE: title,
      RESPONSIBLE_ID: responsible,
      DESCRIPTION: t.DESCRIPTION || '',
      START_DATE_PLAN: t.START_DATE_PLAN || undefined,
      END_DATE_PLAN: t.END_DATE_PLAN || undefined,
      DEADLINE: t.DEADLINE || undefined,
      PRIORITY: t.PRIORITY || 1,
      UF_CRM_TASK: [`D_${dstDealId}`],
      STATUS: status
    };
    try {
      const added = await btrx('tasks.task.add', { fields }, false);
      const newId = added.task?.id || added.id || added;
      await copyChecklist(t.ID, newId);
      await copyComments(t.ID, newId);
      logger.info(`Задача скопирована: ${title} (ID ${t.ID} → ${newId}, статус: ${status === 2 ? 'Открыта' : 'Завершена'})`);
    } catch (e) {
      logger.error(`Ошибка добавления задачи ${t.ID}: ${e.message}`);
    }
  }
}

async function copyChecklist(oldId, newId) {
  const items = await btrx('task.checklistitem.getList', { taskId: oldId });
  for (const it of items) {
    await btrx('task.checklistitem.add', {
      taskId: newId,
      fields: { TITLE: it.TITLE, IS_COMPLETE: it.IS_COMPLETE }
    }, false);
  }
}

async function copyComments(oldId, newId) {
  const com = await btrx('task.commentitem.getList', { taskId: oldId });
  for (const c of com) {
    if (c.POST_MESSAGE?.trim()) {
      await btrx('task.commentitem.add', {
        taskId: newId,
        fields: { POST_MESSAGE: c.POST_MESSAGE }
      }, false);
    }
  }
}

// Копирование дел (активностей) — все как новые, не завершённые
async function copyActivities(srcDealId, dstDealId) {
  const acts = await btrxPaged('crm.activity.list', {
    filter: { OWNER_TYPE_ID: 2, OWNER_ID: srcDealId }
  }, 'activities');

  for (const a of acts) {
    const subject = a.SUBJECT?.trim() || `Дело #${a.ID}`;
    const responsible = a.RESPONSIBLE_ID > 0 ? a.RESPONSIBLE_ID : DEFAULT_RESPONSIBLE;
    const fields = {
      SUBJECT: subject,
      TYPE_ID: a.TYPE_ID,
      DIRECTION: a.DIRECTION,
      START_TIME: a.START_TIME,
      END_TIME: a.END_TIME,
      RESPONSIBLE_ID: responsible,
      DESCRIPTION: a.DESCRIPTION || '',
      COMMUNICATIONS: a.COMMUNICATIONS || [],
      OWNER_ID: dstDealId,
      OWNER_TYPE_ID: 2,
      COMPLETED: 'N'
    };
    try {
      await btrx('crm.activity.add', { fields }, false);
      logger.info(`Дело скопировано: ${subject}`);
    } catch (e) {
      logger.error(`Ошибка копирования дела ${a.ID}: ${e.message}`);
    }
  }
}

// Основная логика (экспорт для web-прослушки или запуска из консоли)
async function transferDeal(srcId) {
  logger.info(`Старт переноса сделки ${srcId} → производство`);
  try {
    const newId = await copyDeal(srcId, DEFAULT_CATEGORY_ID);
    logger.info(`Сделка скопирована: ${srcId} → ${newId}`);
    await copyTasks(srcId, newId);
    await copyActivities(srcId, newId);
    logger.info('🎉 Перенос завершён');
    return newId;
  } catch (err) {
    logger.error(err.stack || err.message);
    throw err;
  }
}

module.exports = { transferDeal };

// Для запуска напрямую (например: node bitrix_deal_transfer.js 1234)
if (require.main === module) {
  const srcId = process.argv[2];
  if (!srcId) {
    logger.error('Нужно передать ID сделки!');
    process.exit(1);
  }
  transferDeal(srcId)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
