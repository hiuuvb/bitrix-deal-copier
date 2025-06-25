// bitrix_deal_task_copier.js — Расширенный скрипт копирования сделки и задач
// Переносит сделку + все задачи (открытые и закрытые) + чек-листы + комментарии
// + последнюю незавершённую задачу (переоткрытие) или создание задачи по последней активности

require('dotenv').config();
const axios = require('axios');
const winston = require('winston');

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

// Универсальный REST вызов
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

// Копирование сделку
async function copyDeal(srcId, catId) {
  const deal = await btrx('crm.deal.get', { id: srcId });
  if (!deal) throw new Error(`Сделка ${srcId} не найдена`);
  // Исключаем системные и ненужные UF-поля
  const {
    ID, CATEGORY_ID, STAGE_ID, DATE_CREATE,
    UF_CRM_PAYMENT_DEADLINE, UF_CRM_SOURCE,
    ...fields
  } = deal;
  fields.CATEGORY_ID = catId;
  const res = await btrx('crm.deal.add', { fields }, false);
  return (typeof res === 'object' ? (res.result || res.id) : res);
}

// Копирование задач и повторное открытие последней незавершённой
async function copyTasks(srcDealId, dstDealId) {
  const tasks = await btrxPaged('tasks.task.list', {
    filter: { 'UF_CRM_TASK': `D_${srcDealId}` },
    select: [
      'ID','TITLE','RESPONSIBLE_ID','DESCRIPTION',
      'START_DATE_PLAN','END_DATE_PLAN','DEADLINE',
      'PRIORITY','STATUS','CHANGED_DATE'
    ]
  }, 'tasks');

  // карта для повторного открытия
  const map = [];
  for (const t of tasks) {
    // дефолтный заголовок
    const title = t.TITLE?.trim() ? t.TITLE : `Задача #${t.ID}`;
    const fields = {
      TITLE:           title,
      RESPONSIBLE_ID:  t.RESPONSIBLE_ID || 0,
      DESCRIPTION:     t.DESCRIPTION || '',
      START_DATE_PLAN: t.START_DATE_PLAN,
      END_DATE_PLAN:   t.END_DATE_PLAN,
      DEADLINE:        t.DEADLINE,
      PRIORITY:        t.PRIORITY,
      UF_CRM_TASK:     [`D_${dstDealId}`],
      STATUS:          t.STATUS
    };
    const added = await btrx('tasks.task.add', { fields }, false);
    const newId = added.task?.id || added.id || added;
    logger.info(`📌 Задача ${t.ID} → ${newId} (${title})`);
    map.push({ newId, status: t.STATUS, changed: t.CHANGED_DATE });
    await copyChecklist(t.ID, newId);
    await copyComments(t.ID, newId);
  }

  // Повторно открываем последнюю незавершённую
  const open = map.filter(i => i.status !== 5);
  if (open.length) {
    open.sort((a, b) => new Date(b.changed) - new Date(a.changed));
    const last = open[0];
    if (last.status === 5) {
      await btrx('tasks.task.update', {
        taskId: last.newId,
        fields: { STATUS: 2 }
      });
      logger.info(`♻️ Переоткрыта задача ${last.newId}`);
    }
  }
}

// Копирование чек-листа
async function copyChecklist(oldId, newId) {
  const items = await btrx('task.checklistitem.getList', { taskId: oldId });
  for (const it of items) {
    await btrx('task.checklistitem.add', {
      taskId: newId,
      fields: { TITLE: it.TITLE, IS_COMPLETE: it.IS_COMPLETE }
    }, false);
  }
}
// Копирование комментариев
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

// Копирование активностей (дел)
async function copyActivities(srcDealId, dstDealId) {
  logger.info(`▶️ Копируем активности из сделки ${srcDealId} → ${dstDealId}`);
  const acts = await btrxPaged('crm.activity.list', {
    filter: { OWNER_TYPE_ID: 2, OWNER_ID: srcDealId }
  }, 'activities');

  for (const a of acts) {
    const fields = {
      SUBJECT:        a.SUBJECT?.trim() ? a.SUBJECT : `Дело #${a.ID}`,
      TYPE_ID:        a.TYPE_ID,
      DIRECTION:      a.DIRECTION,
      START_TIME:     a.START_TIME,
      END_TIME:       a.END_TIME,
      RESPONSIBLE_ID: a.RESPONSIBLE_ID,
      DESCRIPTION:    a.DESCRIPTION || '',
      COMMUNICATIONS: a.COMMUNICATIONS || [],
      OWNER_ID:       dstDealId,
      OWNER_TYPE_ID:  2,
      COMPLETED:      'N'
    };
    try {
      await btrx('crm.activity.add', { fields }, false);
      logger.info(`   • Дело скопировано: ${fields.SUBJECT}`);
    } catch (e) {
      logger.warn(`⚠️ Ошибка копирования дела ${a.ID}: ${e.message}`);
    }
  }
}

// Основная логика
(async () => {
  logger.info(`🔍 Ищем сделку из воронки 70…`);
  const deals = await btrx('crm.deal.list', {
    order:  { ID: 'DESC' },
    filter: { CATEGORY_ID: 70 },
    select: ['ID','TITLE'],
    limit:  1
  });
  const srcId = deals[0]?.ID;
  if (!srcId) { logger.error('❌ Сделка не найдена'); return; }
  logger.info(`📎 Найдена сделка ${srcId}`);

  // Проверяем копию в целевой воронке
  const exists = await btrx('crm.deal.list', {
    filter:   { CATEGORY_ID: DEFAULT_CATEGORY_ID, TITLE: deals[0].TITLE },
    select:   ['ID'],
    limit:    1
  });
  if (exists.length) {
    logger.warn(`⚠️ Сделка уже скопирована (ID ${exists[0].ID})`);
    return;
  }

  try {
    const newId = await copyDeal(srcId, DEFAULT_CATEGORY_ID);
    logger.info(`✅ Сделка скопирована: ${newId}`);
    await copyTasks(srcId, newId);
    await copyActivities(srcId, newId);
    logger.info('🎉 Перенос завершён');
  } catch (err) {
    logger.error(err.stack || err.message);
    process.exit(1);
  }
})();
