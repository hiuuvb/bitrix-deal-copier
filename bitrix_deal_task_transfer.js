require('dotenv').config();
const axios = require('axios');

const BITRIX_URL          = process.env.BITRIX_URL;
const DEFAULT_CATEGORY_ID = Number(process.env.TARGET_CATEGORY_ID || 14);
const DEFAULT_RESPONSIBLE = Number(process.env.DEFAULT_RESPONSIBLE_ID || 1);

// Универсальный вызов Bitrix REST API
async function btrx(method, params = {}, asQuery = true) {
  const url = `${BITRIX_URL}/${method}`;
  const cfg = asQuery ? { params } : {};
  const body = asQuery ? null : params;
  const { data } = await axios.post(url, body, cfg);
  if (data.error) throw new Error(`${method}: ${data.error_description || data.error}`);
  return data.result;
}

// Получить все задачи, связанные с сделкой
async function getTasksForDeal(dealId) {
  return await btrx('tasks.task.list', {
    filter: { 'UF_CRM_TASK': `D_${dealId}` },
    select: ['ID','TITLE','RESPONSIBLE_ID','DESCRIPTION','START_DATE_PLAN','END_DATE_PLAN','DEADLINE','PRIORITY','STATUS','CHANGED_DATE']
  }, true).then(r => r.tasks || []);
}

// Копировать сделку (без задач)
async function copyDeal(srcId, catId) {
  const deal = await btrx('crm.deal.get', { id: srcId });
  const { ID, CATEGORY_ID, STAGE_ID, ...fields } = deal;
  fields.CATEGORY_ID = catId;
  const res = await btrx('crm.deal.add', { fields }, false);
  return res.result || res.id || res;
}

// Копировать задачи
async function copyTasks(srcDealId, dstDealId) {
  const tasks = await getTasksForDeal(srcDealId);

  for (const t of tasks) {
    // Все задачи делаем открытыми (статус 2)
    const fields = {
      TITLE:           t.TITLE?.trim() || `Задача #${t.ID}`,
      RESPONSIBLE_ID:  t.RESPONSIBLE_ID > 0 ? t.RESPONSIBLE_ID : DEFAULT_RESPONSIBLE,
      DESCRIPTION:     t.DESCRIPTION || '',
      START_DATE_PLAN: t.START_DATE_PLAN || undefined,
      END_DATE_PLAN:   t.END_DATE_PLAN || undefined,
      DEADLINE:        t.DEADLINE || undefined,
      PRIORITY:        t.PRIORITY || 1,
      UF_CRM_TASK:     [`D_${dstDealId}`],
      STATUS:          2 // открытая!
    };
    await btrx('tasks.task.add', { fields }, false);
  }
}

// Копировать активности (дела)
async function copyActivities(srcDealId, dstDealId) {
  const acts = await btrx('crm.activity.list', {
    filter: { OWNER_TYPE_ID: 2, OWNER_ID: srcDealId }
  }, true).then(r => r.activities || []);

  for (const a of acts) {
    const fields = {
      SUBJECT:        a.SUBJECT?.trim() || `Дело #${a.ID}`,
      TYPE_ID:        a.TYPE_ID,
      DIRECTION:      a.DIRECTION,
      START_TIME:     a.START_TIME,
      END_TIME:       a.END_TIME,
      RESPONSIBLE_ID: a.RESPONSIBLE_ID > 0 ? a.RESPONSIBLE_ID : DEFAULT_RESPONSIBLE,
      DESCRIPTION:    a.DESCRIPTION || '',
      COMMUNICATIONS: a.COMMUNICATIONS || [],
      OWNER_ID:       dstDealId,
      OWNER_TYPE_ID:  2,
      COMPLETED:      'N'
    };
    await btrx('crm.activity.add', { fields }, false);
  }
}

module.exports = { copyDeal, copyTasks, copyActivities };
