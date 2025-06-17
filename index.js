const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;

app.post("/", async (req, res) => {
  const dealId = req.body.deal_id;

  if (!dealId) return res.status(400).send("Missing deal_id");

  try {
    // Получаем данные по сделке
    const dealRes = await axios.post(`${BITRIX_WEBHOOK}/crm.deal.get`, {
      id: dealId
    });

    const oldDeal = dealRes.data.result;

    // Создаем новую сделку
    const newDealRes = await axios.post(`${BITRIX_WEBHOOK}/crm.deal.add`, {
      fields: {
        TITLE: oldDeal.TITLE + " (копия)",
        STAGE_ID: oldDeal.STAGE_ID,
        CATEGORY_ID: oldDeal.CATEGORY_ID,
        ASSIGNED_BY_ID: oldDeal.ASSIGNED_BY_ID
      }
    });

    const newDealId = newDealRes.data.result;

    // Получаем задачи по сделке
    const tasksRes = await axios.post(`${BITRIX_WEBHOOK}/tasks.task.list`, {
      filter: {
        "UF_CRM_TASK": `D_${dealId}`
      }
    });

    const tasks = tasksRes.data.result.tasks;

    // Копируем задачи
    for (const task of tasks) {
      await axios.post(`${BITRIX_WEBHOOK}/tasks.task.add`, {
        fields: {
          TITLE: task.title + " (копия)",
          RESPONSIBLE_ID: task.responsibleId,
          UF_CRM_TASK: [`D_${newDealId}`]
        }
      });
    }

    res.send(`Сделка и ${tasks.length} задач(и) скопированы.`);
  } catch (err) {
    console.error("Ошибка:", err?.response?.data || err.message);
    res.status(500).send("Ошибка при копировании сделки и задач");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер работает на порту ${PORT}`);
});
