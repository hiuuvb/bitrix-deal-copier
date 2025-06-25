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
  if (data.error) throw new Error(`${method}: ${data.error_description || data.error}`);
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

// Копирование сделки
async function copyDeal(srcDealId, targetCategoryId) {
  const deal = await btrx('crm.deal.get', { id: srcDealId });
  if (!deal) throw new Error(`Сделка ${srcDealId} не найдена`);
  const { ID, CATEGORY_ID, STAGE_ID, DATE_CREATE, UF_CRM_PAYMENT_DEADLINE, UF_CRM_SOURCE, ...fields } = deal;
  fields.CATEGORY_ID = targetCategoryId;
  const res = await btrx('crm.deal.add', { fields }, false);
  return typeof res === 'object' ? (res.result || res.id || res) : res;
}

// Карта старых → новых задач
const taskMap = new Map();

// Копирование задач
async function copyTasks(srcDealId, dstDealId) {
  const tasks = await btrxPaged('tasks.task.list', {
    filter: { 'UF_CRM_TASK': `D_${srcDealId}` },
    select: ['ID','TITLE','UF_CRM_TASK','RESPONSIBLE_ID','DESCRIPTION','DEADLINE','PRIORITY','START_DATE_PLAN','END_DATE_PLAN','STATUS','CHANGED_DATE']
  }, 'tasks');

  for (const t of tasks) {
    if (!t.TITLE?.trim()) { logger.warn(`⚠️ Пропускаем задачу ${t.ID}: нет заголовка`); continue; }
    const fields = { TITLE: t.TITLE, RESPONSIBLE_ID: t.RESPONSIBLE_ID, DESCRIPTION: t.DESCRIPTION||'', DEADLINE: t.DEADLINE, PRIORITY: t.PRIORITY, START_DATE_PLAN: t.START_DATE_PLAN, END_DATE_PLAN: t.END_DATE_PLAN, UF_CRM_TASK: [`D_${dstDealId}`], STATUS: t.STATUS };
    const added = await btrx('tasks.task.add', { fields: fields }, false);
    const newId = added.task?.id||added.id||added;
    taskMap.set(t.ID, { newId, status: t.STATUS, changed: t.CHANGED_DATE });
    logger.info(`📌 Задача ${t.ID} → ${newId} (статус ${t.STATUS})`);
    await copyChecklist(t.ID, newId);
    await copyComments(t.ID, newId);
  }

  const open = [...taskMap.values()].filter(i => i.status !== 5);
  if (open.length) {
    open.sort((a,b)=>new Date(b.changed)-new Date(a.changed));
    const last = open[0];
    if (last.status===5) { await btrx('tasks.task.update',{ taskId: last.newId, fields:{STATUS:2} }); logger.info(`♻️ Переоткрыта задача ${last.newId}`); }
  } else {
    const acts = await btrxPaged('crm.activity.list',{ filter:{OWNER_TYPE_ID:2,OWNER_ID:srcDealId},order:{DEADLINE:'DESC'}},'activities');
    if (acts.length) {
      const a=acts[0];
      const fields={ TITLE:`Follow-up: ${a.SUBJECT}`, RESPONSIBLE_ID:a.RESPONSIBLE_ID, START_DATE_PLAN:a.START_TIME, DEADLINE:a.END_TIME, UF_CRM_TASK:[`D_${dstDealId}`], STATUS:2 };
      const add=await btrx('tasks.task.add',{ fields },false); const id=add.task?.id||add.id||add;
      logger.info(`✅ Создана задача из активности: ${id}`);
    }
  }
}

// Копирование чек-листа
async function copyChecklist(oldId,newId){ const items=await btrx('task.checklistitem.getList',{taskId:oldId}); for(const it of items) await btrx('task.checklistitem.add',{taskId:newId,fields:{TITLE:it.TITLE,IS_COMPLETE:it.IS_COMPLETE}},false); }
// Копирование комментариев
async function copyComments(oldId,newId){ const com=await btrx('task.commentitem.getList',{taskId:oldId}); for(const c of com) if(c.POST_MESSAGE?.trim()) await btrx('task.commentitem.add',{taskId:newId,fields:{POST_MESSAGE:c.POST_MESSAGE}},false); }

// Копирование активностей
async function copyActivities(srcDealId,dstDealId){ logger.info(`▶️ Копируем активности из ${srcDealId}→${dstDealId}`);
  const acts=await btrxPaged('crm.activity.list',{ filter:{OWNER_TYPE_ID:2,OWNER_ID:srcDealId} },'activities');
  for(const act of acts){
    try{ await btrx('crm.activity.add',{ fields:{ SUBJECT:act.SUBJECT,TYPE_ID:act.TYPE_ID,DIRECTION:act.DIRECTION,START_TIME:act.START_TIME,END_TIME:act.END_TIME,RESPONSIBLE_ID:act.RESPONSIBLE_ID,DESCRIPTION:act.DESCRIPTION,COMMUNICATIONS:act.COMMUNICATIONS||[],OWNER_ID:dstDealId,OWNER_TYPE_ID:2 } },false);
      logger.info(`   • Дело скопировано: ${act.SUBJECT}`);
    }catch(e){logger.warn(`⚠️ Ошибка: ${e.message}`);} }
}

// Основная
(async()=>{
  logger.info(`🔍 Ищем сделку из воронки 70...`);
  const deals=await btrx('crm.deal.list',{ order:{ID:'DESC'},filter:{CATEGORY_ID:70},select:['ID','TITLE'],limit:1 });
  const src=deals[0]?.ID; if(!src){logger.error('❌ Сделка не найдена');return;}
  logger.info(`📎 Найдена сделка ${src}`);

  // Всегда копируем сделку
  const newId=await copyDeal(src,DEFAULT_CATEGORY_ID);
  logger.info(`✅ Сделка скопирована: ${newId}`);
  await copyTasks(src,newId);
  await copyActivities(src,newId);
  logger.info(`🎉 Перенос завершён`);
})();
