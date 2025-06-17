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
        STAGE_ID: РД_выдан , // укажи нужную стадию
        CATEGORY: Производство   // укажи нужную воронку
      }
    });

    const newDealId = copyRes.result;
    console.log(`✅ Новая сделка создана: ${newDealId}`);

    // 3. Получаем задачи, привязанные к старой сделке
    const { data: taskRes } = await axios.post(`${BITRIX_URL}/tasks.task.list`, {
      filter: {
        "UF_CRM_TASK": `D_${deal_id}`,
        "STATUS": [1, 2, 3, 4] // только открытые
      }
      filter: {
  "RESPONSIBLE_ID": deal.ASSIGNED_BY_ID,
  "!UF_CRM_TASK": [`D_${deal_id}`],  // исключаем уже найденные
  "STATUS": [1, 2, 3, 4]
}
   
    });

    const tasks = taskRes.result.tasks;
    console.log(`📌 Найдено ${tasks.length} задач`);

    // 4. Копируем каждую задачу и привязываем к новой сделке
    for (const task of tasks) {
      await axios.post(`${BITRIX_URL}/tasks.task.add`, {
        fields: {
          TITLE: task.title,
          RESPONSIBLE_ID: task.responsibleId,
          DESCRIPTION: task.description,
          UF_CRM_TASK: [`D_${newDealId}`],
        }
      });
    }

    res.status(200).send(`Сделка и ${tasks.length} задач скопированы.`);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send('Ошибка при копировании сделки или задач.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
