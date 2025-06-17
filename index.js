const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const BITRIX_URL = process.env.BITRIX_URL; // например https://yourcompany.bitrix24.ru/rest/10730/yourwebhooktoken

app.post('/', async (req, res) => {
  try {
    const { deal_id } = req.body;
    console.log(`▶️ Получена сделка: ${deal_id}`);

    // 1. Получаем данные сделки
    const { data: dealRes } = await axios.post(`${BITRIX_URL}/crm.deal.get`, null, {
      params: { id: deal_id }
    });
    if (!dealRes.result) {
      return res.status(404).send('Сделка не найдена');
    }
    const deal = dealRes.result;

    // 2. Копируем сделку (укажи нужную стадию и воронку)
    const { data: copyRes } = await axios.post(`${BITRIX_URL}/crm.deal.add`, null, {
      params: {
        fields: JSON.stringify({
          TITLE: deal.TITLE,
          STAGE_ID: 'РД_выдан',   // <-- замени на нужный код стадии
          CATEGORY_ID: 14,        // <-- замени на нужный ID воронки
          ASSIGNED_BY_ID: deal.ASSIGNED_BY_ID,
          // сюда можно добавить другие нужные поля из сделки, которые хочешь скопировать
        })
      }
    });

    const newDealId = copyRes.result;
    if (!newDealId) {
      return res.status(500).send('Ошибка при создании новой сделки');
    }
    console.log(`✅ Новая сделка создана: ${newDealId}`);

    // 3. Получаем задачи, связанные с исходной сделкой по UF_CRM_TASK
    const { data: taskRes } = await axios.post(`${BITRIX_URL}/tasks.task.list`, null, {
      params: {
        filter: JSON.stringify({
          UF_CRM_TASK: `D_${deal_id}`,
          STATUS: [1, 2, 3, 4]  // открытые и в работе, при необходимости скорректируй
        }),
        select: JSON.stringify(['ID', 'TITLE', 'RESPONSIBLE_ID', 'DESCRIPTION', 'UF_CRM_TASK'])
      }
    });

    const tasks = taskRes.result?.tasks || [];
    console.log(`📌 Найдено задач: ${tasks.length}`);

    // 4. Копируем задачи и привязываем к новой сделке
    for (const task of tasks) {
      try {
        await axios.post(`${BITRIX_URL}/tasks.task.add`, null, {
          params: {
            fields: JSON.stringify({
              TITLE: task.TITLE,
              RESPONSIBLE_ID: task.RESPONSIBLE_ID,
              DESCRIPTION: task.DESCRIPTION || '',
              UF_CRM_TASK: [`D_${newDealId}`]
            })
          }
        });
        console.log(`Задача ${task.ID} скопирована и привязана к сделке D_${newDealId}`);
      } catch (err) {
        console.error(`Ошибка копирования задачи ${task.ID}:`, err.response?.data || err.message);
      }
    }

    res.status(200).send(`Сделка и ${tasks.length} задач успешно скопированы.`);
  } catch (e) {
    console.error('Ошибка общего уровня:', e.response?.data || e.message);
    res.status(500).send('Ошибка при копировании сделки или задач.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
