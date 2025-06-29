const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const BITRIX_URL = 'https://arles.bitrix24.ru/rest/10730/fhj1sly6jmutcuum';

async function getTasksByDeal(dealId) {
  const response = await axios.post(`${BITRIX_WEBHOOK}/crm.activity.list`, {
    filter: {
      "OWNER_ID": dealId,
      "OWNER_TYPE_ID": 2, // 2 = сделка
      "TYPE_ID": 2        // 2 = задача
    }
  });
  return response.data.result;
}

async function createTaskFrom(oldTask) {
  await axios.post(`${BITRIX_URL}/crm.activity.add`, {
    fields: {
      "OWNER_ID": oldTask.OWNER_ID,
      "OWNER_TYPE_ID": 2,
      "TYPE_ID": 2,
      "SUBJECT": `[REOPENED] ${oldTask.SUBJECT}`,
      "DESCRIPTION": oldTask.DESCRIPTION,
      "RESPONSIBLE_ID": oldTask.RESPONSIBLE_ID,
      "START_TIME": oldTask.START_TIME,
      "END_TIME": oldTask.END_TIME
    }
  });
}

app.post('/webhook/restore-tasks', async (req, res) => {
  const { deal_id } = req.body;

  if (!deal_id) return res.status(400).send('deal_id is required');

  try {
    const tasks = await getTasksByDeal(deal_id);
    const completedTasks = tasks.filter(t => t.COMPLETED === 'Y');

    for (const task of completedTasks) {
      await createTaskFrom(task);
    }

    res.status(200).send('Задачи восстановлены');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Ошибка при обработке');
  }
});

app.listen(3000, () => {
  console.log('Сервер запущен на порту 3000');
});
