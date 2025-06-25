// bitrix_deal_task_copier.js — Расширенный скрипт копирования сделки и задач
// Переносит сделку + все задачи (открытые и закрытые) + чек-листы + комментарии + последнюю незавершённую задачу (или активность)

require('dotenv').config();
const axios = require('axios');
const winston = require('winston');

const BITRIX_URL            = process.env.BITRIX_URL;
const DEFAULT_CATEGORY_ID   = Number(process.env.TARGET_CATEGORY_ID || 14);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'DD-MM-YYYY HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [ new winston.transports.Console() ]
});

// Универсальный вызов методов REST API
async function btrx(method, params = {}, asQuery = true) {
  const url = `${BITRIX_URL}/${method}`;
  const cfg = asQuery ? { params } : {};
  const body = asQuery ? null : params;
  const { data } = await axios.post(url, body, cfg);
  if (data.error) {
    throw new Error(`${method}: ${data.error_description || data.error}`);
  }
  return data.result;
}

// Пагинация для списков
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

// Копирование сделки в целевую воронку (category)
async function copyDeal(srcDealId, targetCategoryId) {
  const deal = await btrx('crm.deal.get', { id: srcDealId });
  if (!deal) throw new Error(`Сделка ${srcDealId} не найдена`);

  // Убираем ненужные поля из копии
  const {
    ID,
    CATEGORY_ID,
    STAGE_ID,
    DATE_CREATE,
    UF_CRM_PAYMENT_DEADLINE,
    UF_CRM_SOURCE,
    ...fields
  } = deal;

  fields.CATEGORY_ID = targetCategoryId;
  const res = await btrx('crm.deal.add', { fields }, false);
  return typeof res === 'object' ? (res.result || res.id || res) : res;
}

// Карта старых → новых задач
const taskMap = new Map();

// Копирование всех задач и пост-обработка последней незавершённой
async function copyTasks(srcDealId, dstDealId) {
  const tasks = await btrxPaged('tasks.task.list', {
    filter: { 'UF_CRM_TASK': `D_${srcDealId}` },
    select: [
      'ID','TITLE','UF_CRM_TASK','RESPONSIBLE_ID','DESCRIPTION',
      'DEADLINE','PRIORITY','START_DATE_PLAN','END_DATE_PLAN',
      'STATUS','CHANGED_DATE'
    ]
  }, 'tasks');

  for (const t of tasks) {
    // Пропустить задачи без заголовка, чтобы избежать ERR_BAD_REQUEST
    if (!t.TITLE || !t.TITLE.trim()) {
      logger.warn(`⚠️ Пропускаем задачу ${t.ID}: нет заголовка`);
      continue;
    }

    const taskData = {
      TITLE:           t.TITLE,
      RESPONSIBLE_ID:  t.RESPONSIBLE_ID,
      DESCRIPTION:     t.DESCRIPTION || '',
      DEADLINE:        t.DEADLINE,
      PRIORITY:        t.PRIORITY,
      START_DATE_PLAN: t.START_DATE_PLAN,
      END_DATE_PLAN:   t.END_DATE_PLAN,
      UF_CRM_TASK:     [`D_${dstDealId}`],
      STATUS:          t.STATUS
    };
    const added = await btrx('tasks.task.add', { fields: taskData }, false);
    const newTaskId = added.task?.id || added.id || added;
    taskMap.set(t.ID, { newId: newTaskId, status: t.STATUS, changed: t.CHANGED_DATE });
    logger.info(`📌 Задача ${t.ID} → ${newTaskId} (статус ${t.STATUS})`);

    await copyChecklist(t.ID, newTaskId);
    await copyComments(t.ID, newTaskId);
  }

  const openEntries = Array.from(taskMap.entries()).filter(([,info]) => info.status !== 5);
  if (openEntries.length) {
    openEntries.sort((a, b) => new Date(b[1].changed) - new Date(a[1].changed));
    const [, lastInfo] = openEntries[0];
    if (lastInfo.status === 5) {
      await btrx('tasks.task.update', {
        taskId: lastInfo.newId,
        fields: { STATUS: 2 }
      });
      logger.info(`♻️ Переоткрыта задача ${lastInfo.newId}`);
    }
  } else {
    const acts = await btrxPaged('crm.activity.list', {
      filter: { OWNER_TYPE_ID:2, OWNER_ID: srcDealId },
      order: { DEADLINE: 'DESC' }
    }, 'activities');

    if (acts.length) {
      const a = acts[0];
      const taskData = {
        TITLE:            `Follow-up: ${a.SUBJECT}`,
        RESPONSIBLE_ID:   a.RESPONSIBLE_ID,
        START_DATE_PLAN:  a.START_TIME,
        DEADLINE:         a.END_TIME,
        UF_CRM_TASK:      [`D_${dstDealId}`],
        STATUS:           2
      };
      const add = await btrx('tasks.task.add', { fields: taskData }, false);
      const id = add.task?.id || add.id || add;
      logger.info(`✅ Создана новая задача из активности: ${id}`);
    }
  }
}

// Копирование чек-листа одной задачи
async function copyChecklist(oldTaskId, newTaskId) {
  const items = await btrx('task.checklistitem.getList', { taskId: oldTaskId });
  for (const item of items) {
    await btrx('task.checklistitem.add', {
      taskId: newTaskId,
      fields: { TITLE: item.TITLE, IS_COMPLETE: item.IS_COMPLETE }
    }, false);
  }
}

// Копирование комментариев одной задачи
async function copyComments(oldTaskId, newTaskId) {
  const comments = await btrx('task.commentitem.getList', { taskId: oldTaskId });
  for (const c of comments) {
    if (c.POST_MESSAGE?.trim()) {
      await btrx('task.commentitem.add', {
        taskId: newTaskId,
        fields: { POST_MESSAGE: c.POST_MESSAGE }
      }, false);
    }
  }
}

// Копирование всех других активностей сделки
async function copyActivities(srcDealId, dstDealId) {
  logger.info(`▶️ Копируем активности из сделки ${srcDealId} → ${dstDealId}`);
  const activities = await btrxPaged('crm.activity.list', {
    filter: { OWNER_TYPE_ID:2, OWNER_ID: srcDealId }
  }, 'activities');

  for (const act of activities) {
    try {
      await btrx('crm.activity.add', {
        fields: {
          SUBJECT:        act.SUBJECT,
          TYPE_ID:        act.TYPE_ID,
          DIRECTION:      act.DIRECTION,
          START_TIME:     act.START_TIME,
          END_TIME:       act.END_TIME,
          RESPONSIBLE_ID: act.RESPONSIBLE_ID,
          DESCRIPTION:    act.DESCRIPTION,
          COMMUNICATIONS: act.COMMUNICATIONS || [],
          OWNER_ID:       dstDealId,
          OWNER_TYPE_ID:  2
        }
      }, false);
      logger.info(`   • Скопировано дело: ${act.SUBJECT}`);
    } catch (err) {
      logger.warn(`   ⚠️ Ошибка при копировании дела "${act.SUBJECT}": ${err.message}`);
    }
  }
}

// Основная логика
(async () => {
  logger.info(`🔍 Ищем последнюю сделку из воронки 70...`);
  const deals = await btrx('crm.deal.list', {
    order:  { ID: 'DESC' },
    filter: { CATEGORY_ID: 70 },
    select: ['ID','TITLE'],
    limit:  1
  });

  const srcId = deals[0]?.ID;
  if (!srcId) {
    logger.error('❌ Не удалось найти сделку в воронке 70');
    process.exit(1);
  }
  logger.info(`📎 Найдена сделка ${srcId}`);

  // Проверим, есть ли уже сделка в целевой воронке
  const exists = await btrx('crm.deal.list', {
    filter: { CATEGORY_ID: DEFAULT_CATEGORY_ID, TITLE: deals[0].TITLE },
    select: ['ID'],
    limit: 1
  });

  if (exists.length) {
    const existingDealId = exists[0].ID;
    logger.warn(`⚠️ Сделка уже есть в воронке ${DEFAULT_CATEGORY_ID} (ID ${existingDealId}), копируем задачи и активности...`);
    await copyTasks(srcId, existingDealId);
    await copyActivities(srcId, existingDealId);
    logger.info(`🎉 Задачи и активности успешно скопированы в существующую сделку ${existingDealId}`);
    return;
  }

  try {
    const newDealId = await copyDeal(srcId, DEFAULT_CATEGORY_ID);
    logger.info(`✅ Сделка скопирована: ${newDealId}`);
    await copyTasks(srcId, newDealId);
    await copyActivities(srcId, newDealId);
    logger.info(`🎉 Все данные успешно перенесены`);
  } catch (err) {
    logger.error(err.stack || err.message);
    process.exit(1);
  }
})();
