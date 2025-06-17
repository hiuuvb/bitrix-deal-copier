const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const BITRIX_URL = process.env.BITRIX_URL;

app.post('/', async (req, res) => {
  try {
    const { deal_id } = req.body;
    console.log(`▶️ Получена сделка: ${deal_id}`);

    // 1. Получаем данные сделки
    const { data: dealRes } = await axios.post(`${BITRIX_URL}/crm.deal.get`, { id: deal_id });
    const deal = dealRes.result;

    // 2. Копируем сделку
    const { data: copyRes } = await axios.post(`${BITRIX_URL}/crm.deal.add`, {
      fields: {
        ...deal,
        TITLE: deal.TITLE ,
        STAGE_ID: 'РД_выдан' , // укажи нужную стадию
        CATEGORY_ID: 1   // укажи нужную воронку
      }
    });

    const newDealId = copyRes.result;
    console.log(`✅ Новая сделка создана: ${newDealId}`);

     // 3. Получаем все подходящие задачи
    const allTasks = [];

    // 3.1. Привязанные к сделке напрямую
    const { data: attachedTasksRes } = await axios.post(`${BITRIX_URL}/tasks.task.list`, {
      filter: {
        "UF_CRM_TASK": `D_${deal_id}`,
        "STATUS": [1, 2, 3, 4]
      }
    });
    if (attachedTasksRes.result?.tasks) {
      allTasks.push(...attachedTasksRes.result.tasks);
    }

    // 3.2. От того же ответственного, но не привязанные
    const { data: extraTasksRes } = await axios.post(`${BITRIX_URL}/tasks.task.list`, {
      filter: {
        "RESPONSIBLE_ID": deal.ASSIGNED_BY_ID,
        "!UF_CRM_TASK": [`D_${deal_id}`],
        "STATUS": [1, 2, 3, 4]
      }
    });
    if (extraTasksRes.result?.tasks) {
      allTasks.push(...extraTasksRes.result.tasks);
    }

    // Удаляем дубли по task.id
    const uniqueTasks = Object.values(
      allTasks.reduce((acc, task) => {
        acc[task.id] = task;
        return acc;
      }, {})
    );

    console.log(`📌 Найдено ${uniqueTasks.length} задач`);

    // 4. Копируем задачи
    for (const task of uniqueTasks) {
      await axios.post(`${BITRIX_URL}/tasks.task.add`, {
        fields: {
          TITLE: task.title,
          RESPONSIBLE_ID: task.responsibleId,
          DESCRIPTION: task.description,
          UF_CRM_TASK: [`D_${newDealId}`],
        }
      });
    }

    res.status(200).send(`Сделка и ${uniqueTasks.length} задач скопированы.`);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send('Ошибка при копировании сделки или задач.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
