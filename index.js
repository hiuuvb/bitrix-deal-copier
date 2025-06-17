require('dotenv').config();
const express = require('express');
const axios = require('axios');
const winston = require('winston');

// ────────────────────────────────────────────────────────────────────────────────
// Настройки
// ────────────────────────────────────────────────────────────────────────────────
const BITRIX_URL = process.env.BITRIX_URL;
if (!BITRIX_URL) {
  throw new Error('Отсутствует переменная окружения BITRIX_URL');
}

const logger = winston.createLogger({
  level: 'info',
  transports: [new winston.transports.Console()],
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
});

const app = express();
app.use(express.json());

// ────────────────────────────────────────────────────────────────────────────────
// Вспомогательный wrapper для вызова Bitrix24 REST
// ────────────────────────────────────────────────────────────────────────────────
async function bx(method, params = {}, context = '') {
  const { data } = await axios.post(`${BITRIX_URL}/${method}`, null, { params });
  if (data.error) {
    throw new Error(`[Bitrix] ${context || method}: ${data.error_description || data.error}`);
  }
  return data.result;
}

// ────────────────────────────────────────────────────────────────────────────────
// Healthcheck
// ────────────────────────────────────────────────────────────────────────────────
app.get('/healthcheck', (_, res) => res.status(200).send('ok'));

// ────────────────────────────────────────────────────────────────────────────────
// Основной endpoint копирования сделки и задач
// ────────────────────────────────────────────────────────────────────────────────
app.post('/', async (req, res) => {
  const { deal_id } = req.body || {};
  if (!deal_id) {
    return res.status(400).send('Не передан deal_id');
  }
  logger.info(`▶️  Запрос на копирование сделки ${deal_id}`);

  try {
    // 1. Получаем исходную сделку
    const deal = await bx('crm.deal.get', { id: deal_id }, 'crm.deal.get');
    if (!deal) return res.status(404).send('Сделка не найдена в Bitrix24');

    // 2. Создаём новую сделку
    const newDealId = await bx(
      'crm.deal.add',
      {
        fields: {
          TITLE: deal.TITLE,
          CATEGORY_ID: 14,          // TODO: id воронки
          STAGE_ID: 'РД_выдан',    // TODO: код стадии
          ASSIGNED_BY_ID: deal.ASSIGNED_BY_ID,
        },
      },
      'crm.deal.add'
    );
    logger.info(`✅ Новая сделка ${newDealId} создана из ${deal_id}`);

    // 3. Находим связанные задачи
    const taskList = await bx(
      'tasks.task.list',
      {
        filter: {
          UF_CRM_TASK: `D_${deal_id}`,
          STATUS: [1, 2, 3, 4],
        },
        select: ['ID', 'TITLE', 'RESPONSIBLE_ID', 'DESCRIPTION'],
      },
      'tasks.task.list'
    );
    const tasks = taskList.tasks || [];
    logger.info(`📌 Найдено задач для копирования: ${tasks.length}`);

    // 4. Копируем задачи параллельно
    const copyResults = await Promise.allSettled(
      tasks.map((t) =>
        bx(
          'tasks.task.add',
          {
            fields: {
              TITLE: t.TITLE,
              RESPONSIBLE_ID: t.RESPONSIBLE_ID,
              DESCRIPTION: t.DESCRIPTION || '',
              UF_CRM_TASK: [`D_${newDealId}`],
            },
          },
          `tasks.task.add (src ${t.ID})`
        )
      )
    );

    const success = copyResults.filter((r) => r.status === 'fulfilled').length;
    const failed = copyResults.filter((r) => r.status === 'rejected');
    failed.forEach((f) => logger.error(f.reason.message));

    res
      .status(200)
      .send(`Сделка скопирована (ID ${newDealId}). Задач скопировано: ${success}/${tasks.length}.`);
  } catch (err) {
    logger.error(err.message);
    res.status(500).send(err.message);
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Запуск сервера
// ────────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`🚀 Сервер запущен на http://localhost:${PORT}`));
