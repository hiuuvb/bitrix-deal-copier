const axios = require('axios');
const BITRIX_URL = process.env.BITRIX_URL;
const DEFAULT_RESPONSIBLE_ID = Number(process.env.DEFAULT_RESPONSIBLE_ID || 1);

// 📌 1. Копируем сделку
async function copyDeal(dealId, targetCategoryId) {
  // Получаем данные по исходной сделке
  const { data: original } = await axios.post(`${BITRIX_URL}/crm.deal.get.json`, {
    id: dealId
  });

  const deal = original.result;
  if (!deal) throw new Error(`Сделка с id ${dealId} не найдена`);

  // Готовим данные для новой сделки
  const newDeal = {
    TITLE: `${deal.TITLE} (копия)`,
    TYPE_ID: deal.TYPE_ID,
    STAGE_ID: `C${targetCategoryId}:NEW`,
    CATEGORY_ID: targetCategoryId,
    ASSIGNED_BY_ID: deal.ASSIGNED_BY_ID || DEFAULT_RESPONSIBLE_ID,
    CONTACT_ID: deal.CONTACT_ID || null,
    COMPANY_ID: deal.COMPANY_ID || null,
    BEGINDATE: deal.BEGINDATE,
    CLOSEDATE: deal.CLOSEDATE,
    CURRENCY_ID: deal.CURRENCY_ID,
    OPPORTUNITY: deal.OPPORTUNITY,
    COMMENTS: deal.COMMENTS
  };

  const { data: created } = await axios.post(`${BITRIX_URL}/crm.deal.add.json`, {
    fields: newDeal
  });

  if (!created.result) throw new Error('Не удалось создать новую сделку');
  return created.result;
}

// 📌 2. Копируем завершённые задачи и открываем последнюю
async function copyTasks(oldDealId, newDealId) {
  // Получить задачи по сделке
  const { data: response } = await axios.post(`${BITRIX_URL}/tasks.task.list`, {
    filter: {
      'UF_CRM_TASK': `D_${oldDealId}`
    }
  });

  const tasks = response.result.tasks || [];

  if (!tasks.length) return;

  // Найти последнюю по дате завершённую
  const sorted = tasks
    .filter(t => t.status === 5) // завершённые
    .sort((a, b) => new Date(b.updatedDate) - new Date(a.updatedDate));

  for (let task of tasks) {
    const isLastClosed = task.id === sorted[0]?.id;
    const newTaskFields = {
      TITLE: task.title,
      DESCRIPTION: task.description,
      RESPONSIBLE_ID: task.responsibleId || DEFAULT_RESPONSIBLE_ID,
      CREATED_BY: task.createdBy,
      UF_CRM_TASK: [`D_${newDealId}`]
    };

    if (isLastClosed) {
      // Открываем заново
      newTaskFields.STATUS = 2;
    }

    await axios.post(`${BITRIX_URL}/tasks.task.add`, {
      fields: newTaskFields
    });
  }
}

// 📌 3. Копируем активности (звонки, встречи и т.п.)
async function copyActivities(oldDealId, newDealId) {
  const { data: res } = await axios.post(`${BITRIX_URL}/crm.activity.list`, {
    filter: { 'OWNER_TYPE_ID': 2, 'OWNER_ID': oldDealId } // 2 = сделка
  });

  const activities = res.result || [];

  for (let act of activities) {
    const newAct = {
      TYPE_ID: act.TYPE_ID,
      SUBJECT: act.SUBJECT,
      DESCRIPTION: act.DESCRIPTION,
      COMPLETED: 'N',
      RESPONSIBLE_ID: act.RESPONSIBLE_ID || DEFAULT_RESPONSIBLE_ID,
      OWNER_ID: newDealId,
      OWNER_TYPE_ID: 2 // сделка
    };

    await axios.post(`${BITRIX_URL}/crm.activity.add`, {
      fields: newAct
    });
  }
}

// 📦 Экспорт
module.exports = {
  copyDeal,
  copyTasks,
  copyActivities
};
