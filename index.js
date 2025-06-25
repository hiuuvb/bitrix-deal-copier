// bitrix_deal_task_copier.js — Скрипт переноса сделки, задач и дел (активностей)
// Работает даже с пустыми заголовками, всё переоткрывается в новой воронке

require('dotenv').config();
const axios = require('axios');
const winston = require('winston');

const BITRIX_URL          = process.env.BITRIX_URL;
const DEFAULT_CATEGORY_ID = Number(process.env.TARGET_CATEGORY_ID || 14);
const DEFAULT_RESPONSIBLE = Number(process.env.DEFAULT_RESPONSIBLE_ID || 1); // резервный ответственный

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

// Копирование сделки
async function copyDeal(srcId, catId) {
  const deal = await btrx('crm.deal.get', { id: srcId });
  if (!deal) throw new Error(`Сделка ${srcId} не найдена`);
  const {
    ID, CATEGORY_ID, STAGE_ID, DATE_CREATE, UF_CRM_PAYMENT_DEADLINE, UF_CRM_SOURCE, ...fields
  } = deal;
  fields.CATEGORY_ID = catId;
  const res = await btrx('crm.deal.add', { fields }, false);
  return (typeof res === 'object' ? (res.result || res.id) : res);
}

// Копирование задач с обработкой заголовков и ответственных
async function copyTasks(srcDealId, dstDealId) {
  const tasks = await btrxPaged('tasks.task.list', {
    filter: { 'UF_CRM_TASK': `D_${srcDealId}` },
    select: [
      'ID','TITLE','RESPONSIBLE_ID','DESCRIPTION',
      'START_DATE_PLAN','END_DATE_PLAN','DEADLINE','PRIORITY','STATUS','CHANGED_DATE'
    ]
  }, 'tasks');

  // Определим последнюю не завершённую задачу
  let lastOpenTask = null;
  for (const t of tasks) {
    if (t.STATUS != 5 && (!lastOpenTask || new Date(t.CHANGED_DATE) > new Date(lastOpenTask.CHANGED_DATE))) {
      lastOpenTask = t;
    }
  }

  for (const t of tasks) {
    const title = t.TITLE && t.TITLE.trim() ? t.TITLE : `Задача #${t.ID}`;
    const responsible = t.RESPONSIBLE_ID > 0 ? t.RESPONSIBLE_ID : DEFAULT_RESPONSIBLE;

    // По умолчанию копируем с тем же статусом, но для последней незавершённой — открываем!
    let status = t.STATUS;
    if (lastOpenTask && t.ID === lastOpenTask.ID) status = 2;

    const fields = {
      TITLE:           title,
      RESPONSIBLE_ID:  responsible,
      DESCRIPTION:     t.DESCRIPTION || '',
      START_DATE_PLAN: t.START_DATE_PLAN || undefined,
      END_DATE_PLAN:   t.END_DATE_PLAN || undefined,
      DEADLINE:        t.DEADLINE || undefined,
      PRIORITY:        t.PRIORITY || 1,
      UF_CRM_TASK:     [`D_${dstDealId}`],
      STATUS:          status
    };
    try {
      logger.info('➡️ Создаём задачу:', fields);
      const added = await btrx('tasks.task.add', { fields }, false);
      const newId = added.task?.id || added.id || added;
      logger.info(`📌 Задача ${t.ID} → ${newId} (${title})`);
      await copyChecklist(t.ID, newId);
      await copyComments(t.ID, newId);
    } catch (e) {
      logger.error(`Ошибка добавления задачи ${t.ID}: ${e.message}`);
      logger.error(JSON.stringify(fields));
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

// Копирование дел (активностей) — как новые, всегда не завершённые
async function copyActivities(srcDealId, dstDealId) {
  logger.info(`▶️ Копируем активности из сделки ${srcDealId} → ${dstDealId}`);
  const acts = await btrxPaged('crm.activity.list', {
    filter: { OWNER_TYPE_ID: 2, OWNER_ID: srcDealId }
  }, 'activities');

  for (const a of acts) {
    const subject = a.SUBJECT && a.SUBJECT.trim() ? a.SUBJECT : `Дело #${a.ID}`;
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
      COMPLETED:      'N' // всегда открыто
    };
    try {
      logger.info('➡️ Создаём дело:', fields);
      await btrx('crm.activity.add', { fields }, false);
      logger.info(`   • Дело скопировано: ${subject}`);
    } catch (e) {
      logger.error(`Ошибка копирования дела ${a.ID}: ${e.message}`);
      logger.error(JSON.stringify(fields));
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
